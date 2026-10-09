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
import { StudioApiClient, type IdentityObservation, type ProjectedArtifactVersion, type ProjectedTaskDetail, type StudioRoomSnapshot } from "./studio-api.js";
import { buildStudioSessionSeedScript, globalSignOut, passwordGrant, signOut, supabaseStorageKey, type FetchLike, type SignOutReceipt, type StudioUserSession } from "./supabase-session.js";

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
export const STALE_EDIT_PROBE_INSTRUCTION = "Voice Lab stale-edit probe: revise this section of a superseded version.";
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

/** Caches one principal token per cleanup flow; never logged or persisted. */
interface TokenSource { token(): Promise<string>; held(): StudioUserSession | null; forget(): void }

type IdentitySnapshot = { observed: Partial<DeploymentIdentity>; event: DriverEvent };

/** The Studio extensions the worker calls for G7 runs (absent on the legacy driver). */
export interface StudioDriverExtensions {
  studioAction(run: RunRecord, operationId: string, input: Record<string, unknown>): Promise<DriverOperationResult>;
  refreshStudioEvidence(run: RunRecord, join: DurableStudioJoin): Promise<DriverEvent[]>;
  adoptStudioJoin(runId: string, join: DurableStudioJoin): void;
  studioReadiness(): Promise<Record<string, unknown>>;
}

export function hasStudioExtensions(driver: VoiceBrowserDriver): driver is VoiceBrowserDriver & StudioDriverExtensions {
  const candidate = driver as Partial<StudioDriverExtensions>;
  return typeof candidate.studioAction === "function" && typeof candidate.refreshStudioEvidence === "function" && typeof candidate.adoptStudioJoin === "function";
}

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
      // The final canonical outcome read happens while the principal session
      // still exists; its join to the run stays `uncertain` (no exchange
      // binding on native tasks).
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
    const signedOut = events.some((event) => event.kind === "studio.cleanup.signed_out" && event.payload.confirmed === true);
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
    const tokens = this.#tokenSource(null);
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

  #tokenSource(session: StudioSession | null): TokenSource {
    let held = session?.auth ?? null;
    return {
      token: async () => {
        const nowSeconds = Math.floor(this.#now() / 1_000);
        if (held && held.expiresAt - nowSeconds > 60) return held.accessToken;
        held = await passwordGrant({ supabaseUrl: this.studio.supabaseUrl, publishableKey: this.studio.supabasePublishableKey }, { email: this.studio.principalEmail, password: this.studio.principalPassword }, { fetchImpl: this.#fetch, expectedUserId: this.config.principalId });
        if (session) { session.auth = held; this.#state(session.runId).authIssued = true; }
        return held.accessToken;
      },
      held: () => held,
      forget: () => { held = null; if (session) session.auth = null; },
    };
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
   * The run's candidate report: design tasks of the principal in the run's
   * window with a published page. The join to the run is `uncertain`; a
   * target that is not unique is refused, never guessed.
   */
  async #reportTarget(run: RunRecord, tokens: TokenSource): Promise<{ status: "found"; artifactId: string; versions: ProjectedArtifactVersion[]; sections: string[]; designTaskId: string } | { status: "unavailable"; reason: string }> {
    const observed = await this.#observeTasks(run, tokens, []);
    const designs = observed.details.filter((detail) => detail.task.kind === "design" && detail.design?.artifactId && detail.design.publishedVersionId);
    const artifacts = [...new Set(designs.map((detail) => detail.design!.artifactId!))];
    if (artifacts.length === 0) return { status: "unavailable", reason: "no_published_design_in_run_window" };
    if (artifacts.length > 1) return { status: "unavailable", reason: "report_target_ambiguous" };
    const artifactId = artifacts[0]!;
    const versions = await this.#api.artifactVersions(artifactId, await tokens.token());
    if (versions.status !== "available") return { status: "unavailable", reason: `artifact_versions_${versions.reason}` };
    const latestDesign = designs.sort((left, right) => (right.task.createdAt ?? "").localeCompare(left.task.createdAt ?? ""))[0]!;
    return { status: "found", artifactId, versions: versions.value, sections: latestDesign.design!.sections, designTaskId: latestDesign.task.id };
  }

  async #htmlEditAction(run: RunRecord, tokens: TokenSource, operationId: string, purpose: "section_revision" | "stale_edit", input: Record<string, unknown>): Promise<{ events: DriverEvent[]; taskId: string | null; receipt: Record<string, unknown> }> {
    const events: DriverEvent[] = [];
    const record = (payload: Record<string, unknown>): Record<string, unknown> => {
      const full: Record<string, unknown> = { purpose, operation_id: operationId, target_join: "uncertain", ...payload };
      events.push({ kind: "studio.action.html_edit", source: "canonical", payload: full, dedupeKey: contentKey("studio-html-edit", run.id, full) });
      return full;
    };
    // A target that cannot be resolved without guessing is typed, the
    // request is not sent, and the step reports `performed: false`.
    const notPerformed = (reason: string, extra: Record<string, unknown> = {}) => {
      record({ status: "unavailable", reason, requested: false, ...extra });
      return { events, taskId: null, receipt: { performed: false, status: "unavailable", reason } };
    };
    const target = await this.#reportTarget(run, tokens);
    if (target.status !== "found") return notPerformed(target.reason);
    const withPage = target.versions.filter((version) => version.renditions.some((rendition) => rendition.format === "html"));
    const current = target.versions[0] ?? null;
    const requestedSections = Array.isArray(input.sections) ? (input.sections as unknown[]).filter((value): value is string => typeof value === "string" && SECTION.test(value)) : [];
    const sections = requestedSections.length > 0 ? requestedSections.slice(0, 16) : target.sections.slice(0, 1);
    if (sections.length === 0) return notPerformed("section_unknown", { artifact_id: target.artifactId });
    let versionId: string;
    let supersededBy: string | null = null;
    if (purpose === "section_revision") {
      if (!current || !withPage.some((version) => version.id === current.id)) return notPerformed("current_version_has_no_designed_page", { artifact_id: target.artifactId });
      versionId = current.id;
    } else {
      const older = withPage.find((version) => current !== null && version.id !== current.id);
      if (!older || !current) return notPerformed("no_superseded_version", { artifact_id: target.artifactId });
      versionId = older.id;
      supersededBy = current.id;
    }
    const instruction = purpose === "stale_edit" ? STALE_EDIT_PROBE_INSTRUCTION : typeof input.instruction === "string" ? input.instruction : "";
    if (instruction.length < 1 || instruction.length > 2_000) throw studioError("STUDIO_ACTION_INVALID", "A section-only revision needs an instruction of 1 to 2000 characters.", "validation");
    const answer = await this.#api.htmlEdit(this.studio.projectId, { versionId, sections, instruction }, await tokens.token(), `voice-lab-g7:${operationId}`);
    const payload = record({
      status: answer.accepted ? "admitted" : "refused", requested: true, artifact_id: target.artifactId, version_id: versionId, superseded_by_version_id: supersededBy,
      sections, instruction_sha256: sha256(instruction), http_status: answer.http_status, code: answer.code,
      task_id: answer.receipt?.taskId ?? null, receipt_state: answer.receipt?.state ?? null, receipt_version_id: answer.receipt?.versionId ?? null,
    });
    let finalState: string | null = null;
    if (purpose === "section_revision" && answer.accepted && answer.receipt) {
      const budget = typeof input._settle_budget_ms === "number" ? input._settle_budget_ms : this.#timeouts.designSettleMs;
      const settle = Math.min(typeof input.timeout_ms === "number" ? Math.max(input.timeout_ms, 0) : this.#timeouts.designSettleMs, this.#timeouts.designSettleMs, budget);
      const deadline = this.#now() + settle;
      for (;;) {
        const detail = await this.#api.nativeTask(this.studio.projectId, answer.receipt.taskId, await tokens.token());
        finalState = detail.status === "available" ? detail.value.design?.state ?? null : null;
        if (finalState !== null && ["published", "failed", "cancelled", "superseded"].includes(finalState)) break;
        if (this.#now() >= deadline) break;
        await this.#wait(2_000);
      }
    }
    return { events, taskId: answer.receipt?.taskId ?? null, receipt: { performed: true, status: payload.status, http_status: payload.http_status, code: payload.code, task_id: payload.task_id, design_state_at_return: finalState } };
  }

  /**
   * Forget a note this run recorded by voice. Only a note bound to the run's
   * own, ownership-proven exchange is withdrawn: the preview's ids and
   * revisions are sent back with its proof, never its words.
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
    const entries = await this.#api.missionEntries(this.studio.projectId, await tokens.token());
    if (entries.status !== "available") return notPerformed(`mission_${entries.reason}`);
    const principal = run.principalId.toLowerCase();
    const bound = entries.value.filter((entry) => entry.exchangeId === exchangeId && entry.actorId === principal && entry.state === "current");
    const requested = typeof input.entry_id === "string" ? input.entry_id.toLowerCase() : null;
    const target = requested !== null ? bound.find((entry) => entry.id === requested) ?? null : bound.length === 1 ? bound[0]! : null;
    if (!target) return notPerformed(requested !== null ? "entry_not_bound_to_run_exchange" : bound.length === 0 ? "no_note_bound_to_run_exchange" : "note_target_ambiguous", { bound_note_count: bound.length });
    const preview = await this.#api.withdrawalPreview(this.studio.projectId, target.id, await tokens.token());
    if (preview.status !== "available" || preview.value.entryId !== target.id) return notPerformed(preview.status === "available" ? "preview_entry_mismatch" : `preview_${preview.reason}`, { entry_id: target.id });
    const answer = await this.#api.withdraw(this.studio.projectId, preview.value, await tokens.token(), `voice-lab-g7:${operationId}`);
    const payload = recordEvent({
      status: answer.accepted ? "committed" : "refused", requested: true, entry_id: target.id, entry_bound_exchange_id: exchangeId,
      preview_entry_count: preview.value.entryIds.length, preview_decision_count: preview.value.decisions.length,
      http_status: answer.http_status, code: answer.code, receipt_status: answer.receipt?.status ?? null, receipt_operation: answer.receipt?.operation ?? null,
      affected_count: answer.receipt?.affectedCount ?? null,
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
    const inWindow = snapshot.work
      .filter((task) => task.actorId === principal && task.createdAt !== null && Date.parse(task.createdAt) >= windowStartMs)
      .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
      .map((task) => task.id);
    const ids = [...new Set([...focus, ...inWindow])].slice(0, MAX_OBSERVED_TASKS);
    const details: ProjectedTaskDetail[] = [];
    const unavailable: Array<{ task_id: string; reason: string }> = [];
    for (const id of ids) {
      const detail = await this.#api.nativeTask(this.studio.projectId, id, await tokens.token());
      if (detail.status === "available") details.push(detail.value);
      else unavailable.push({ task_id: id, reason: detail.reason });
    }
    // Design tasks a research task handed its HTML to are part of the outcome.
    for (const designId of details.map((detail) => detail.research?.designTaskId).filter((value): value is string => typeof value === "string")) {
      if (details.length >= MAX_OBSERVED_TASKS || details.some((detail) => detail.task.id === designId)) continue;
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
    const artifacts: Array<Record<string, unknown>> = [];
    const verified = new Set<string>();
    for (const detail of observed.details) {
      const design = detail.design;
      if (!design?.artifactId || !design.publishedVersionId || verified.has(design.publishedVersionId) || verified.size >= MAX_VERIFIED_ARTIFACTS) continue;
      verified.add(design.publishedVersionId);
      artifacts.push(await this.#verifyArtifact(tokens, design.artifactId, design.publishedVersionId, detail.task.id));
    }
    const payload = {
      purpose, operation_id: operationId,
      join: { basis: "actor_and_time_window", status: "uncertain", missing_product_field: "NativeTask.exchangeId", window_start: new Date(observed.windowStartMs).toISOString(), principal_actor_only: true },
      focus_task_ids: this.#focusTasks(run.id),
      live_exchange_present: observed.snapshot.exchangeId !== null,
      tasks: observed.details.map((detail) => ({
        task_id: detail.task.id, kind: detail.task.kind, state: detail.task.state, phase: detail.task.phase, created_at: detail.task.createdAt,
        focus: this.#focusTasks(run.id).includes(detail.task.id),
        research: detail.research ? { html_state: detail.research.htmlState, design_task_id: detail.research.designTaskId, amends_task_id: detail.research.amendsTaskId } : null,
        design: detail.design ? { state: detail.design.state, mode: detail.design.mode, artifact_id: detail.design.artifactId, base_version_id: detail.design.baseVersionId, published_version_id: detail.design.publishedVersionId, research_task_id: detail.design.researchTaskId, revisions: detail.design.revisions, section_count: detail.design.sections.length } : null,
        outputs: detail.outputs.map((output) => ({ artifact_version_id: output.artifactVersionId, format: output.format, source_id: output.sourceId, sha256: output.sha256, byte_length: output.byteLength })),
      })),
      tasks_unavailable: observed.unavailable,
      artifacts,
    };
    return { event: { kind: "studio.outcome.observed", source: "canonical", payload, dedupeKey: contentKey("studio-outcome", run.id, payload) } };
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
      // The password grant never succeeded for this run: there is no session
      // to revoke, and attempting a fresh grant would create one.
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
    const record = this.#exchanges.get(runId);
    if (record && receipt.confirmed && receipt.scope === "global") record.globalSignOutConfirmed = true;
    // Each sign-out is its own durable event (a later identical-looking
    // sign-out must never dedupe into an earlier one: the dead-owner release
    // needs the sign-out that happened after the lease expired).
    const signedOut = { ...receipt, session_basis: tokenBasis, credentials_excluded: true, sign_out_id: randomUUID() };
    return { kind: "studio.cleanup.signed_out", source: "canonical", payload: signedOut, dedupeKey: contentKey("studio-signed-out", runId, signedOut) };
  }

  async #closeBrowser(runId: string, session: StudioSession, reason: string): Promise<DriverEvent> {
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
    const tokens = this.#tokenSource(null);
    const settled = await this.#settleExchange(runId, tokens).catch((error: unknown) => ({ confirmed: false, events: [this.#exchangeEndUnavailable(runId, purpose, error)] }));
    events.push(...settled.events);
    // The joined exchange's late receipts are read with the same session.
    const exchangeId = this.#exchanges.get(runId)?.exchangeId ?? null;
    if (exchangeId !== null && tokens.held() !== null) events.push(...await this.#readBridge(runId, exchangeId, tokens, new Map()).catch(() => []));
    events.push(await this.#signOut(runId, tokens));
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
    const tokens = this.#tokenSource(session);
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
