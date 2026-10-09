import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type BrowserContext, type Page } from "playwright";

import type { ResolvedAudio } from "../audio.js";
import {
  DriverEndFailure,
  PAGE_PUSH_BINDING_NAME,
  PlaywrightVoiceDriver,
  VOICE_LAB_BROWSER_CONTEXT_OPTIONS,
  assertPageLocation,
  closeContextWithProof,
  closeDisposableBrowserProcess,
  disposableBrowserProcessIsActive,
  launchDisposableBrowserProcess,
  readHarnessEvents,
  type ActiveProductTarget,
  type BrowserAcquisitionObserver,
  type BrowserStartStage,
  type D02BrowserContextBinding,
  type D02ProductCleanupAcknowledgement,
  type D02ProductCleanupRequest,
  type DriverEndResult,
  type DriverOperationResult,
  type DriverStartResult,
  type OwnedBrowserProcess,
  type RecoveryTransportBinding,
  type VoiceBrowserDriver,
} from "../browser-driver.js";
import { buildVoiceLabInitScript } from "../browser-init.js";
import type { BrowserProcessTermination } from "../browser-process-termination.js";
import type { VoiceLabConfig } from "../config.js";
import { VoiceLabError, labError, type DeploymentIdentity, type LabEvent, type RunRecord } from "../domain.js";
import { redact, sha256 as labSha256, validateAllowedOrigin } from "../security.js";
import {
  STUDIO_G7_CONTRACT_VERSION,
  STUDIO_LIVE_DESIGN_STATES,
  STUDIO_G7_TARGET_KIND,
  STUDIO_RUN_BINDING_SCHEMA,
  StudioContractViolation,
  canonicalJson,
  computeRunBindingSha256,
  parsePageReceipt,
  type StudioPageReceipt,
} from "./contract.js";
import type { StudioG7Config } from "./config.js";
import { buildStudioObserverScript } from "./page-scripts.js";
import { probeStudioReadiness } from "./readiness.js";
import { STUDIO_G7_ACTIONS, STUDIO_G7_VOICE_STEPS, isStudioG7ScenarioVersion, STUDIO_G7_SCENARIO_ID_SET, studioG7StepId, type StudioG7Action, type StudioG7VoiceStep } from "./scenarios.js";
import { STUDIO_ROOM_PRESENCE_KIND, STUDIO_ROOM_PRESENCE_SCHEMA, StudioApiClient, classifyRoomPresence, type IdentityObservation, type ProjectedArtifactVersion, type ProjectedTaskDetail, type StudioRoomSnapshot } from "./studio-api.js";
import { STUDIO_CALLS_END_STEP, STUDIO_CALLS_READ_KIND, STUDIO_CALLS_READ_SCHEMA } from "./calls-certification.js";
import { buildStudioSessionSeedScript, globalSignOut, passwordGrant, revokeIssuedSession, signOut, supabaseStorageKey, type FetchLike, type IssuedStudioSession, type SignOutReceipt, type StudioUserSession } from "./supabase-session.js";

type DriverEvent = Omit<LabEvent, "runId" | "seq" | "at">;

const MAX_PUSH_QUEUE = 4_096;
const BRIDGE_POLL_MS = 2_000;
const STATS_POLL_MS = 5_000;
/** Product clock vs Lab clock tolerance for the actor/time-window task join. */
export const OUTCOME_WINDOW_TOLERANCE_MS = 120_000;
const MAX_OBSERVED_TASKS = 12;
const MAX_VERIFIED_ARTIFACTS = 4;
/** A stale edit carries this fixed Lab instruction; it must be refused before anything is admitted. */
/** Waits before each local revoke attempt of the evidence-refresh session (three attempts). */
export const STUDIO_REFRESH_REVOKE_BACKOFF_MS: readonly number[] = [0, 500, 1_000];
/** Waits before each local logout attempt of a session issued and then refused, per cleanup (three attempts). */
export const STUDIO_REFUSED_SESSION_LOGOUT_BACKOFF_MS: readonly number[] = [0, 500, 1_000];
export const STALE_EDIT_PROBE_INSTRUCTION = "Voice Lab stale-edit probe: revise this section of a superseded version.";
/** The run's own synthetic note, recorded first; the create utterance asks for research that draws on it. */
export const STUDIO_G7_NOTE_TEXT = "Families in the pilot prefer Saturday morning sessions near the river.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECTION = /^[a-z][a-z0-9-]{0,63}$/;

export interface StudioDriverDependencies {
  fetchImpl?: FetchLike;
  launchBrowserServer?: (options: Parameters<typeof chromium.launchServer>[0]) => ReturnType<typeof chromium.launchServer>;
  connectBrowser?: (endpoint: string) => ReturnType<typeof chromium.connect>;
  /** Readiness is product-agnostic (Chromium + WebAudio); reuse the legacy probe. */
  readinessDriver?: Pick<VoiceBrowserDriver, "readiness" | "close">;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  setTimer?: (callback: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (handle: unknown) => void;
  /** UI timeouts (tests shorten them). */
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>;
}

const DEFAULT_TIMEOUTS = {
  navigationMs: 30_000,
  controlVisibleMs: 30_000,
  ariaPressedMs: 10_000,
  micArrivalGraceMs: 5_000,
  exchangeOpenMs: 20_000,
  exchangeEndMs: 15_000,
  sessionClosedMs: 10_000,
  uiActionMs: 5_000,
  designSettleMs: 120_000,
  /** Between re-reads of the exchange's calls until every listed call is answered. */
  callsSettleWaitMs: 1_000,
};

interface PushItem { arrival: number; payload: unknown }
interface AcceptedPageReceipt { arrival: number; receipt: StudioPageReceipt }

interface StudioSession {
  runId: string;
  testRunId: string;
  cleanupObligationId: string;
  ownership: OwnedBrowserProcess;
  context: BrowserContext | null;
  page: Page | null;
  harnessCursor: number;
  push: { queue: PushItem[]; overflow: boolean; arrival: number };
  accepted: AcceptedPageReceipt[];
  issuedTrackHashes: Set<string>;
  auth: StudioUserSession | null;
  runBindingSha256: string;
  bridgeSeen: Map<string, string>;
  sessionClosedSeen: boolean;
  lastBridgePollAt: number;
  lastStatsAt: number;
  statsSequence: number;
  pendingEvents: DriverEvent[];
}

/**
 * What this driver instance knows about a run, independent of its browser.
 * A record is either retained (this instance ran the start) or adopted from
 * the run's durable write-ahead events after a worker restart.
 */
export interface ExchangeRecord {
  exchangeId: string | null;
  preexistingExchangeId: string | null;
  speakRequested: boolean;
  browserLaunched: boolean;
  authIssued: boolean;
  /** Grant id of this run's bound `mic_published` page receipt (the grant gate). */
  grantId: string | null;
  runBindingSha256: string | null;
  exchangeOpenedAtMs: number | null;
  join: "retained" | "durable";
  /** This driver's start is still running (Speak may be opening the exchange right now). */
  startInProgress: boolean;
  /** When Speak was requested (driver clock; audit only, never compared across workers). */
  speakRequestedAtMs: number | null;
  /** The run's browser is closed (or, adopted, a dead owner's can no longer act). */
  browserClosed: boolean;
  /** A global sign-out of the principal was confirmed (after Speak). */
  globalSignOutConfirmed: boolean;
}

/** The durable join a restarted worker hands the driver (from write-ahead events). */
export interface DurableStudioJoin {
  exchangeId: string | null;
  grantId: string | null;
  runBindingSha256: string;
  speakRequested: boolean;
  exchangeOpenedAtMs: number | null;
  /** When the durable Speak intent was recorded (audit only). */
  speakRequestedAtMs?: number | null;
  /** Durable after the Speak intent: the run's browser closed (or quiesced). */
  browserClosed?: boolean;
  /** Durable after the Speak intent: a confirmed global sign-out. */
  globalSignOutConfirmed?: boolean;
}

export type OwnershipStatus = "proven" | "unavailable" | "mismatch";

/** The run's own report on its canonical chain, or why it cannot be resolved without guessing. */
type OwnReport =
  | { status: "found"; createTaskId: string; designTaskId: string; artifactId: string; publishedVersionId: string; versions: ProjectedArtifactVersion[]; sections: string[] }
  | { status: "refused"; outcome: "unavailable" | "uncertain"; reason: string };

/** Caches one principal token per cleanup flow; never logged or persisted. */
interface TokenSource { token(): Promise<string>; held(): StudioUserSession | null; forget(): void }

/**
 * A run's sessions that Supabase issued and the Lab did not accept: each is
 * recorded when issued, before any validation could refuse it (and throw),
 * and owes a logout. Their access tokens (the revoke material) live only
 * here, in memory: never logged, persisted or put in an event, and dropped
 * once revoked.
 */
interface RefusedSessions { owed: IssuedStudioSession[]; revoked: number }

/** What the run's refused sessions came to: how many there were, how many stay unrevoked, and this cleanup's logout attempts. */
interface RefusedSessionsOutcome { refused: number; unrevoked: number; attempts: number; httpStatus: number | null }

/**
 * Local logout of every refused session the run still owes, each retried with
 * the bounded backoff. One issued to the principal itself is revoked by a
 * confirmed global sign-out of the principal (`principalSignedOut`); one
 * issued to anyone else only by its own logout.
 */
async function revokeRefusedSessions(sessions: RefusedSessions, principalId: string, principalSignedOut: boolean, logout: (issued: IssuedStudioSession) => Promise<SignOutReceipt>, wait: (ms: number) => Promise<void>): Promise<RefusedSessionsOutcome> {
  let attempts = 0;
  let httpStatus: number | null = null;
  for (const issued of [...sessions.owed]) {
    if (principalSignedOut && issued.userId !== null && issued.userId.toLowerCase() === principalId.toLowerCase()) issued.revoked = true;
    for (const backoffMs of STUDIO_REFUSED_SESSION_LOGOUT_BACKOFF_MS) {
      if (issued.revoked) break;
      if (backoffMs > 0) await wait(backoffMs);
      attempts += 1;
      httpStatus = (await logout(issued)).http_status;
    }
    if (!issued.revoked) continue;
    sessions.owed.splice(sessions.owed.indexOf(issued), 1);
    sessions.revoked += 1;
  }
  return { refused: sessions.owed.length + sessions.revoked, unrevoked: sessions.owed.length, attempts, httpStatus };
}

/** The refused sessions' counts on a sign-out or revoke receipt (no token, ever). */
function refusedSessionsFields(outcome: RefusedSessionsOutcome): Record<string, number> {
  return { refused_sessions: outcome.refused, refused_sessions_unrevoked: outcome.unrevoked, refused_logout_attempts: outcome.attempts };
}

type IdentitySnapshot = { observed: Partial<DeploymentIdentity>; event: DriverEvent };

/** The Studio extensions the worker calls for G7 runs (absent on the legacy driver). */
export interface StudioDriverExtensions {
  studioAction(run: RunRecord, operationId: string, input: Record<string, unknown>): Promise<DriverOperationResult>;
  /**
   * The sign-out fence's holder check for an API-only recovery: consulted right
   * before its global logout; false (the marker was taken over) means only
   * the recovery's own session is signed out (scope=local). null removes it.
   */
  setStudioSignOutGate(runId: string, gate: (() => Promise<boolean>) | null): void;
  /**
   * The run's certified create task (the create step's /calls
   * certification), or null while it is not certified: the only root the
   * run's report is resolved from, before an edit and for byte verification.
   */
  setStudioOwnCreateTask(runId: string, taskId: string | null): void;
  /**
   * One settled read of the run's exchange's calls (A15 getExchangeCalls), as
   * the principal: re-read (bounded) until every listed call is answered.
   * `baseline` (no `after`) is a voice step's write-ahead baseline; `after`
   * (`after` = that baseline's `readAt`, verbatim) lists the step's calls.
   */
  readStudioCalls(run: RunRecord, purpose: "baseline" | "after", operationId: string, stepId: string | null, after?: string | null): Promise<DriverEvent>;
  refreshStudioEvidence(run: RunRecord, join: DurableStudioJoin): Promise<DriverEvent[]>;
  adoptStudioJoin(runId: string, join: DurableStudioJoin): void;
  studioReadiness(): Promise<Record<string, unknown>>;
}

export function hasStudioExtensions(driver: VoiceBrowserDriver): driver is VoiceBrowserDriver & StudioDriverExtensions {
  const candidate = driver as Partial<StudioDriverExtensions>;
  return typeof candidate.studioAction === "function" && typeof candidate.refreshStudioEvidence === "function" && typeof candidate.adoptStudioJoin === "function" && typeof candidate.readStudioCalls === "function" && typeof candidate.setStudioSignOutGate === "function" && typeof candidate.setStudioOwnCreateTask === "function";
}

/** More calls than this in one exchange: the read is typed unavailable rather than truncated. */
const MAX_RECORDED_CALLS = 1_000;
/** Reads of the calls until every listed call is answered (A15 answeredAt); then the read is typed unsettled. */
export const STUDIO_CALLS_SETTLE_ATTEMPTS = 10;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Content-addressed dedupe key: exact replays dedupe, differing retries never collide. */
function contentKey(prefix: string, runId: string, payload: Record<string, unknown>): string {
  return `${prefix}:${runId}:${sha256(canonicalJson(payload))}`;
}

function studioError(code: string, message: string, category: "harness" | "product" | "authorization" | "deployment" | "validation", retryable = false, details?: Record<string, unknown>): VoiceLabError {
  return new VoiceLabError(labError(code, message, category, retryable, details));
}

/**
 * VoiceBrowserDriver for the Studio (LiveKit) G7 target.
 *
 * Ownership, process lifetime and the media seam are reused from the legacy
 * driver: one disposable Chromium process per run, the shared init script's
 * getUserMedia replacement and `__sophiaVoiceLab.schedule` injection, and the
 * private page-push binding. Authority is the synthetic principal's own
 * Supabase session; product evidence and outcomes are read only through the
 * member API with that principal's JWT.
 *
 * Exchange cleanup is conservative. The driver requests End only for an
 * exchange it can prove is this run's own (the exchange id joined to this run
 * when its Speak opened it, whose qualification evidence names this run's
 * binding hash and the grant id of this run's bound page receipts), and only
 * as the id-bound API End of that exchange, never the room UI's End button
 * (which acts on whatever exchange the room shows when clicked). For anything
 * else it never requests End: it only verifies, read-only, that the run's
 * exchange is no longer live (one live exchange per room), or types the state
 * `uncertain` / `unavailable` for a later recovery. Leaving the room and
 * closing its own browser are not ownership-gated: they act on the
 * principal's presence and the run's browser, not on an exchange. The
 * product's guard ends every exchange under a grant at its deadline
 * independently.
 */
export class StudioG7Driver implements VoiceBrowserDriver, StudioDriverExtensions {
  readonly #sessions = new Map<string, StudioSession>();
  readonly #starting = new Set<string>();
  /** Survives browser loss: the watchdog and recovery still need the exchange join. */
  readonly #exchanges = new Map<string, ExchangeRecord>();
  readonly #watchdogs = new Map<string, unknown>();
  /** Watchdog/recovery events produced while no browser session exists. */
  readonly #orphanEvents = new Map<string, DriverEvent[]>();
  /** Per run: sessions issued and refused, still owing their logout (memory only). */
  readonly #refusedSessions = new Map<string, RefusedSessions>();
  readonly #api: StudioApiClient;
  readonly #fetch: FetchLike;
  readonly #readiness: Pick<VoiceBrowserDriver, "readiness" | "close">;
  readonly #now: () => number;
  readonly #wait: (ms: number) => Promise<void>;
  readonly #setTimer: (callback: () => void, ms: number) => { unref?: () => void };
  readonly #clearTimer: (handle: unknown) => void;
  readonly #timeouts: typeof DEFAULT_TIMEOUTS;

  constructor(
    readonly config: VoiceLabConfig,
    readonly studio: StudioG7Config,
    readonly deps: StudioDriverDependencies = {},
  ) {
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#api = new StudioApiClient(studio.apiOrigin, studio.studioOrigin, config.allowedOrigins, this.#fetch, 10_000, studio.objectStoreOrigins ?? []);
    validateAllowedOrigin(studio.supabaseUrl, config.allowedOrigins);
    this.#readiness = deps.readinessDriver ?? new PlaywrightVoiceDriver(config, fetch, undefined, undefined, deps.launchBrowserServer, deps.connectBrowser);
    this.#now = deps.now ?? (() => Date.now());
    this.#wait = deps.wait ?? ((ms) => sleep(Math.max(0, ms)).then(() => undefined));
    this.#setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...(deps.timeouts ?? {}) };
  }

  hasSession(runId: string): boolean { return this.#sessions.has(runId); }

  readiness(): Promise<{ ok: boolean; detail: string; engine?: string; version?: string }> {
    return this.#readiness.readiness();
  }

  /** Target-aware readiness without signing in (see readiness.ts). */
  async studioReadiness(): Promise<Record<string, unknown>> {
    return probeStudioReadiness(this.config, this.studio, this.#fetch);
  }

  async verifyTarget(run: RunRecord): Promise<DriverStartResult> {
    const identity = await this.#observeIdentities(run, "pre_resource");
    return { observedDeployment: identity.observed as DeploymentIdentity, events: [identity.event] };
  }

  async start(run: RunRecord, _frontendCapability: string, _browserContextBinding?: D02BrowserContextBinding, onStage?: (stage: BrowserStartStage) => Promise<void>, onAcquired?: BrowserAcquisitionObserver, onDurable?: (events: DriverEvent[]) => Promise<void>): Promise<DriverStartResult> {
    if (this.#sessions.has(run.id) || this.#starting.has(run.id)) throw studioError("BROWSER_ALREADY_STARTED", "Run already owns or is acquiring a browser process.", "harness");
    if (!isStudioG7ScenarioVersion(run.scenarioVersion) || run.scenarioId === null || !STUDIO_G7_SCENARIO_ID_SET.has(run.scenarioId)) {
      throw new VoiceLabError(labError("SCENARIO_UNSUPPORTED_FOR_TARGET", "Only Studio G7 scenarios run on the Studio LiveKit target.", "validation", false, { status: "unsupported_for_target", target_kind: STUDIO_G7_TARGET_KIND, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion }));
    }
    this.#starting.add(run.id);
    const runBindingSha256 = computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion! });
    this.#exchanges.set(run.id, { exchangeId: null, preexistingExchangeId: null, speakRequested: false, browserLaunched: false, authIssued: false, grantId: null, runBindingSha256, exchangeOpenedAtMs: null, join: "retained", startInProgress: true, speakRequestedAtMs: null, browserClosed: false, globalSignOutConfirmed: false });
    try { return await this.#startReserved(run, runBindingSha256, onStage, onAcquired, onDurable); }
    finally {
      const record = this.#exchanges.get(run.id);
      if (record) record.startInProgress = false;
    }
  }

  async #startReserved(run: RunRecord, runBindingSha256: string, onStage?: (stage: BrowserStartStage) => Promise<void>, onAcquired?: BrowserAcquisitionObserver, onDurable?: (events: DriverEvent[]) => Promise<void>): Promise<DriverStartResult> {
    let identity: IdentitySnapshot;
    let ownership: OwnedBrowserProcess;
    try {
      identity = await this.#observeIdentities(run, "startup");
      ownership = await launchDisposableBrowserProcess(run, this.deps.launchBrowserServer, this.deps.connectBrowser);
      this.#state(run.id).browserLaunched = true;
    } finally {
      this.#starting.delete(run.id);
    }
    const acquisition: DriverEvent = {
      kind: "harness.browser_process_acquired", source: "browser",
      payload: { schema: "sophia_voice_lab_browser_process_ownership_v1",
        voice_lab_run_id_sha256: labSha256(run.id), cleanup_obligation_id_sha256: labSha256(run.cleanupObligationId),
        process_id_sha256: ownership.processIdSha256, browser_boot_id_sha256: ownership.bootIdSha256,
        execution_epoch_sha256: ownership.executionEpochSha256, started_at: ownership.startedAt,
        one_process_per_run: true, raw_process_id_excluded: true },
      dedupeKey: `browser-process:${ownership.executionEpochSha256}`,
    };
    const session: StudioSession = {
      runId: run.id, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId,
      ownership, context: null, page: null, harnessCursor: 0,
      push: { queue: [], overflow: false, arrival: 0 }, accepted: [], issuedTrackHashes: new Set(),
      auth: null, runBindingSha256,
      bridgeSeen: new Map(), sessionClosedSeen: false, lastBridgePollAt: 0, lastStatsAt: 0, statsSequence: 0, pendingEvents: [],
    };
    // Registered immediately after launch: every later failure (ownership
    // persistence, auth, UI) flows through abort, which proves the browser
    // close, settles the exchange and signs the principal out.
    this.#sessions.set(run.id, session);
    this.#armWatchdog(run);
    session.pendingEvents.push(identity.event, acquisition);
    await onAcquired?.(acquisition, { engine: "chromium", version: ownership.browser.version() });
    // Password grant for the dedicated synthetic principal (stage name reused
    // from the legacy start trace: the auth session is established here).
    await onStage?.("frontend_auth_session");
    const auth = await this.#tokenSource(session).token().then(() => session.auth!);
    session.pendingEvents.splice(0);
    const declared: DriverEvent = {
      kind: "studio.run_binding.declared", source: "canonical",
      payload: { schema: STUDIO_RUN_BINDING_SCHEMA, contract_version: STUDIO_G7_CONTRACT_VERSION, run_binding_sha256: runBindingSha256, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, test_run_id: run.testRunId, cleanup_obligation_id_sha256: labSha256(run.cleanupObligationId) },
      dedupeKey: `studio-run-binding:${run.id}`,
    };
    const established: DriverEvent = {
      kind: "studio.auth.session_established", source: "canonical",
      // expires_in_s: the access-JWT lifetime the product issued (a dead
      // owner's lease is never released before it has elapsed).
      payload: { principal_id_sha256: labSha256(run.principalId), principal_bound: true, expires_at: auth.expiresAt, expires_in_s: auth.expiresIn, credentials_excluded: true },
      dedupeKey: `studio-auth:${run.id}:${auth.expiresAt}`,
    };
    const events: DriverEvent[] = [identity.event, acquisition, declared, established];
    try {
      // Durable before the browser is seeded with the session: a worker that
      // dies from here on leaves the issued lifetime for the dead-owner wait.
      await onDurable?.([declared, established]);
      await onStage?.("browser_init_script");
      const context = await ownership.browser.newContext(VOICE_LAB_BROWSER_CONTEXT_OPTIONS);
      session.context = context;
      await context.exposeBinding(PAGE_PUSH_BINDING_NAME, (source, raw: unknown) => {
        if (session.page === null || source.page !== session.page) return undefined;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const envelope = raw as Record<string, unknown>;
        if (envelope.schema !== "sophia_voice_lab_page_push_v1" || envelope.channel !== "studio") return undefined;
        if (session.push.queue.length >= MAX_PUSH_QUEUE) { session.push.overflow = true; return undefined; }
        session.push.arrival += 1;
        session.push.queue.push({ arrival: session.push.arrival, payload: envelope.payload });
        const detail = envelope.payload && typeof envelope.payload === "object" ? (envelope.payload as Record<string, unknown>).detail : null;
        try { session.accepted.push({ arrival: session.push.arrival, receipt: parsePageReceipt(detail) }); } catch { /* typed on drain */ }
        return undefined;
      });
      await context.addInitScript({ content: buildStudioSessionSeedScript({ studioOrigin: this.studio.studioOrigin, storageKey: supabaseStorageKey(this.studio.supabaseUrl), session: auth }) });
      await context.addInitScript({ content: buildVoiceLabInitScript({ pageOrigin: this.studio.studioOrigin, websocketOrigins: [], maxAudioBytes: this.config.maxAudioBytes, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, profile: STUDIO_G7_TARGET_KIND }) });
      await context.addInitScript({ content: buildStudioObserverScript({ studioOrigin: this.studio.studioOrigin }) });
      await onStage?.("frontend_home_navigation");
      const page = await context.newPage();
      session.page = page;
      const roomPath = `/p/${this.studio.projectId}/studio`;
      await page.goto(new URL(roomPath, this.studio.studioOrigin).toString(), { waitUntil: "domcontentloaded", timeout: this.#timeouts.navigationMs });
      assertPageLocation(page.url(), this.studio.studioOrigin, (pathname) => pathname === roomPath, "STUDIO_ROUTE_DRIFT");
      await onStage?.("voice_start_button");
      events.push(await this.#joinRoom(session, "initial"));
      events.push(await this.#ensureMicrophoneOn(session));
      await onStage?.("voice_startup_readiness");
      const gate = await this.#awaitGrantGate(session);
      events.push(...gate.events);
      this.#state(run.id).grantId = gate.grantId;
      const before = await this.#api.snapshot(this.studio.projectId, await this.#tokenSource(session).token());
      if (before.exchangeId !== null) {
        this.#state(run.id).preexistingExchangeId = before.exchangeId;
        throw studioError("STUDIO_PROJECT_EXCHANGE_ALREADY_OPEN", "The synthetic project already had a live exchange before this run spoke; it was not adopted and is never touched.", "harness", false, { status: "unavailable" });
      }
      // Write-ahead: the durable intent precedes the click, so a restarted
      // worker that finds no intent knows this run never opened an exchange.
      const requestedAt = this.#now();
      const intentPayload = { grant_id: gate.grantId, run_binding_sha256: runBindingSha256, write_ahead: true, requested_at_lab_ms: requestedAt };
      const intent: DriverEvent = { kind: "studio.exchange.speak_requested", source: "canonical", payload: intentPayload, dedupeKey: `studio-speak-requested:${run.id}` };
      await onDurable?.([...events, intent]);
      events.push(intent);
      this.#state(run.id).speakRequested = true;
      this.#state(run.id).speakRequestedAtMs = requestedAt;
      await this.#clickControl(session, /^Speak with Sophia$/, this.#timeouts.controlVisibleMs);
      const opened = await this.#awaitExchange(session, run);
      await onDurable?.([opened]);
      events.push(opened);
      const ownershipProof = await this.#proveOwnership(run.id, this.#tokenSource(session));
      events.push(ownershipProof.event);
      if (ownershipProof.status === "mismatch") {
        throw studioError("STUDIO_EXCHANGE_OWNERSHIP_MISMATCH", "The opened exchange's qualification evidence is bound to another run or grant; it is never touched.", "harness", false, { status: "fail", reason: ownershipProof.reason });
      }
      events.push(...await this.drain(run.id));
      return { observedDeployment: identity.observed as DeploymentIdentity, events };
    } catch (error) {
      session.pendingEvents.push(...events.filter((event) => event.kind !== "harness.browser_process_acquired"));
      if (error instanceof VoiceLabError) throw error;
      throw studioError("STUDIO_ROUTE_FAILED", "The Studio room route could not be established.", "harness", false, { error_class: error instanceof Error ? error.name : "Error" });
    }
  }

  async schedule(run: RunRecord, operationId: string, utteranceId: string, audio: ResolvedAudio, delayMs = 0, _activeTarget?: ActiveProductTarget): Promise<DriverOperationResult> {
    const session = this.#requireSession(run.id);
    const page = this.#requirePage(session);
    const receipt = await page.evaluate(async (input) => {
      const bridge = (window as any).__sophiaVoiceLab;
      if (!bridge?.schedule) throw new Error("Voice Lab injection bridge is unavailable");
      return bridge.schedule(input);
    }, {
      operationId,
      utteranceId,
      audioBase64: audio.bytes.toString("base64"),
      sha256: audio.sha256,
      delayMs,
      expectedSilence: audio.fixture?.fixtureClass === "silence",
      settlementWindowMs: 3_000,
      activeTarget: null,
    });
    const events = await this.drain(run.id);
    return { receipt: { product: redact(receipt as Record<string, unknown>), execution_epoch_sha256: session.ownership.executionEpochSha256 }, events };
  }

  async rotate(): Promise<DriverOperationResult> {
    throw studioError("STUDIO_OPERATION_UNSUPPORTED", "Provider socket rotation does not exist on the Studio LiveKit target: the browser has no provider socket.", "validation", false, { status: "unsupported" });
  }

  async continueSession(): Promise<DriverEvent[]> {
    // The Studio's own supabase-js refreshes its session; the driver re-grants
    // its API token on demand. There is no Lab-run context to continue.
    return [];
  }

  async quiesceD02Provider(_run: RunRecord, _request: D02ProductCleanupRequest): Promise<D02ProductCleanupAcknowledgement> {
    throw studioError("STUDIO_OPERATION_UNSUPPORTED", "The D02 browser-provider quiescence contract does not apply to the Studio target.", "validation", false, { status: "unsupported" });
  }

  async drain(runId: string, force = false): Promise<DriverEvent[]> {
    const session = this.#requireSession(runId);
    const events: DriverEvent[] = session.pendingEvents.splice(0);
    const page = this.#requirePage(session);
    const harness = await readHarnessEvents(page, session.harnessCursor);
    session.harnessCursor = harness.cursor;
    this.#noteIssuedTracks(session, harness.events);
    events.push(...harness.events);
    events.push(...this.#drainPush(session));
    const now = this.#now();
    const exchangeId = this.#exchanges.get(runId)?.exchangeId ?? null;
    if (exchangeId !== null && (force || now - session.lastBridgePollAt >= BRIDGE_POLL_MS)) {
      session.lastBridgePollAt = now;
      events.push(...await this.#readBridge(runId, exchangeId, this.#tokenSource(session), session.bridgeSeen, (closed) => { if (closed) session.sessionClosedSeen = true; }));
    }
    if (force || now - session.lastStatsAt >= STATS_POLL_MS) {
      session.lastStatsAt = now;
      const stats = await this.#senderStats(session).catch(() => null);
      if (stats) events.push(stats);
    }
    return events;
  }

  /**
   * One G7 non-voice step as one operation: leave and return, a section-only
   * revision, a stale edit, or a withdrawal. Every product request is made as
   * the principal through the member API; only ids, states, hashes and
   * enumerated codes are recorded.
   */
  async studioAction(run: RunRecord, operationId: string, input: Record<string, unknown>): Promise<DriverOperationResult> {
    const action = input.action;
    const session = this.#requireSession(run.id);
    const tokens = this.#tokenSource(session);
    if (Object.hasOwn(input, "_own_create_task_id")) this.setStudioOwnCreateTask(run.id, typeof input._own_create_task_id === "string" ? input._own_create_task_id : null);
    // The run's own note, handed over from its durable record_note receipt.
    if (typeof input._own_note_entry_id === "string" && typeof input._own_note_source_id === "string" && UUID.test(input._own_note_entry_id) && UUID.test(input._own_note_source_id)) {
      this.#ownNote.set(run.id, { entryId: input._own_note_entry_id.toLowerCase(), sourceId: input._own_note_source_id.toLowerCase() });
    }
    if (action === "observe") {
      // Not a step: a read-only outcome read for a voice step, optionally
      // after a bounded wait so the product can act on the utterance.
      const forStep = input.for_step;
      if (typeof forStep !== "string" || !(STUDIO_G7_VOICE_STEPS as readonly string[]).includes(forStep)) throw studioError("STUDIO_ACTION_INVALID", "observe needs for_step naming a G7 voice step.", "validation");
      const budget = typeof input._settle_budget_ms === "number" ? input._settle_budget_ms : 30_000;
      const waitMs = Math.min(typeof input.wait_ms === "number" ? Math.max(0, input.wait_ms) : 0, budget);
      if (waitMs > 0) await this.#wait(waitMs);
      const stepId = studioG7StepId(forStep as StudioG7VoiceStep);
      const events: DriverEvent[] = [...await this.drain(run.id, true)];
      const observed = await this.#observeOutcome(run, tokens, stepId, [], operationId);
      events.push(observed.event);
      return { receipt: { action, step_id: stepId, performed: false, status: "observed", outcome_observation_sha256: sha256(canonicalJson(observed.event.payload)), execution_epoch_sha256: session.ownership.executionEpochSha256 }, events };
    }
    if (typeof action !== "string" || !(STUDIO_G7_ACTIONS as readonly string[]).includes(action)) throw studioError("STUDIO_ACTION_INVALID", "Unknown Studio G7 action.", "validation");
    const stepId = studioG7StepId(action as StudioG7Action);
    const events: DriverEvent[] = [...await this.drain(run.id, true)];
    const focus: string[] = [];
    let receipt: Record<string, unknown>;
    if (action === "record_note") {
      // No outcome observation: the note's effect is read where it matters (the research's inputs, the withdrawal).
      const result = await this.#recordNoteAction(run, tokens, operationId, input);
      events.push(...result.events);
      return { receipt: { action, step_id: stepId, ...result.receipt, execution_epoch_sha256: session.ownership.executionEpochSha256 }, events: [...events, ...await this.drain(run.id, true)] };
    }
    if (action === "leave_and_return") {
      const before = await this.#observeOutcome(run, tokens, `${stepId}:before`, [], operationId);
      events.push(before.event);
      events.push(...await this.#leaveAndReturn(run, session, operationId));
      receipt = { action, step_id: stepId, performed: true, status: "returned" };
    } else if (action === "section_revision" || action === "stale_edit") {
      const result = await this.#htmlEditAction(run, tokens, operationId, action, input);
      events.push(...result.events);
      if (result.taskId) focus.push(result.taskId);
      receipt = { action, step_id: stepId, ...result.receipt };
    } else {
      // The design's state before the withdrawal: an end the withdrawal did
      // not cause (already cancelled, failed) is never its effect.
      const before = await this.#observeOutcome(run, tokens, `${stepId}:before`, [], operationId);
      events.push(before.event);
      const result = await this.#withdrawalAction(run, tokens, operationId, input);
      events.push(...result.events);
      receipt = { action, step_id: stepId, ...result.receipt };
    }
    const after = await this.#observeOutcome(run, tokens, stepId, focus, operationId);
    events.push(after.event);
    events.push(...await this.drain(run.id, true));
    return { receipt: { ...receipt, outcome_observation_sha256: sha256(canonicalJson(after.event.payload)), execution_epoch_sha256: session.ownership.executionEpochSha256 }, events };
  }

  async end(run: RunRecord, _frontendFinalizeCapability: string, _frontendCleanupCapability: string, _operationDeadlineAt?: number): Promise<DriverEndResult> {
    const session = this.#requireSession(run.id);
    const events: DriverEvent[] = [];
    try {
      events.push(...await this.drain(run.id, true));
      const tokens = this.#tokenSource(session);
      // The final canonical outcome read, and the exchange's calls (the read
      // after the last voice steps), happen while the principal session
      // still exists.
      events.push((await this.#observeOutcome(run, tokens, "final", this.#focusTasks(run.id), "end").catch((error: unknown) => ({ event: this.#outcomeUnavailable(run.id, "final", error) }))).event);
      const settled = await this.#settleExchange(run.id, tokens);
      events.push(...settled.events);
      const left = await this.#clickIfVisible(session, /^Leave the room$/);
      const leftPayload = { basis: "ui_leave", control_clicked: left };
      events.push({ kind: "studio.room.left", source: "browser", payload: leftPayload, dedupeKey: contentKey("studio-room-left", run.id, leftPayload) });
      // Receipts written after End (session_closed, the last reply) are read
      // here, by every later drain and by the evidence refresh; they are
      // ordered by (source, seq), never by arrival.
      if (settled.confirmed) events.push(...await this.#awaitSessionClosed(session));
      events.push(...await this.drain(run.id, true));
      events.push((await this.#observeIdentities(run, "final")).event);
      // The final calls audit, post-quiescence: once the exchange ended and
      // the bridge reported its provider session closed, no further voice call
      // can be recorded. Read every call (settled: all answered) before the
      // global sign-out revokes the principal's read. What it was taken after
      // is recorded; the evaluator proves quiescence from the ledger order and
      // types anything less unproven.
      const audit = await this.#readCalls(run.id, tokens, "baseline", "end", STUDIO_CALLS_END_STEP, null)
        .catch(() => this.#callsReadRefused(run.id, "baseline", "end", STUDIO_CALLS_END_STEP, null, "calls_read_failed"));
      events.push({ ...audit, payload: { ...audit.payload, quiescence: { exchange_ended: settled.confirmed, session_closed: session.sessionClosedSeen } } });
      events.push(await this.#signOut(run.id, tokens));
      events.push(await this.#closeBrowser(run.id, session, "normal_end"));
      // An exchange that could not be settled keeps the watchdog: recovery
      // re-verifies it read-only until it is no longer live.
      if (settled.confirmed) this.#clearWatchdog(run.id);
      return { events, artifacts: [] };
    } catch (error) {
      throw new DriverEndFailure(error, events);
    }
  }

  async abort(run: RunRecord, reason: string): Promise<DriverEndResult> {
    const session = this.#sessions.get(run.id);
    if (!session) return { events: await this.#apiOnlyCleanup(run.id, `abort:${reason}`), artifacts: [] };
    const events: DriverEvent[] = [];
    try { events.push(...await this.drain(run.id, true)); }
    catch (error) {
      events.push(...session.pendingEvents.splice(0));
      try { events.push(...this.#drainPush(session)); } catch { /* overflow is typed below */ }
      const capture = { reason: error instanceof VoiceLabError ? error.detail.code : "page_unavailable" };
      events.push({ kind: "cleanup.capture_unavailable", source: "browser", payload: capture, dedupeKey: contentKey("cleanup-capture-unavailable", run.id, capture) });
    }
    const pageAlive = session.page !== null && disposableBrowserProcessIsActive(session.ownership) && !session.page.isClosed();
    const tokens = this.#tokenSource(session);
    const settled = await this.#settleExchange(run.id, tokens).catch((error: unknown) => ({ confirmed: false, events: [this.#exchangeEndUnavailable(run.id, "abort", error)] }));
    events.push(...settled.events);
    if (pageAlive) await this.#clickIfVisible(session, /^Leave the room$/).catch(() => false);
    const exchangeId = this.#exchanges.get(run.id)?.exchangeId ?? null;
    if (exchangeId !== null) events.push(...await this.#readBridge(run.id, exchangeId, tokens, session.bridgeSeen).catch(() => []));
    events.push(await this.#signOut(run.id, tokens));
    events.push(await this.#closeBrowser(run.id, session, reason));
    if (settled.confirmed) this.#clearWatchdog(run.id);
    return { events, artifacts: [] };
  }

  async recover(run: RecoveryTransportBinding, _recoveryCapability: string, _processTermination?: BrowserProcessTermination): Promise<DriverEndResult> {
    const events = await this.#apiOnlyCleanup(run.id, "recover");
    const ended = events.filter((event) => event.kind === "studio.cleanup.exchange_ended");
    const exchangeEnded = ended.length > 0 && ended.every((event) => event.payload.confirmed === true);
    // Only a confirmed GLOBAL sign-out signs the principal out; a withheld or local-only one never does.
    const signedOut = events.some((event) => event.kind === "studio.cleanup.signed_out" && event.payload.confirmed === true && event.payload.scope === "global");
    const exchangeStatus = ended.at(-1)?.payload.status ?? "unavailable";
    const recovery = { complete: exchangeEnded && signedOut && !this.#sessions.has(run.id), exchange_ended: exchangeEnded, exchange_status: exchangeStatus, signed_out: signedOut, browser_session_absent: !this.#sessions.has(run.id) };
    events.push({ kind: "studio.cleanup.recovery", source: "canonical", payload: recovery, dedupeKey: contentKey("studio-recovery", run.id, recovery) });
    return { events, artifacts: [] };
  }

  /**
   * Evidence completion after End: re-read the run's exchange evidence with a
   * fresh principal session (late receipts such as `session_closed` or the
   * last reply), then revoke only that session (scope=local). The run's own
   * cleanup already signed the principal out globally; a later run of the
   * same principal may be live now, and a global sign-out would revoke its
   * tokens. Nothing else is read or touched.
   */
  async refreshStudioEvidence(run: RunRecord, join: DurableStudioJoin): Promise<DriverEvent[]> {
    if (join.exchangeId === null || !UUID.test(join.exchangeId)) return [];
    this.adoptStudioJoin(run.id, join);
    const tokens = this.#tokenSource(null, run.id);
    const events: DriverEvent[] = [];
    try {
      events.push(...await this.#readBridge(run.id, join.exchangeId, tokens, new Map()));
    } catch (error) {
      const payload = { exchange_id: join.exchangeId, reason: error instanceof VoiceLabError ? error.detail.code : "refresh_failed", http_status: null };
      events.push({ kind: "studio.bridge_evidence_unavailable", source: "canonical", payload, dedupeKey: contentKey("studio-bridge-unavailable", run.id, payload) });
    }
    const held = tokens.held();
    if (held !== null) {
      // Revoke only this session, retrying with backoff. Never fall back to a
      // global sign-out here: a later run of the principal may be live. If it
      // stays unrevoked the cleanup proof says so (refresh_session_revoked)
      // until a global sign-out the worker makes only once no other run
      // holds admission.
      let receipt: SignOutReceipt | null = null;
      let attempts = 0;
      for (const backoffMs of STUDIO_REFRESH_REVOKE_BACKOFF_MS) {
        if (backoffMs > 0) await this.#wait(backoffMs);
        attempts += 1;
        receipt = await signOut({ supabaseUrl: this.studio.supabaseUrl, publishableKey: this.studio.supabasePublishableKey }, held.accessToken, "local", { fetchImpl: this.#fetch });
        if (receipt.confirmed) break;
      }
      tokens.forget();
      const revoked = { ...receipt!, status: receipt!.confirmed ? "revoked" : "unrevoked", attempts, purpose: "evidence_refresh", credentials_excluded: true, revocation_id: randomUUID() };
      events.push({ kind: "studio.evidence.session_revoked", source: "canonical", payload: revoked, dedupeKey: contentKey("studio-evidence-session-revoked", run.id, revoked) });
    }
    // A session issued and refused for the run owes its own logout here too,
    // never a global one; while it stays unrevoked the cleanup proof says so.
    const refused = await this.#revokeRefusedSessions(run.id, false);
    if (refused !== null && refused.attempts > 0) {
      const outcome = { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "local", confirmed: refused.unrevoked === 0, http_status: refused.httpStatus, basis: refused.unrevoked === 0 ? "issued_sessions_revoked" : "issued_session_unrevoked", status: refused.unrevoked === 0 ? "revoked" : "unrevoked", attempts: refused.attempts, purpose: "evidence_refresh_refused_grant", ...refusedSessionsFields(refused), credentials_excluded: true, revocation_id: randomUUID() };
      events.push({ kind: "studio.evidence.session_revoked", source: "canonical", payload: outcome, dedupeKey: contentKey("studio-evidence-session-revoked", run.id, outcome) });
    }
    return events;
  }

  async cancel(runId: string, _reason: string): Promise<void> {
    const session = this.#sessions.get(runId);
    if (!session) return;
    const closed = session.context ? await closeContextWithProof(session.context, () => session.ownership.browser.contexts()) : { closed: true, errorClass: null };
    const processClosed = closed.closed ? await closeDisposableBrowserProcess(session.ownership) : { closed: false, errorClass: closed.errorClass };
    if (!closed.closed || !processClosed.closed) throw studioError("BROWSER_PROCESS_CLOSE_FAILED", "Cancelled operation left a browser context or process that could not be proven closed.", "harness", true, { error_class: closed.errorClass ?? processClosed.errorClass });
    // The exchange join and the watchdog survive: abort/recover still settle
    // the exchange and sign the principal out.
    this.#orphanEvents.set(runId, [...(this.#orphanEvents.get(runId) ?? []), ...session.pendingEvents.splice(0)]);
    this.#sessions.delete(runId);
  }

  async close(): Promise<void> {
    const results = await Promise.all([...this.#sessions.values()].map((session) => closeDisposableBrowserProcess(session.ownership)));
    for (const handle of this.#watchdogs.values()) this.#clearTimer(handle);
    this.#watchdogs.clear();
    this.#sessions.clear();
    this.#ownCreate.clear();
    this.#focus.clear();
    this.#ownNote.clear();
    await this.#readiness.close();
    if (results.some((result) => !result.closed)) throw studioError("BROWSER_PROCESS_CLOSE_FAILED", "Worker shutdown could not prove every owned browser process closed.", "harness", true, { unresolved_processes: results.filter((result) => !result.closed).length });
  }

  // ------------------------------------------------------------------ helpers

  async #observeIdentities(run: Pick<RunRecord, "id">, phase: "pre_resource" | "startup" | "final"): Promise<{ observed: Partial<DeploymentIdentity>; event: DriverEvent }> {
    const [api, studio] = await Promise.all([this.#api.apiIdentity(), this.#api.studioIdentity()]);
    const mismatch = (component: "api" | "studio", observation: IdentityObservation) => observation.status === "observed" && observation.commit !== this.studio.expected[component];
    for (const [component, observation] of [["api", api], ["studio", studio]] as const) {
      if (mismatch(component, observation)) {
        throw new VoiceLabError(labError("DEPLOYMENT_MISMATCH", `${component} deployment does not match the exact requested commit.`, "deployment", false, { component, expected: this.studio.expected[component], observed: (observation as { commit: string }).commit, phase }));
      }
    }
    const observed: Partial<DeploymentIdentity> = {
      ...(studio.status === "observed" ? { frontend: studio.commit } : {}),
      ...(api.status === "observed" ? { backend: api.commit } : {}),
    };
    return {
      observed,
      event: {
        kind: "studio.deployment.identity", source: "canonical",
        // A missing identity is typed unavailable, never guessed. The bridge
        // identity arrives only in provider receipts.
        payload: { phase, api, studio, bridge: { status: "from_provider_receipts", expected: this.studio.expected.bridge }, expected: { ...this.studio.expected } },
        dedupeKey: contentKey(`studio-identity-${phase}`, run.id, { api, studio }),
      },
    };
  }

  #requireSession(runId: string): StudioSession {
    const session = this.#sessions.get(runId);
    if (!session) throw studioError("BROWSER_SESSION_LOST", "The browser worker no longer owns this run; it cannot be reconstructed honestly.", "harness");
    if (!disposableBrowserProcessIsActive(session.ownership)) throw studioError("BROWSER_EXECUTION_EPOCH_LOST", "The run-owned browser process is no longer active.", "harness", false, { execution_epoch_sha256: session.ownership.executionEpochSha256 });
    return session;
  }

  #requirePage(session: StudioSession): Page {
    if (session.page === null || session.page.isClosed()) throw studioError("BROWSER_EXECUTION_EPOCH_LOST", "The Studio page is no longer available.", "harness", false, { execution_epoch_sha256: session.ownership.executionEpochSha256 });
    return session.page;
  }

  #tokenSource(session: StudioSession): TokenSource;
  #tokenSource(session: StudioSession | null, runId: string): TokenSource;
  #tokenSource(session: StudioSession | null, runId: string = session!.runId): TokenSource {
    let held = session?.auth ?? null;
    return {
      token: async () => {
        const nowSeconds = Math.floor(this.#now() / 1_000);
        if (held && held.expiresAt - nowSeconds > 60) return held.accessToken;
        // The logout a session owes is recorded the moment Supabase issues
        // it, before any validation can refuse it (and throw); the session is
        // dropped from the owed ones only once accepted.
        const refused = this.#refusedOf(runId);
        let issued = null as IssuedStudioSession | null;
        held = await passwordGrant({ supabaseUrl: this.studio.supabaseUrl, publishableKey: this.studio.supabasePublishableKey }, { email: this.studio.principalEmail, password: this.studio.principalPassword }, { fetchImpl: this.#fetch, expectedUserId: this.config.principalId, onIssued: (fresh) => { issued = fresh; refused.owed.push(fresh); } });
        const accepted = issued === null ? -1 : refused.owed.indexOf(issued);
        if (accepted >= 0) refused.owed.splice(accepted, 1);
        if (session) { session.auth = held; this.#state(session.runId).authIssued = true; }
        return held.accessToken;
      },
      held: () => held,
      forget: () => { held = null; if (session) session.auth = null; },
    };
  }

  #refusedOf(runId: string): RefusedSessions {
    let refused = this.#refusedSessions.get(runId);
    if (refused === undefined) { refused = { owed: [], revoked: 0 }; this.#refusedSessions.set(runId, refused); }
    return refused;
  }

  /** The run's refused sessions, each logout retried (see revokeRefusedSessions); null when the run never had one. */
  async #revokeRefusedSessions(runId: string, principalSignedOut: boolean): Promise<RefusedSessionsOutcome | null> {
    const refused = this.#refusedSessions.get(runId);
    if (refused === undefined || refused.owed.length + refused.revoked === 0) return null;
    const target = { supabaseUrl: this.studio.supabaseUrl, publishableKey: this.studio.supabasePublishableKey };
    return revokeRefusedSessions(refused, this.config.principalId, principalSignedOut, (issued) => revokeIssuedSession(target, issued, { fetchImpl: this.#fetch }), this.#wait);
  }

  #noteIssuedTracks(session: StudioSession, events: DriverEvent[]): void {
    for (const event of events) {
      if (event.kind !== "harness.media_stream_issued" || event.payload.replacement_active !== true || !Array.isArray(event.payload.track_id_sha256s)) continue;
      for (const hash of event.payload.track_id_sha256s) if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) session.issuedTrackHashes.add(hash);
    }
  }

  /** Read issued-track receipts without advancing the durable cursor. */
  async #peekHarness(session: StudioSession): Promise<DriverEvent[]> {
    if (!session.page || session.page.isClosed()) return [];
    return (await readHarnessEvents(session.page, 0).catch(() => ({ cursor: 0, events: [] as DriverEvent[] }))).events;
  }

  #drainPush(session: StudioSession): DriverEvent[] {
    if (session.push.overflow) throw studioError("STUDIO_PAGE_PUSH_OVERFLOW", "Studio page receipts exceeded the bounded worker queue.", "harness", false);
    const events: DriverEvent[] = [];
    for (const item of session.push.queue.splice(0)) {
      const payload = item.payload && typeof item.payload === "object" && !Array.isArray(item.payload) ? item.payload as Record<string, unknown> : {};
      const observedAtMs = typeof payload.observed_at_ms === "number" && Number.isFinite(payload.observed_at_ms) ? payload.observed_at_ms : null;
      const provenance = { source: "studio-page-push", worker_arrival: item.arrival, observed_at: observedAtMs === null ? null : new Date(observedAtMs).toISOString() };
      try {
        const receipt = parsePageReceipt(payload.detail);
        const receiptJson = canonicalJson(receipt);
        const receiptSha256 = sha256(receiptJson);
        events.push({ kind: "studio.page_receipt", source: "product", payload: { event: receipt.event, receipt_json: receiptJson, receipt_sha256: receiptSha256, _capture_provenance: provenance }, dedupeKey: `studio-page:${session.runId}:${item.arrival}:${receiptSha256}` });
      } catch (error) {
        const violation = error instanceof StudioContractViolation ? error : new StudioContractViolation("page_receipt_unparseable");
        events.push({ kind: "studio.page_receipt_rejected", source: "browser", payload: { reason: violation.reason, path: violation.path, _capture_provenance: provenance }, dedupeKey: `studio-page-rejected:${session.runId}:${item.arrival}` });
      }
    }
    return events;
  }

  /**
   * Read the exchange's qualification evidence and return only receipts not
   * yet returned through `seen`. Identical replays dedupe by content; a
   * different body under the same (source, seq) is kept and fails the
   * evaluation's sequence integrity.
   */
  async #readBridge(runId: string, exchangeId: string, tokens: TokenSource, seen: Map<string, string>, onClosed?: (closed: boolean) => void): Promise<DriverEvent[]> {
    const read = await this.#api.qualificationEvidence(exchangeId, await tokens.token());
    if (read.status === "unavailable") {
      const payload = { exchange_id: exchangeId, reason: read.reason, http_status: read.http_status };
      return [{ kind: "studio.bridge_evidence_unavailable", source: "canonical", payload, dedupeKey: contentKey("studio-bridge-unavailable", runId, payload) }];
    }
    if (read.status === "rejected") {
      const payload = { exchange_id: exchangeId, reason: read.reason, path: read.path, http_status: read.http_status };
      return [{ kind: "studio.bridge_evidence_rejected", source: "canonical", payload, dedupeKey: contentKey("studio-bridge-rejected", runId, payload) }];
    }
    const events: DriverEvent[] = [];
    const grantJson = canonicalJson(read.evidence.grant);
    const grantSha256 = sha256(grantJson);
    const grantKey = `grant:${read.evidence.grant.grantId}:${read.evidence.state}`;
    if (seen.get(grantKey) !== grantSha256) {
      seen.set(grantKey, grantSha256);
      events.push({ kind: "studio.bridge_grant", source: "canonical", payload: { exchange_id: exchangeId, exchange_state: read.evidence.state, grant_json: grantJson, grant_sha256: grantSha256 }, dedupeKey: `studio-bridge-grant:${exchangeId}:${read.evidence.state}:${grantSha256}` });
    }
    for (const entry of read.evidence.receipts) {
      const receiptJson = canonicalJson(entry.receipt);
      const receiptSha256 = sha256(receiptJson);
      const key = `${entry.source}:${entry.seq}:${receiptSha256}`;
      if (entry.kind === "session_closed") onClosed?.(true);
      if (seen.has(key)) continue;
      seen.set(key, receiptSha256);
      events.push({ kind: "studio.bridge_receipt", source: "canonical", payload: { exchange_id: exchangeId, source: entry.source, seq: entry.seq, kind: entry.kind, received_at: entry.receivedAt, receipt_json: receiptJson, receipt_sha256: receiptSha256, _capture_provenance: { source: "studio-member-api", observed_at: entry.receivedAt } }, dedupeKey: `studio-bridge:${exchangeId}:${entry.source}:${entry.seq}:${receiptSha256}:${sha256(entry.receivedAt)}` });
    }
    return events;
  }

  async #senderStats(session: StudioSession): Promise<DriverEvent | null> {
    if (!session.page || session.page.isClosed()) return null;
    const rows = await session.page.evaluate(async () => {
      const studio = (window as any).__sophiaVoiceLabStudio;
      return studio?.senderStats ? studio.senderStats() : [];
    }) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    session.statsSequence += 1;
    const projected = rows.slice(0, 16).map((row) => ({
      track_id_sha256: typeof row.track_id_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.track_id_sha256) ? row.track_id_sha256 : null,
      lab_issued_track: typeof row.track_id_sha256 === "string" && session.issuedTrackHashes.has(row.track_id_sha256),
      packets_sent: typeof row.packets_sent === "number" ? row.packets_sent : null,
      bytes_sent: typeof row.bytes_sent === "number" ? row.bytes_sent : null,
      audio_level: typeof row.audio_level === "number" ? row.audio_level : null,
      total_audio_energy: typeof row.total_audio_energy === "number" ? row.total_audio_energy : null,
    }));
    return { kind: "studio.webrtc.sender_stats", source: "browser", payload: { corroboration_only: true, satisfies_receipt: false, rows: projected }, dedupeKey: `studio-stats:${session.runId}:${session.statsSequence}` };
  }

  async #clickControl(session: StudioSession, name: RegExp, timeoutMs: number): Promise<void> {
    const page = this.#requirePage(session);
    const control = page.getByRole("button", { name }).first();
    await control.waitFor({ state: "visible", timeout: timeoutMs });
    await control.click({ timeout: timeoutMs });
  }

  async #clickIfVisible(session: StudioSession, name: RegExp): Promise<boolean> {
    if (!session.page || session.page.isClosed()) return false;
    const control = session.page.getByRole("button", { name }).first();
    const visible = await control.waitFor({ state: "visible", timeout: this.#timeouts.uiActionMs }).then(() => true, () => false);
    if (!visible) return false;
    return control.click({ timeout: this.#timeouts.uiActionMs }).then(() => true, () => false);
  }

  async #joinRoom(session: StudioSession, attempt: string): Promise<DriverEvent> {
    await this.#clickControl(session, /^Join the room$/, this.#timeouts.controlVisibleMs);
    return { kind: "studio.room.joined", source: "browser", payload: { attempt }, dedupeKey: `studio-room-joined:${session.runId}:${attempt}:${session.push.arrival}` };
  }

  async #ensureMicrophoneOn(session: StudioSession): Promise<DriverEvent> {
    const page = this.#requirePage(session);
    const mic = page.getByRole("button", { name: /^Microphone$/ }).first();
    await mic.waitFor({ state: "visible", timeout: this.#timeouts.controlVisibleMs });
    // The mic-on-arrival preference (`sophia.mic.v1` = on) enables the mic
    // asynchronously after Join; clicking during that window would toggle it
    // off. Give the arrival path a bounded grace period before clicking.
    const initial = await mic.getAttribute("aria-pressed");
    let current = initial;
    const graceDeadline = this.#now() + this.#timeouts.micArrivalGraceMs;
    while (current !== "true" && this.#now() < graceDeadline) {
      await this.#wait(100);
      current = await mic.getAttribute("aria-pressed");
    }
    const toggled = current !== "true";
    if (toggled) await mic.click({ timeout: this.#timeouts.uiActionMs });
    const deadline = this.#now() + this.#timeouts.ariaPressedMs;
    let pressed = current === "true";
    while (!pressed && this.#now() < deadline) {
      await this.#wait(100);
      pressed = await mic.getAttribute("aria-pressed") === "true";
    }
    if (!pressed) throw studioError("STUDIO_MICROPHONE_NOT_ON", "The Studio Microphone toggle did not report aria-pressed=true.", "product", true);
    const micPayload = { aria_pressed_initial: initial === "true" ? "true" : initial === "false" ? "false" : "absent", toggled, push_arrival: session.push.arrival };
    return { kind: "studio.room.microphone_on", source: "browser", payload: micPayload, dedupeKey: contentKey("studio-mic-on", session.runId, micPayload) };
  }

  /**
   * The grant must exist before an exchange opens (a grant never covers an
   * earlier exchange). The only pre-exchange product signal is a grant-bound
   * `mic_published` page receipt, emitted when the room token carries the
   * qualification. Wait for one bound to this run's binding and carrying the
   * Lab-issued track; rejoin periodically to refetch the room token.
   */
  async #awaitGrantGate(session: StudioSession): Promise<{ events: DriverEvent[]; grantId: string }> {
    const events: DriverEvent[] = [];
    const deadline = this.#now() + this.studio.grantWaitMs;
    let nextRejoin = this.#now() + this.studio.grantRejoinIntervalMs;
    let rejoins = 0;
    let checkedArrival = 0;
    while (this.#now() < deadline) {
      this.#noteIssuedTracks(session, await this.#peekHarness(session));
      for (const item of session.accepted.filter((candidate) => candidate.arrival > checkedArrival)) {
        if (item.receipt.runBindingSha256 !== session.runBindingSha256) {
          throw studioError("STUDIO_RECEIPT_BINDING_MISMATCH", "A Studio qualification receipt was bound to a different run binding.", "harness", false, { status: "fail", expected_run_binding_sha256: session.runBindingSha256 });
        }
        if (item.receipt.event !== "mic_published") continue;
        if (!session.issuedTrackHashes.has(sha256(item.receipt.trackId))) {
          this.#noteIssuedTracks(session, await this.#peekHarness(session));
          if (!session.issuedTrackHashes.has(sha256(item.receipt.trackId))) {
            throw studioError("STUDIO_PHYSICAL_MICROPHONE_FALLBACK", "The Studio published a microphone track the Lab did not issue.", "harness", false, { status: "fail" });
          }
        }
        const grantId = item.receipt.grantId.toLowerCase();
        const gate = { run_binding_sha256: session.runBindingSha256, grant_id: grantId, rejoins, lab_issued_track: true };
        events.push({ kind: "studio.grant_gate.passed", source: "browser", payload: gate, dedupeKey: contentKey("studio-grant-gate", session.runId, gate) });
        return { events, grantId };
      }
      checkedArrival = session.push.arrival;
      if (this.#now() >= nextRejoin && this.#now() + 1_000 < deadline) {
        rejoins += 1;
        if (await this.#clickIfVisible(session, /^Leave the room$/)) {
          events.push(await this.#joinRoom(session, `grant_gate_rejoin_${rejoins}`));
          events.push(await this.#ensureMicrophoneOn(session));
        }
        nextRejoin = this.#now() + this.studio.grantRejoinIntervalMs;
      }
      await this.#wait(250);
    }
    throw studioError("STUDIO_QUALIFICATION_GRANT_UNAVAILABLE", "No grant-bound mic_published receipt arrived; the operator grant for this run binding is absent or inactive.", "harness", false, { status: "unavailable", run_binding_sha256: session.runBindingSha256, rejoins });
  }

  /**
   * The exchange this run's Speak opened: the room's live exchange, absent
   * before the click. When the snapshot names a floor holder other than this
   * run's principal the exchange is not joined (End is never requested for
   * it); when it names none, the join is recorded with
   * `input_actor_is_principal: null` (unverified) and ownership rests on the
   * evidence proof alone.
   */
  async #awaitExchange(session: StudioSession, run: RunRecord): Promise<DriverEvent> {
    const deadline = this.#now() + this.#timeouts.exchangeOpenMs;
    while (this.#now() < deadline) {
      const snapshot = await this.#api.snapshot(this.studio.projectId, await this.#tokenSource(session).token());
      if (snapshot.exchangeId !== null) {
        if (snapshot.inputActorId !== null && snapshot.inputActorId !== run.principalId.toLowerCase()) {
          throw studioError("STUDIO_EXCHANGE_NOT_PRINCIPALS", "The live exchange's floor holder is not this run's principal; it was not joined and is never touched.", "harness", false, { status: "fail" });
        }
        const state = this.#state(session.runId);
        state.exchangeId = snapshot.exchangeId;
        state.exchangeOpenedAtMs = this.#now();
        return { kind: "studio.exchange.opened", source: "canonical", payload: {
          exchange_id: snapshot.exchangeId, input_epoch: snapshot.inputEpoch, room_id_sha256: snapshot.roomId === null ? null : labSha256(snapshot.roomId),
          project_id: this.studio.projectId, grant_id: state.grantId, run_binding_sha256: session.runBindingSha256,
          input_actor_is_principal: snapshot.inputActorId === null ? null : true, opened_at_lab_ms: state.exchangeOpenedAtMs,
          verified_by: "member_snapshot", write_ahead: true,
        }, dedupeKey: `studio-exchange-opened:${session.runId}:${snapshot.exchangeId}` };
      }
      await this.#wait(500);
    }
    throw studioError("STUDIO_EXCHANGE_NOT_OPENED", "Speak with Sophia did not open an exchange visible in the member snapshot.", "product", true);
  }

  async #awaitSessionClosed(session: StudioSession): Promise<DriverEvent[]> {
    const events: DriverEvent[] = [];
    const exchangeId = this.#exchanges.get(session.runId)?.exchangeId ?? null;
    if (exchangeId === null) return events;
    const deadline = this.#now() + this.#timeouts.sessionClosedMs;
    while (!session.sessionClosedSeen && this.#now() < deadline) {
      events.push(...await this.#readBridge(session.runId, exchangeId, this.#tokenSource(session), session.bridgeSeen, (closed) => { if (closed) session.sessionClosedSeen = true; }).catch(() => []));
      if (session.sessionClosedSeen) break;
      await this.#wait(1_000);
    }
    return events;
  }

  /**
   * Canonical ownership of the run's joined exchange: its qualification
   * evidence, read as the principal, names this run's binding hash and the
   * grant id of this run's bound page receipts. Anything less is not proof.
   */
  async #proveOwnership(runId: string, tokens: TokenSource): Promise<{ status: OwnershipStatus; reason: string | null; event: DriverEvent }> {
    const record = this.#exchanges.get(runId) ?? null;
    const exchangeId = record?.exchangeId ?? null;
    const emit = (status: OwnershipStatus, reason: string | null, observed: { grant_id: string | null; run_binding_matches: boolean | null; exchange_state: string | null }) => {
      const payload = { exchange_id: exchangeId, status, reason, expected_grant_id: record?.grantId ?? null, ...observed, basis: "evidence_grant_binding_and_page_receipt_grant", join: record?.join ?? "none" };
      return { status, reason, event: { kind: "studio.exchange.ownership", source: "canonical" as const, payload, dedupeKey: contentKey("studio-ownership", runId, payload) } };
    };
    if (exchangeId === null) return emit("unavailable", "no_exchange_join", { grant_id: null, run_binding_matches: null, exchange_state: null });
    if (!record?.runBindingSha256) return emit("unavailable", "run_binding_unknown", { grant_id: null, run_binding_matches: null, exchange_state: null });
    let read;
    try { read = await this.#api.qualificationEvidence(exchangeId, await tokens.token()); }
    catch (error) { return emit("unavailable", error instanceof VoiceLabError ? error.detail.code : "evidence_read_failed", { grant_id: null, run_binding_matches: null, exchange_state: null }); }
    if (read.status === "unavailable") return emit("unavailable", `evidence_${read.reason}`, { grant_id: null, run_binding_matches: null, exchange_state: null });
    if (read.status === "rejected") return emit("unavailable", "evidence_rejected", { grant_id: null, run_binding_matches: null, exchange_state: null });
    const grantId = read.evidence.grant.grantId.toLowerCase();
    const bindingMatches = read.evidence.grant.runBindingSha256 === record.runBindingSha256;
    const observed = { grant_id: grantId, run_binding_matches: bindingMatches, exchange_state: read.evidence.state };
    if (!bindingMatches) return emit("mismatch", "evidence_bound_to_another_run", observed);
    if (record.grantId === null) return emit("unavailable", "page_receipt_grant_unknown", observed);
    if (record.grantId !== grantId) return emit("mismatch", "evidence_bound_to_another_grant", observed);
    return emit("proven", null, observed);
  }

  /**
   * Settle this run's exchange. Requests End only when ownership is proven,
   * and only as the id-bound API End of that exchange (never the room UI's
   * End, which acts on whatever exchange the room shows at click time);
   * otherwise verifies read-only that the run's exchange is not live, or types
   * the state for recovery.
   */
  async #settleExchange(runId: string, tokens: TokenSource): Promise<{ confirmed: boolean; events: DriverEvent[] }> {
    const record = this.#exchanges.get(runId) ?? null;
    const events: DriverEvent[] = [];
    const settle = (confirmed: boolean, status: "confirmed" | "uncertain" | "unavailable", basis: string, extra: Record<string, unknown> = {}) => {
      // What the driver knew when it OBSERVED this (the ledger seq is only
      // when it was drained): the proof counts an end against that.
      const payload = { confirmed, status, basis, exchange_id: record?.exchangeId ?? null, join: record?.join ?? "none", verified_by: "member_snapshot",
        speak_requested_before_observation: record?.speakRequested === true,
        browser_closed_before_observation: record?.browserClosed === true, signed_out_before_observation: record?.globalSignOutConfirmed === true,
        speak_requested_at_lab_ms: record?.speakRequestedAtMs ?? null, observed_at_lab_ms: this.#now(), ...extra };
      events.push({ kind: "studio.cleanup.exchange_ended", source: "canonical", payload, dedupeKey: contentKey("studio-exchange-ended", runId, payload) });
      return { confirmed, events };
    };
    if (record && record.join === "retained" && !record.speakRequested && record.exchangeId === null) {
      // This driver owns the run and never clicked Speak: no exchange can
      // have been opened by it, so no member-API read is needed. (Should Speak
      // be requested later, the proof no longer counts this confirmation.)
      return settle(true, "confirmed", "no_exchange_opened_by_run", { verified_by: "driver_never_requested_exchange", ownership: "not_required" });
    }
    let snapshot = await this.#api.snapshot(this.studio.projectId, await tokens.token());
    if (record && record.speakRequested && record.exchangeId === null) {
      // Speak was requested but no exchange is joined, whether or not start is
      // still running: the requested exchange may still open while the
      // principal can act in the room. Nothing live confirms only once the
      // run's browser is closed and the principal signed out globally; no
      // time window is used (it cannot prove a later open won't happen).
      if (snapshot.exchangeId !== null) return settle(false, "uncertain", "live_exchange_not_joined_to_run", { ownership: "not_required", live_exchange_present: true });
      if (!record.browserClosed || !record.globalSignOutConfirmed) return settle(false, "uncertain", "principal_may_still_open_exchange", { ownership: "not_required" });
      return settle(true, "confirmed", "no_live_exchange_after_principal_left", { ownership: "not_required" });
    }
    const join = record?.exchangeId ?? null;
    if (join === null) {
      // No Speak intent and no join known to this driver. One live exchange
      // per room: if none is live, whatever this run may have opened has ended.
      if (snapshot.exchangeId === null) return settle(true, "confirmed", "no_live_exchange_in_room", { ownership: "not_required" });
      return settle(false, "uncertain", "live_exchange_not_joined_to_run", { ownership: "not_required", live_exchange_present: true });
    }
    if (snapshot.exchangeId !== join) {
      return settle(true, "confirmed", snapshot.exchangeId === null ? "run_exchange_not_live" : "run_exchange_not_live_other_exchange_live", { ownership: "not_required" });
    }
    const proof = await this.#proveOwnership(runId, tokens);
    events.push(proof.event);
    if (proof.status !== "proven") {
      return settle(false, proof.status === "mismatch" ? "uncertain" : "unavailable", "ownership_unproven_not_touched", { ownership: proof.status, reason: proof.reason });
    }
    let usedApi = false;
    const deadline = this.#now() + this.#timeouts.exchangeEndMs;
    while (snapshot.exchangeId === join) {
      if (!usedApi) {
        const ended = await this.#api.endExchange(join, await tokens.token());
        usedApi = true;
        const requested = { basis: "api_end", exchange_id: join, accepted: ended.accepted, http_status: ended.http_status };
        events.push({ kind: "studio.exchange.end_requested", source: "canonical", payload: requested, dedupeKey: contentKey("studio-end-api", runId, requested) });
      }
      if (this.#now() >= deadline) break;
      await this.#wait(500);
      snapshot = await this.#api.snapshot(this.studio.projectId, await tokens.token());
    }
    const confirmed = snapshot.exchangeId !== join;
    return settle(confirmed, confirmed ? "confirmed" : "unavailable", usedApi ? "api_end" : "already_ended", { ownership: "proven" });
  }

  #exchangeEndUnavailable(runId: string, purpose: string, error: unknown): DriverEvent {
    const record = this.#exchanges.get(runId) ?? null;
    const payload = { confirmed: false, status: "unavailable", basis: "member_api_unavailable", purpose, exchange_id: record?.exchangeId ?? null, join: record?.join ?? "none", verified_by: "member_snapshot", error_code: error instanceof VoiceLabError ? error.detail.code : "error" };
    return { kind: "studio.cleanup.exchange_ended", source: "canonical", payload, dedupeKey: contentKey("studio-exchange-ended", runId, payload) };
  }

  async #leaveAndReturn(run: RunRecord, session: StudioSession, operationId: string): Promise<DriverEvent[]> {
    const events: DriverEvent[] = [];
    const leftAt = session.push.arrival;
    await this.#clickControl(session, /^Leave the room$/, this.#timeouts.controlVisibleMs);
    const leftPayload = { basis: "ui_leave", push_arrival_before: leftAt, operation_id: operationId };
    events.push({ kind: "studio.room.left", source: "browser", payload: leftPayload, dedupeKey: contentKey("studio-room-left", run.id, leftPayload) });
    events.push(await this.#joinRoom(session, `return:${operationId}`));
    events.push(await this.#ensureMicrophoneOn(session));
    const deadline = this.#now() + this.#timeouts.controlVisibleMs;
    while (this.#now() < deadline) {
      this.#noteIssuedTracks(session, await this.#peekHarness(session));
      const republished = session.accepted.some((item) => item.arrival > leftAt && item.receipt.event === "mic_published" && item.receipt.runBindingSha256 === session.runBindingSha256 && session.issuedTrackHashes.has(sha256(item.receipt.trackId)));
      if (republished) {
        events.push({ kind: "studio.room.rejoined", source: "browser", payload: { lab_track_republished: true, operation_id: operationId }, dedupeKey: `studio-room-rejoined:${run.id}:${operationId}` });
        return events;
      }
      await this.#wait(250);
    }
    throw studioError("STUDIO_RETURN_UNCONFIRMED", "The returning participant did not republish a Lab-issued microphone track.", "product", true);
  }

  /**
   * The run's own report, resolved ONLY through the product's own links, each
   * read as the principal through the member API: the run's certified create
   * task (the worker hands it over from the create step's /calls
   * certification) whose NativeTask.exchangeId is the run's own exchange, the
   * design task its research handed the page to (research.designTaskId), which
   * names that research task back, and that design's artifact and published
   * version. Any missing, ambiguous or foreign link refuses: a candidate in the
   * time window or by the principal is never a fallback.
   */
  async #resolveOwnReport(run: RunRecord, tokens: TokenSource): Promise<OwnReport> {
    const refuse = (outcome: "unavailable" | "uncertain", reason: string): OwnReport => ({ status: "refused", outcome, reason });
    const createTaskId = this.#ownCreate.get(run.id) ?? null;
    if (createTaskId === null) return refuse("unavailable", "create_step_not_certified");
    const runExchange = this.#exchanges.get(run.id)?.exchangeId?.toLowerCase() ?? null;
    if (runExchange === null) return refuse("unavailable", "no_exchange_joined_to_run");
    const research = await this.#api.nativeTask(this.studio.projectId, createTaskId, await tokens.token());
    if (research.status !== "available") return refuse("unavailable", `own_research_${research.reason}`);
    if (research.value.task.id !== createTaskId || research.value.task.kind !== "research" || research.value.research === null) return refuse("uncertain", "target_not_canonical");
    // The research task's exchange binding must be the run's own exchange.
    if (research.value.task.exchangeId?.toLowerCase() !== runExchange) return refuse("uncertain", "target_not_canonical");
    const designTaskId = research.value.research.designTaskId;
    if (designTaskId === null) return refuse("unavailable", "own_design_pending");
    const design = await this.#api.nativeTask(this.studio.projectId, designTaskId, await tokens.token());
    if (design.status !== "available") return refuse("unavailable", `own_design_${design.reason}`);
    const progress = design.value.design;
    if (design.value.task.id !== designTaskId || design.value.task.kind !== "design" || progress === null) return refuse("uncertain", "target_not_canonical");
    // The design names the run's own research back, and is bound to no other exchange.
    if (progress.researchTaskId !== createTaskId) return refuse("uncertain", "target_not_canonical");
    if (design.value.task.exchangeId !== null && design.value.task.exchangeId.toLowerCase() !== runExchange) return refuse("uncertain", "target_not_canonical");
    if (progress.state !== "published" || progress.artifactId === null || progress.publishedVersionId === null) return refuse("unavailable", "own_design_pending");
    const versions = await this.#api.artifactVersions(progress.artifactId, await tokens.token());
    if (versions.status !== "available") return refuse("unavailable", `artifact_versions_${versions.reason}`);
    if (versions.value.some((version) => version.artifactId !== progress.artifactId)) return refuse("uncertain", "target_not_canonical");
    if (!versions.value.some((version) => version.id === progress.publishedVersionId)) return refuse("uncertain", "own_published_version_not_listed");
    return { status: "found", createTaskId, designTaskId, artifactId: progress.artifactId, publishedVersionId: progress.publishedVersionId, versions: versions.value, sections: progress.sections };
  }

  /**
   * The run's own live work: its own design (create task -> research ->
   * designTaskId -> the design naming that research back) and the Lab's own
   * edits of that design's artifact (same research), each read as the
   * principal; live while designing or reviewing.
   */
  async #ownLiveWork(run: RunRecord, tokens: TokenSource): Promise<{ status: "found"; createTaskId: string; designTaskId: string; liveTaskIds: string[] } | { status: "refused"; reason: string }> {
    const createTaskId = this.#ownCreate.get(run.id) ?? null;
    if (createTaskId === null) return { status: "refused", reason: "create_step_not_certified" };
    const runExchange = this.#exchanges.get(run.id)?.exchangeId?.toLowerCase() ?? null;
    const research = await this.#api.nativeTask(this.studio.projectId, createTaskId, await tokens.token());
    if (research.status !== "available") return { status: "refused", reason: `own_research_${research.reason}` };
    if (research.value.task.kind !== "research" || research.value.research === null || runExchange === null || research.value.task.exchangeId?.toLowerCase() !== runExchange) return { status: "refused", reason: "target_not_canonical" };
    const designTaskId = research.value.research.designTaskId;
    if (designTaskId === null) return { status: "refused", reason: "own_design_pending" };
    const candidates = [designTaskId, ...this.#focusTasks(run.id).filter((id) => id !== designTaskId)];
    let artifactId: string | null = null;
    const liveTaskIds: string[] = [];
    for (const taskId of candidates) {
      const detail = await this.#api.nativeTask(this.studio.projectId, taskId, await tokens.token());
      if (detail.status !== "available" || detail.value.design === null || detail.value.task.kind !== "design") {
        if (taskId === designTaskId) return { status: "refused", reason: detail.status === "available" ? "target_not_canonical" : `own_design_${detail.reason}` };
        continue;
      }
      const design = detail.value.design;
      if (design.researchTaskId !== createTaskId || (detail.value.task.exchangeId !== null && detail.value.task.exchangeId.toLowerCase() !== runExchange)) {
        if (taskId === designTaskId) return { status: "refused", reason: "target_not_canonical" };
        continue;
      }
      if (taskId === designTaskId) artifactId = design.artifactId;
      else if (design.artifactId !== artifactId) continue;
      if (STUDIO_LIVE_DESIGN_STATES.has(design.state) && !["succeeded", "failed", "cancelled"].includes(detail.value.task.state)) liveTaskIds.push(taskId);
    }
    if (liveTaskIds.length === 0) return { status: "refused", reason: "no_own_live_design" };
    return { status: "found", createTaskId, designTaskId, liveTaskIds };
  }

  readonly #ownCreate = new Map<string, string | null>();
  /** Whether per-run own-chain state (the certified create, the Lab's edit tasks) is still held for this run (diagnostics). */
  retainsStudioRunState(runId: string): boolean {
    return this.#ownCreate.has(runId) || this.#focus.has(runId) || this.#ownNote.has(runId);
  }
  /**
   * The run's certified create task (the create step's /calls certification),
   * as the worker last computed it; null while the create step is not
   * certified. The run's report is resolved only from it.
   */
  setStudioOwnCreateTask(runId: string, taskId: string | null): void {
    this.#ownCreate.set(runId, typeof taskId === "string" && UUID.test(taskId) ? taskId.toLowerCase() : null);
  }

  async #htmlEditAction(run: RunRecord, tokens: TokenSource, operationId: string, purpose: "section_revision" | "stale_edit", input: Record<string, unknown>): Promise<{ events: DriverEvent[]; taskId: string | null; receipt: Record<string, unknown> }> {
    const events: DriverEvent[] = [];
    const record = (payload: Record<string, unknown>): Record<string, unknown> => {
      const full: Record<string, unknown> = { purpose, operation_id: operationId, target_join: "canonical_chain", own_create_task_id: this.#ownCreate.get(run.id) ?? null, ...payload };
      events.push({ kind: "studio.action.html_edit", source: "canonical", payload: full, dedupeKey: contentKey("studio-html-edit", run.id, full) });
      return full;
    };
    // A target that cannot be resolved without guessing is typed, the
    // request is not sent, and the step reports `performed: false`.
    const notPerformed = (reason: string, extra: Record<string, unknown> = {}, outcome: "unavailable" | "uncertain" = "unavailable") => {
      record({ status: outcome, reason, requested: false, ...extra });
      return { events, taskId: null, receipt: { performed: false, status: outcome, reason } };
    };
    // Only the run's own report, on its canonical chain, is ever edited. A
    // revision first waits (bounded) for the own design to publish its page:
    // the product admits no edit before (not_started:no_html_page).
    const budget = typeof input._settle_budget_ms === "number" ? input._settle_budget_ms : this.#timeouts.designSettleMs;
    const deadline = this.#now() + Math.min(typeof input.timeout_ms === "number" ? Math.max(input.timeout_ms, 0) : this.#timeouts.designSettleMs, this.#timeouts.designSettleMs, budget);
    let target = await this.#resolveOwnReport(run, tokens);
    while (purpose === "section_revision" && target.status !== "found" && target.reason === "own_design_pending" && this.#now() < deadline) {
      await this.#wait(2_000);
      target = await this.#resolveOwnReport(run, tokens);
    }
    if (target.status !== "found") return notPerformed(target.reason, {}, target.outcome);
    const chain = { design_task_id: target.designTaskId, artifact_id: target.artifactId };
    const withPage = (versionId: string) => target.versions.some((version) => version.id === versionId && version.renditions.some((rendition) => rendition.format === "html"));
    const current = target.versions[0] ?? null;
    const requestedSections = Array.isArray(input.sections) ? (input.sections as unknown[]).filter((value): value is string => typeof value === "string" && SECTION.test(value)) : [];
    const sections = requestedSections.length > 0 ? requestedSections.slice(0, 16) : target.sections.slice(0, 1);
    if (sections.length === 0) return notPerformed("section_unknown", chain);
    // A revision sends the own artifact's CURRENT version (the version id
    // binds the request to that artifact: a later version of the own report,
    // e.g. a PDF rendition that keeps the page, is still the run's own). The
    // stale probe sends an own version a newer one superseded (the newest
    // such): the product checks staleness before anything else, so it is
    // refused 409 stale_revision even while an edit is under way.
    let versionId: string;
    let supersededBy: string | null = null;
    if (purpose === "section_revision") {
      if (current === null || current.artifactId !== target.artifactId) return notPerformed("own_version_not_current", chain, "uncertain");
      if (!withPage(current.id)) return notPerformed("current_version_has_no_designed_page", chain);
      versionId = current.id;
    } else {
      const superseded = current === null ? null : target.versions.find((version) => version.id !== current.id) ?? null;
      if (current === null || superseded === null) return notPerformed("no_superseded_version", chain);
      versionId = superseded.id;
      supersededBy = current.id;
    }
    const instruction = purpose === "stale_edit" ? STALE_EDIT_PROBE_INSTRUCTION : typeof input.instruction === "string" ? input.instruction : "";
    if (instruction.length < 1 || instruction.length > 2_000) throw studioError("STUDIO_ACTION_INVALID", "A section-only revision needs an instruction of 1 to 2000 characters.", "validation");
    // Re-verified immediately before the mutating request: a chain that
    // changed in between (another design, artifact, version or binding) is
    // refused, never followed.
    const again = await this.#resolveOwnReport(run, tokens);
    if (again.status !== "found") return notPerformed("target_changed", { ...chain, recheck_reason: again.reason }, "uncertain");
    if (again.createTaskId !== target.createTaskId || again.designTaskId !== target.designTaskId || again.artifactId !== target.artifactId || again.publishedVersionId !== target.publishedVersionId || (again.versions[0]?.id ?? null) !== (current?.id ?? null)) return notPerformed("target_changed", chain, "uncertain");
    const answer = await this.#api.htmlEdit(this.studio.projectId, { versionId, sections, instruction }, await tokens.token(), `voice-lab-g7:${operationId}`);
    const payload = record({
      status: answer.accepted ? "admitted" : "refused", requested: true, ...chain, version_id: versionId, superseded_by_version_id: supersededBy,
      sections, instruction_sha256: sha256(instruction), http_status: answer.http_status, code: answer.code,
      task_id: answer.receipt?.taskId ?? null, receipt_state: answer.receipt?.state ?? null, receipt_version_id: answer.receipt?.versionId ?? null,
    });
    // The edit (X) is not waited for: the episode withdraws the note while X
    // is still live. Its state at return is read once.
    let finalState: string | null = null;
    if (purpose === "section_revision" && answer.accepted && answer.receipt) {
      const detail = await this.#api.nativeTask(this.studio.projectId, answer.receipt.taskId, await tokens.token());
      finalState = detail.status === "available" ? detail.value.design?.state ?? null : null;
    }
    return { events, taskId: answer.receipt?.taskId ?? null, receipt: { performed: true, status: payload.status, http_status: payload.http_status, code: payload.code, task_id: payload.task_id, design_state_at_return: finalState } };
  }

  /**
   * The run's own note, recorded through the principal's own member route
   * (record_note): the receipt names the entry and the note's source S (the
   * entry's source_id), which a research drawing on the note holds in its
   * manifest's dependency graph and a withdrawal later reaches. The words
   * are the Lab's fixed synthetic note (STUDIO_G7_NOTE_TEXT), never a
   * caller's: a durable operation must be re-executable after a crash, so
   * caller-chosen words would have to be kept in its input. Only the hash of
   * the words is recorded.
   */
  async #recordNoteAction(run: RunRecord, tokens: TokenSource, operationId: string, _input: Record<string, unknown>): Promise<{ events: DriverEvent[]; receipt: Record<string, unknown> }> {
    const text = STUDIO_G7_NOTE_TEXT;
    const answer = await this.#api.recordNote(this.studio.projectId, { kind: "observation", epistemic: "reported", text }, await tokens.token(), `voice-lab-g7:${operationId}`);
    const committed = answer.accepted && answer.receipt !== null && answer.receipt.status === "committed" && answer.receipt.operation === "record_note";
    const payload = {
      operation_id: operationId, requested: true, status: committed ? "committed" : "refused", http_status: answer.http_status, code: answer.code,
      entry_id: answer.receipt?.entryId ?? null, source_id: answer.receipt?.sourceId ?? null, receipt_operation: answer.receipt?.operation ?? null, text_sha256: sha256(text),
    };
    this.#ownNote.set(run.id, committed ? { entryId: answer.receipt!.entryId, sourceId: answer.receipt!.sourceId } : null);
    return { events: [{ kind: "studio.action.record_note", source: "canonical", payload, dedupeKey: contentKey("studio-record-note", run.id, payload) }],
      receipt: { performed: true, status: payload.status, http_status: payload.http_status, code: payload.code, entry_id: payload.entry_id, source_id: payload.source_id } };
  }

  /** The run's own note (from its record_note receipt), as the worker last handed it over or as recorded by this driver. */
  readonly #ownNote = new Map<string, { entryId: string; sourceId: string } | null>();

  /**
   * Forget the run's own note: the one its own record_note request recorded
   * (else, without one, the one current note the principal recorded by voice
   * in the run's ownership-proven exchange). The preview's ids and revisions
   * are sent back with its proof, never its words, and only when the whole
   * cascade is the run's own. The run's own live work (the edit X, resolved
   * on the own chain) is recorded, never guessed: an edit that is no longer
   * live leaves the design's end unproven, never a pass (evaluate.ts).
   */
  async #withdrawalAction(run: RunRecord, tokens: TokenSource, operationId: string, input: Record<string, unknown>): Promise<{ events: DriverEvent[]; receipt: Record<string, unknown> }> {
    const events: DriverEvent[] = [];
    const recordEvent = (payload: Record<string, unknown>): Record<string, unknown> => {
      const full: Record<string, unknown> = { operation_id: operationId, ...payload };
      events.push({ kind: "studio.action.withdrawal", source: "canonical", payload: full, dedupeKey: contentKey("studio-withdrawal", run.id, full) });
      return full;
    };
    const notPerformed = (reason: string, extra: Record<string, unknown> = {}) => {
      recordEvent({ status: "unavailable", reason, requested: false, ...extra });
      return { events, receipt: { performed: false, status: "unavailable", reason } };
    };
    const proof = await this.#proveOwnership(run.id, tokens);
    events.push(proof.event);
    const exchangeId = this.#exchanges.get(run.id)?.exchangeId ?? null;
    if (proof.status !== "proven" || exchangeId === null) return notPerformed("exchange_ownership_unproven", { ownership: proof.status, ownership_reason: proof.reason });
    const live = await this.#ownLiveWork(run, tokens);
    const chain = live.status === "found"
      ? { own_create_task_id: live.createTaskId, design_task_id: live.designTaskId, own_live_task_ids: live.liveTaskIds }
      : { own_create_task_id: this.#ownCreate.get(run.id) ?? null, design_task_id: null, own_live_task_ids: [], own_live_reason: live.reason };
    const mission = await this.#api.mission(this.studio.projectId, await tokens.token());
    if (mission.status !== "available") return notPerformed(`mission_${mission.reason}`, chain);
    const entries = mission.value.entries;
    const principal = run.principalId.toLowerCase();
    const ownNote = this.#ownNote.get(run.id) ?? null;
    // The run's own notes: the one its own request recorded, and the
    // principal's notes bound to its exchange (voice). A named one may be any
    // version not yet withdrawn (forgetting it forgets its whole chain).
    const ownNotes = entries.filter((entry) => entry.state !== "withdrawn" && entry.actorId === principal && (entry.id === ownNote?.entryId || entry.exchangeId === exchangeId));
    const bound = ownNotes.filter((entry) => entry.state === "current");
    const requested = typeof input.entry_id === "string" ? input.entry_id.toLowerCase() : null;
    const target = requested !== null ? ownNotes.find((entry) => entry.id === requested) ?? null
      : ownNote !== null ? ownNotes.find((entry) => entry.id === ownNote.entryId) ?? null
      : bound.length === 1 ? bound[0]! : null;
    if (!target) return notPerformed(requested !== null ? "entry_not_own_note" : ownNote !== null ? "own_note_not_found" : bound.length === 0 ? "no_note_bound_to_run_exchange" : "note_target_ambiguous", { ...chain, bound_note_count: bound.length });
    const preview = await this.#api.withdrawalPreview(this.studio.projectId, target.id, await tokens.token());
    if (preview.status !== "available" || preview.value.entryId !== target.id) return notPerformed(preview.status === "available" ? "preview_entry_mismatch" : `preview_${preview.reason}`, { ...chain, entry_id: target.id });
    // The preview's whole cascade (product mission_forget_reach: every
    // version of the note, and every decision resting on one of them) is
    // confirmed by the request. So every previewed entry must be the run's
    // own note, and every previewed decision the run's own: proposed by the
    // principal by voice, decided by nobody else, resting only on the run's
    // own notes. Another member's correction or decision is never withdrawn.
    const ownEntryIds = new Set(entries.filter((entry) => entry.actorId === principal && (entry.id === ownNote?.entryId || entry.exchangeId === exchangeId)).map((entry) => entry.id));
    const ownDecisionIds = new Set(mission.value.decisions.filter((decision) => decision.proposedBy === principal && decision.proposedVia === "voice"
      && (decision.decidedBy === null || decision.decidedBy === principal)
      && decision.supportingEntryIds.length > 0 && decision.supportingEntryIds.every((id) => ownEntryIds.has(id))).map((decision) => decision.id));
    const foreignEntries = preview.value.entryIds.filter((id) => !ownEntryIds.has(id)).length;
    const foreignDecisions = preview.value.decisions.filter((decision) => !ownDecisionIds.has(decision.id)).length;
    if (foreignEntries > 0 || foreignDecisions > 0) return notPerformed("withdrawal_cascade_not_own", { ...chain, entry_id: target.id, foreign_entry_count: foreignEntries, foreign_decision_count: foreignDecisions, preview_entry_count: preview.value.entryIds.length, preview_decision_count: preview.value.decisions.length });
    const answer = await this.#api.withdraw(this.studio.projectId, preview.value, await tokens.token(), `voice-lab-g7:${operationId}`);
    const payload = recordEvent({
      status: answer.accepted ? "committed" : "refused", requested: true, ...chain, entry_id: target.id, entry_bound_exchange_id: target.exchangeId,
      own_note_entry_id: ownNote?.entryId ?? null, own_note_source_id: ownNote?.sourceId ?? null, entry_source_id: target.sourceId,
      preview_entry_count: preview.value.entryIds.length, preview_decision_count: preview.value.decisions.length,
      http_status: answer.http_status, code: answer.code, receipt_status: answer.receipt?.status ?? null, receipt_operation: answer.receipt?.operation ?? null,
      // The forgotten note's source as the withdraw_note receipt names it.
      receipt_source_id: answer.receipt?.sourceId ?? null, affected_count: answer.receipt?.affectedCount ?? null,
    });
    return { events, receipt: { performed: true, status: payload.status, entry_id: target.id, http_status: payload.http_status, code: payload.code } };
  }

  #focusTasks(runId: string): string[] {
    return this.#focus.get(runId) ?? [];
  }

  readonly #focus = new Map<string, string[]>();

  async #observeTasks(run: RunRecord, tokens: TokenSource, focus: string[]): Promise<{ snapshot: StudioRoomSnapshot; details: ProjectedTaskDetail[]; windowStartMs: number; unavailable: Array<{ task_id: string; reason: string }> }> {
    const snapshot = await this.#api.snapshot(this.studio.projectId, await tokens.token());
    const record = this.#exchanges.get(run.id) ?? null;
    const windowStartMs = (record?.exchangeOpenedAtMs ?? run.createdAt.getTime()) - OUTCOME_WINDOW_TOLERANCE_MS;
    const principal = run.principalId.toLowerCase();
    // Discovery only (which tasks to read): the tasks the run's exchange
    // created (A15 NativeTask.exchangeId), then the principal's recent ones.
    // Attribution to a step never uses this window (evaluate.ts).
    const runExchange = record?.exchangeId ?? null;
    const bound = runExchange === null ? [] : snapshot.work.filter((task) => task.exchangeId === runExchange).map((task) => task.id);
    const inWindow = snapshot.work
      .filter((task) => task.actorId === principal && task.createdAt !== null && Date.parse(task.createdAt) >= windowStartMs)
      .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
      .map((task) => task.id);
    // The run's own create task is read first, whatever the window holds.
    const ownCreate = this.#ownCreate.get(run.id) ?? null;
    const ids = [...new Set([...(ownCreate === null ? [] : [ownCreate]), ...focus, ...bound, ...inWindow])].slice(0, MAX_OBSERVED_TASKS);
    const details: ProjectedTaskDetail[] = [];
    const unavailable: Array<{ task_id: string; reason: string }> = [];
    for (const id of ids) {
      const detail = await this.#api.nativeTask(this.studio.projectId, id, await tokens.token());
      if (detail.status === "available") details.push(detail.value);
      else unavailable.push({ task_id: id, reason: detail.reason });
    }
    // Design tasks a research task handed its HTML to are part of the outcome.
    for (const [index, designId] of details.map((detail) => detail.research?.designTaskId ?? null).entries()) {
      if (designId === null) continue;
      // The own research's design is always read (it is the run's report); others within the bound.
      const own = details[index]!.task.id === ownCreate;
      if ((!own && details.length >= MAX_OBSERVED_TASKS) || details.some((detail) => detail.task.id === designId)) continue;
      const detail = await this.#api.nativeTask(this.studio.projectId, designId, await tokens.token());
      if (detail.status === "available") details.push(detail.value);
    }
    return { snapshot, details, windowStartMs, unavailable };
  }

  /**
   * Canonical outcome read through the member API as the principal: native
   * tasks (ids, kinds, states, phases), their designs, the published
   * version's HTML rendition and the SHA-256 of its downloaded bytes, compared
   * with the source's and the rendition's declared digests.
   */
  async #observeOutcome(run: RunRecord, tokens: TokenSource, purpose: string, focus: string[], operationId: string): Promise<{ event: DriverEvent }> {
    if (focus.length > 0) this.#focus.set(run.id, [...new Set([...(this.#focus.get(run.id) ?? []), ...focus])].slice(0, MAX_OBSERVED_TASKS));
    const observed = await this.#observeTasks(run, tokens, this.#focusTasks(run.id));
    const runExchange = this.#exchanges.get(run.id)?.exchangeId ?? null;
    // Only the run's own report is verified, on its canonical chain (as an
    // edit resolves it): the own design's published version first, then the
    // Lab's own edits of that artifact. Another design's bytes, in the window
    // or by the principal, are never downloaded or judged.
    const ownReport = this.#ownReportOf(run.id, observed.details, runExchange);
    const artifacts: Array<Record<string, unknown>> = [];
    const verified = new Set<string>();
    for (const target of ownReport.status === "resolved" ? ownReport.versions : []) {
      if (verified.has(target.versionId) || verified.size >= MAX_VERIFIED_ARTIFACTS) continue;
      verified.add(target.versionId);
      artifacts.push(await this.#verifyArtifact(tokens, target.artifactId, target.versionId, target.taskId));
    }
    const exchangeOf = (detail: ProjectedTaskDetail) => detail.task.exchangeId;
    const payload = {
      purpose, operation_id: operationId,
      // A task is the run's only through the exchange id the service
      // recorded for the voice tool call that created it (A15); the window
      // only chose which tasks to read.
      join: {
        basis: "native_task_exchange_id", run_exchange_id: runExchange,
        bound_task_ids: runExchange === null ? [] : observed.details.filter((detail) => exchangeOf(detail) === runExchange).map((detail) => detail.task.id),
        other_exchange_task_count: observed.details.filter((detail) => exchangeOf(detail) !== null && exchangeOf(detail) !== runExchange).length,
        unbound_task_count: observed.details.filter((detail) => exchangeOf(detail) === null).length,
        discovery_window_start: new Date(observed.windowStartMs).toISOString(), principal_actor_only: true,
      },
      focus_task_ids: this.#focusTasks(run.id),
      live_exchange_present: observed.snapshot.exchangeId !== null,
      tasks: observed.details.map((detail) => ({
        task_id: detail.task.id, kind: detail.task.kind, state: detail.task.state, phase: detail.task.phase, created_at: detail.task.createdAt, exchange_id: detail.task.exchangeId, goal_id: detail.task.goalId,
        // Ids and enumerated classes only: the sources of its consumed closure now withdrawn (R2), and why it ended.
        withdrawn_source_ids: detail.withdrawnSourceIds, reason_class: detail.reasonClass, input_source_ids: detail.task.inputSourceIds,
        focus: this.#focusTasks(run.id).includes(detail.task.id),
        research: detail.research ? { html_state: detail.research.htmlState, design_task_id: detail.research.designTaskId, amends_task_id: detail.research.amendsTaskId } : null,
        design: detail.design ? { state: detail.design.state, mode: detail.design.mode, artifact_id: detail.design.artifactId, base_version_id: detail.design.baseVersionId, published_version_id: detail.design.publishedVersionId, research_task_id: detail.design.researchTaskId, revisions: detail.design.revisions, section_count: detail.design.sections.length, reason_class: detail.designReasonClass } : null,
        outputs: detail.outputs.map((output) => ({ artifact_version_id: output.artifactVersionId, format: output.format, source_id: output.sourceId, sha256: output.sha256, byte_length: output.byteLength })),
      })),
      tasks_unavailable: observed.unavailable,
      own_report: ownReport.status === "resolved"
        ? { status: "resolved", reason: null, create_task_id: ownReport.createTaskId, design_task_id: ownReport.designTaskId, artifact_id: ownReport.artifactId }
        : { status: ownReport.status, reason: ownReport.reason, create_task_id: this.#ownCreate.get(run.id) ?? null, design_task_id: null, artifact_id: null },
      artifacts,
    };
    return { event: { kind: "studio.outcome.observed", source: "canonical", payload, dedupeKey: contentKey("studio-outcome", run.id, payload) } };
  }

  /**
   * The run's own report from one observation's member reads (the same chain
   * #resolveOwnReport follows): the own research bound to the run's exchange,
   * its one design naming it back, and that design's published version, then
   * the Lab's own edit tasks of the same artifact and research.
   */
  #ownReportOf(runId: string, details: ProjectedTaskDetail[], runExchange: string | null): { status: "resolved"; createTaskId: string; designTaskId: string; artifactId: string; versions: Array<{ taskId: string; artifactId: string; versionId: string }> } | { status: "unavailable" | "uncertain"; reason: string } {
    const createTaskId = this.#ownCreate.get(runId) ?? null;
    if (createTaskId === null) return { status: "unavailable", reason: "create_step_not_certified" };
    if (runExchange === null) return { status: "unavailable", reason: "no_exchange_joined_to_run" };
    const research = details.find((detail) => detail.task.id === createTaskId) ?? null;
    if (research === null) return { status: "unavailable", reason: "own_research_not_observed" };
    if (research.task.kind !== "research" || research.research === null || research.task.exchangeId?.toLowerCase() !== runExchange.toLowerCase()) return { status: "uncertain", reason: "target_not_canonical" };
    const designTaskId = research.research.designTaskId;
    if (designTaskId === null) return { status: "unavailable", reason: "own_design_pending" };
    const design = details.find((detail) => detail.task.id === designTaskId) ?? null;
    if (design === null || design.design === null) return { status: "unavailable", reason: "own_design_not_observed" };
    if (design.task.kind !== "design" || design.design.researchTaskId !== createTaskId || (design.task.exchangeId !== null && design.task.exchangeId.toLowerCase() !== runExchange.toLowerCase())) return { status: "uncertain", reason: "target_not_canonical" };
    // A version the own design published stays the run's own (a later withdrawal may cancel the design).
    const artifactId = design.design.artifactId;
    if (artifactId === null || design.design.publishedVersionId === null) return { status: "unavailable", reason: "own_design_pending" };
    const versions = [{ taskId: designTaskId, artifactId, versionId: design.design.publishedVersionId }];
    for (const editTaskId of this.#focusTasks(runId)) {
      const edit = details.find((detail) => detail.task.id === editTaskId)?.design ?? null;
      if (edit === null || edit.researchTaskId !== createTaskId || edit.artifactId !== artifactId || edit.publishedVersionId === null) continue;
      versions.push({ taskId: editTaskId, artifactId, versionId: edit.publishedVersionId });
    }
    return { status: "resolved", createTaskId, designTaskId, artifactId, versions };
  }

  async #verifyArtifact(tokens: TokenSource, artifactId: string, versionId: string, taskId: string): Promise<Record<string, unknown>> {
    const base = { artifact_id: artifactId, version_id: versionId, task_id: taskId };
    const versions = await this.#api.artifactVersions(artifactId, await tokens.token());
    if (versions.status !== "available") return { ...base, status: "unavailable", reason: `versions_${versions.reason}` };
    const version = versions.value.find((candidate) => candidate.id === versionId);
    if (!version) return { ...base, status: "unavailable", reason: "published_version_not_listed" };
    const rendition = version.renditions.find((candidate) => candidate.format === "html") ?? null;
    const sourceId = rendition?.sourceId ?? (version.format === "html" ? version.sourceId : null);
    const facts = { ...base, version_state: version.state, version_format: version.format, is_latest: versions.value[0]?.id === version.id, source_id: sourceId, rendition_sha256: rendition?.sha256 ?? null, source_hash: version.sourceHash };
    if (sourceId === null) return { ...facts, status: "unavailable", reason: "no_html_rendition" };
    const content = await this.#api.sourceContent(sourceId, await tokens.token());
    if (content.status !== "available") return { ...facts, status: "unavailable", reason: `content_${content.reason}` };
    let downloaded: { sha256: string; byteLength: number; basis: string } | null = null;
    let reason: string | null = null;
    if (content.value.downloadUrl !== null) {
      const result = await this.#api.downloadSha256(content.value.downloadUrl);
      if (result.status === "downloaded") downloaded = { sha256: result.sha256, byteLength: result.byteLength, basis: "signed_object_store_url" };
      else reason = result.reason;
    } else if (content.value.inlineText !== null) {
      const bytes = Buffer.from(content.value.inlineText, "utf8");
      downloaded = { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, basis: "member_api_inline_text" };
    } else reason = "no_download_url_or_inline_bytes";
    const contentSha = content.value.sha256;
    if (!downloaded) return { ...facts, content_sha256: contentSha, status: "unavailable", reason };
    const sourceHashApplies = version.sourceId === sourceId && version.sourceHash !== null;
    const agrees = downloaded.sha256 === contentSha && (rendition === null || rendition.sha256 === downloaded.sha256) && (!sourceHashApplies || version.sourceHash === downloaded.sha256) && downloaded.byteLength === content.value.byteLength;
    return { ...facts, content_sha256: contentSha, downloaded_sha256: downloaded.sha256, downloaded_byte_length: downloaded.byteLength, download_basis: downloaded.basis, source_hash_compared: sourceHashApplies, hashes_agree: agrees, status: agrees ? "verified" : "mismatch", reason: agrees ? null : "downloaded_bytes_disagree_with_declared_digest" };
  }

  #outcomeUnavailable(runId: string, purpose: string, error: unknown): DriverEvent {
    const payload = { purpose, status: "unavailable", reason: error instanceof VoiceLabError ? error.detail.code : "outcome_read_failed" };
    return { kind: "studio.outcome.unavailable", source: "canonical", payload, dedupeKey: contentKey("studio-outcome-unavailable", runId, payload) };
  }

  /**
   * Global sign-out. If the held token is no longer accepted, a fresh grant
   * is used so global scope still revokes every session of the principal.
   */
  async #signOut(runId: string, tokens: TokenSource): Promise<DriverEvent> {
    const target = { supabaseUrl: this.studio.supabaseUrl, publishableKey: this.studio.supabasePublishableKey };
    const known = this.#exchanges.get(runId);
    if (tokens.held() === null && known !== undefined && known.join === "retained" && !known.authIssued) {
      // The password grant never gave this run a session it accepted, and
      // attempting a fresh grant would create one.
      const refused = await this.#revokeRefusedSessions(runId, false);
      if (refused !== null) return this.#refusedSignOut(runId, refused);
      // Nor did it issue any: there is no session to revoke.
      const none = { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: null, basis: "no_session_issued", session_basis: "none", credentials_excluded: true };
      // Content-addressed: a repeated "no session was ever issued" is one fact.
      return { kind: "studio.cleanup.signed_out", source: "canonical", payload: none, dedupeKey: contentKey("studio-signed-out", runId, none) };
    }
    let receipt: SignOutReceipt | null = null;
    let tokenBasis = "held_session";
    try {
      const held = tokens.held();
      if (held) receipt = await globalSignOut(target, held.accessToken, { fetchImpl: this.#fetch });
      if (!receipt?.confirmed) {
        tokenBasis = "fresh_grant";
        tokens.forget();
        receipt = await globalSignOut(target, await tokens.token(), { fetchImpl: this.#fetch });
      }
    } catch (error) {
      receipt = { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: false, http_status: null, basis: "unreachable" };
      tokenBasis = error instanceof VoiceLabError ? error.detail.code : "sign_out_failed";
    }
    tokens.forget();
    // Sessions issued and refused for this run (this sign-out's own fresh
    // grant included) owe their own logout: while one stays unrevoked the
    // run is not signed out.
    const refused = await this.#revokeRefusedSessions(runId, receipt.confirmed && receipt.scope === "global");
    if (refused !== null && refused.unrevoked > 0 && receipt.confirmed) receipt = { ...receipt, confirmed: false, basis: "issued_session_unrevoked" as SignOutReceipt["basis"] };
    const record = this.#exchanges.get(runId);
    if (record && receipt.confirmed && receipt.scope === "global") record.globalSignOutConfirmed = true;
    // Each sign-out is its own durable event (a later identical-looking
    // sign-out must never dedupe into an earlier one: the dead-owner release
    // needs the sign-out that happened after the lease expired).
    const signedOut = { ...receipt, ...(refused === null ? {} : refusedSessionsFields(refused)), session_basis: tokenBasis, credentials_excluded: true, sign_out_id: randomUUID() };
    return { kind: "studio.cleanup.signed_out", source: "canonical", payload: signedOut, dedupeKey: contentKey("studio-signed-out", runId, signedOut) };
  }

  /**
   * The sign-out of a run that was issued sessions but accepted none: it is
   * signed out once each was revoked, and stays unconfirmed (pending) while
   * one is not. Never `no_session_issued`.
   */
  #refusedSignOut(runId: string, refused: RefusedSessionsOutcome): DriverEvent {
    const revoked = refused.unrevoked === 0;
    const payload = { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: revoked, http_status: refused.httpStatus, basis: revoked ? "issued_sessions_revoked" : "issued_session_unrevoked", session_basis: "refused_grant", ...refusedSessionsFields(refused), credentials_excluded: true, sign_out_id: randomUUID() };
    return { kind: "studio.cleanup.signed_out", source: "canonical", payload, dedupeKey: contentKey("studio-signed-out", runId, payload) };
  }

  async #closeBrowser(runId: string, session: StudioSession, reason: string): Promise<DriverEvent> {
    // The run's session ends here: no later action or outcome read uses its
    // own-chain root or its edit tasks.
    this.#ownCreate.delete(runId);
    this.#focus.delete(runId);
    this.#ownNote.delete(runId);
    const ownership = session.ownership;
    // A context cannot outlive its browser process. When the process already
    // exited (crash, OOM kill) the close proof is the reaped process itself.
    const processAlive = disposableBrowserProcessIsActive(ownership);
    const closed = session.context && processAlive ? await closeContextWithProof(session.context, () => ownership.browser.contexts()) : { closed: true, errorClass: null };
    const processClosed = closed.closed ? await closeDisposableBrowserProcess(ownership) : { closed: false, errorClass: closed.errorClass };
    if (closed.closed && processClosed.closed) {
      this.#sessions.delete(runId);
      // Learned only into an existing record (#state would invent a retained one).
      const record = this.#exchanges.get(runId);
      if (record) record.browserClosed = true;
      return { kind: "cleanup.browser_context_closed", source: "browser", payload: {
        schema: "sophia_voice_lab_execution_epoch_browser_cleanup_v1",
        voice_lab_run_id_sha256: labSha256(runId),
        cleanup_obligation_id_sha256: labSha256(session.cleanupObligationId),
        reason,
        close_resolved: true,
        browser_registry_absent: true,
        browser_process_close_resolved: true,
        browser_process_disconnected: true,
        process_id_sha256: ownership.processIdSha256,
        browser_boot_id_sha256: ownership.bootIdSha256,
        execution_epoch_sha256: ownership.executionEpochSha256,
        raw_process_id_excluded: true,
        process_exited_before_close: !processAlive,
      }, dedupeKey: `cleanup:${runId}:browser` };
    }
    return { kind: "cleanup.browser_context_close_failed", source: "browser", payload: { reason, close_resolved: closed.closed, browser_registry_absent: false, browser_process_close_resolved: processClosed.closed, execution_epoch_sha256: ownership.executionEpochSha256, error_class: closed.errorClass ?? processClosed.errorClass }, dedupeKey: `cleanup:${runId}:browser-close-failed` };
  }

  /** Cleanup with no browser at all: settle the exchange via the API (ownership-gated), then sign out. */
  async #apiOnlyCleanup(runId: string, purpose: string): Promise<DriverEvent[]> {
    const events: DriverEvent[] = [...(this.#orphanEvents.get(runId) ?? [])];
    this.#orphanEvents.delete(runId);
    const tokens = this.#tokenSource(null, runId);
    const settled = await this.#settleExchange(runId, tokens).catch((error: unknown) => ({ confirmed: false, events: [this.#exchangeEndUnavailable(runId, purpose, error)] }));
    events.push(...settled.events);
    // The joined exchange's late receipts are read with the same session.
    const exchangeId = this.#exchanges.get(runId)?.exchangeId ?? null;
    if (exchangeId !== null && tokens.held() !== null) events.push(...await this.#readBridge(runId, exchangeId, tokens, new Map()).catch(() => []));
    // A recovery (possibly of a dead owner's orphan browser) also reads the
    // room as the bridge last saw it, with the session it already holds and
    // before the sign-out ends it. It never signs in for this alone (a run
    // that never allocated a browser stays network-free).
    if (purpose === "recover" && tokens.held() !== null) events.push(await this.#readRoomPresence(runId, tokens, purpose));
    // A fenced recovery logs the principal out globally only while it still
    // holds its sign-out marker; otherwise only its own session goes. A gate
    // that cannot be read is never "not held" nor "held": nothing global is
    // sent, and the recovery stays incomplete, to be retried.
    const gate = this.#signOutGates.get(runId);
    const fence = gate === undefined ? "held" : await gate().then((value) => value ? "held" : "not_held", () => "unreadable");
    events.push(fence === "held" ? await this.#signOut(runId, tokens) : await this.#localSignOutOnly(runId, tokens, fence === "not_held" ? "sign_out_fence_not_held" : "sign_out_fence_unreadable"));
    const known = this.#exchanges.get(runId);
    if (known !== undefined && known.join === "retained" && !known.browserLaunched) {
      // Start failed before Chromium launched (e.g. deployment mismatch):
      // this driver instance owned the run and never allocated a browser.
      const absent = { browser_never_allocated: true, basis: "driver_failed_before_browser_launch", authoritative_ledger_read: false };
      events.push({ kind: "cleanup.browser_context_absent", source: "browser", payload: absent, dedupeKey: contentKey("cleanup-browser-absent", runId, absent) });
    }
    if (settled.confirmed) this.#clearWatchdog(runId);
    return events;
  }

  /**
   * One read of the room as the media bridge last saw it (A15 live
   * presence), as the principal: whether the principal is in it, and counts;
   * nobody's identity. classifyRoomPresence says what it proves: only a
   * fresh, observed report is evidence (present or absent); anything else is
   * typed unobservable with its reason.
   */
  async #readRoomPresence(runId: string, tokens: TokenSource, purpose: string): Promise<DriverEvent> {
    const emit = (status: "present" | "absent" | "unobservable", reason: string | null, httpStatus: number | null, report: Record<string, unknown> = {}): DriverEvent => {
      const payload = { schema: STUDIO_ROOM_PRESENCE_SCHEMA, purpose, status, reason, http_status: httpStatus, observation_id: randomUUID(), observed_at_lab_ms: this.#now(), identities_excluded: true, ...report };
      return { kind: STUDIO_ROOM_PRESENCE_KIND, source: "canonical", payload, dedupeKey: contentKey("studio-room-presence", runId, payload) };
    };
    let roomId: string | null;
    try { roomId = (await this.#api.snapshot(this.studio.projectId, await tokens.token())).roomId; }
    catch (error) { return emit("unobservable", "snapshot_unavailable", null, { error_code: error instanceof VoiceLabError ? error.detail.code : null }); }
    if (roomId === null || !UUID.test(roomId)) return emit("unobservable", "room_id_unavailable", null);
    let read;
    try { read = await this.#api.livePresence(roomId, await tokens.token()); }
    catch { return emit("unobservable", "presence_read_failed", null); }
    const observation = classifyRoomPresence(read, roomId);
    return emit(observation.status, observation.reason, read.http_status, read.status === "available" ? {
      observed: read.value.observed, fresh: read.value.fresh, self_present: read.value.selfPresent, participants: read.value.participants, guests: read.value.guests,
      voice: read.value.voice, live_exchange_id: read.value.exchangeId, reported_at: read.value.reportedAt,
    } : {});
  }

  readonly #signOutGates = new Map<string, () => Promise<boolean>>();
  setStudioSignOutGate(runId: string, gate: (() => Promise<boolean>) | null): void {
    if (gate === null) this.#signOutGates.delete(runId);
    else this.#signOutGates.set(runId, gate);
  }

  /** Revoke only the session this recovery holds (scope=local); never the principal's others. */
  async #localSignOutOnly(runId: string, tokens: TokenSource, basis: string): Promise<DriverEvent> {
    const held = tokens.held();
    let receipt: SignOutReceipt | null = null;
    if (held) {
      receipt = await signOut({ supabaseUrl: this.studio.supabaseUrl, publishableKey: this.studio.supabasePublishableKey }, held.accessToken, "local", { fetchImpl: this.#fetch })
        .catch(() => ({ schema: "sophia_voice_lab_studio_sign_out_v1", scope: "local", confirmed: false, http_status: null, basis: "unreachable" }) as SignOutReceipt);
    }
    tokens.forget();
    // confirmed: only a revoke the server confirmed (no session held is no revoke). A local
    // sign-out never counts as the principal signed out (only a global one does).
    const payload = { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "local", confirmed: receipt?.confirmed === true, http_status: receipt?.http_status ?? null, basis, session_basis: held ? "held_session" : "none", global_sign_out_withheld: true, credentials_excluded: true, sign_out_id: randomUUID() };
    return { kind: "studio.cleanup.signed_out", source: "canonical", payload, dedupeKey: contentKey("studio-signed-out", runId, payload) };
  }

  async readStudioCalls(run: RunRecord, purpose: "baseline" | "after", operationId: string, stepId: string | null, after: string | null = null): Promise<DriverEvent> {
    // Read only with the run's own browser session: never a sign-in without
    // one. With one, the read uses the session's token source, which renews
    // the session (a password grant) within 60 s of its expiry; the renewed
    // session replaces the run's own, so End's global sign-out revokes it.
    const session = this.#sessions.get(run.id) ?? null;
    if (session === null) return this.#callsReadRefused(run.id, purpose, operationId, stepId, after, "no_browser_session");
    return this.#readCalls(run.id, this.#tokenSource(session), purpose, operationId, stepId, after);
  }

  #callsReadRefused(runId: string, purpose: "baseline" | "after", operationId: string, stepId: string | null, after: string | null, reason: string): DriverEvent {
    const payload = { schema: STUDIO_CALLS_READ_SCHEMA, purpose, operation_id: operationId, step_id: stepId, exchange_id: this.#exchanges.get(runId)?.exchangeId ?? null, after, read_id: randomUUID(), observed_at_lab_ms: this.#now(), status: "unavailable", reason, http_status: null, read_at: null, settled: false, attempts: 0, max_seq: null, calls: [] };
    return { kind: STUDIO_CALLS_READ_KIND, source: "canonical", payload, dedupeKey: purpose === "baseline" ? `studio-calls-baseline:${runId}:${operationId}` : contentKey("studio-calls-read", runId, payload) };
  }

  /**
   * Read the principal's own voice calls in the run's joined exchange (A15
   * getExchangeCalls) and record them: seq, tool, the command each admitted
   * (id, kind, goal, authority epoch, state) and the task it created. Ids,
   * kinds, numbers and times only. A refusal is typed by the product's
   * convention: 422 not_found (not the principal's exchange) or 404 (the
   * route is absent: voice qualification off); neither is ever a baseline.
   */
  async #readCalls(runId: string, tokens: TokenSource, purpose: "baseline" | "after", operationId: string, stepId: string | null, after: string | null): Promise<DriverEvent> {
    const exchangeId = this.#exchanges.get(runId)?.exchangeId ?? null;
    const emit = (body: Record<string, unknown>): DriverEvent => {
      const payload = { schema: STUDIO_CALLS_READ_SCHEMA, purpose, operation_id: operationId, step_id: stepId, exchange_id: exchangeId, after, read_id: randomUUID(), observed_at_lab_ms: this.#now(), ...body };
      return { kind: STUDIO_CALLS_READ_KIND, source: "canonical", payload, dedupeKey: purpose === "baseline" ? `studio-calls-baseline:${runId}:${operationId}` : contentKey("studio-calls-read", runId, payload) };
    };
    const refused = (reason: string, httpStatus: number | null) => emit({ status: "unavailable", reason, http_status: httpStatus, read_at: null, settled: false, attempts: 0, max_seq: null, calls: [] });
    if (exchangeId === null) return refused("no_exchange_join", null);
    let attempts = 0;
    for (;;) {
      attempts += 1;
      let read;
      try { read = await this.#api.exchangeCalls(exchangeId, await tokens.token(), after); }
      catch (error) { return refused(error instanceof VoiceLabError ? error.detail.code : "calls_read_failed", null); }
      if (read.status !== "available") return refused(read.reason, read.http_status);
      if (read.value.calls.length > MAX_RECORDED_CALLS) return refused("calls_over_bound", read.http_status);
      // Whatever an unanswered call admits may not have committed yet: re-read until every listed call is answered.
      const settled = read.value.calls.every((call) => call.answeredAt !== null);
      if (settled || attempts >= STUDIO_CALLS_SETTLE_ATTEMPTS) {
        const calls = read.value.calls.map((call) => ({
          seq: call.seq, recorded_at: call.recordedAt, input_epoch: call.inputEpoch, tool: call.tool, task_id: call.taskId, answered_at: call.answeredAt, outcome: call.outcome,
          command: call.command === null ? null : { command_id: call.command.commandId, kind: call.command.kind, goal_id: call.command.goalId, authority_epoch: call.command.authorityEpoch, goal_revision: call.command.goalRevision, state: call.command.state, created_at: call.command.createdAt },
        }));
        return emit({ status: "available", reason: null, http_status: read.http_status, read_at: read.value.readAt, settled, attempts, max_seq: calls.at(-1)?.seq ?? 0, calls });
      }
      await this.#wait(this.#timeouts.callsSettleWaitMs);
    }
  }

  #state(runId: string): ExchangeRecord {
    let state = this.#exchanges.get(runId);
    if (!state) {
      state = { exchangeId: null, preexistingExchangeId: null, speakRequested: false, browserLaunched: false, authIssued: false, grantId: null, runBindingSha256: null, exchangeOpenedAtMs: null, join: "retained", startInProgress: false, speakRequestedAtMs: null, browserClosed: false, globalSignOutConfirmed: false };
      this.#exchanges.set(runId, state);
    }
    return state;
  }

  #armWatchdog(run: RunRecord): void {
    this.#clearWatchdog(run.id);
    const delay = Math.max(0, run.expiresAt.getTime() - this.#now());
    const handle = this.#setTimer(() => { void this.fireWatchdog(run.id).catch(() => undefined); }, delay);
    handle.unref?.();
    this.#watchdogs.set(run.id, handle);
  }

  /**
   * Run deadline reached: settle the exchange through the API even if the
   * page or the whole browser is gone (ending it only when ownership is
   * proven). Its receipts are returned by the next drain/abort/recover for
   * durable persistence. The product guard still ends the exchange at the
   * grant deadline independently of the Lab.
   */
  async fireWatchdog(runId: string): Promise<DriverEvent[]> {
    this.#watchdogs.delete(runId);
    const session = this.#sessions.get(runId) ?? null;
    const tokens = this.#tokenSource(session, runId);
    const settled = await this.#settleExchange(runId, tokens).catch((error: unknown) => ({ confirmed: false, events: [this.#exchangeEndUnavailable(runId, "watchdog", error)] }));
    const fired = { basis: "run_deadline", exchange_end_confirmed: settled.confirmed };
    const events: DriverEvent[] = [{ kind: "studio.watchdog.fired", source: "worker", payload: fired, dedupeKey: contentKey("studio-watchdog", runId, fired) }, ...settled.events];
    if (session) session.pendingEvents.push(...events);
    else this.#orphanEvents.set(runId, [...(this.#orphanEvents.get(runId) ?? []), ...events]);
    return events;
  }

  #clearWatchdog(runId: string): void {
    const handle = this.#watchdogs.get(runId);
    if (handle !== undefined) this.#clearTimer(handle);
    this.#watchdogs.delete(runId);
  }

  /**
   * Seed the exchange join from durable write-ahead evidence (worker restart).
   * A join the driver already retains is never replaced.
   */
  adoptStudioJoin(runId: string, join: DurableStudioJoin): void {
    const existing = this.#exchanges.get(runId);
    if (existing) {
      // Never replaced; only the principal's durable departure is learned.
      if (join.browserClosed === true) existing.browserClosed = true;
      if (join.globalSignOutConfirmed === true) existing.globalSignOutConfirmed = true;
      return;
    }
    const exchangeId = join.exchangeId !== null && UUID.test(join.exchangeId) ? join.exchangeId : null;
    const grantId = join.grantId !== null && UUID.test(join.grantId) ? join.grantId : null;
    this.#exchanges.set(runId, { exchangeId, preexistingExchangeId: null, speakRequested: join.speakRequested || exchangeId !== null, browserLaunched: true, authIssued: true, grantId, runBindingSha256: /^[0-9a-f]{64}$/.test(join.runBindingSha256) ? join.runBindingSha256 : null, exchangeOpenedAtMs: join.exchangeOpenedAtMs, join: "durable", startInProgress: false, speakRequestedAtMs: typeof join.speakRequestedAtMs === "number" ? join.speakRequestedAtMs : null, browserClosed: join.browserClosed === true, globalSignOutConfirmed: join.globalSignOutConfirmed === true });
  }

  /** Test seam: the exchange join the driver retains across browser loss. */
  exchangeJoin(runId: string): ExchangeRecord | null {
    return this.#exchanges.get(runId) ?? null;
  }
}
