import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";

import { chromium, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Page, type Response as PlaywrightResponse } from "playwright";

import type { ResolvedAudio } from "./audio.js";
import { buildVoiceLabInitScript } from "./browser-init.js";
import type { VoiceLabConfig } from "./config.js";
import { VoiceLabError, labError, type DeploymentDependencies, type DeploymentIdentity, type LabEvent, type RunRecord } from "./domain.js";
import { canonicalRequestHash, decryptStorageState, redact, sha256, validateAllowedOrigin } from "./security.js";

export interface DriverStartResult {
  observedDeployment: DeploymentIdentity;
  events: Omit<LabEvent, "runId" | "seq" | "at">[];
  browserContextBinding?: D02BrowserContextBinding;
}
export type D02BrowserContextBinding = {
  voice_lab_run_id_sha256: string;
  browser_worker_id_sha256: string;
  browser_lease_epoch: number;
  browser_context_id_sha256: string;
};
export type D02ProductCleanupRequest = {
  browserContextBinding: D02BrowserContextBinding;
  providerSessionIdSha256: string;
  frozenProviderConnectionEpochs: number[];
};
export type D02ProductCleanupAcknowledgement = {
  schema: "sophia_voice_lab_d02_product_provider_cleanup_acknowledgement_v1";
  voice_lab_run_id_sha256: string;
  browser_worker_id_sha256: string;
  browser_lease_epoch: number;
  browser_context_id_sha256: string;
  provider_session_id_sha256: string;
  frozen_provider_connection_epochs: number[];
  browser_provider_close_receipt_count: number;
  browser_provider_activation_abort_receipt_count: number;
  settlement_acknowledgement_sha256: string;
  raw_provider_and_receipt_identifiers_excluded: true;
};
export interface DriverOperationResult { receipt: Record<string, unknown>; events: Omit<LabEvent, "runId" | "seq" | "at">[]; }
export interface DriverEndResult { events: Omit<LabEvent, "runId" | "seq" | "at">[]; artifacts: { id: string; kind: string; contentType: string; bytes: Buffer }[]; }
export type ActiveProductTarget = Record<string, unknown>;

export const SYNTHETIC_FINALIZATION_EXCLUSION_KEYS = [
  "memory", "offline_pipeline", "learning", "ordinary_product_analytics",
  "ordinary_user_projects", "shared_spaces", "debrief",
] as const;

/** Validate only the cross-plane identity/retention/isolation envelope here.
 * The worker additionally validates and re-hashes the complete transcript. */
export function hasExactFinalizationEnvelope(run: RunRecord, receipt: Record<string, unknown> | null | undefined, requireRawCleanupObligation = false): boolean {
  if (!receipt || receipt.test_run_id !== run.testRunId || receipt.synthetic_isolated !== true) return false;
  const cleanupBound = requireRawCleanupObligation
    ? receipt.cleanup_obligation_id === run.cleanupObligationId
    : receipt.cleanup_obligation_id === run.cleanupObligationId || receipt.cleanup_obligation_id_sha256 === sha256(run.cleanupObligationId);
  if (!cleanupBound) return false;
  const exclusions = receipt.exclusions;
  if (!exclusions || typeof exclusions !== "object" || Array.isArray(exclusions)) return false;
  const exclusionRecord = exclusions as Record<string, unknown>;
  const keys = Object.keys(exclusionRecord).sort();
  const expectedKeys = [...SYNTHETIC_FINALIZATION_EXCLUSION_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) || expectedKeys.some((key) => exclusionRecord[key] !== true)) return false;
  const finalizedAt = typeof receipt.finalized_at === "string" ? new Date(receipt.finalized_at) : null;
  const retentionExpiresAt = typeof receipt.retention_expires_at === "string" ? new Date(receipt.retention_expires_at) : null;
  const providerExpiresAt = run.expiresAt.toISOString();
  if (!finalizedAt || !retentionExpiresAt || Number.isNaN(finalizedAt.getTime()) || Number.isNaN(retentionExpiresAt.getTime())
    || finalizedAt.toISOString() !== receipt.finalized_at || retentionExpiresAt.toISOString() !== receipt.retention_expires_at
    || receipt.provider_expires_at !== providerExpiresAt
    || receipt.retention_anchor !== "finalized_at" || receipt.retention_hours !== run.capturePolicy.retentionHours
    || retentionExpiresAt.getTime() !== finalizedAt.getTime() + run.capturePolicy.retentionHours * 3_600_000) return false;
  const transcript = receipt.canonical_transcript as Record<string, unknown> | undefined;
  return transcript?.provider_expires_at === providerExpiresAt
    && transcript.retention_expires_at === receipt.retention_expires_at
    && transcript.retention_hours === run.capturePolicy.retentionHours
    && transcript.retention_anchor === "finalized_at";
}

export interface VoiceBrowserDriver {
  verifyTarget(run: RunRecord): Promise<DriverStartResult>;
  start(run: RunRecord, frontendCapability: string, browserContextBinding?: D02BrowserContextBinding): Promise<DriverStartResult>;
  schedule(run: RunRecord, operationId: string, utteranceId: string, audio: ResolvedAudio, delayMs?: number, activeTarget?: ActiveProductTarget): Promise<DriverOperationResult>;
  rotate(run: RunRecord, expectedEpoch: number, operationId: string, activeTarget?: ActiveProductTarget): Promise<DriverOperationResult>;
  continueSession(run: RunRecord, frontendContinueCapability: string): Promise<Omit<LabEvent, "runId" | "seq" | "at">[]>;
  quiesceD02Provider(run: RunRecord, request: D02ProductCleanupRequest): Promise<D02ProductCleanupAcknowledgement>;
  drain(runId: string): Promise<Omit<LabEvent, "runId" | "seq" | "at">[]>;
  end(run: RunRecord, frontendFinalizeCapability: string, frontendCleanupCapability: string): Promise<DriverEndResult>;
  abort(run: RunRecord, reason: string, frontendFinalizeCapability?: string, frontendCleanupCapability?: string): Promise<DriverEndResult>;
  recover(run: RunRecord, recoveryCapability: string): Promise<DriverEndResult>;
  cancel(runId: string, reason: string): Promise<void>;
  hasSession(runId: string): boolean;
  readiness(): Promise<{ ok: boolean; detail: string; engine?: string; version?: string }>;
  close(): Promise<void>;
}

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  harnessCursor: number;
  productCursor: { generation: number; seq: number } | null;
  latestProviderReceipt: (Record<string, unknown> & { _seq: number }) | null;
  contextExpiresAt: number;
  expectedBinding: { testRunId: string; cleanupObligationId: string; principalId: string; scenarioId: string | null; scenarioVersion: string | null; environment: string; retentionHours: number; providerExpiresAt: string; browserContextBinding?: D02BrowserContextBinding };
}

export class PlaywrightVoiceDriver implements VoiceBrowserDriver {
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #pendingContexts = new Map<string, BrowserContext>();
  #browser: Browser | null = null;
  #browserLaunch: Promise<Browser> | null = null;
  #readinessCache: { expiresAt: number; value: { ok: boolean; detail: string; engine?: string; version?: string } } | null = null;
  #readinessInFlight: Promise<{ ok: boolean; detail: string; engine?: string; version?: string }> | null = null;

  constructor(
    readonly config: VoiceLabConfig,
    readonly fetchImpl: typeof fetch = fetch,
    readonly launchBrowser: (options: Parameters<typeof chromium.launch>[0]) => ReturnType<typeof chromium.launch> = (options) => chromium.launch(options),
    readonly checkExecutable: (file: string, mode: number) => Promise<void> = access,
  ) {}

  hasSession(runId: string): boolean { return this.#sessions.has(runId); }
  async verifyTarget(run: RunRecord): Promise<DriverStartResult> {
    const deployment = await this.#verifyDeployment(run);
    return { observedDeployment: deployment.identity, events: [{ kind: "deployment.verified", source: "canonical", payload: deployment.components, dedupeKey: `deployment:${run.id}:pre-resource` }] };
  }
  async readiness(): Promise<{ ok: boolean; detail: string; engine?: string; version?: string }> {
    if (this.#readinessCache?.value.ok && !this.#browser?.isConnected()) this.#readinessCache = null;
    if (this.#readinessCache && this.#readinessCache.expiresAt > Date.now()) return this.#readinessCache.value;
    if (this.#readinessInFlight) return this.#readinessInFlight;
    this.#readinessInFlight = this.#probeBrowserReadiness();
    try {
      const value = await this.#readinessInFlight;
      this.#readinessCache = { expiresAt: Date.now() + (value.ok ? 60_000 : 30_000), value };
      return value;
    } finally {
      this.#readinessInFlight = null;
    }
  }

  async start(run: RunRecord, frontendCapability: string, browserContextBinding?: D02BrowserContextBinding): Promise<DriverStartResult> {
    if (this.#sessions.has(run.id)) throw new VoiceLabError(labError("BROWSER_ALREADY_STARTED", "Run already owns a browser session.", "conflict"));
    const exactBrowserContextBinding = validateD02BrowserContextBinding(run, browserContextBinding);
    const deployment = await this.#verifyDeployment(run);
    const observedDeployment = deployment.identity;
    let storageState: { cookies: unknown[]; origins: unknown[] } | undefined;
    if (this.config.storageStateCiphertext || this.config.storageStateKey) {
      if (!this.config.storageStateCiphertext || !this.config.storageStateKey) throw new VoiceLabError(labError("STORAGE_STATE_INVALID", "Both encrypted storageState values must be configured together.", "authorization"));
      storageState = decryptStorageState(this.config.storageStateCiphertext, this.config.storageStateKey) as { cookies: unknown[]; origins: unknown[] };
      if (!Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)) throw new VoiceLabError(labError("STORAGE_STATE_INVALID", "Decrypted storageState has an invalid shape.", "authorization"));
    }
    const frontendOrigin = validateAllowedOrigin(run.target.frontendUrl, this.config.allowedOrigins).origin;
    const browser = await this.#ensureBrowser();
    const context = await browser.newContext({ ...(storageState === undefined ? {} : { storageState: storageState as any }), serviceWorkers: "block" });
    this.#pendingContexts.set(run.id, context);
    try {
      // No OS/browser microphone permission is granted. The init script's
      // page-owned MediaStreamDestination is the only accepted audio stream;
      // if that replacement is absent, native gUM stays denied and startup
      // cannot allocate a provider from a physical microphone.
      const grantUrl = new URL(this.config.authGrantPath, frontendOrigin).toString();
      const { response: grantResponse, payload: grantReceipt } = await requestBoundJson(context.request, "POST", grantUrl, 15_000, frontendCapability);
      if (!grantResponse.ok()) throw new VoiceLabError(labError("AUTH_GRANT_REJECTED", `Frontend test grant exchange was rejected with HTTP ${grantResponse.status()}.`, "authorization"));
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const sessionState = grantReceipt?.auth_session_state;
      const replay = grantReceipt?.idempotent_replay;
      if (grantReceipt?.ok !== true || grantReceipt?.test_run_id !== run.testRunId || grantReceipt?.cleanup_obligation_id !== run.cleanupObligationId || typeof grantReceipt.expires_at !== "number" || grantReceipt.expires_at <= nowSeconds || grantReceipt.expires_at > nowSeconds + 305
        || grantReceipt.prior_session_cleanup_verified !== true || !Number.isInteger(grantReceipt.expired_lab_sessions_revoked) || Number(grantReceipt.expired_lab_sessions_revoked) < 0
        || grantReceipt.no_prior_conflicting_session !== true || (sessionState !== "created" && sessionState !== "idempotent_replay") || typeof replay !== "boolean" || replay !== (sessionState === "idempotent_replay")
        || !sameD02BrowserContextBinding(grantReceipt, exactBrowserContextBinding)) {
        throw new VoiceLabError(labError("AUTH_GRANT_BINDING_INVALID", "Frontend grant receipt did not prove the exact run, bounded expiry, conflict-free session admission, and cleanup verification.", "authorization"));
      }
      const authSessionUrl = new URL(this.config.authSessionPath, frontendOrigin).toString();
      const { response: authSession, payload: authIdentity } = await requestBoundJson(context.request, "GET", authSessionUrl, 10_000);
      const authUser = authIdentity?.user as Record<string, unknown> | undefined;
      if (!authSession.ok() || authUser?.id !== run.principalId) throw new VoiceLabError(labError("AUTH_PRINCIPAL_MISMATCH", "The browser session is not bound to the exact dedicated Voice Lab principal.", "authorization", false, { observed_principal_sha256: typeof authUser?.id === "string" ? sha256(authUser.id) : null }));
      await context.addInitScript({ content: buildVoiceLabInitScript({ pageOrigin: frontendOrigin, websocketOrigins: [...this.config.websocketOrigins], maxAudioBytes: this.config.maxAudioBytes, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId }) });
      const page = await context.newPage();
      const session: BrowserSession = { context, page, harnessCursor: 0, productCursor: null, latestProviderReceipt: null, contextExpiresAt: Number(grantReceipt.expires_at), expectedBinding: { testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, principalId: run.principalId, scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion, environment: run.environment, retentionHours: run.capturePolicy.retentionHours, providerExpiresAt: run.expiresAt.toISOString(), ...(exactBrowserContextBinding === undefined ? {} : { browserContextBinding: exactBrowserContextBinding }) } };
      this.#sessions.set(run.id, session);
      this.#pendingContexts.delete(run.id);
      await page.goto(new URL("/", frontendOrigin).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      assertPageLocation(page.url(), frontendOrigin, (pathname) => pathname === "/", "ORDINARY_UI_ORIGIN_DRIFT");
      const micAnchor = page.locator(this.config.onboardingMicSelector).first();
      await micAnchor.waitFor({ state: "visible", timeout: 20_000 });
      const anchoredButton = micAnchor.locator("xpath=ancestor::button[1]");
      const dashboardButton = await anchoredButton.count() > 0
        ? anchoredButton
        : page.getByRole("button", { name: /^Start (?:open session|prepare|debrief|reset|vent)$/i }).first();
      await dashboardButton.waitFor({ state: "visible", timeout: 5_000 });
      await dashboardButton.click();
      const fresh = page.getByRole("button", { name: new RegExp(`^${escapeRegex(this.config.freshButtonName)}$`, "i") }).first();
      if (await fresh.isVisible({ timeout: 1_200 }).catch(() => false)) await fresh.click();
      await page.waitForURL((url) => url.origin === frontendOrigin && /^\/session(?:\/|$)/.test(url.pathname) && url.hash === "", { timeout: 20_000 });
      assertPageLocation(page.url(), frontendOrigin, (pathname) => /^\/session(?:\/|$)/.test(pathname), "ORDINARY_UI_ORIGIN_DRIFT");
      const voiceTab = page.getByRole("tab", { name: /^voice$/i }).first();
      if (await voiceTab.isVisible({ timeout: 2_000 }).catch(() => false) && await voiceTab.getAttribute("aria-selected") !== "true") await voiceTab.click();
      const startButton = page.getByRole("button", { name: this.config.startButtonName, exact: true }).first();
      await startButton.waitFor({ state: "visible", timeout: 20_000 });
      await startButton.click();
      const events = await this.#waitForStartupReadiness(run.id, session, 45_000);
      events.push(...await this.drain(run.id));
      events.push({ kind: "deployment.verified", source: "canonical", payload: deployment.components, dedupeKey: `deployment:${run.id}:startup` });
      events.push(await this.#snapshotEvent(session, "startup"));
      return { observedDeployment, events, ...(exactBrowserContextBinding === undefined ? {} : { browserContextBinding: exactBrowserContextBinding }) };
    } catch (error) {
      const closed = await closeContextWithProof(context, () => this.#browser?.contexts() ?? []);
      if (closed.closed) { this.#sessions.delete(run.id); this.#pendingContexts.delete(run.id); }
      else throw new VoiceLabError(labError("BROWSER_CONTEXT_CLOSE_FAILED", "Failed start left a browser context that could not be proven closed.", "harness", true, { original_error_class: error instanceof VoiceLabError ? error.detail.code : error instanceof Error ? error.name : "Error", close_error_class: closed.errorClass }));
      if (error instanceof VoiceLabError) throw error;
      throw new VoiceLabError(labError("ORDINARY_UI_ROUTE_FAILED", "The ordinary deployed Sophia voice route could not be established.", "harness", false, { cause: error instanceof Error ? error.message : String(error) }));
    }
  }

  async schedule(run: RunRecord, operationId: string, utteranceId: string, audio: ResolvedAudio, delayMs = 0, activeTarget?: ActiveProductTarget): Promise<DriverOperationResult> {
    const session = this.#requireSession(run.id);
    const receipt = await session.page.evaluate(async (input) => {
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
      activeTarget: projectActiveProductTarget(activeTarget, operationId),
    });
    const events = await this.drain(run.id);
    events.push(await this.#snapshotEvent(session, "turn_schedule"));
    return { receipt: redact(receipt as Record<string, unknown>), events };
  }

  async rotate(run: RunRecord, expectedEpoch: number, operationId: string, activeTarget?: ActiveProductTarget): Promise<DriverOperationResult> {
    const session = this.#requireSession(run.id);
    const events = await this.drain(run.id);
    const productPrecondition = session.latestProviderReceipt;
    if (Number(productPrecondition?.providerConnectionEpoch) !== expectedEpoch || productPrecondition?.continuityState !== "active") throw new VoiceLabError(labError("PROVIDER_EPOCH_PRECONDITION_FAILED", "Requested rotation epoch does not match the latest active product provider epoch receipt.", "conflict", true, { expected: expectedEpoch, observed: productPrecondition?.providerConnectionEpoch ?? null, continuity_state: productPrecondition?.continuityState ?? null }));
    const receipt = await session.page.evaluate((target) => {
      const bridge = (window as any).__sophiaVoiceLab;
      if (!bridge?.rotate) throw new Error("Voice Lab socket bridge is unavailable");
      return bridge.rotate(target);
    }, projectActiveProductTarget(activeTarget, operationId));
    const deadline = Date.now() + 30_000;
    let restoration: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const batch = await this.drain(run.id);
      events.push(...batch);
      const candidate = session.latestProviderReceipt;
      if (candidate && Number(candidate._seq) > Number(productPrecondition?._seq ?? 0) && (candidate.phase === "restored" || candidate.phase === "degraded")) { restoration = candidate; break; }
      await session.page.waitForTimeout(100);
    }
    if (!restoration) throw new VoiceLabError(labError("SOCKET_ROTATION_TIMEOUT", "No product restored/degraded provider epoch receipt arrived before timeout.", "product", true, { expected_epoch: expectedEpoch }));
    if (restoration.phase === "degraded") throw new VoiceLabError(labError("SOCKET_ROTATION_DEGRADED", "Product continuity degraded after socket rotation.", "product", false, { expected_epoch: expectedEpoch, receipt: redact(restoration) }));
    return { receipt: { harness: redact(receipt as Record<string, unknown>), product: redact(restoration) }, events };
  }

  async continueSession(run: RunRecord, frontendContinueCapability: string): Promise<Omit<LabEvent, "runId" | "seq" | "at">[]> {
    const session = this.#requireSession(run.id);
    if (session.contextExpiresAt - Math.floor(Date.now() / 1_000) > 30) return [];
    const url = new URL(this.config.authContinuePath, new URL(run.target.frontendUrl).origin).toString();
    const { response, payload: receipt } = await requestBoundJson(session.context.request, "POST", url, 10_000, frontendContinueCapability);
    const now = Math.floor(Date.now() / 1_000);
    const allowedOps = receipt?.allowed_ops;
    if (!response.ok() || receipt?.ok !== true || receipt?.test_run_id !== run.testRunId || receipt?.cleanup_obligation_id !== run.cleanupObligationId || receipt?.session_preserved !== true || !Array.isArray(allowedOps) || allowedOps.length !== 3 || !allowedOps.includes("session:create") || !allowedOps.includes("session:read") || !allowedOps.includes("session:finalize") || typeof receipt?.expires_at !== "number" || receipt.expires_at <= now || receipt.expires_at > now + 305 || !sameD02BrowserContextBinding(receipt, session.expectedBinding.browserContextBinding)) throw new VoiceLabError(labError("SESSION_CONTINUATION_FAILED", "Short-lived synthetic run context could not be refreshed without rotating the dedicated auth session.", "authorization", true, { status: response.status() }));
    session.contextExpiresAt = receipt.expires_at;
    return [{ kind: "auth.session_continued", source: "canonical", payload: { test_run_id: run.testRunId, expires_at: receipt.expires_at, session_preserved: true, ...(session.expectedBinding.browserContextBinding ?? {}) }, dedupeKey: `auth-continue:${run.id}:${receipt.expires_at}` }];
  }

  async quiesceD02Provider(run: RunRecord, request: D02ProductCleanupRequest): Promise<D02ProductCleanupAcknowledgement> {
    const session = this.#requireSession(run.id);
    const binding = validateD02BrowserContextBinding(run, request.browserContextBinding);
    const frozenEpochs = [...request.frozenProviderConnectionEpochs];
    if (!binding || !sameD02BrowserContextBinding(binding, session.expectedBinding.browserContextBinding)
      || typeof run.providerSessionId !== "string" || !PRODUCT_SAFE_ID.test(run.providerSessionId)
      || !SHA256.test(request.providerSessionIdSha256) || sha256(run.providerSessionId) !== request.providerSessionIdSha256
      || frozenEpochs.length === 0 || frozenEpochs.length > 64
      || frozenEpochs.some((epoch, index) => !Number.isSafeInteger(epoch) || epoch < 1 || index > 0 && epoch <= frozenEpochs[index - 1]!)) {
      throw new VoiceLabError(labError("D02_PRODUCT_CLEANUP_BINDING_INVALID", "The D02 product cleanup request did not match the exact owned browser/provider context.", "harness", false));
    }
    const control = {
      schema: "sophia_voice_lab_d02_browser_worker_product_cleanup_control_v1",
      voice_lab_run_id_sha256: binding.voice_lab_run_id_sha256,
      test_run_id: run.testRunId,
      cleanup_obligation_id: run.cleanupObligationId,
      browser_worker_id_sha256: binding.browser_worker_id_sha256,
      browser_lease_epoch: binding.browser_lease_epoch,
      browser_context_id_sha256: binding.browser_context_id_sha256,
      provider_session_id: run.providerSessionId,
      frozen_provider_connection_epochs: frozenEpochs,
    } as const;
    let rawAcknowledgement: unknown;
    let acknowledged = false;
    let lastErrorClass = "ProductCleanupError";
    const deadline = Date.now() + 15_000;
    while (!acknowledged && Date.now() < deadline) {
      try {
        rawAcknowledgement = await session.page.evaluate(async (input) => {
          const bridge = (window as any).__sophiaVoiceLabD02WorkerCleanup;
          if (!bridge || typeof bridge.close !== "function") throw new Error("D02 product cleanup bridge is unavailable");
          return Promise.race([
            bridge.close(input),
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error("D02 product cleanup acknowledgement timed out")), 2_500)),
          ]);
        }, control);
        acknowledged = true;
      } catch (error) {
        lastErrorClass = error instanceof Error ? error.name : "ProductCleanupError";
        if (Date.now() < deadline) await session.page.waitForTimeout(250);
      }
    }
    if (!acknowledged) {
      throw new VoiceLabError(labError("D02_PRODUCT_CLEANUP_UNCONFIRMED", "The exact product-owned provider cleanup did not return its accepted canonical receipt echo before the shutdown grace deadline.", "product", true, { error_class: lastErrorClass }));
    }
    const accepted = validateD02ProductCleanupEcho(rawAcknowledgement, run.providerSessionId, frozenEpochs);
    return {
      schema: "sophia_voice_lab_d02_product_provider_cleanup_acknowledgement_v1",
      voice_lab_run_id_sha256: binding.voice_lab_run_id_sha256,
      browser_worker_id_sha256: binding.browser_worker_id_sha256,
      browser_lease_epoch: binding.browser_lease_epoch,
      browser_context_id_sha256: binding.browser_context_id_sha256,
      provider_session_id_sha256: request.providerSessionIdSha256,
      frozen_provider_connection_epochs: frozenEpochs,
      browser_provider_close_receipt_count: accepted.browser_provider_close_receipts.length,
      browser_provider_activation_abort_receipt_count: accepted.browser_provider_activation_abort_receipts.length,
      settlement_acknowledgement_sha256: canonicalRequestHash(accepted),
      raw_provider_and_receipt_identifiers_excluded: true,
    };
  }

  async drain(runId: string): Promise<Omit<LabEvent, "runId" | "seq" | "at">[]> {
    const session = this.#requireSession(runId);
    const harness = await session.page.evaluate((after) => (window as any).__sophiaVoiceLab?.drain(after) ?? { min_seq: after + 1, latest_seq: after, events: [] }, session.harnessCursor);
    if (harness.min_seq > session.harnessCursor + 1) throw cursorGap("harness", session.harnessCursor, harness.min_seq);
    const events: Omit<LabEvent, "runId" | "seq" | "at">[] = [];
    for (const event of harness.events as Array<{ seq: number; kind: string; payload: Record<string, unknown> }>) {
      if (event.seq <= session.harnessCursor) continue;
      session.harnessCursor = event.seq;
      const observedAt = typeof (event as any).observed_at === "string" ? (event as any).observed_at : null;
      events.push({ kind: event.kind, source: "browser", payload: redact({ ...event.payload, _capture_provenance: { source: "voice-lab-init", seq: event.seq, observed_at: observedAt } }), dedupeKey: `browser:${event.seq}` });
    }
    const productDrain = await drainProductCapture(session.productCursor, (cursor) => session.page.evaluate((requestedCursor) => {
        const capture = (window as any).__sophiaCapture;
        if (capture?.readAfter) return capture.readAfter(requestedCursor, 500);
        return { unsupported: true, cursor: requestedCursor, metadata: null, events: [] };
      }, cursor));
    for (const page of productDrain.pages) {
      // This is a content-free runner receipt over the product-authored ring
      // metadata returned by readAfter. It lets the evidence evaluator prove
      // pagination, generation continuity, capacity, and drop accounting
      // without exposing application payloads.
      events.push({
        kind: "capture.product_page",
        source: "browser",
        payload: page,
        dedupeKey: `product-page:${page.generation}:${page.requestedSeq}:${page.returnedSeq}`,
      });
    }
    for (const event of productDrain.events) {
        // synthetic_test is product-authored on the capture event envelope. It
        // must never be reconstructed from runner state or copied from payload.
        const appBinding = validateAppSyntheticBinding(event.synthetic_test, session.expectedBinding);
        events.push({
          kind: mapProductEvent(event),
          source: "product",
          payload: redact({
            ...(event.payload ?? {}),
            ...(appBinding === null ? {} : { _app_synthetic_binding: appBinding }),
            _capture_provenance: { generation: event.generation, seq: event.seq, recorded_at: event.recordedAt ?? null, category: event.category ?? null, name: event.name ?? null },
          }),
          dedupeKey: `product:${event.generation}:${event.seq}`,
        });
        if (appBinding !== null && event.name === "gemini-provider-connection-epoch" && event.payload?.receipt && typeof event.payload.receipt === "object") session.latestProviderReceipt = { ...(event.payload.receipt as Record<string, unknown>), _seq: event.seq };
    }
    session.productCursor = productDrain.cursor;
    return events;
  }

  async end(run: RunRecord, frontendFinalizeCapability: string, frontendCleanupCapability: string): Promise<DriverEndResult> {
    const session = this.#requireSession(run.id);
    const artifacts: DriverEndResult["artifacts"] = [];
    {
      const refreshUrl = new URL(this.config.authRefreshPath, new URL(run.target.frontendUrl).origin).toString();
      const { response: refreshed } = await requestBoundJson(session.context.request, "POST", refreshUrl, 15_000, frontendFinalizeCapability);
      if (!refreshed.ok()) throw new VoiceLabError(labError("FINALIZATION_GRANT_REJECTED", `Frontend finalization grant refresh was rejected with HTTP ${refreshed.status()}.`, "authorization"));
      const frontendOrigin = new URL(run.target.frontendUrl).origin;
      const finalizationResponse = session.page.waitForResponse((response) => isExactFinalizationResponse(response, frontendOrigin), { timeout: 20_000 }).catch(() => null);
      const end = session.page.getByRole("button", { name: /^End session$/i }).first();
      await end.waitFor({ state: "visible", timeout: 10_000 });
      await end.click();
      const confirm = session.page.getByRole("button", { name: /^end session$/i }).last();
      await confirm.waitFor({ state: "visible", timeout: 5_000 });
      await confirm.click();
      const response = await finalizationResponse;
      if (!response || response.status() !== 202 || !isJsonResponse(response)) throw new VoiceLabError(labError("PRODUCT_FINALIZATION_UNCONFIRMED", "The ordinary UI did not produce an exact-origin JSON 202 product finalization receipt.", "product", true, { status: response?.status() ?? null }));
      const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
      const evidenceReceipt = responseBody?.evidence_receipt as Record<string, unknown> | undefined;
      if (!hasExactFinalizationEnvelope(run, responseBody, true) || typeof evidenceReceipt?.sha256 !== "string") throw new VoiceLabError(labError("FINALIZATION_ISOLATION_UNCONFIRMED", "Finalization receipt did not prove the bound synthetic run, cleanup obligation, exact retention policy, durable evidence, and exact isolation exclusions.", "product", false));
      const events: Omit<LabEvent, "runId" | "seq" | "at">[] = [];
      const closeDeadline = Date.now() + 10_000;
      let providerClosed = false;
      while (Date.now() < closeDeadline) {
        const batch = await this.drain(run.id);
        events.push(...batch);
        if (batch.some((event) => event.kind === "provider.stage" && isValidatedAppBinding(event.payload._app_synthetic_binding, session.expectedBinding) && (event.payload.stage === "closed" || event.payload.stage === "ended"))) { providerClosed = true; break; }
        await session.page.waitForTimeout(100);
      }
      if (!providerClosed) throw new VoiceLabError(labError("PROVIDER_CLEANUP_UNCONFIRMED", "Product finalization succeeded but provider transport closure was not observed.", "product", true));
      const finalDeployment = await this.#verifyDeployment(run);
      events.push({ kind: "deployment.reverified", source: "canonical", payload: finalDeployment.components, dedupeKey: `deployment:${run.id}:final` });
      events.push(await this.#snapshotEvent(session, "finalization"));
      events.push({ kind: "session.finalized", source: "canonical", payload: redact({ http_status: response.status(), receipt: responseBody }), dedupeKey: `canonical:${run.id}:finalized` });
      if (run.capturePolicy.screenshot) {
        const bytes = await session.page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
        artifacts.push({ id: randomUUID(), kind: "final_screenshot", contentType: "image/jpeg", bytes });
      }
      const cleanupUrl = new URL(this.config.authCleanupPath, new URL(run.target.frontendUrl).origin).toString();
      const { response: cleanup, payload: cleanupReceipt } = await requestBoundJson(session.context.request, "POST", cleanupUrl, 15_000, frontendCleanupCapability);
      if (!cleanup.ok() || cleanupReceipt?.ok !== true || cleanupReceipt?.session_revoked !== true || cleanupReceipt?.cookies_cleared !== true || cleanupReceipt?.test_run_id !== run.testRunId || cleanupReceipt?.cleanup_obligation_id !== run.cleanupObligationId) throw new VoiceLabError(labError("AUTH_SESSION_CLEANUP_UNCONFIRMED", "Dedicated test auth session and cookie cleanup was not confirmed for this run.", "authorization", true, { status: cleanup.status() }));
      events.push({ kind: "auth.session_cleanup", source: "canonical", payload: redact(cleanupReceipt), dedupeKey: `canonical:${run.id}:auth-cleanup` });
      events.push(await this.#closeContextEvent(run.id, session.context, "normal_end"));
      return { events, artifacts };
    }
  }

  async abort(run: RunRecord, reason: string, frontendFinalizeCapability?: string, frontendCleanupCapability?: string): Promise<DriverEndResult> {
    const session = this.#sessions.get(run.id);
    if (!session) return { events: [{ kind: "cleanup.browser_absent", source: "browser", payload: { reason }, dedupeKey: `cleanup:${run.id}:absent` }], artifacts: [] };
    const events: Omit<LabEvent, "runId" | "seq" | "at">[] = [];
    const artifacts: DriverEndResult["artifacts"] = [];
    {
      try { events.push(...await this.drain(run.id)); } catch (error) { events.push({ kind: "cleanup.capture_unavailable", source: "browser", payload: { reason: error instanceof Error ? error.message : String(error) }, dedupeKey: `cleanup:${run.id}:capture-unavailable` }); }
      try { events.push(await this.#snapshotEvent(session, "finalization")); } catch { /* typed event above is sufficient */ }
      if (run.capturePolicy.screenshot) {
        const bytes = await session.page.screenshot({ type: "jpeg", quality: 50, fullPage: false }).catch(() => null);
        if (bytes) artifacts.push({ id: randomUUID(), kind: "final_screenshot", contentType: "image/jpeg", bytes });
      }
      if (frontendFinalizeCapability) {
        try {
          const refreshUrl = new URL(this.config.authRefreshPath, new URL(run.target.frontendUrl).origin).toString();
          const { response: refreshed } = await requestBoundJson(session.context.request, "POST", refreshUrl, 10_000, frontendFinalizeCapability);
          if (!refreshed.ok()) throw new Error(`finalize grant HTTP ${refreshed.status()}`);
          const frontendOrigin = new URL(run.target.frontendUrl).origin;
          const finalizationResponse = session.page.waitForResponse((response) => isExactFinalizationResponse(response, frontendOrigin), { timeout: 12_000 }).catch(() => null);
          const endButton = session.page.getByRole("button", { name: /^End session$/i }).first();
          await endButton.waitFor({ state: "visible", timeout: 5_000 });
          await endButton.click();
          const confirm = session.page.getByRole("button", { name: /^end session$/i }).last();
          if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click();
          const response = await finalizationResponse;
          const receipt = response && response.status() === 202 && isJsonResponse(response) ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
          const confirmed = Boolean(response?.ok() && hasExactFinalizationEnvelope(run, receipt, true));
          events.push({ kind: "cleanup.product_finalization", source: "canonical", payload: redact({ confirmed, http_status: response?.status() ?? null, receipt }), dedupeKey: `cleanup:${run.id}:product-finalization` });
          if (confirmed) events.push({ kind: "session.finalized", source: "canonical", payload: redact({ http_status: response?.status() ?? null, receipt }), dedupeKey: `canonical:${run.id}:finalized` });
          if (confirmed) {
            const deadline = Date.now() + 8_000;
            while (Date.now() < deadline) {
              const batch = await this.drain(run.id);
              events.push(...batch);
              if (batch.some((event) => event.kind === "provider.stage" && isValidatedAppBinding(event.payload._app_synthetic_binding, session.expectedBinding) && ["closed", "ended"].includes(String(event.payload.stage)))) break;
              await session.page.waitForTimeout(100);
            }
          }
        } catch (error) {
          events.push({ kind: "cleanup.product_finalization", source: "canonical", payload: { confirmed: false, unavailable_reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }, dedupeKey: `cleanup:${run.id}:product-finalization` });
        }
      } else {
        events.push({ kind: "cleanup.product_finalization", source: "canonical", payload: { confirmed: false, unavailable_reason: "finalization_capability_unavailable" }, dedupeKey: `cleanup:${run.id}:product-finalization` });
      }
      if (frontendCleanupCapability) {
        const cleanupUrl = new URL(this.config.authCleanupPath, new URL(run.target.frontendUrl).origin).toString();
        const cleanupResult = await requestBoundJson(session.context.request, "POST", cleanupUrl, 10_000, frontendCleanupCapability).catch(() => null);
        const cleanup = cleanupResult?.response ?? null;
        const receipt = cleanupResult?.payload ?? null;
        events.push({ kind: "auth.session_cleanup", source: "canonical", payload: redact({ status: cleanup?.status() ?? null, receipt, confirmed: Boolean(cleanup?.ok() && (receipt as any)?.session_revoked === true && (receipt as any)?.cookies_cleared === true && (receipt as any)?.test_run_id === run.testRunId && (receipt as any)?.cleanup_obligation_id === run.cleanupObligationId) }), dedupeKey: `cleanup:${run.id}:auth` });
      }
      events.push(await this.#closeContextEvent(run.id, session.context, reason));
      return { events, artifacts };
    }
  }

  async recover(run: RunRecord, recoveryCapability: string): Promise<DriverEndResult> {
    const origin = validateAllowedOrigin(run.target.gatewayUrl, this.config.allowedOrigins).origin;
    const pathname = `${this.config.recoveryPathPrefix.replace(/\/$/, "")}/${encodeURIComponent(run.testRunId)}/recover`;
    try {
      const response = await this.fetchImpl(new URL(pathname, origin), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json", "X-Sophia-Voice-Lab-Recovery-Auth": this.config.recoveryInternalSecret, "X-Sophia-Voice-Lab-Capability": recoveryCapability },
      });
      const receipt = await response.json().catch(() => null) as Record<string, unknown> | null;
      const components = receipt?.components as Record<string, { status?: unknown }> | undefined;
      const durableReceipt = receipt?.receipt as Record<string, unknown> | undefined;
      const liveComponentComplete = components !== undefined && ["canonical_session", "voice_provider", "builder", "auth_sessions"].every((key) => typeof components[key]?.status === "string" && !["pending", "failed", "unavailable", "retention_pending"].includes(String(components[key]!.status)));
      const builder = components?.builder as Record<string, unknown> | undefined;
      const builderReceipt = builder?.receipt && typeof builder.receipt === "object" ? builder.receipt as Record<string, unknown> : {};
      const authoritativeBuilderZero = builder?.status === "completed" && (builder?.cleanup_complete ?? builderReceipt.cleanup_complete) === true && (builder?.discovery_complete ?? builderReceipt.discovery_complete) === true && (builder?.authoritative_zero_tasks ?? builderReceipt.authoritative_zero_tasks) === true && Number.isInteger(builder?.discovered_task_count ?? builderReceipt.discovered_task_count) && Number(builder?.discovered_task_count ?? builderReceipt.discovered_task_count) >= 0;
      const durable = typeof durableReceipt?.storage === "string" && typeof durableReceipt?.object_path === "string" && typeof durableReceipt?.sha256 === "string" && /^[a-f0-9]{64}$/.test(durableReceipt.sha256);
      const canonicalEvidence = components?.canonical_evidence as Record<string, unknown> | undefined;
      const purgeDueRaw = receipt?.retention_purge_due_at;
      const purgeDue = typeof purgeDueRaw === "string" ? new Date(purgeDueRaw) : null;
      const purgeDueValid = purgeDue !== null && !Number.isNaN(purgeDue.getTime()) && purgeDue.toISOString() === purgeDueRaw;
      const retentionPending = receipt?.retention_purge_pending === true && receipt?.retention_purged === false && receipt?.retention_maintenance_complete === false && purgeDueValid && canonicalEvidence?.status === "retention_pending";
      const retentionPurged = receipt?.retention_purge_pending === false && receipt?.retention_purged === true && receipt?.retention_maintenance_complete === true;
      const cleanupBound = receipt?.cleanup_obligation_id === run.cleanupObligationId;
      const liveComplete = response.status === 200 && receipt?.ok === true && receipt?.complete === true && receipt?.live_cleanup_complete === true && receipt?.live_resources_zero === true && receipt?.test_run_id === run.testRunId && cleanupBound && liveComponentComplete && authoritativeBuilderZero && durable && (retentionPending || retentionPurged);
      const pending = response.status === 202 && receipt?.ok === true && receipt?.complete === false && receipt?.live_resources_zero !== true && receipt?.test_run_id === run.testRunId && cleanupBound && typeof receipt?.recovery_id === "string";
      const attemptId = typeof receipt?.attempt_id === "string" ? receipt.attempt_id : `${String(receipt?.recovery_id ?? response.status)}:${String(receipt?.recovered_at ?? "unknown")}`;
      return { events: [{ kind: "cleanup.recovery", source: "canonical", payload: redact({ complete: liveComplete, pending, live_cleanup_complete: liveComplete, retention_purge_pending: retentionPending, retention_purged: retentionPurged, retention_purge_due_at: purgeDueValid ? purgeDueRaw : null, http_status: response.status, receipt }), dedupeKey: `recovery:${run.id}:${attemptId}:${retentionPurged ? "retention-purged" : liveComplete ? "live-complete" : pending ? "pending" : "failed"}` }], artifacts: [] };
    } catch (error) {
      return { events: [{ kind: "cleanup.recovery", source: "canonical", payload: { complete: false, pending: false, unavailable_reason: error instanceof Error ? error.name : "recovery_failed" }, dedupeKey: `recovery:${run.id}:unavailable` }], artifacts: [] };
    }
  }

  async cancel(runId: string, _reason: string): Promise<void> {
    const session = this.#sessions.get(runId);
    const context = session?.context ?? this.#pendingContexts.get(runId);
    if (!context) return;
    const result = await closeContextWithProof(context, () => this.#browser?.contexts() ?? []);
    if (!result.closed) throw new VoiceLabError(labError("BROWSER_CONTEXT_CLOSE_FAILED", "Cancelled operation left a browser context that could not be proven closed.", "harness", true, { error_class: result.errorClass }));
    this.#sessions.delete(runId);
    this.#pendingContexts.delete(runId);
  }

  async close(): Promise<void> {
    const contexts = [...new Set([...this.#sessions.values()].map((session) => session.context).concat([...this.#pendingContexts.values()]))];
    const results = await Promise.all(contexts.map((context) => closeContextWithProof(context, () => this.#browser?.contexts() ?? [])));
    if (results.some((result) => !result.closed)) throw new VoiceLabError(labError("BROWSER_CONTEXT_CLOSE_FAILED", "Worker shutdown could not prove every owned browser context closed.", "harness", true, { unresolved_contexts: results.filter((result) => !result.closed).length }));
    this.#sessions.clear(); this.#pendingContexts.clear();
    if (this.#browser) await this.#browser.close();
    this.#browser = null;
    this.#readinessCache = null;
  }

  async #ensureBrowser(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    this.#browserLaunch ??= this.launchBrowser({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"] });
    try {
      this.#browser = await this.#browserLaunch;
      this.#browser.once("disconnected", () => {
        this.#readinessCache = null;
        this.#browser = null;
      });
      return this.#browser;
    } finally {
      this.#browserLaunch = null;
    }
  }

  async #probeBrowserReadiness(): Promise<{ ok: boolean; detail: string; engine?: string; version?: string }> {
    try {
      await this.checkExecutable(chromium.executablePath(), fsConstants.X_OK);
      const browser = await this.#ensureBrowser();
      const context = await browser.newContext({ serviceWorkers: "block" });
      try {
        const page = await context.newPage();
        const media = await page.evaluate(async () => {
          if (typeof AudioContext !== "function") return { webAudio: false };
          const audio = new AudioContext();
          const sampleRate = audio.sampleRate;
          await audio.close();
          return { webAudio: sampleRate > 0 };
        });
        if (!media.webAudio) throw new Error("WebAudioUnavailable");
      } finally {
        const closed = await closeContextWithProof(context, () => browser.contexts());
        if (!closed.closed) throw new Error(closed.errorClass ?? "ReadinessContextCloseFailed");
      }
      return { ok: true, detail: "chromium-launch-context-webaudio-ready", engine: "chromium", version: browser.version() };
    } catch (error) {
      return { ok: false, detail: `chromium-readiness-failed:${error instanceof Error ? error.name : "Error"}` };
    }
  }

  async #verifyDeployment(run: RunRecord): Promise<{ identity: DeploymentIdentity; components: Record<keyof DeploymentIdentity | keyof DeploymentDependencies, Record<string, unknown>> }> {
    const [frontend, backend, voice, langgraph] = await Promise.all([
      this.#fetchBuild(run.target.frontendUrl, "/api/app-version", ["build_id"]),
      this.#fetchBuild(run.target.gatewayUrl, "/version", ["commit_sha", "git_sha", "build_id"]),
      this.#fetchBuild(run.target.voiceUrl, "/version", ["commit_sha", "git_sha", "build_id"]),
      this.#fetchBuild(run.target.langgraphUrl, "/version", ["commit_sha", "git_sha", "build_id"]),
    ]);
    const observed = { frontend: frontend.commitSha, backend: backend.commitSha, voice: voice.commitSha };
    for (const key of ["frontend", "backend", "voice"] as const) {
      if (observed[key] !== run.target.expectedDeployment[key]) throw new VoiceLabError(labError("DEPLOYMENT_MISMATCH", `${key} deployment does not match the exact requested commit.`, "deployment", false, { component: key, expected: run.target.expectedDeployment[key], observed: observed[key] }));
    }
    if (langgraph.commitSha !== run.target.expectedDependencies.langgraph) {
      throw new VoiceLabError(labError("DEPLOYMENT_MISMATCH", "langgraph deployment does not match the exact requested dependency commit.", "deployment", false, { component: "langgraph", expected: run.target.expectedDependencies.langgraph, observed: langgraph.commitSha }));
    }
    return {
      identity: observed,
      components: {
        frontend: deploymentComponent(frontend),
        backend: deploymentComponent(backend),
        voice: deploymentComponent(voice),
        langgraph: deploymentComponent(langgraph),
      },
    };
  }

  async #fetchBuild(base: string, pathname: string, fields: string[]): Promise<{ commitSha: string; deploymentId: string | null; serviceId: string | null }> {
    const baseUrl = validateAllowedOrigin(base, this.config.allowedOrigins);
    const target = new URL(pathname, baseUrl.origin);
    const response = await this.fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!response.ok) throw new VoiceLabError(labError("DEPLOYMENT_IDENTITY_UNAVAILABLE", `Deployment identity endpoint ${target.origin}${pathname} returned HTTP ${response.status}.`, "deployment", true));
    const payload = await response.json() as Record<string, unknown>;
    const value = fields.map((field) => payload[field]).find((candidate) => typeof candidate === "string" && /^[a-f0-9]{40}$/i.test(candidate));
    if (typeof value !== "string") throw new VoiceLabError(labError("DEPLOYMENT_IDENTITY_INVALID", `Deployment identity endpoint ${target.origin}${pathname} did not return an exact commit SHA.`, "deployment"));
    const safeIdentifier = (candidate: unknown) => typeof candidate === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(candidate) ? candidate : null;
    return { commitSha: value, deploymentId: safeIdentifier(payload.deployment_id ?? payload.deploymentId), serviceId: safeIdentifier(payload.service_id ?? payload.serviceId) };
  }

  #requireSession(runId: string): BrowserSession {
    const session = this.#sessions.get(runId);
    if (!session) throw new VoiceLabError(labError("BROWSER_SESSION_LOST", "The browser worker no longer owns this run; it cannot be reconstructed honestly.", "harness"));
    return session;
  }

  async #closeContextEvent(runId: string, context: BrowserContext, reason: string): Promise<Omit<LabEvent, "runId" | "seq" | "at">> {
    const result = await closeContextWithProof(context, () => this.#browser?.contexts() ?? []);
    if (result.closed) {
      if (this.#sessions.get(runId)?.context === context) this.#sessions.delete(runId);
      if (this.#pendingContexts.get(runId) === context) this.#pendingContexts.delete(runId);
      return { kind: "cleanup.browser_context_closed", source: "browser", payload: { reason, close_resolved: true, browser_registry_absent: true }, dedupeKey: `cleanup:${runId}:browser` };
    }
    return { kind: "cleanup.browser_context_close_failed", source: "browser", payload: { reason, close_resolved: false, browser_registry_absent: false, error_class: result.errorClass }, dedupeKey: `cleanup:${runId}:browser-close-failed` };
  }

  async #waitForStartupReadiness(runId: string, session: BrowserSession, timeoutMs: number): Promise<Omit<LabEvent, "runId" | "seq" | "at">[]> {
    const deadline = Date.now() + timeoutMs;
    const drained: Omit<LabEvent, "runId" | "seq" | "at">[] = [];
    const observed = new Set<string>();
    let issuedIdentity: { stream: string; tracks: string[] } | null = null;
    let productIdentity: { stream: string; tracks: string[] } | null = null;
    while (Date.now() < deadline) {
      const batch = await this.drain(runId);
      drained.push(...batch);
      for (const event of batch) {
        if (event.source === "product" && !isValidatedAppBinding(event.payload._app_synthetic_binding, session.expectedBinding)) continue;
        observed.add(event.kind);
        if (event.kind === "harness.media_stream_issued") {
          const tracks = event.payload.track_id_sha256s;
          if (event.payload.replacement_active === true && typeof event.payload.stream_id_sha256 === "string" && Array.isArray(tracks) && tracks.every((value) => typeof value === "string")) issuedIdentity = { stream: event.payload.stream_id_sha256, tracks: [...tracks as string[]].sort() };
        }
        if (event.kind === "session.microphone_stream_acquired" && typeof event.payload.streamId === "string" && Array.isArray(event.payload.trackIds) && event.payload.trackIds.every((value) => typeof value === "string")) productIdentity = { stream: sha256(event.payload.streamId), tracks: (event.payload.trackIds as string[]).map(sha256).sort() };
        if (event.kind === "provider.stage" && ["connected", "streaming_audio"].includes(String(event.payload.stage ?? event.payload.geminiStage ?? ""))) observed.add("provider.streaming_ready");
      }
      const hasCredentials = observed.has("session.credentials_received");
      const hasHarness = observed.has("harness.initialized") && issuedIdentity !== null;
      const hasMedia = observed.has("session.microphone_stream_acquired") && productIdentity !== null && issuedIdentity !== null && issuedIdentity.stream === productIdentity.stream && JSON.stringify(issuedIdentity.tracks) === JSON.stringify(productIdentity.tracks);
      const hasProviderReceipt = observed.has("provider.connection_epoch");
      const hasStreaming = observed.has("provider.connection_observability") || observed.has("provider.streaming_ready");
      if (hasHarness && hasCredentials && hasMedia && hasProviderReceipt && hasStreaming) return drained;
      await session.page.waitForTimeout(100);
    }
    throw new VoiceLabError(labError("VOICE_START_TIMEOUT", "The ordinary voice UI did not prove the page-owned synthetic stream, credentials, and provider readiness before timeout.", "product", true, { harness_initialized: observed.has("harness.initialized"), replacement_stream_issued: issuedIdentity !== null, product_stream_acquired: productIdentity !== null, synthetic_stream_correlated: issuedIdentity !== null && productIdentity !== null && issuedIdentity.stream === productIdentity.stream && JSON.stringify(issuedIdentity.tracks) === JSON.stringify(productIdentity.tracks) }));
  }

  async #snapshotEvent(session: BrowserSession, stage: "startup" | "turn_schedule" | "finalization"): Promise<Omit<LabEvent, "runId" | "seq" | "at">> {
    const snapshot = await session.page.evaluate(() => {
      const capture = (window as any).__sophiaCapture;
      return capture?.snapshot?.() ?? capture?.export?.() ?? null;
    });
    const metadata = snapshot && typeof snapshot === "object" && (snapshot as Record<string, unknown>).metadata && typeof (snapshot as Record<string, unknown>).metadata === "object" ? (snapshot as Record<string, unknown>).metadata as Record<string, unknown> : {};
    const appBinding = validateAppSyntheticBinding(metadata.synthetic_test, session.expectedBinding);
    const serialized = JSON.stringify(snapshot);
    const payload = serialized.length <= 250_000
      ? { stage, snapshot: redact(snapshot), ...(appBinding === null ? {} : { _app_synthetic_binding: appBinding }) }
      : { stage, snapshot: null, unavailable_reason: "snapshot_exceeded_250kb_cap", observed_byte_length: Buffer.byteLength(serialized) };
    return { kind: "capture.snapshot", source: "product", payload, dedupeKey: `snapshot:${stage}:${Date.now()}` };
  }
}

export async function closeContextWithProof(
  context: Pick<BrowserContext, "close">,
  browserContexts: () => Array<Pick<BrowserContext, "close">>,
): Promise<{ closed: boolean; errorClass: string | null }> {
  let closeResolved = false;
  let errorClass: string | null = null;
  try { await context.close(); closeResolved = true; }
  catch (error) { errorClass = error instanceof Error ? error.name : "ContextCloseError"; }
  const browserRegistryAbsent = !browserContexts().includes(context);
  return { closed: closeResolved && browserRegistryAbsent, errorClass: closeResolved ? (browserRegistryAbsent ? null : "BrowserRegistryStillOwnsContext") : errorClass };
}

/**
 * Executes a privileged same-origin API request without following redirects.
 * The returned URL and successful content type are checked before any receipt
 * is trusted, so a signed capability can never be replayed at a redirect
 * target (including another path on the same origin).
 */
export async function requestBoundJson(
  request: Pick<APIRequestContext, "get" | "post">,
  method: "GET" | "POST",
  expectedUrl: string,
  timeoutMs: number,
  capability?: string,
): Promise<{ response: APIResponse; payload: Record<string, unknown> | null }> {
  const options = {
    ...(capability === undefined ? {} : { headers: { "X-Sophia-Voice-Lab-Capability": capability } }),
    failOnStatusCode: false,
    maxRedirects: 0,
    timeout: timeoutMs,
  };
  const response = method === "POST"
    ? await request.post(expectedUrl, { ...options, data: undefined })
    : await request.get(expectedUrl, options);
  if (response.url() !== expectedUrl) throw new VoiceLabError(labError("PRIVILEGED_RESPONSE_TARGET_MISMATCH", "Privileged browser API response URL did not match the exact requested origin and path.", "authorization", false, { expected_url_sha256: sha256(expectedUrl), observed_url_sha256: sha256(response.url()) }));
  if (response.status() >= 300 && response.status() < 400) throw new VoiceLabError(labError("PRIVILEGED_REDIRECT_REJECTED", "Privileged browser API request attempted a redirect and was rejected before forwarding credentials.", "authorization", false, { status: response.status() }));
  if (response.ok() && !isJsonResponse(response)) throw new VoiceLabError(labError("PRIVILEGED_RECEIPT_INVALID", "Privileged browser API returned a non-JSON success response.", "authorization"));
  const payload = isJsonResponse(response) ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
  if (response.ok() && (payload === null || typeof payload !== "object" || Array.isArray(payload))) throw new VoiceLabError(labError("PRIVILEGED_RECEIPT_INVALID", "Privileged browser API returned malformed JSON.", "authorization"));
  return { response, payload };
}

export function isExactFinalizationResponse(response: Pick<PlaywrightResponse, "url" | "request">, frontendOrigin: string): boolean {
  if (response.request().method() !== "POST") return false;
  try {
    const url = new URL(response.url());
    return url.origin === frontendOrigin && url.search === "" && url.hash === "" && (url.pathname === "/api/sophia/end-session" || url.pathname === "/api/sessions/end");
  } catch { return false; }
}

function isJsonResponse(response: Pick<APIResponse, "headers">): boolean {
  const contentType = response.headers()["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" || contentType?.endsWith("+json") === true;
}

export function assertPageLocation(pageUrl: string, expectedOrigin: string, allowedPath: (pathname: string) => boolean, code: string): void {
  let url: URL;
  try { url = new URL(pageUrl); }
  catch { throw new VoiceLabError(labError(code, "Product navigation returned an invalid URL.", "authorization")); }
  if (url.origin !== expectedOrigin || !allowedPath(url.pathname) || url.hash !== "") throw new VoiceLabError(labError(code, "Product navigation left the exact allowlisted frontend origin or route.", "authorization", false, { observed_origin_sha256: sha256(url.origin), observed_path_sha256: sha256(url.pathname) }));
}

function mapProductEvent(event: { category?: string; name?: string }): string {
  if (event.name === "gemini-output-audio-received") return "audio.output.received";
  if (event.name === "gemini-output-audio-chunk") return "audio.output.provider_chunk";
  if (event.name === "gemini-output-audio-playback-scheduled") return "audio.output.scheduled";
  if (event.name === "gemini-output-audio-playback-started") return "audio.output.started";
  if (event.name === "gemini-output-audio-playback-completed") return "audio.output.completed";
  if (event.name === "gemini-output-audio-playback-dropped") return "audio.output.dropped";
  if (event.name === "gemini-output-audio-playback-flushed") return "audio.output.flushed";
  if (event.name === "gemini-output-leg-receipt") return "audio.output.leg_receipt";
  if (event.name === "gemini-input-leg-receipt") return "audio.input.product_leg";
  if (event.name === "gemini-input-turn-receipt") return "audio.input.product_turn";
  if (event.name === "gemini-input-evidence-fault") return "audio.input.product_fault";
  if (event.name === "gemini-trace-fault-receipt") return "trace.fault_receipt";
  if (event.name === "credentials-received") return "session.credentials_received";
  if (event.name === "microphone-stream-acquired") return "session.microphone_stream_acquired";
  if (event.name === "gemini-connection-observability") return "provider.connection_observability";
  if (event.name === "gemini-provider-connection-epoch") return "provider.connection_epoch";
  if (event.name === "gemini-stage-changed") return "provider.stage";
  return `product.${event.category ?? "unknown"}.${event.name ?? "unknown"}`;
}

function projectActiveProductTarget(target: ActiveProductTarget | undefined, operationId: string): Record<string, unknown> | null {
  if (target === undefined) return null;
  const labEventSeq = Number(target.event_seq);
  const productGeneration = Number(target.product_generation);
  const productSeq = Number(target.product_seq);
  const providerConnectionEpoch = Number(target.provider_connection_epoch);
  if (typeof operationId !== "string" || !PRODUCT_SAFE_ID.test(operationId) || !Number.isSafeInteger(labEventSeq) || labEventSeq < 1
    || !Number.isSafeInteger(productGeneration) || productGeneration < 1 || !Number.isSafeInteger(productSeq) || productSeq < 1
    || !Number.isSafeInteger(providerConnectionEpoch) || providerConnectionEpoch < 1) {
    throw new VoiceLabError(labError("ACTIVE_TARGET_CAPTURE_CURSOR_INVALID", "The active target lacks an exact product capture cursor and provider epoch.", "harness", false));
  }
  if (target.kind === "output_realization") {
    const stableId = target.stable_id;
    const chunkHash = target.chunk_hash;
    const playbackGeneration = Number(target.playback_generation);
    if (typeof stableId !== "string" || !PRODUCT_SAFE_ID.test(stableId) || typeof chunkHash !== "string" || !/^[a-f0-9]{64}$/.test(chunkHash)
      || !Number.isSafeInteger(playbackGeneration) || playbackGeneration < 0) {
      throw new VoiceLabError(labError("ACTIVE_TARGET_IDENTITY_INVALID", "The output active target identity is malformed.", "harness", false));
    }
    return { kind: "output_realization", operationId, labEventSeq, productGeneration, productSeq, stableId, chunkHash, providerConnectionEpoch, playbackGeneration };
  }
  const toolCallId = target.tool_call_id ?? target.stable_id;
  const effectId = target.effect_id;
  if (typeof toolCallId !== "string" || !PRODUCT_SAFE_ID.test(toolCallId) || typeof effectId !== "string" || !PRODUCT_SAFE_ID.test(effectId)) {
    throw new VoiceLabError(labError("ACTIVE_TARGET_IDENTITY_INVALID", "The tool active target identity is malformed.", "harness", false));
  }
  return { kind: "tool_effect", operationId, labEventSeq, productGeneration, productSeq, toolCallId, effectId, providerConnectionEpoch };
}
function cursorGap(source: string, after: number, minimum: number, reason?: string): VoiceLabError { return new VoiceLabError(labError("CAPTURE_CURSOR_GAP", `${source} capture cursor advanced beyond undrained events.`, "harness", false, { after, minimum, ...(reason === undefined ? {} : { reason }) })); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function deploymentComponent(value: { commitSha: string; deploymentId: string | null; serviceId: string | null }): Record<string, unknown> {
  return {
    commit_sha: value.commitSha,
    deployment_id: value.deploymentId,
    service_id: value.serviceId,
    availability: {
      deployment_id: value.deploymentId ? "available" : "endpoint_field_unavailable",
      service_id: value.serviceId ? "available" : "endpoint_field_unavailable",
    },
  };
}

type ExpectedSyntheticBinding = BrowserSession["expectedBinding"];
const PRODUCT_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const D02_BROWSER_CONTEXT_KEYS = [
  "voice_lab_run_id_sha256",
  "browser_worker_id_sha256",
  "browser_lease_epoch",
  "browser_context_id_sha256",
] as const;

export function validateD02BrowserContextBinding(run: RunRecord, binding: D02BrowserContextBinding | undefined): D02BrowserContextBinding | undefined {
  if (run.scenarioId !== "V-D02") {
    if (binding !== undefined) throw browserContextBindingMismatch("forbidden_for_scenario");
    return undefined;
  }
  if (!binding || Object.keys(binding).length !== D02_BROWSER_CONTEXT_KEYS.length || Object.keys(binding).some((key) => !D02_BROWSER_CONTEXT_KEYS.includes(key as typeof D02_BROWSER_CONTEXT_KEYS[number]))
    || !SHA256.test(binding.voice_lab_run_id_sha256) || binding.voice_lab_run_id_sha256 !== sha256(run.id)
    || !SHA256.test(binding.browser_worker_id_sha256)
    || !Number.isSafeInteger(binding.browser_lease_epoch) || binding.browser_lease_epoch < 1
    || !SHA256.test(binding.browser_context_id_sha256)) {
    throw browserContextBindingMismatch("malformed_or_wrong_run");
  }
  return { ...binding };
}

function sameD02BrowserContextBinding(value: Record<string, unknown> | null | undefined, expected: D02BrowserContextBinding | undefined): boolean {
  const candidate = value ?? {};
  const present = D02_BROWSER_CONTEXT_KEYS.filter((key) => candidate[key] !== undefined);
  if (expected === undefined) return present.length === 0;
  return present.length === D02_BROWSER_CONTEXT_KEYS.length
    && candidate.voice_lab_run_id_sha256 === expected.voice_lab_run_id_sha256
    && candidate.browser_worker_id_sha256 === expected.browser_worker_id_sha256
    && candidate.browser_lease_epoch === expected.browser_lease_epoch
    && candidate.browser_context_id_sha256 === expected.browser_context_id_sha256;
}

type D02ProductCleanupEcho = {
  browser_provider_close_receipts: Record<string, unknown>[];
  browser_provider_activation_abort_receipts: Record<string, unknown>[];
};

function hasExactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const exact = [...expected].sort();
  return keys.length === exact.length && keys.every((key, index) => key === exact[index]);
}

export function validateD02ProductCleanupEcho(value: unknown, providerSessionId: string, frozenEpochs: readonly number[]): D02ProductCleanupEcho {
  if (!PRODUCT_SAFE_ID.test(providerSessionId) || !hasExactObjectKeys(value, ["browser_provider_close_receipts", "browser_provider_activation_abort_receipts"])) {
    throw new VoiceLabError(labError("D02_PRODUCT_CLEANUP_ACK_INVALID", "The product cleanup acknowledgement envelope was malformed.", "evidence", false));
  }
  const closeReceipts = value.browser_provider_close_receipts;
  const abortReceipts = value.browser_provider_activation_abort_receipts;
  if (!Array.isArray(closeReceipts) || !Array.isArray(abortReceipts)) throw new VoiceLabError(labError("D02_PRODUCT_CLEANUP_ACK_INVALID", "The product cleanup acknowledgement arrays were malformed.", "evidence", false));
  const closeEpochs: number[] = [];
  for (const receipt of closeReceipts) {
    if (!hasExactObjectKeys(receipt, ["schema", "receipt_id", "session_id", "provider_connection_epoch", "websocket_close_observed", "websocket_close_code", "websocket_closed_at"])
      || receipt.schema !== "sophia_gemini_browser_provider_close_v1" || typeof receipt.receipt_id !== "string" || !UUID_V4.test(receipt.receipt_id)
      || receipt.session_id !== providerSessionId || !Number.isSafeInteger(receipt.provider_connection_epoch) || Number(receipt.provider_connection_epoch) < 1
      || receipt.websocket_close_observed !== true || !Number.isSafeInteger(receipt.websocket_close_code) || Number(receipt.websocket_close_code) < 1000 || Number(receipt.websocket_close_code) > 4999
      || !canonicalUtcMillis(receipt.websocket_closed_at)) {
      throw new VoiceLabError(labError("D02_PRODUCT_CLEANUP_ACK_INVALID", "A product browser-close receipt was malformed or cross-bound.", "evidence", false));
    }
    closeEpochs.push(Number(receipt.provider_connection_epoch));
  }
  const abortEpochs: number[] = [];
  for (const receipt of abortReceipts) {
    if (!hasExactObjectKeys(receipt, ["schema", "receipt_id", "session_id", "previous_activated_epoch", "candidate_epoch", "websocket_created", "aborted_at"])
      || receipt.schema !== "sophia_gemini_browser_provider_activation_abort_v1" || typeof receipt.receipt_id !== "string" || !UUID_V4.test(receipt.receipt_id)
      || receipt.session_id !== providerSessionId || !Number.isSafeInteger(receipt.previous_activated_epoch) || Number(receipt.previous_activated_epoch) < 0
      || !Number.isSafeInteger(receipt.candidate_epoch) || Number(receipt.candidate_epoch) < 1 || Number(receipt.candidate_epoch) !== Number(receipt.previous_activated_epoch) + 1
      || receipt.websocket_created !== false || !canonicalUtcMillis(receipt.aborted_at)) {
      throw new VoiceLabError(labError("D02_PRODUCT_CLEANUP_ACK_INVALID", "A product activation-abort receipt was malformed or cross-bound.", "evidence", false));
    }
    abortEpochs.push(Number(receipt.candidate_epoch));
  }
  if (closeEpochs.some((epoch, index) => index > 0 && epoch <= closeEpochs[index - 1]!) || abortEpochs.some((epoch, index) => index > 0 && epoch <= abortEpochs[index - 1]!)) {
    throw new VoiceLabError(labError("D02_PRODUCT_CLEANUP_ACK_INVALID", "The product cleanup receipt arrays were not canonical.", "evidence", false));
  }
  const acceptedEpochs = [...closeEpochs, ...abortEpochs].sort((left, right) => left - right);
  if (new Set(acceptedEpochs).size !== acceptedEpochs.length || acceptedEpochs.length !== frozenEpochs.length || acceptedEpochs.some((epoch, index) => epoch !== frozenEpochs[index])) {
    throw new VoiceLabError(labError("D02_PRODUCT_CLEANUP_EPOCH_DRIFT", "The accepted product cleanup receipt union did not equal the exact frozen provider epochs.", "evidence", false));
  }
  return {
    browser_provider_close_receipts: closeReceipts.map((receipt) => ({ ...receipt })),
    browser_provider_activation_abort_receipts: abortReceipts.map((receipt) => ({ ...receipt })),
  };
}

/**
 * Validate the original product-authored capture-envelope binding, then retain
 * only hashes plus governed catalog fields. Absence is typed by callers as
 * unavailable; a present-but-malformed or cross-run binding is a hard abort.
 */
export function validateAppSyntheticBinding(value: unknown, expected: ExpectedSyntheticBinding): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw productBindingMismatch("malformed");
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["synthetic", "principal_id", "test_run_id", "cleanup_obligation_id", "scenario_id", "scenario_version", "voice_lab_run_id_sha256", "browser_worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256", "environment", "retention_hours", "provider_expires_at"]);
  const safeOptional = (item: unknown): item is string | undefined => item === undefined || (typeof item === "string" && PRODUCT_SAFE_ID.test(item));
  if (
    candidate.synthetic !== true
    || Object.keys(candidate).some((key) => !allowed.has(key))
    || typeof candidate.principal_id !== "string" || !PRODUCT_SAFE_ID.test(candidate.principal_id)
    || typeof candidate.test_run_id !== "string" || !PRODUCT_SAFE_ID.test(candidate.test_run_id)
    || typeof candidate.cleanup_obligation_id !== "string" || !UUID_V4.test(candidate.cleanup_obligation_id)
    || typeof candidate.environment !== "string" || !PRODUCT_SAFE_ID.test(candidate.environment)
    || !Number.isSafeInteger(candidate.retention_hours) || Number(candidate.retention_hours) < 1 || Number(candidate.retention_hours) > 168
    || !canonicalUtcMillis(candidate.provider_expires_at)
    || !safeOptional(candidate.scenario_id)
    || !safeOptional(candidate.scenario_version)
  ) throw productBindingMismatch("malformed");
  const expectedScenarioId = expected.scenarioId ?? undefined;
  const expectedScenarioVersion = expected.scenarioVersion ?? undefined;
  if (
    candidate.principal_id !== expected.principalId
    || candidate.test_run_id !== expected.testRunId
    || candidate.cleanup_obligation_id !== expected.cleanupObligationId
    || candidate.environment !== expected.environment
    || candidate.retention_hours !== expected.retentionHours
    || candidate.provider_expires_at !== expected.providerExpiresAt
    || candidate.scenario_id !== expectedScenarioId
    || candidate.scenario_version !== expectedScenarioVersion
    || !sameD02BrowserContextBinding(candidate, expected.browserContextBinding)
  ) throw productBindingMismatch("does_not_match_reserved_run");
  return {
    app_authenticated: true,
    synthetic: true,
    principal_id_sha256: sha256(expected.principalId),
    test_run_id_sha256: sha256(expected.testRunId),
    cleanup_obligation_id_sha256: sha256(expected.cleanupObligationId),
    environment: expected.environment,
    scenario_id: expected.scenarioId,
    scenario_version: expected.scenarioVersion,
    retention_hours: expected.retentionHours,
    provider_expires_at: expected.providerExpiresAt,
    ...(expected.browserContextBinding ?? {}),
  };
}

function isValidatedAppBinding(value: unknown, expected: ExpectedSyntheticBinding): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return binding.app_authenticated === true
    && binding.synthetic === true
    && binding.principal_id_sha256 === sha256(expected.principalId)
    && binding.test_run_id_sha256 === sha256(expected.testRunId)
    && binding.cleanup_obligation_id_sha256 === sha256(expected.cleanupObligationId)
    && binding.environment === expected.environment
    && binding.scenario_id === expected.scenarioId
    && binding.scenario_version === expected.scenarioVersion
    && binding.retention_hours === expected.retentionHours
    && binding.provider_expires_at === expected.providerExpiresAt
    && sameD02BrowserContextBinding(binding, expected.browserContextBinding);
}

function canonicalUtcMillis(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function productBindingMismatch(reason: string): VoiceLabError {
  return new VoiceLabError(labError("PRODUCT_RUN_BINDING_MISMATCH", "Product capture provenance did not match the exact authenticated synthetic run.", "harness", false, { reason }));
}

function browserContextBindingMismatch(reason: string): VoiceLabError {
  return new VoiceLabError(labError("BROWSER_CONTEXT_BINDING_MISMATCH", "Browser context ownership did not match the exact V-D02 run, worker, and lease.", "harness", false, { reason }));
}

type ProductCursor = { generation: number; seq: number };
type ProductCaptureEvent = { generation?: number; seq: number; recordedAt?: string; category?: string; name?: string; payload?: Record<string, unknown>; synthetic_test?: unknown };
type ProductCapturePage = {
  generation: number;
  requestedGeneration: number | null;
  requestedSeq: number;
  returnedSeq: number;
  oldestSeq: number | null;
  latestSeq: number;
  totalProduced: number | null;
  droppedCount: number | null;
  capacity: number | null;
  eventCount: number;
  gap: false;
};
type ProductReadResult = { unsupported?: boolean; cursor?: ProductCursor | null; events?: ProductCaptureEvent[]; metadata?: { generation?: number | null; capacity?: number | null; oldestSeq?: number | null; latestSeq?: number | null; totalProduced?: number | null; droppedCount?: number | null; gap?: boolean; gapReason?: string | null } | null };

export async function drainProductCapture(initialCursor: ProductCursor | null, readAfter: (cursor: ProductCursor | null) => Promise<ProductReadResult>): Promise<{ cursor: ProductCursor; events: Array<ProductCaptureEvent & { generation: number }>; pages: ProductCapturePage[] }> {
  let cursor = initialCursor;
  const events: Array<ProductCaptureEvent & { generation: number }> = [];
  const pages: ProductCapturePage[] = [];
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const prior = cursor;
    const page = await readAfter(prior);
    if (page.unsupported || !page.metadata || !page.cursor || !Array.isArray(page.events)) throw new VoiceLabError(labError("CAPTURE_DRAIN_UNSUPPORTED", "Deployed frontend lacks the required generation-aware capture drain contract.", "harness"));
    if (page.metadata.gap) throw cursorGap("product", prior?.seq ?? 0, Number(page.metadata.oldestSeq ?? 0), String(page.metadata.gapReason ?? "unknown"));
    for (const event of page.events) {
      if (event.seq <= (prior?.seq ?? 0)) continue;
      events.push({ ...event, generation: page.cursor.generation });
    }
    pages.push({
      generation: page.cursor.generation,
      requestedGeneration: prior?.generation ?? null,
      requestedSeq: prior?.seq ?? 0,
      returnedSeq: page.cursor.seq,
      oldestSeq: page.metadata.oldestSeq ?? null,
      latestSeq: Number(page.metadata.latestSeq ?? page.cursor.seq),
      totalProduced: page.metadata.totalProduced ?? null,
      droppedCount: page.metadata.droppedCount ?? null,
      capacity: page.metadata.capacity ?? null,
      eventCount: page.events.filter((event) => event.seq > (prior?.seq ?? 0)).length,
      gap: false,
    });
    cursor = page.cursor;
    const latestSeq = Number(page.metadata.latestSeq ?? page.cursor.seq);
    if (page.cursor.seq >= latestSeq) return { cursor: page.cursor, events, pages };
    if (prior !== null && prior.generation === page.cursor.generation && prior.seq === page.cursor.seq) throw cursorGap("product", prior.seq, Number(page.metadata.oldestSeq ?? 0), "drain_made_no_progress");
  }
  throw new VoiceLabError(labError("CAPTURE_DRAIN_PAGE_LIMIT", "Capture drain exceeded the bounded 10,000-event page limit.", "harness"));
}
