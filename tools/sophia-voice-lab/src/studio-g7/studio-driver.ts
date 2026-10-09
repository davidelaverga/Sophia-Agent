import { createHash } from "node:crypto";
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
import { isStudioG7ScenarioVersion, STUDIO_G7_SCENARIO_ID_SET } from "./scenarios.js";
import { StudioApiClient, type IdentityObservation } from "./studio-api.js";
import { buildStudioSessionSeedScript, globalSignOut, passwordGrant, supabaseStorageKey, type FetchLike, type SignOutReceipt, type StudioUserSession } from "./supabase-session.js";

type DriverEvent = Omit<LabEvent, "runId" | "seq" | "at">;

const MAX_PUSH_QUEUE = 4_096;
const BRIDGE_POLL_MS = 2_000;
const STATS_POLL_MS = 5_000;

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
  preexistingExchangeId: string | null;
  exchangeId: string | null;
  speakRequested: boolean;
  bridgeSeen: Map<string, string>;
  sessionClosedSeen: boolean;
  lastBridgePollAt: number;
  lastStatsAt: number;
  statsSequence: number;
  pendingEvents: DriverEvent[];
}

/** What this driver instance knows about a run, independent of its browser. */
interface ExchangeRecord {
  exchangeId: string | null;
  preexistingExchangeId: string | null;
  speakRequested: boolean;
  browserLaunched: boolean;
  authIssued: boolean;
}

/** Caches one principal token per cleanup flow; never logged or persisted. */
interface TokenSource { token(): Promise<string>; held(): StudioUserSession | null; forget(): void }

type IdentitySnapshot = { observed: Partial<DeploymentIdentity>; event: DriverEvent };

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
 * Supabase session; product evidence is read only through the member API with
 * that principal's JWT. Every cleanup path (end, abort, recover, watchdog)
 * ends the exchange through `POST /exchanges/{id}/end` when the UI cannot,
 * verifies the end via the member snapshot, and signs the principal out
 * globally, whether or not the page is alive.
 */
export class StudioG7Driver implements VoiceBrowserDriver {
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
    this.#api = new StudioApiClient(studio.apiOrigin, studio.studioOrigin, config.allowedOrigins, this.#fetch);
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

  async verifyTarget(run: RunRecord): Promise<DriverStartResult> {
    const identity = await this.#observeIdentities(run, "pre_resource");
    return { observedDeployment: identity.observed as DeploymentIdentity, events: [identity.event] };
  }

  async start(run: RunRecord, _frontendCapability: string, _browserContextBinding?: D02BrowserContextBinding, onStage?: (stage: BrowserStartStage) => Promise<void>, onAcquired?: BrowserAcquisitionObserver): Promise<DriverStartResult> {
    if (this.#sessions.has(run.id) || this.#starting.has(run.id)) throw studioError("BROWSER_ALREADY_STARTED", "Run already owns or is acquiring a browser process.", "harness");
    if (!isStudioG7ScenarioVersion(run.scenarioVersion) || run.scenarioId === null || !STUDIO_G7_SCENARIO_ID_SET.has(run.scenarioId)) {
      throw new VoiceLabError(labError("SCENARIO_UNSUPPORTED_FOR_TARGET", "Only Studio G7 scenarios run on the Studio LiveKit target.", "validation", false, { status: "unsupported_for_target", target_kind: STUDIO_G7_TARGET_KIND, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion }));
    }
    this.#starting.add(run.id);
    this.#exchanges.set(run.id, { exchangeId: null, preexistingExchangeId: null, speakRequested: false, browserLaunched: false, authIssued: false });
    let identity: IdentitySnapshot;
    let ownership: OwnedBrowserProcess;
    const runBindingSha256 = computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion! });
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
      auth: null, runBindingSha256, preexistingExchangeId: null, exchangeId: null, speakRequested: false,
      bridgeSeen: new Map(), sessionClosedSeen: false, lastBridgePollAt: 0, lastStatsAt: 0, statsSequence: 0, pendingEvents: [],
    };
    // Registered immediately after launch: every later failure (ownership
    // persistence, auth, UI) flows through abort, which proves the browser
    // close, ends any exchange and signs the principal out.
    this.#sessions.set(run.id, session);
    this.#armWatchdog(run);
    session.pendingEvents.push(identity.event, acquisition);
    await onAcquired?.(acquisition, { engine: "chromium", version: ownership.browser.version() });
    // Password grant for the dedicated synthetic principal (stage name reused
    // from the legacy start trace: the auth session is established here).
    await onStage?.("frontend_auth_session");
    const auth = await this.#tokenSource(session).token().then(() => session.auth!);
    session.pendingEvents.splice(0);
    const events: DriverEvent[] = [identity.event, acquisition, {
      kind: "studio.run_binding.declared", source: "canonical",
      payload: { schema: STUDIO_RUN_BINDING_SCHEMA, contract_version: STUDIO_G7_CONTRACT_VERSION, run_binding_sha256: runBindingSha256, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, test_run_id: run.testRunId, cleanup_obligation_id_sha256: labSha256(run.cleanupObligationId) },
      dedupeKey: `studio-run-binding:${run.id}`,
    }, {
      kind: "studio.auth.session_established", source: "canonical",
      payload: { principal_id_sha256: labSha256(run.principalId), principal_bound: true, expires_at: auth.expiresAt, credentials_excluded: true },
      dedupeKey: `studio-auth:${run.id}:${auth.expiresAt}`,
    }];
    try {
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
      events.push(...await this.#awaitGrantGate(session));
      const before = await this.#api.snapshot(this.studio.projectId, await this.#tokenSource(session).token());
      if (before.exchangeId !== null) {
        session.preexistingExchangeId = before.exchangeId;
        this.#state(run.id).preexistingExchangeId = before.exchangeId;
        throw studioError("STUDIO_PROJECT_EXCHANGE_ALREADY_OPEN", "The synthetic project already had an open exchange before this run spoke; it was not adopted.", "harness", false, { status: "unavailable" });
      }
      await this.#clickControl(session, /^Speak with Sophia$/, this.#timeouts.controlVisibleMs);
      session.speakRequested = true;
      this.#state(run.id).speakRequested = true;
      events.push(await this.#awaitExchange(session));
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
    if (session.exchangeId !== null && (force || now - session.lastBridgePollAt >= BRIDGE_POLL_MS)) {
      session.lastBridgePollAt = now;
      events.push(...await this.#drainBridge(session));
    }
    if (force || now - session.lastStatsAt >= STATS_POLL_MS) {
      session.lastStatsAt = now;
      const stats = await this.#senderStats(session).catch(() => null);
      if (stats) events.push(stats);
    }
    return events;
  }

  /**
   * Leave the room and return. Not exposed as an MCP operation in this change;
   * the G7 catalogue types the step `unavailable` until it is.
   */
  async leaveAndReturn(run: RunRecord): Promise<DriverEvent[]> {
    const session = this.#requireSession(run.id);
    const events: DriverEvent[] = [...await this.drain(run.id, true)];
    const leftAt = session.push.arrival;
    await this.#clickControl(session, /^Leave the room$/, this.#timeouts.controlVisibleMs);
    const leftPayload = { basis: "ui_leave", push_arrival_before: leftAt };
    events.push({ kind: "studio.room.left", source: "browser", payload: leftPayload, dedupeKey: contentKey("studio-room-left", run.id, leftPayload) });
    events.push(await this.#joinRoom(session, "return"));
    events.push(await this.#ensureMicrophoneOn(session));
    const deadline = this.#now() + this.#timeouts.controlVisibleMs;
    while (this.#now() < deadline) {
      this.#noteIssuedTracks(session, await this.#peekHarness(session));
      const republished = session.accepted.some((item) => item.arrival > leftAt && item.receipt.event === "mic_published" && item.receipt.runBindingSha256 === session.runBindingSha256 && session.issuedTrackHashes.has(sha256(item.receipt.trackId)));
      if (republished) {
        events.push({ kind: "studio.room.rejoined", source: "browser", payload: { lab_track_republished: true }, dedupeKey: `studio-room-rejoined:${run.id}:${leftAt}` });
        events.push(...await this.drain(run.id, true));
        return events;
      }
      await this.#wait(250);
    }
    throw studioError("STUDIO_RETURN_UNCONFIRMED", "The returning participant did not republish a Lab-issued microphone track.", "product", true);
  }

  async end(run: RunRecord, _frontendFinalizeCapability: string, _frontendCleanupCapability: string, _operationDeadlineAt?: number): Promise<DriverEndResult> {
    const session = this.#requireSession(run.id);
    const events: DriverEvent[] = [];
    try {
      events.push(...await this.drain(run.id, true));
      const clickedEnd = await this.#clickIfVisible(session, /^End$/);
      const endRequested = { basis: "ui_end", control_clicked: clickedEnd };
      events.push({ kind: "studio.exchange.end_requested", source: "browser", payload: endRequested, dedupeKey: contentKey("studio-end-ui", run.id, endRequested) });
      const tokens = this.#tokenSource(session);
      const ended = await this.#verifyExchangeEnded(run.id, tokens, clickedEnd);
      events.push(...ended.events);
      if (!ended.confirmed) throw studioError("STUDIO_EXCHANGE_END_UNCONFIRMED", "The member snapshot did not confirm the exchange ended.", "product", true);
      const left = await this.#clickIfVisible(session, /^Leave the room$/);
      const leftPayload = { basis: "ui_leave", control_clicked: left };
      events.push({ kind: "studio.room.left", source: "browser", payload: leftPayload, dedupeKey: contentKey("studio-room-left", run.id, leftPayload) });
      // Receipts written after End (session_closed, the last reply) are read
      // here and by every later drain; they are ordered by seq, not arrival.
      events.push(...await this.#awaitSessionClosed(session));
      events.push(...await this.drain(run.id, true));
      events.push((await this.#observeIdentities(run, "final")).event);
      events.push(await this.#signOut(run.id, tokens));
      events.push(await this.#closeBrowser(run.id, session, "normal_end"));
      this.#clearWatchdog(run.id);
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
    if (pageAlive && session.exchangeId !== null) {
      const clicked = await this.#clickIfVisible(session, /^End$/).catch(() => false);
      const endRequested = { basis: "ui_end", control_clicked: clicked };
      events.push({ kind: "studio.exchange.end_requested", source: "browser", payload: endRequested, dedupeKey: contentKey("studio-end-ui", run.id, endRequested) });
    }
    const tokens = this.#tokenSource(session);
    const ended = await this.#verifyExchangeEnded(run.id, tokens, false).catch((error: unknown) => ({ confirmed: false, events: [this.#exchangeEndUnavailable(run.id, "abort", error)] }));
    events.push(...ended.events);
    if (pageAlive) await this.#clickIfVisible(session, /^Leave the room$/).catch(() => false);
    if (session.exchangeId !== null) events.push(...await this.#drainBridge(session).catch(() => []));
    events.push(await this.#signOut(run.id, tokens));
    events.push(await this.#closeBrowser(run.id, session, reason));
    if (ended.confirmed) this.#clearWatchdog(run.id);
    return { events, artifacts: [] };
  }

  async recover(run: RecoveryTransportBinding, _recoveryCapability: string, _processTermination?: BrowserProcessTermination): Promise<DriverEndResult> {
    const events = await this.#apiOnlyCleanup(run.id, "recover");
    const exchangeEnded = events.some((event) => event.kind === "studio.cleanup.exchange_ended" && event.payload.confirmed === true);
    const signedOut = events.some((event) => event.kind === "studio.cleanup.signed_out" && event.payload.confirmed === true);
    const recovery = { complete: exchangeEnded && signedOut && !this.#sessions.has(run.id), exchange_ended: exchangeEnded, signed_out: signedOut, browser_session_absent: !this.#sessions.has(run.id) };
    events.push({ kind: "studio.cleanup.recovery", source: "canonical", payload: recovery, dedupeKey: contentKey("studio-recovery", run.id, recovery) });
    return { events, artifacts: [] };
  }

  async cancel(runId: string, _reason: string): Promise<void> {
    const session = this.#sessions.get(runId);
    if (!session) return;
    const closed = session.context ? await closeContextWithProof(session.context, () => session.ownership.browser.contexts()) : { closed: true, errorClass: null };
    const processClosed = closed.closed ? await closeDisposableBrowserProcess(session.ownership) : { closed: false, errorClass: closed.errorClass };
    if (!closed.closed || !processClosed.closed) throw studioError("BROWSER_PROCESS_CLOSE_FAILED", "Cancelled operation left a browser context or process that could not be proven closed.", "harness", true, { error_class: closed.errorClass ?? processClosed.errorClass });
    // The exchange join and the watchdog survive: abort/recover still end the
    // exchange through the API and sign the principal out.
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

  async #drainBridge(session: StudioSession): Promise<DriverEvent[]> {
    if (session.exchangeId === null) return [];
    const exchangeId = session.exchangeId;
    const read = await this.#api.qualificationEvidence(exchangeId, await this.#tokenSource(session).token());
    if (read.status === "unavailable") return [{ kind: "studio.bridge_evidence_unavailable", source: "canonical", payload: { exchange_id: exchangeId, reason: read.reason, http_status: read.http_status }, dedupeKey: `studio-bridge-unavailable:${exchangeId}:${read.reason}:${read.http_status}` }];
    if (read.status === "rejected") return [{ kind: "studio.bridge_evidence_rejected", source: "canonical", payload: { exchange_id: exchangeId, reason: read.reason, path: read.path, http_status: read.http_status }, dedupeKey: `studio-bridge-rejected:${exchangeId}:${read.reason}:${read.path ?? ""}` }];
    const events: DriverEvent[] = [];
    for (const grant of read.evidence.grants) {
      const grantJson = canonicalJson(grant);
      const grantSha256 = sha256(grantJson);
      const key = `grant:${grant.grantId}`;
      if (session.bridgeSeen.get(key) === grantSha256) continue;
      session.bridgeSeen.set(key, grantSha256);
      events.push({ kind: "studio.bridge_grant", source: "canonical", payload: { exchange_id: exchangeId, grant_json: grantJson, grant_sha256: grantSha256 }, dedupeKey: `studio-bridge-grant:${exchangeId}:${grantSha256}` });
    }
    for (const entry of read.evidence.receipts) {
      const receiptJson = canonicalJson(entry.receipt);
      const receiptSha256 = sha256(receiptJson);
      const key = `seq:${entry.seq}:${receiptSha256}`;
      if (entry.kind === "session_closed") session.sessionClosedSeen = true;
      if (session.bridgeSeen.has(key)) continue;
      session.bridgeSeen.set(key, receiptSha256);
      events.push({ kind: "studio.bridge_receipt", source: "canonical", payload: { exchange_id: exchangeId, seq: entry.seq, kind: entry.kind, received_at: entry.receivedAt, receipt_json: receiptJson, receipt_sha256: receiptSha256, _capture_provenance: { source: "studio-member-api", observed_at: entry.receivedAt } }, dedupeKey: `studio-bridge:${exchangeId}:${entry.seq}:${receiptSha256}:${sha256(entry.receivedAt)}` });
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
  async #awaitGrantGate(session: StudioSession): Promise<DriverEvent[]> {
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
        const gate = { run_binding_sha256: session.runBindingSha256, grant_id: item.receipt.grantId, rejoins, lab_issued_track: true };
        events.push({ kind: "studio.grant_gate.passed", source: "browser", payload: gate, dedupeKey: contentKey("studio-grant-gate", session.runId, gate) });
        return events;
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

  async #awaitExchange(session: StudioSession): Promise<DriverEvent> {
    const deadline = this.#now() + this.#timeouts.exchangeOpenMs;
    while (this.#now() < deadline) {
      const snapshot = await this.#api.snapshot(this.studio.projectId, await this.#tokenSource(session).token());
      if (snapshot.exchangeId !== null) {
        session.exchangeId = snapshot.exchangeId;
        Object.assign(this.#state(session.runId), { exchangeId: snapshot.exchangeId, speakRequested: true });
        return { kind: "studio.exchange.opened", source: "canonical", payload: { exchange_id: snapshot.exchangeId, input_epoch: snapshot.inputEpoch, room_id_sha256: snapshot.roomId === null ? null : labSha256(snapshot.roomId), project_id: this.studio.projectId, verified_by: "member_snapshot" }, dedupeKey: `studio-exchange-opened:${session.runId}:${snapshot.exchangeId}` };
      }
      await this.#wait(500);
    }
    throw studioError("STUDIO_EXCHANGE_NOT_OPENED", "Speak with Sophia did not open an exchange visible in the member snapshot.", "product", true);
  }

  async #awaitSessionClosed(session: StudioSession): Promise<DriverEvent[]> {
    const events: DriverEvent[] = [];
    const deadline = this.#now() + this.#timeouts.sessionClosedMs;
    while (!session.sessionClosedSeen && this.#now() < deadline) {
      events.push(...await this.#drainBridge(session).catch(() => []));
      if (session.sessionClosedSeen) break;
      await this.#wait(1_000);
    }
    return events;
  }

  /**
   * Ensure this run's exchange has ended and verify it through the member
   * snapshot. Works with or without a live page: the API End uses the
   * principal's own JWT. With `uiGrace`, the UI End gets half the window
   * before the API End is sent. Without a retained join (driver restart) the
   * open exchange of the dedicated synthetic project is presumed to be this
   * run's: concurrency is one and the project serves only the Lab.
   */
  async #verifyExchangeEnded(runId: string, tokens: TokenSource, uiGrace: boolean): Promise<{ confirmed: boolean; events: DriverEvent[] }> {
    const retained = this.#exchanges.get(runId);
    const record: ExchangeRecord = retained ?? { exchangeId: null, preexistingExchangeId: null, speakRequested: true, browserLaunched: true, authIssued: true };
    const events: DriverEvent[] = [];
    if (retained && retained.exchangeId === null && !retained.speakRequested) {
      // This driver owns the run and never clicked Speak: no exchange can
      // have been opened by it, so no member-API read is needed.
      const none = { confirmed: true, basis: "no_exchange_opened_by_run", exchange_id: null, join: "retained", verified_by: "driver_never_requested_exchange" };
      events.push({ kind: "studio.cleanup.exchange_ended", source: "canonical", payload: none, dedupeKey: contentKey("studio-exchange-ended", runId, none) });
      return { confirmed: true, events };
    }
    let snapshot = await this.#api.snapshot(this.studio.projectId, await tokens.token());
    const target = record.exchangeId ?? (record.speakRequested && snapshot.exchangeId !== null && snapshot.exchangeId !== record.preexistingExchangeId ? snapshot.exchangeId : null);
    if (target === null) {
      const none = { confirmed: true, basis: "no_exchange_opened_by_run", exchange_id: null, join: retained ? "retained" : "member_snapshot_after_driver_loss", verified_by: "member_snapshot" };
      events.push({ kind: "studio.cleanup.exchange_ended", source: "canonical", payload: none, dedupeKey: contentKey("studio-exchange-ended", runId, none) });
      return { confirmed: true, events };
    }
    let usedApi = false;
    const openAtFirstRead = snapshot.exchangeId === target;
    const start = this.#now();
    const apiAt = uiGrace ? start + Math.floor(this.#timeouts.exchangeEndMs / 2) : start;
    const deadline = start + this.#timeouts.exchangeEndMs;
    while (snapshot.exchangeId === target) {
      if (!usedApi && this.#now() >= apiAt) {
        const ended = await this.#api.endExchange(target, await tokens.token());
        usedApi = true;
        const requested = { basis: "api_end", exchange_id: target, accepted: ended.accepted, http_status: ended.http_status };
        events.push({ kind: "studio.exchange.end_requested", source: "canonical", payload: requested, dedupeKey: contentKey("studio-end-api", runId, requested) });
      }
      if (this.#now() >= deadline) break;
      await this.#wait(500);
      snapshot = await this.#api.snapshot(this.studio.projectId, await tokens.token());
    }
    const confirmed = snapshot.exchangeId !== target;
    // Basis says who ended it: the API End sent here, the UI End clicked just
    // before (uiGrace), or an earlier/independent end (guard, prior cleanup).
    const basis = usedApi ? "api_end" : uiGrace ? "ui_end" : openAtFirstRead ? "unconfirmed" : "already_ended";
    const endedPayload = { confirmed, basis, exchange_id: target, join: retained ? "retained" : "member_snapshot_after_driver_loss", verified_by: "member_snapshot" };
    events.push({ kind: "studio.cleanup.exchange_ended", source: "canonical", payload: endedPayload, dedupeKey: contentKey("studio-exchange-ended", runId, endedPayload) });
    return { confirmed, events };
  }

  #exchangeEndUnavailable(runId: string, purpose: string, error: unknown): DriverEvent {
    const payload = { confirmed: false, basis: "member_api_unavailable", purpose, exchange_id: this.#exchanges.get(runId)?.exchangeId ?? null, verified_by: "member_snapshot", error_code: error instanceof VoiceLabError ? error.detail.code : "error" };
    return { kind: "studio.cleanup.exchange_ended", source: "canonical", payload, dedupeKey: contentKey("studio-exchange-ended", runId, payload) };
  }

  /**
   * Global sign-out. If the held token is no longer accepted, a fresh grant
   * is used so global scope still revokes every session of the principal.
   */
  async #signOut(runId: string, tokens: TokenSource): Promise<DriverEvent> {
    const target = { supabaseUrl: this.studio.supabaseUrl, publishableKey: this.studio.supabasePublishableKey };
    const known = this.#exchanges.get(runId);
    if (tokens.held() === null && known !== undefined && !known.authIssued) {
      // The password grant never succeeded for this run: there is no session
      // to revoke, and attempting a fresh grant would create one.
      const none = { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: null, basis: "no_session_issued", session_basis: "none", credentials_excluded: true };
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
    const signedOut = { ...receipt, session_basis: tokenBasis, credentials_excluded: true };
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

  /** Cleanup with no browser at all: end the exchange via the API, then sign out. */
  async #apiOnlyCleanup(runId: string, purpose: string): Promise<DriverEvent[]> {
    const events: DriverEvent[] = [...(this.#orphanEvents.get(runId) ?? [])];
    this.#orphanEvents.delete(runId);
    const tokens = this.#tokenSource(null);
    const ended = await this.#verifyExchangeEnded(runId, tokens, false).catch((error: unknown) => ({ confirmed: false, events: [this.#exchangeEndUnavailable(runId, purpose, error)] }));
    events.push(...ended.events);
    events.push(await this.#signOut(runId, tokens));
    const known = this.#exchanges.get(runId);
    if (known !== undefined && !known.browserLaunched) {
      // Start failed before Chromium launched (e.g. deployment mismatch):
      // this driver instance owned the run and never allocated a browser.
      const absent = { browser_never_allocated: true, basis: "driver_failed_before_browser_launch", authoritative_ledger_read: false };
      events.push({ kind: "cleanup.browser_context_absent", source: "browser", payload: absent, dedupeKey: contentKey("cleanup-browser-absent", runId, absent) });
    }
    if (ended.confirmed) this.#clearWatchdog(runId);
    return events;
  }

  #state(runId: string): ExchangeRecord {
    let state = this.#exchanges.get(runId);
    if (!state) {
      state = { exchangeId: null, preexistingExchangeId: null, speakRequested: false, browserLaunched: false, authIssued: false };
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
   * Run deadline reached: end the exchange through the API even if the page
   * or the whole browser is gone. Its receipts are returned by the next
   * drain/abort/recover for durable persistence. The product guard still ends
   * the exchange at the grant deadline independently of the Lab.
   */
  async fireWatchdog(runId: string): Promise<DriverEvent[]> {
    this.#watchdogs.delete(runId);
    const tokens = this.#tokenSource(this.#sessions.get(runId) ?? null);
    const ended = await this.#verifyExchangeEnded(runId, tokens, false).catch((error: unknown) => ({ confirmed: false, events: [this.#exchangeEndUnavailable(runId, "watchdog", error)] }));
    const fired = { basis: "run_deadline", exchange_end_confirmed: ended.confirmed };
    const events: DriverEvent[] = [{ kind: "studio.watchdog.fired", source: "worker", payload: fired, dedupeKey: contentKey("studio-watchdog", runId, fired) }, ...ended.events];
    const session = this.#sessions.get(runId);
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
   * Seed the exchange join from durable evidence (worker restart). A join the
   * driver already retains is never replaced.
   */
  adoptExchangeJoin(runId: string, exchangeId: string): void {
    if (this.#exchanges.has(runId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(exchangeId)) return;
    this.#exchanges.set(runId, { exchangeId, preexistingExchangeId: null, speakRequested: true, browserLaunched: true, authIssued: true });
  }

  /** Test seam: the exchange join the driver retains across browser loss. */
  exchangeJoin(runId: string): ExchangeRecord | null {
    return this.#exchanges.get(runId) ?? null;
  }
}
