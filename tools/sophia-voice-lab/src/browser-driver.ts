import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type BrowserServer, type Page, type Response as PlaywrightResponse } from "playwright";

import type { ResolvedAudio } from "./audio.js";
import { buildVoiceLabInitScript } from "./browser-init.js";
import type { VoiceLabConfig } from "./config.js";
import { VoiceLabError, labError, type DeploymentDependencies, type DeploymentIdentity, type LabEvent, type RunRecord } from "./domain.js";
import { canonicalRequestHash, redact, sha256, validateAllowedOrigin } from "./security.js";

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

const CONTROL_ADAPTER_RECEIPT_KEYS = [
  "ok", "schema", "action", "test_run_id", "scenario_id", "scenario_version",
  "cleanup_obligation_id", "expected_deployment", "control_epoch_sha256",
  "expires_at", "ordinary_user_access",
] as const;
const CONTROL_ADAPTER_RECEIPT_HEADER = "x-sophia-voice-lab-control-receipt";

/** The synthetic principal's committed onboarding state selects reduced motion.
 * Mirror that ordinary accessibility preference at the browser media-query
 * layer so canvas-heavy session visuals take their authored static path. */
export const VOICE_LAB_BROWSER_CONTEXT_OPTIONS = {
  serviceWorkers: "block",
  reducedMotion: "reduce",
} as const;

export function decodeVoiceLabControlAdapterReceiptHeader(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
}

/** Follow the ordinary session UI through both authored exit confirmations.
 * The second guard is conditional: it appears only while Sophia is still
 * draining output after the public assistant turn has completed. */
export async function clickEndSessionThroughExitGuards(page: Pick<Page, "getByRole">): Promise<void> {
  const end = page.getByRole("button", { name: /^End session$/i }).first();
  await end.waitFor({ state: "visible", timeout: 10_000 });
  await end.click();
  const confirm = page.getByRole("button", { name: /^end session$/i }).last();
  await confirm.waitFor({ state: "visible", timeout: 5_000 });
  await confirm.click();
  const leaveAnyway = page.getByRole("button", { name: /^Leave anyway$/i }).last();
  if (await leaveAnyway.isVisible({ timeout: 2_000 }).catch(() => false)) await leaveAnyway.click();
}

export function validateVoiceLabControlAdapterReceipt(
  receipt: unknown,
  action: "session-start" | "voice-start",
  run: Pick<RunRecord, "testRunId" | "scenarioId" | "scenarioVersion" | "cleanupObligationId" | "target">,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Record<string, unknown> | null {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const value = receipt as Record<string, unknown>;
  const expected = value.expected_deployment;
  const keys = Object.keys(value).sort();
  const allowed = [...CONTROL_ADAPTER_RECEIPT_KEYS].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) return null;
  if (value.ok !== true || value.schema !== "sophia_voice_lab_control_adapter_v1" || value.action !== action
    || value.test_run_id !== run.testRunId || value.scenario_id !== run.scenarioId || value.scenario_version !== run.scenarioVersion
    || value.cleanup_obligation_id !== run.cleanupObligationId || value.ordinary_user_access !== false
    || typeof value.control_epoch_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.control_epoch_sha256)
    || !Number.isSafeInteger(value.expires_at) || Number(value.expires_at) <= nowSeconds
    || !expected || typeof expected !== "object" || Array.isArray(expected)
    || canonicalRequestHash(expected) !== canonicalRequestHash(run.target.expectedDeployment)) return null;
  return value;
}

export const SYNTHETIC_FINALIZATION_EXCLUSION_KEYS = [
  "memory", "offline_pipeline", "learning", "ordinary_product_analytics",
  "ordinary_user_projects", "shared_spaces", "debrief",
] as const;

/** Polling delays must remain owned by the worker. A Playwright page timer is
 * serviced by the renderer and can therefore outlive the worker watchdog when
 * the ordinary product main thread is unresponsive. */
export async function waitOnWorkerClock(delayMs: number): Promise<void> {
  await sleep(Math.max(0, delayMs));
}

async function observeOnWorkerClock<T>(
  operation: () => Promise<T>,
  fallback: T,
  timeoutMs = 250,
): Promise<T> {
  return Promise.race([
    operation().then((value) => value, () => fallback),
    sleep(timeoutMs).then(() => fallback),
  ]);
}

type ClientPageErrorDiagnostic = {
  error_class: string;
  safe_signature: string;
  next_chunk: string | null;
  next_frames: Array<{ chunk: string; line: number; column: number }>;
  digest: string | null;
};
type ClientChunkFrame = { chunk: string; line: number; column: number };
export type SessionNavigationResponseDiagnostic = {
  transport: "document" | "route_fetch";
  status: number;
  ok: boolean;
  completion: "pending" | "finished" | "failed";
};

/** Observe only the fixed transport/status/completion state of a same-origin
 * `/session` response. The response body, URL parameters, headers, and failure
 * text are intentionally excluded from the diagnostic. */
export function observeSessionNavigationResponse(
  response: PlaywrightResponse,
  frontendOrigin: string,
  update: (diagnostic: SessionNavigationResponseDiagnostic) => void,
  active: () => boolean = () => true,
): void {
  let target: URL;
  try {
    target = new URL(response.url());
  } catch {
    return;
  }
  if (target.origin !== frontendOrigin || !/^\/session(?:\/|$)/.test(target.pathname)) return;
  const resourceType = response.request().resourceType();
  if (resourceType !== "document" && resourceType !== "fetch" && resourceType !== "xhr") return;
  const base = {
    transport: resourceType === "document" ? "document" as const : "route_fetch" as const,
    status: response.status(),
    ok: response.ok(),
  };
  if (!active()) return;
  update({ ...base, completion: "pending" });
  void response.finished().then(() => {
    if (active()) update({ ...base, completion: "finished" });
  }).catch(() => {
    if (active()) update({ ...base, completion: "failed" });
  });
}
export function classifyBrowserStartCause(error: unknown): {
  error_class: string;
  safe_signature: string;
  character_length: number;
} {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const errorClass = typeof record?.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(record.name)
    ? record.name
    : "Error";
  const message = typeof record?.message === "string" ? record.message : String(error);
  return { error_class: errorClass, safe_signature: `sha256:${sha256(message)}`, character_length: message.length };
}

export type SessionVoiceRouteDiagnostic = {
  page_closed: boolean;
  location: "expected_session" | "dashboard" | "same_origin_other" | "cross_origin" | "invalid";
  document_ready_state: "loading" | "interactive" | "complete" | "unavailable";
  document_navigation_matches_session_route: boolean;
  document_body_children: "zero" | "one" | "multiple" | "unavailable";
  next_flight_payload_present: boolean;
  voice_tab: "absent" | "hidden" | "disabled" | "selected" | "available";
  voice_button: "absent" | "hidden" | "disabled" | "ready" | "active_listening" | "active_thinking" | "active_speaking" | "active_ptt";
  dashboard_mic_visible: boolean;
  dashboard_mic_button: "absent" | "hidden" | "disabled" | "available";
  consent_visible: boolean;
  auth_gate_visible: boolean;
  auth_checking_visible: boolean;
  auth_authenticated_children_present: boolean;
  auth_unauthenticated_present: boolean;
  protected_consent_pending_present: boolean;
  protected_content_ready_present: boolean;
  session_content_mounted_present: boolean;
  session_route_loading_present: boolean;
  session_store_loading_visible: boolean;
  voice_fallback_visible: boolean;
};

export function shouldCaptureSessionVoiceRoute(stage: string): boolean {
  return stage === "dashboard_privacy_consent"
    || stage === "dashboard_microphone_cta"
    || stage === "voice_tab_selection"
    || stage.startsWith("voice_start");
}

/** Project only fixed, product-authored UI states. Never serialize arbitrary
 * page text, URLs, attributes, or user data into an MCP error. */
export async function classifySessionVoiceRoute(
  page: Page,
  frontendOrigin: string,
  readyButtonName: string,
): Promise<SessionVoiceRouteDiagnostic> {
  let location: SessionVoiceRouteDiagnostic["location"] = "invalid";
  try {
    const current = new URL(page.url());
    location = current.origin !== frontendOrigin
      ? "cross_origin"
      : /^\/session(?:\/|$)/.test(current.pathname) && current.hash === ""
        ? "expected_session"
        : current.pathname === "/" && current.hash === ""
          ? "dashboard"
          : "same_origin_other";
  } catch {
    location = "invalid";
  }

  const documentState: {
    readyState: "loading" | "interactive" | "complete" | "unavailable";
    bodyChildren: "zero" | "one" | "multiple" | "unavailable";
    navigationMatchesSession: boolean;
    nextFlightPresent: boolean;
  } = await observeOnWorkerClock(() => page.evaluate((expectedOrigin) => {
    const readyState = document.readyState === "loading" || document.readyState === "interactive" || document.readyState === "complete"
      ? document.readyState
      : "unavailable";
    const childCount = document.body?.childElementCount;
    const bodyChildren = typeof childCount !== "number"
      ? "unavailable"
      : childCount === 0
        ? "zero"
        : childCount === 1
          ? "one"
          : "multiple";
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    let navigationMatchesSession = false;
    try {
      const target = new URL(navigation?.name ?? "");
      navigationMatchesSession = target.origin === expectedOrigin && /^\/session(?:\/|$)/.test(target.pathname);
    } catch {
      navigationMatchesSession = false;
    }
    return {
      readyState,
      bodyChildren,
      navigationMatchesSession,
      nextFlightPresent: Array.from(document.scripts).some((script) => (script.textContent ?? "").includes("self.__next_f.push")),
    };
  }, frontendOrigin), {
    readyState: "unavailable" as const,
    bodyChildren: "unavailable" as const,
    navigationMatchesSession: false,
    nextFlightPresent: false,
  });

  const voiceTab = page.getByRole("tab", { name: /^voice$/i }).first();
  const voiceTabCount = await observeOnWorkerClock(() => voiceTab.count(), 0);
  const voiceTabVisible = voiceTabCount > 0 && await observeOnWorkerClock(() => voiceTab.isVisible(), false);
  const voiceTabDisabled = voiceTabVisible && !await observeOnWorkerClock(() => voiceTab.isEnabled(), false);
  const voiceTabSelected = voiceTabVisible && await observeOnWorkerClock(() => voiceTab.getAttribute("aria-selected"), null) === "true";
  const voice_tab: SessionVoiceRouteDiagnostic["voice_tab"] = voiceTabCount === 0
    ? "absent"
    : !voiceTabVisible
      ? "hidden"
      : voiceTabDisabled
        ? "disabled"
        : voiceTabSelected
          ? "selected"
          : "available";

  const buttonStates: Array<{ state: SessionVoiceRouteDiagnostic["voice_button"]; name: string }> = [
    { state: "ready", name: readyButtonName },
    { state: "active_listening", name: "Listening..." },
    { state: "active_thinking", name: "Thinking..." },
    { state: "active_speaking", name: "Speaking..." },
    { state: "active_ptt", name: "Recording... release to send" },
  ];
  let voice_button: SessionVoiceRouteDiagnostic["voice_button"] = "absent";
  for (const candidate of buttonStates) {
    const button = page.getByRole("button", { name: candidate.name, exact: true }).first();
    if (await observeOnWorkerClock(() => button.count(), 0) === 0) continue;
    if (!await observeOnWorkerClock(() => button.isVisible(), false)) {
      if (voice_button === "absent") voice_button = "hidden";
      continue;
    }
    voice_button = !await observeOnWorkerClock(() => button.isEnabled(), false) ? "disabled" : candidate.state;
    break;
  }

  const micAnchor = page.locator('[data-onboarding="mic-cta"]').first();
  const structuralMicButton = micAnchor.locator("xpath=../button[1]");
  const semanticMicButton = page.getByRole("button", { name: /^Start (?:open session|prepare|debrief|reset|vent)$/i }).first();
  const micButton = await observeOnWorkerClock(() => structuralMicButton.count(), 0) > 0 ? structuralMicButton : semanticMicButton;
  const micButtonCount = await observeOnWorkerClock(() => micButton.count(), 0);
  const micButtonVisible = micButtonCount > 0 && await observeOnWorkerClock(() => micButton.isVisible(), false);
  const dashboard_mic_button: SessionVoiceRouteDiagnostic["dashboard_mic_button"] = micButtonCount === 0
    ? "absent"
    : !micButtonVisible
      ? "hidden"
      : !await observeOnWorkerClock(() => micButton.isEnabled(), false)
        ? "disabled"
        : "available";

  return {
    page_closed: page.isClosed(),
    location,
    document_ready_state: documentState.readyState,
    document_navigation_matches_session_route: documentState.navigationMatchesSession,
    document_body_children: documentState.bodyChildren,
    next_flight_payload_present: documentState.nextFlightPresent,
    voice_tab,
    voice_button,
    dashboard_mic_visible: await observeOnWorkerClock(() => micAnchor.isVisible(), false),
    dashboard_mic_button,
    consent_visible: await observeOnWorkerClock(() => page.locator(CONSENT_ACCEPT_SELECTOR).first().isVisible(), false),
    auth_gate_visible: await observeOnWorkerClock(() => page.getByRole("button", { name: "Continue with Google", exact: true }).first().isVisible(), false),
    auth_checking_visible: await observeOnWorkerClock(() => page.locator('[data-voice-lab-route-state="auth-checking"]').first().isVisible(), false),
    auth_authenticated_children_present: await observeOnWorkerClock(() => page.locator('[data-voice-lab-route-state="auth-authenticated-children"]').count(), 0) > 0,
    auth_unauthenticated_present: await observeOnWorkerClock(() => page.locator('[data-voice-lab-route-state="auth-unauthenticated"]').count(), 0) > 0,
    protected_consent_pending_present: await observeOnWorkerClock(() => page.locator('[data-voice-lab-route-state="protected-consent-pending"]').count(), 0) > 0,
    protected_content_ready_present: await observeOnWorkerClock(() => page.locator('[data-voice-lab-route-state="protected-content-ready"]').count(), 0) > 0,
    session_content_mounted_present: await observeOnWorkerClock(() => page.locator('[data-voice-lab-route-state="session-content-mounted"]').count(), 0) > 0,
    session_route_loading_present: await observeOnWorkerClock(() => page.locator('[data-voice-lab-route-state="session-route-loading"]').count(), 0) > 0,
    session_store_loading_visible: await observeOnWorkerClock(() => page.locator('[data-voice-lab-route-state="session-store-loading"]').first().isVisible(), false),
    voice_fallback_visible: await observeOnWorkerClock(() => page.getByText("Voice input unavailable", { exact: true }).first().isVisible(), false),
  };
}

/** Keep production browser failures actionable without projecting arbitrary
 * exception text, URLs, query strings, or user data into MCP error details. */
export function classifyClientPageError(error: unknown): ClientPageErrorDiagnostic {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const errorClass = typeof record?.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(record.name)
    ? record.name
    : "Error";
  const message = typeof record?.message === "string" ? record.message : String(error);
  const undefinedProperty = /^Cannot read properties of (undefined|null) \(reading ['"]([A-Za-z_$][A-Za-z0-9_$.-]{0,79})['"]\)$/.exec(message);
  const missingIdentifier = /^([A-Za-z_$][A-Za-z0-9_$]{0,79}) is not defined$/.exec(message);
  const nonFunctionIdentifier = /^([A-Za-z_$][A-Za-z0-9_$]{0,79}) is not a function$/.exec(message);
  const reactCode = /Minified React error #(\d{1,6})/.exec(message);
  const safeSignature = undefinedProperty
    ? `${undefinedProperty[1]}_property:${undefinedProperty[2]}`
    : missingIdentifier
      ? `identifier_not_defined:${missingIdentifier[1]}`
      : nonFunctionIdentifier
        ? `identifier_not_function:${nonFunctionIdentifier[1]}`
        : reactCode
        ? `react_error:${reactCode[1]}`
        : message === "Maximum call stack size exceeded"
          ? "maximum_call_stack"
          : `unclassified_sha256:${sha256(message)}`;
  const stack = typeof record?.stack === "string" ? record.stack : "";
  const nextChunk = /\/_next\/static\/chunks\/([A-Za-z0-9._-]{1,160}\.js)(?::\d+){0,2}/.exec(stack)?.[1] ?? null;
  const nextFrames = [...stack.matchAll(/\/_next\/static\/chunks\/([A-Za-z0-9._-]{1,160}\.js):(\d{1,8}):(\d{1,8})/g)]
    .slice(0, 5)
    .map((match) => ({ chunk: match[1]!, line: Number(match[2]), column: Number(match[3]) }));
  const rawDigest = record?.digest;
  const digest = typeof rawDigest === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(rawDigest) ? rawDigest : null;
  return { error_class: errorClass, safe_signature: safeSignature, next_chunk: nextChunk, next_frames: nextFrames, digest };
}

/** Chromium console events can retain a source location when Error.stack drops
 * coordinates. Project only Next chunk coordinates and normalize Playwright's
 * zero-based location to the one-based stack-frame convention. */
export function classifyClientConsoleErrorLocation(location: {
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}, expectedOrigin: string): ClientChunkFrame | null {
  let locationUrl: URL;
  try { locationUrl = new URL(location.url ?? ""); } catch { return null; }
  const chunk = /^\/_next\/static\/chunks\/([A-Za-z0-9._-]{1,160}\.js)$/.exec(locationUrl.pathname)?.[1];
  const lineNumber = location.lineNumber;
  const columnNumber = location.columnNumber;
  if (locationUrl.origin !== expectedOrigin || !chunk || !Number.isInteger(lineNumber) || !Number.isInteger(columnNumber)
    || Number(lineNumber) < 0 || Number(columnNumber) < 0
    || Number(lineNumber) > 99_999_999 || Number(columnNumber) > 99_999_999) return null;
  return { chunk, line: Number(lineNumber) + 1, column: Number(columnNumber) + 1 };
}
export function withClientDiagnosticFrames(
  diagnostic: ClientPageErrorDiagnostic | null,
  frames: ClientChunkFrame[],
): ClientPageErrorDiagnostic | null {
  if (!diagnostic || frames.length === 0) return diagnostic;
  if (diagnostic.next_frames.length > 0
    || (diagnostic.next_chunk !== null && !frames.some((frame) => diagnostic.next_chunk === frame.chunk))) return diagnostic;
  return { ...diagnostic, next_chunk: diagnostic.next_chunk ?? frames[0]!.chunk, next_frames: frames.slice(0, 5) };
}

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

export type BrowserStartStage =
  | "frontend_auth_grant"
  | "frontend_auth_session"
  | "browser_init_script"
  | "frontend_home_navigation"
  | "control_adapter_session_start"
  | "control_adapter_voice_start"
  | "dashboard_privacy_consent"
  | "dashboard_microphone_cta"
  | "session_navigation"
  | "session_navigation_recovery_reload"
  | "voice_tab_selection"
  | "voice_start_button"
  | "voice_start_recovery_reload"
  | "voice_startup_readiness";

export interface VoiceBrowserDriver {
  verifyTarget(run: RunRecord): Promise<DriverStartResult>;
  start(run: RunRecord, frontendCapability: string, browserContextBinding?: D02BrowserContextBinding, onStage?: (stage: BrowserStartStage) => Promise<void>): Promise<DriverStartResult>;
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
  ownership: OwnedBrowserProcess;
  context: BrowserContext;
  page: Page;
  harnessCursor: number;
  productCursor: { generation: number; seq: number } | null;
  latestProviderReceipt: (Record<string, unknown> & { _seq: number }) | null;
  contextExpiresAt: number;
  expectedBinding: { testRunId: string; cleanupObligationId: string; principalId: string; scenarioId: string | null; scenarioVersion: string | null; environment: string; retentionHours: number; providerExpiresAt: string; browserContextBinding?: D02BrowserContextBinding };
  startupPush: StartupPushState;
}

export type OwnedBrowserProcess = {
  browser: Browser;
  server: BrowserServer;
  child: ChildProcess;
  processId: number;
  processIdSha256: string;
  bootIdSha256: string;
  executionEpochSha256: string;
  startedAt: string;
};

const RUN_BROWSER_ARGS = ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"] as const;

export function browserProcessOwnershipHashes(input: {
  runId: string;
  cleanupObligationId: string;
  processId: number;
  nonce: string;
  startedAt: string;
}): { processIdSha256: string; bootIdSha256: string; executionEpochSha256: string } {
  if (!Number.isSafeInteger(input.processId) || input.processId < 1 || !UUID_V4.test(input.nonce)
    || !Number.isFinite(new Date(input.startedAt).getTime()) || new Date(input.startedAt).toISOString() !== input.startedAt) {
    throw new VoiceLabError(labError("BROWSER_PROCESS_OWNERSHIP_INVALID", "Browser process ownership inputs were malformed.", "harness", false));
  }
  const processIdSha256 = sha256(String(input.processId));
  const bootIdSha256 = sha256(canonicalRequestHash({ process_id_sha256: processIdSha256, nonce: input.nonce, started_at: input.startedAt }));
  const executionEpochSha256 = sha256(canonicalRequestHash({ run_id: input.runId, cleanup_obligation_id: input.cleanupObligationId, boot_id_sha256: bootIdSha256 }));
  return { processIdSha256, bootIdSha256, executionEpochSha256 };
}

export async function launchDisposableBrowserProcess(
  run: Pick<RunRecord, "id" | "cleanupObligationId">,
  launchServer: (options: Parameters<typeof chromium.launchServer>[0]) => ReturnType<typeof chromium.launchServer> = (options) => chromium.launchServer(options),
  connect: (endpoint: string) => ReturnType<typeof chromium.connect> = (endpoint) => chromium.connect(endpoint),
): Promise<OwnedBrowserProcess> {
  const server = await launchServer({ headless: true, args: [...RUN_BROWSER_ARGS] });
  const child = server.process();
  const processId = child.pid;
  if (!Number.isSafeInteger(processId) || Number(processId) < 1) {
    await server.close().catch(() => undefined);
    throw new VoiceLabError(labError("BROWSER_PROCESS_OWNERSHIP_INVALID", "Chromium did not expose an owned process identity.", "harness", false));
  }
  const startedAt = new Date().toISOString();
  const hashes = browserProcessOwnershipHashes({
    runId: run.id,
    cleanupObligationId: run.cleanupObligationId,
    processId: Number(processId),
    nonce: randomUUID(),
    startedAt,
  });
  try {
    const browser = await connect(server.wsEndpoint());
    return { browser, server, child, processId: Number(processId), startedAt, ...hashes };
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

export async function closeDisposableBrowserProcess(ownership: OwnedBrowserProcess): Promise<{ closed: boolean; errorClass: string | null }> {
  let errorClass: string | null = null;
  await ownership.browser.close().catch((error: unknown) => { errorClass = error instanceof Error ? error.name : "BrowserCloseError"; });
  await ownership.server.close().catch((error: unknown) => { errorClass ??= error instanceof Error ? error.name : "BrowserServerCloseError"; });
  for (let attempt = 0; attempt < 20 && ownership.child.exitCode === null && ownership.child.signalCode === null; attempt += 1) {
    await waitOnWorkerClock(50);
  }
  if (ownership.child.exitCode === null && ownership.child.signalCode === null) {
    ownership.child.kill("SIGKILL");
    for (let attempt = 0; attempt < 20 && ownership.child.exitCode === null && ownership.child.signalCode === null; attempt += 1) {
      await waitOnWorkerClock(50);
    }
  }
  const closed = !ownership.browser.isConnected()
    && (ownership.child.exitCode !== null || ownership.child.signalCode !== null);
  return { closed, errorClass: closed ? null : errorClass ?? "BrowserProcessStillAlive" };
}

export function disposableBrowserProcessIsActive(ownership: OwnedBrowserProcess): boolean {
  return ownership.browser.isConnected()
    && ownership.child.exitCode === null
    && ownership.child.signalCode === null;
}

type StartupPushEnvelope = {
  page: Page;
  channel: "harness" | "product" | "control";
  payload: unknown;
};

type StartupPushState = {
  active: boolean;
  overflow: boolean;
  queue: StartupPushEnvelope[];
};

const PAGE_PUSH_BINDING_NAME = "__sophiaVoiceLabPushV1";
const MAX_STARTUP_PUSH_EVENTS = 4_096;

const CONSENT_ACCEPT_SELECTOR = '[data-voice-lab="consent-accept"]';
export const SESSION_NAVIGATION_ROUTE_TIMEOUT_MS = 75_000;

export class PlaywrightVoiceDriver implements VoiceBrowserDriver {
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #pendingContexts = new Map<string, BrowserContext>();
  readonly #pendingProcesses = new Map<string, OwnedBrowserProcess>();
  readonly #startingRuns = new Set<string>();
  #browser: Browser | null = null;
  #browserLaunch: Promise<Browser> | null = null;
  #readinessCache: { expiresAt: number; value: { ok: boolean; detail: string; engine?: string; version?: string } } | null = null;
  #readinessInFlight: Promise<{ ok: boolean; detail: string; engine?: string; version?: string }> | null = null;

  constructor(
    readonly config: VoiceLabConfig,
    readonly fetchImpl: typeof fetch = fetch,
    readonly launchBrowser: (options: Parameters<typeof chromium.launch>[0]) => ReturnType<typeof chromium.launch> = (options) => chromium.launch(options),
    readonly checkExecutable: (file: string, mode: number) => Promise<void> = access,
    readonly launchBrowserServer: (options: Parameters<typeof chromium.launchServer>[0]) => ReturnType<typeof chromium.launchServer> = (options) => chromium.launchServer(options),
    readonly connectBrowser: (endpoint: string) => ReturnType<typeof chromium.connect> = (endpoint) => chromium.connect(endpoint),
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

  async start(run: RunRecord, frontendCapability: string, browserContextBinding?: D02BrowserContextBinding, onStage?: (stage: BrowserStartStage) => Promise<void>): Promise<DriverStartResult> {
    if (this.#sessions.has(run.id) || this.#pendingProcesses.has(run.id) || this.#startingRuns.has(run.id)) throw new VoiceLabError(labError("BROWSER_ALREADY_STARTED", "Run already owns or is acquiring a browser process.", "conflict"));
    this.#startingRuns.add(run.id);
    const prepared = await (async () => {
      const exactBrowserContextBinding = validateD02BrowserContextBinding(run, browserContextBinding);
      const deployment = await this.#verifyDeployment(run);
      const frontendOrigin = validateAllowedOrigin(run.target.frontendUrl, this.config.allowedOrigins).origin;
      const ownership = await this.#launchOwnedBrowserProcess(run);
      this.#pendingProcesses.set(run.id, ownership);
      return { exactBrowserContextBinding, deployment, frontendOrigin, ownership };
    })().finally(() => {
      this.#startingRuns.delete(run.id);
    });
    const { exactBrowserContextBinding, deployment, frontendOrigin, ownership } = prepared;
    const observedDeployment = deployment.identity;
    const browser = ownership.browser;
    const startupPush: StartupPushState = { active: true, overflow: false, queue: [] };
    const installPushBinding = async (targetContext: BrowserContext): Promise<void> => {
      await targetContext.exposeBinding(PAGE_PUSH_BINDING_NAME, (source, raw: unknown) => {
        if (!startupPush.active || raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const envelope = raw as Record<string, unknown>;
        if (envelope.schema !== "sophia_voice_lab_page_push_v1") return undefined;
        if (envelope.channel !== "harness" && envelope.channel !== "product") return undefined;
        if (startupPush.queue.length >= MAX_STARTUP_PUSH_EVENTS) {
          startupPush.overflow = true;
          return undefined;
        }
        startupPush.queue.push({ page: source.page, channel: envelope.channel, payload: envelope.payload });
        return undefined;
      });
    };
    let context: BrowserContext;
    try {
      // The server-issued grant creates the dedicated synthetic Better Auth
      // session inside this new context. Importing cookies or Web Storage from
      // another browser is forbidden: every run begins with an empty origin
      // store and acquires all authority through the bound grant response.
      context = await browser.newContext(VOICE_LAB_BROWSER_CONTEXT_OPTIONS);
      await installPushBinding(context);
    } catch (error) {
      await this.#closeOwnedBrowserProcess(ownership);
      this.#pendingProcesses.delete(run.id);
      throw error;
    }
    this.#pendingContexts.set(run.id, context);
    let ordinaryRouteStage: BrowserStartStage = "frontend_auth_grant";
    const enterStage = async (stage: BrowserStartStage): Promise<void> => {
      ordinaryRouteStage = stage;
      await onStage?.(stage);
    };
    let latestClientPageError: ClientPageErrorDiagnostic | null = null;
    let page: Page | null = null;
    let latestClientConsoleFrames: ClientChunkFrame[] = [];
    let latestSessionNavigationResponse: SessionNavigationResponseDiagnostic | null = null;
    const currentClientPageErrorDiagnostic = (): ClientPageErrorDiagnostic | null =>
      withClientDiagnosticFrames(latestClientPageError, latestClientConsoleFrames);
    try {
      // No OS/browser microphone permission is granted. The init script's
      // page-owned MediaStreamDestination is the only accepted audio stream;
      // if that replacement is absent, native gUM stays denied and startup
      // cannot allocate a provider from a physical microphone.
      await enterStage("frontend_auth_grant");
      const grantUrl = new URL(this.config.authGrantPath, frontendOrigin).toString();
      const { response: grantResponse, payload: grantReceipt } = await requestBoundJsonWithOneTransientRetry(context.request, "POST", grantUrl, 15_000, frontendCapability);
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
      await enterStage("frontend_auth_session");
      const { response: authSession, payload: authIdentity } = await requestBoundJson(context.request, "GET", authSessionUrl, 10_000);
      const authUser = authIdentity?.user as Record<string, unknown> | undefined;
      if (!authSession.ok() || authUser?.id !== run.principalId) throw new VoiceLabError(labError("AUTH_PRINCIPAL_MISMATCH", "The browser session is not bound to the exact dedicated Voice Lab principal.", "authorization", false, { observed_principal_sha256: typeof authUser?.id === "string" ? sha256(authUser.id) : null }));
      await enterStage("browser_init_script");
      const initScriptContent = buildVoiceLabInitScript({ pageOrigin: frontendOrigin, websocketOrigins: [...this.config.websocketOrigins], maxAudioBytes: this.config.maxAudioBytes, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId });
      await context.addInitScript({ content: initScriptContent });
      await enterStage("frontend_home_navigation");
      let activePage = await context.newPage();
      page = activePage;
      const attachPageDiagnostics = (targetPage: Page): void => {
        targetPage.on("pageerror", (error) => {
          latestClientPageError = classifyClientPageError(error);
        });
        targetPage.on("console", (message) => {
          if (message.type() !== "error") return;
          const frame = classifyClientConsoleErrorLocation(message.location(), frontendOrigin);
          if (frame) latestClientConsoleFrames = [frame];
        });
        targetPage.on("response", (response) => {
          if (!startupPush.active) return;
          let action: "session-start" | "voice-start" | null = null;
          try {
            const target = new URL(response.url());
            if (target.origin !== frontendOrigin) return;
            observeSessionNavigationResponse(
              response,
              frontendOrigin,
              (diagnostic) => { latestSessionNavigationResponse = diagnostic; },
              () => startupPush.active,
            );
            if (response.status() !== 200) return;
            if (target.pathname === "/api/voice-lab/control/session-start") action = "session-start";
            if (target.pathname === "/api/voice-lab/control/voice-start") action = "voice-start";
          } catch {
            return;
          }
          if (action === null) return;
          const enqueueReceipt = (receipt: unknown): boolean => {
            if (!startupPush.active) return false;
            const value = validateVoiceLabControlAdapterReceipt(receipt, action, run);
            if (!value) return false;
            if (startupPush.queue.length >= MAX_STARTUP_PUSH_EVENTS) {
              startupPush.overflow = true;
              return true;
            }
            startupPush.queue.push({ page: targetPage, channel: "control", payload: value });
            return true;
          };
          const headerReceipt = decodeVoiceLabControlAdapterReceiptHeader(
            response.headers()[CONTROL_ADAPTER_RECEIPT_HEADER],
          );
          if (enqueueReceipt(headerReceipt)) return;
          void response.json().then((receipt: unknown) => {
            enqueueReceipt(receipt);
          }).catch(() => undefined);
        });
      };
      attachPageDiagnostics(page);
      const session: BrowserSession = { ownership, context, page: activePage, harnessCursor: 0, productCursor: null, latestProviderReceipt: null, contextExpiresAt: Number(grantReceipt.expires_at), expectedBinding: { testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, principalId: run.principalId, scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion, environment: run.environment, retentionHours: run.capturePolicy.retentionHours, providerExpiresAt: run.expiresAt.toISOString(), ...(exactBrowserContextBinding === undefined ? {} : { browserContextBinding: exactBrowserContextBinding }) }, startupPush };
      this.#sessions.set(run.id, session);
      this.#pendingContexts.delete(run.id);
      this.#pendingProcesses.delete(run.id);
      await page.goto(new URL("/", frontendOrigin).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      assertPageLocation(page.url(), frontendOrigin, (pathname) => pathname === "/", "ORDINARY_UI_ORIGIN_DRIFT");
      await enterStage("control_adapter_session_start");
      await activePage.waitForURL(
        (url) => url.origin === frontendOrigin && /^\/session(?:\/|$)/.test(url.pathname) && url.hash === "",
        { timeout: SESSION_NAVIGATION_ROUTE_TIMEOUT_MS, waitUntil: "commit" },
      );
      assertPageLocation(page.url(), frontendOrigin, (pathname) => /^\/session(?:\/|$)/.test(pathname), "ORDINARY_UI_ORIGIN_DRIFT");
      await enterStage("control_adapter_voice_start");
      await enterStage("voice_startup_readiness");
      const events = await this.#waitForStartupReadiness(
        session,
        45_000,
        frontendOrigin,
        currentClientPageErrorDiagnostic,
        () => latestClientConsoleFrames.slice(0, 5),
        () => latestSessionNavigationResponse,
      );
      events.push(...this.#drainStartupPush(session));
      events.push({
        kind: "harness.browser_process_acquired",
        source: "browser",
        payload: {
          schema: "sophia_voice_lab_browser_process_ownership_v1",
          voice_lab_run_id_sha256: sha256(run.id),
          cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
          process_id_sha256: ownership.processIdSha256,
          browser_boot_id_sha256: ownership.bootIdSha256,
          execution_epoch_sha256: ownership.executionEpochSha256,
          started_at: ownership.startedAt,
          one_process_per_run: true,
          raw_process_id_excluded: true,
        },
        dedupeKey: `browser-process:${ownership.executionEpochSha256}`,
      });
      events.push({ kind: "deployment.verified", source: "canonical", payload: deployment.components, dedupeKey: `deployment:${run.id}:startup` });
      // A renderer snapshot is intentionally deferred until after start has
      // released the worker operation lease. The push receipts above already
      // prove the exact page-owned stream and product/provider binding while
      // the just-started media stack is settling.
      events.push({ kind: "capture.snapshot", source: "product", payload: { stage: "startup", snapshot: null, unavailable_reason: "deferred_until_post_start_renderer_command" }, dedupeKey: `snapshot:startup:${Date.now()}` });
      startupPush.active = false;
      return { observedDeployment, events, ...(exactBrowserContextBinding === undefined ? {} : { browserContextBinding: exactBrowserContextBinding }) };
    } catch (error) {
      startupPush.active = false;
      // A validated grant has allocated a Better Auth session. Retain that
      // context for worker.abort(), which owns the separately minted cleanup
      // capability and must revoke the login before closing the browser.
      if (this.#sessions.get(run.id)?.context === context) {
        if (error instanceof VoiceLabError) throw error;
        throw new VoiceLabError(labError("ORDINARY_UI_ROUTE_FAILED", "The ordinary deployed Sophia voice route could not be established.", "harness", false, { stage: ordinaryRouteStage, cause: classifyBrowserStartCause(error), client_page_error: currentClientPageErrorDiagnostic(), client_console_error_frames: latestClientConsoleFrames.slice(0, 5), session_navigation_response: latestSessionNavigationResponse, route_state: shouldCaptureSessionVoiceRoute(ordinaryRouteStage) && page ? await classifySessionVoiceRoute(page, frontendOrigin, this.config.startButtonName) : null }));
      }
      const closed = await closeContextWithProof(context, () => ownership.browser.contexts());
      const processClosed = closed.closed ? await this.#closeOwnedBrowserProcess(ownership) : { closed: false, errorClass: closed.errorClass };
      if (closed.closed && processClosed.closed) { this.#sessions.delete(run.id); this.#pendingContexts.delete(run.id); this.#pendingProcesses.delete(run.id); }
      else throw new VoiceLabError(labError("BROWSER_CONTEXT_CLOSE_FAILED", "Failed start left a browser context or process that could not be proven closed.", "harness", true, { original_error_class: error instanceof VoiceLabError ? error.detail.code : error instanceof Error ? error.name : "Error", close_error_class: closed.errorClass ?? processClosed.errorClass }));
      if (error instanceof VoiceLabError) throw error;
      throw new VoiceLabError(labError("ORDINARY_UI_ROUTE_FAILED", "The ordinary deployed Sophia voice route could not be established.", "harness", false, { stage: ordinaryRouteStage, cause: classifyBrowserStartCause(error), client_page_error: currentClientPageErrorDiagnostic(), client_console_error_frames: latestClientConsoleFrames.slice(0, 5), session_navigation_response: latestSessionNavigationResponse, route_state: shouldCaptureSessionVoiceRoute(ordinaryRouteStage) && page ? await classifySessionVoiceRoute(page, frontendOrigin, this.config.startButtonName) : null }));
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
    return { receipt: { product: redact(receipt as Record<string, unknown>), execution_epoch_sha256: session.ownership.executionEpochSha256 }, events };
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
      await waitOnWorkerClock(100);
    }
    if (!restoration) throw new VoiceLabError(labError("SOCKET_ROTATION_TIMEOUT", "No product restored/degraded provider epoch receipt arrived before timeout.", "product", true, { expected_epoch: expectedEpoch }));
    if (restoration.phase === "degraded") throw new VoiceLabError(labError("SOCKET_ROTATION_DEGRADED", "Product continuity degraded after socket rotation.", "product", false, { expected_epoch: expectedEpoch, receipt: redact(restoration) }));
    return { receipt: { harness: redact(receipt as Record<string, unknown>), product: redact(restoration), execution_epoch_sha256: session.ownership.executionEpochSha256 }, events };
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
    return [{ kind: "auth.session_continued", source: "canonical", payload: { test_run_id: run.testRunId, expires_at: receipt.expires_at, session_preserved: true, execution_epoch_sha256: session.ownership.executionEpochSha256, ...(session.expectedBinding.browserContextBinding ?? {}) }, dedupeKey: `auth-continue:${run.id}:${receipt.expires_at}` }];
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
        if (Date.now() < deadline) await waitOnWorkerClock(250);
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

  #drainStartupPush(session: BrowserSession): Omit<LabEvent, "runId" | "seq" | "at">[] {
    if (session.startupPush.overflow) {
      throw new VoiceLabError(labError("STARTUP_PUSH_OVERFLOW", "Startup capture exceeded the bounded worker push queue.", "harness", false));
    }
    const queued = session.startupPush.queue.splice(0);
    const events: Omit<LabEvent, "runId" | "seq" | "at">[] = [];
    for (const envelope of queued) {
      // Fresh-context recovery can leave the old page alive briefly while its
      // best-effort close settles. Only the currently owned exact page may
      // advance startup cursors.
      if (envelope.page !== session.page || envelope.payload === null
        || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) continue;
      const raw = envelope.payload as Record<string, unknown>;
      if (envelope.channel === "control") {
        events.push({
          kind: `control.adapter_authorized.${String(raw.action)}`,
          source: "canonical",
          payload: redact(raw),
          dedupeKey: `control-adapter:${String(raw.action)}:${String(raw.control_epoch_sha256)}`,
        });
        continue;
      }
      if (envelope.channel === "harness") {
        if (!Number.isSafeInteger(raw.seq) || Number(raw.seq) < 1 || typeof raw.kind !== "string"
          || raw.payload === null || typeof raw.payload !== "object" || Array.isArray(raw.payload)) continue;
        const seq = Number(raw.seq);
        if (seq <= session.harnessCursor) continue;
        if (seq !== session.harnessCursor + 1) throw cursorGap("harness", session.harnessCursor, seq, "startup_push_sequence_gap");
        session.harnessCursor = seq;
        events.push({
          kind: raw.kind,
          source: "browser",
          payload: redact({ ...(raw.payload as Record<string, unknown>), _capture_provenance: { source: "voice-lab-init-push", seq, observed_at: typeof raw.observed_at === "string" ? raw.observed_at : null } }),
          dedupeKey: `browser:${seq}`,
        });
        continue;
      }
      if (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 1
        || !Number.isSafeInteger(raw.seq) || Number(raw.seq) < 1) continue;
      const generation = Number(raw.generation);
      const seq = Number(raw.seq);
      if (session.productCursor) {
        if (generation === session.productCursor.generation && seq <= session.productCursor.seq) continue;
        if (generation !== session.productCursor.generation || seq !== session.productCursor.seq + 1) {
          throw cursorGap("product", session.productCursor.seq, seq, "startup_push_sequence_gap");
        }
      } else if (seq !== 1) {
        throw cursorGap("product", 0, seq, "startup_push_initial_gap");
      }
      const product = raw as ProductCaptureEvent;
      const appBinding = validateAppSyntheticBinding(product.synthetic_test, session.expectedBinding);
      session.productCursor = { generation, seq };
      events.push({
        kind: mapProductEvent(product),
        source: "product",
        payload: redact({
          ...(product.payload ?? {}),
          ...(appBinding === null ? {} : { _app_synthetic_binding: appBinding }),
          _capture_provenance: { generation, seq, recorded_at: product.recordedAt ?? null, category: product.category ?? null, name: product.name ?? null },
        }),
        dedupeKey: `product:${generation}:${seq}`,
      });
      if (appBinding !== null && product.name === "gemini-provider-connection-epoch"
        && product.payload?.receipt && typeof product.payload.receipt === "object") {
        session.latestProviderReceipt = { ...(product.payload.receipt as Record<string, unknown>), _seq: seq };
      }
    }
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
      await clickEndSessionThroughExitGuards(session.page);
      const response = await finalizationResponse;
      if (!response || response.status() !== 202 || !isJsonResponse(response)) throw new VoiceLabError(labError("PRODUCT_FINALIZATION_UNCONFIRMED", "The ordinary UI did not produce an exact-origin JSON 202 product finalization receipt.", "product", true, { status: response?.status() ?? null }));
      const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
      const evidenceReceipt = responseBody?.evidence_receipt as Record<string, unknown> | undefined;
      if (!hasExactFinalizationEnvelope(run, responseBody, true) || typeof evidenceReceipt?.sha256 !== "string") throw new VoiceLabError(labError("FINALIZATION_ISOLATION_UNCONFIRMED", "Finalization receipt did not prove the bound synthetic run, cleanup obligation, exact retention policy, durable evidence, and exact isolation exclusions.", "product", false));
      const events: Omit<LabEvent, "runId" | "seq" | "at">[] = [];
      const closeDeadline = Date.now() + 10_000;
      let providerClosedEvent: Omit<LabEvent, "runId" | "seq" | "at"> | null = null;
      while (Date.now() < closeDeadline) {
        const batch = await this.drain(run.id);
        events.push(...batch);
        providerClosedEvent = batch.find((event) => event.kind === "provider.stage" && isValidatedAppBinding(event.payload._app_synthetic_binding, session.expectedBinding) && (event.payload.stage === "closed" || event.payload.stage === "ended")) ?? null;
        if (providerClosedEvent) break;
        await waitOnWorkerClock(100);
      }
      if (!providerClosedEvent) throw new VoiceLabError(labError("PROVIDER_CLEANUP_UNCONFIRMED", "Product finalization succeeded but provider transport closure was not observed.", "product", true));
      events.push(this.#providerTransportClosedEvent(run, session, providerClosedEvent));
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
      events.push({ kind: "auth.session_cleanup", source: "canonical", payload: redact({
        ...cleanupReceipt,
        cleanup_proof_schema: "sophia_voice_lab_execution_epoch_auth_cleanup_v1",
        voice_lab_run_id_sha256: sha256(run.id),
        cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
        process_id_sha256: session.ownership.processIdSha256,
        browser_boot_id_sha256: session.ownership.bootIdSha256,
        execution_epoch_sha256: session.ownership.executionEpochSha256,
      }), dedupeKey: `canonical:${run.id}:auth-cleanup` });
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
          await clickEndSessionThroughExitGuards(session.page);
          const response = await finalizationResponse;
          const receipt = response && response.status() === 202 && isJsonResponse(response) ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
          const confirmed = Boolean(response?.ok() && hasExactFinalizationEnvelope(run, receipt, true));
          events.push({ kind: "cleanup.product_finalization", source: "canonical", payload: redact({ confirmed, http_status: response?.status() ?? null, receipt }), dedupeKey: `cleanup:${run.id}:product-finalization` });
          if (confirmed) events.push({ kind: "session.finalized", source: "canonical", payload: redact({ http_status: response?.status() ?? null, receipt }), dedupeKey: `canonical:${run.id}:finalized` });
          if (confirmed) {
            const deadline = Date.now() + 8_000;
            let providerClosedEvent: Omit<LabEvent, "runId" | "seq" | "at"> | null = null;
            while (Date.now() < deadline) {
              const batch = await this.drain(run.id);
              events.push(...batch);
              providerClosedEvent = batch.find((event) => event.kind === "provider.stage" && isValidatedAppBinding(event.payload._app_synthetic_binding, session.expectedBinding) && ["closed", "ended"].includes(String(event.payload.stage))) ?? null;
              if (providerClosedEvent) break;
              await waitOnWorkerClock(100);
            }
            if (providerClosedEvent) events.push(this.#providerTransportClosedEvent(run, session, providerClosedEvent));
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
        events.push({ kind: "auth.session_cleanup", source: "canonical", payload: redact({
          status: cleanup?.status() ?? null,
          receipt,
          confirmed: Boolean(cleanup?.ok() && (receipt as any)?.session_revoked === true && (receipt as any)?.cookies_cleared === true && (receipt as any)?.test_run_id === run.testRunId && (receipt as any)?.cleanup_obligation_id === run.cleanupObligationId),
          cleanup_proof_schema: "sophia_voice_lab_execution_epoch_auth_cleanup_v1",
          voice_lab_run_id_sha256: sha256(run.id),
          cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
          process_id_sha256: session.ownership.processIdSha256,
          browser_boot_id_sha256: session.ownership.bootIdSha256,
          execution_epoch_sha256: session.ownership.executionEpochSha256,
        }), dedupeKey: `cleanup:${run.id}:auth` });
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
      // Live resource cleanup is an independent terminal boundary. For an
      // allocation-free failure, product evidence may not exist yet, so the
      // first truthful receipt can prove live zero before a retention deadline
      // is materialized. Evidence publication and retention remain separately
      // governed below and must never hold browser/provider cleanup open.
      const liveComplete = response.status === 200 && receipt?.ok === true && receipt?.complete === true && receipt?.live_cleanup_complete === true && receipt?.live_resources_zero === true && receipt?.test_run_id === run.testRunId && cleanupBound && liveComponentComplete && authoritativeBuilderZero && durable;
      const pending = response.status === 202 && receipt?.ok === true && receipt?.complete === false && receipt?.live_resources_zero !== true && receipt?.test_run_id === run.testRunId && cleanupBound && typeof receipt?.recovery_id === "string";
      const recoveryState = retentionPurged
        ? "retention-purged"
        : liveComplete && retentionPending
          ? "live-complete-retention-pending"
          : liveComplete
            ? "live-complete-retention-unsettled"
            : pending
              ? "pending"
              : "failed";
      const recoveryPayload = redact({ complete: liveComplete, pending, live_cleanup_complete: liveComplete, retention_purge_pending: retentionPending, retention_purged: retentionPurged, retention_purge_due_at: purgeDueValid ? purgeDueRaw : null, http_status: response.status, receipt });
      // Each Gateway recovery attempt is separately durable evidence. Pending
      // attempts legitimately carry new attempt receipts, so a state-only key
      // would collide even though the canonical payload changed. Hash the
      // already-redacted payload so exact transport replays dedupe while later
      // attempts remain append-only evidence.
      return { events: [{ kind: "cleanup.recovery", source: "canonical", payload: recoveryPayload, dedupeKey: `recovery:${run.id}:${recoveryState}:${canonicalRequestHash(recoveryPayload)}` }], artifacts: [] };
    } catch (error) {
      return { events: [{ kind: "cleanup.recovery", source: "canonical", payload: { complete: false, pending: false, unavailable_reason: error instanceof Error ? error.name : "recovery_failed" }, dedupeKey: `recovery:${run.id}:unavailable` }], artifacts: [] };
    }
  }

  async cancel(runId: string, _reason: string): Promise<void> {
    const session = this.#sessions.get(runId);
    const context = session?.context ?? this.#pendingContexts.get(runId);
    const ownership = session?.ownership ?? this.#pendingProcesses.get(runId);
    if (!context && !ownership) return;
    const result = context
      ? await closeContextWithProof(context, () => ownership?.browser.contexts() ?? [])
      : { closed: true, errorClass: null };
    const processResult = result.closed && ownership
      ? await this.#closeOwnedBrowserProcess(ownership)
      : { closed: ownership === undefined, errorClass: result.errorClass };
    if (!result.closed || !processResult.closed) throw new VoiceLabError(labError("BROWSER_PROCESS_CLOSE_FAILED", "Cancelled operation left a browser context or process that could not be proven closed.", "harness", true, { error_class: result.errorClass ?? processResult.errorClass }));
    this.#sessions.delete(runId);
    this.#pendingContexts.delete(runId);
    this.#pendingProcesses.delete(runId);
  }

  async close(): Promise<void> {
    const ownerships = [...new Set([...this.#sessions.values()].map((session) => session.ownership).concat([...this.#pendingProcesses.values()]))];
    const results = await Promise.all(ownerships.map((ownership) => this.#closeOwnedBrowserProcess(ownership)));
    if (results.some((result) => !result.closed)) throw new VoiceLabError(labError("BROWSER_PROCESS_CLOSE_FAILED", "Worker shutdown could not prove every owned browser process closed.", "harness", true, { unresolved_processes: results.filter((result) => !result.closed).length }));
    this.#sessions.clear(); this.#pendingContexts.clear(); this.#pendingProcesses.clear();
    if (this.#browser) await this.#browser.close();
    this.#browser = null;
    this.#readinessCache = null;
  }

  async #launchOwnedBrowserProcess(run: RunRecord): Promise<OwnedBrowserProcess> {
    return launchDisposableBrowserProcess(run, this.launchBrowserServer, this.connectBrowser);
  }

  async #closeOwnedBrowserProcess(ownership: OwnedBrowserProcess): Promise<{ closed: boolean; errorClass: string | null }> {
    return closeDisposableBrowserProcess(ownership);
  }

  async #ensureBrowser(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    this.#browserLaunch ??= this.launchBrowser({ headless: true, args: [...RUN_BROWSER_ARGS] });
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
      const context = await browser.newContext(VOICE_LAB_BROWSER_CONTEXT_OPTIONS);
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
    if (!disposableBrowserProcessIsActive(session.ownership)) throw new VoiceLabError(labError("BROWSER_EXECUTION_EPOCH_LOST", "The run-owned browser process is no longer active; this execution epoch is fenced and cannot be reconstructed.", "harness", false, { execution_epoch_sha256: session.ownership.executionEpochSha256 }));
    return session;
  }

  #providerTransportClosedEvent(
    run: RunRecord,
    session: BrowserSession,
    providerEvent: Omit<LabEvent, "runId" | "seq" | "at">,
  ): Omit<LabEvent, "runId" | "seq" | "at"> {
    return {
      kind: "cleanup.provider_transport_closed",
      source: "canonical",
      payload: {
        schema: "sophia_voice_lab_execution_epoch_provider_cleanup_v1",
        voice_lab_run_id_sha256: sha256(run.id),
        cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
        process_id_sha256: session.ownership.processIdSha256,
        browser_boot_id_sha256: session.ownership.bootIdSha256,
        execution_epoch_sha256: session.ownership.executionEpochSha256,
        provider_stage: String(providerEvent.payload.stage),
        provider_event_sha256: canonicalRequestHash({ kind: providerEvent.kind, payload: redact(providerEvent.payload) }),
        exact_product_binding_validated: true,
        raw_process_and_provider_identifiers_excluded: true,
      },
      dedupeKey: `cleanup:${run.id}:provider:${session.ownership.executionEpochSha256}`,
    };
  }

  async #closeContextEvent(runId: string, context: BrowserContext, reason: string): Promise<Omit<LabEvent, "runId" | "seq" | "at">> {
    const session = this.#sessions.get(runId);
    const ownership = session?.ownership ?? this.#pendingProcesses.get(runId);
    const result = await closeContextWithProof(context, () => ownership?.browser.contexts() ?? []);
    const processResult = result.closed && ownership
      ? await this.#closeOwnedBrowserProcess(ownership)
      : { closed: ownership === undefined, errorClass: result.errorClass };
    if (result.closed && processResult.closed) {
      if (this.#sessions.get(runId)?.context === context) this.#sessions.delete(runId);
      if (this.#pendingContexts.get(runId) === context) this.#pendingContexts.delete(runId);
      this.#pendingProcesses.delete(runId);
      return { kind: "cleanup.browser_context_closed", source: "browser", payload: {
        schema: "sophia_voice_lab_execution_epoch_browser_cleanup_v1",
        voice_lab_run_id_sha256: sha256(runId),
        cleanup_obligation_id_sha256: session ? sha256(session.expectedBinding.cleanupObligationId) : null,
        reason,
        close_resolved: true,
        browser_registry_absent: true,
        browser_process_close_resolved: true,
        browser_process_disconnected: true,
        process_id_sha256: ownership?.processIdSha256 ?? null,
        browser_boot_id_sha256: ownership?.bootIdSha256 ?? null,
        execution_epoch_sha256: ownership?.executionEpochSha256 ?? null,
        raw_process_id_excluded: true,
      }, dedupeKey: `cleanup:${runId}:browser` };
    }
    return { kind: "cleanup.browser_context_close_failed", source: "browser", payload: { reason, close_resolved: result.closed, browser_registry_absent: result.closed && processResult.closed, browser_process_close_resolved: processResult.closed, execution_epoch_sha256: ownership?.executionEpochSha256 ?? null, error_class: result.errorClass ?? processResult.errorClass }, dedupeKey: `cleanup:${runId}:browser-close-failed` };
  }

  async #waitForStartupReadiness(
    session: BrowserSession,
    timeoutMs: number,
    frontendOrigin: string,
    clientPageErrorDiagnostic: () => ClientPageErrorDiagnostic | null,
    clientConsoleErrorFrames: () => ClientChunkFrame[],
    sessionNavigationResponse: () => SessionNavigationResponseDiagnostic | null,
  ): Promise<Omit<LabEvent, "runId" | "seq" | "at">[]> {
    const deadline = Date.now() + timeoutMs;
    const drained: Omit<LabEvent, "runId" | "seq" | "at">[] = [];
    const observed = new Set<string>();
    let issuedIdentity: { stream: string; tracks: string[] } | null = null;
    let productIdentity: { stream: string; tracks: string[] } | null = null;
    while (Date.now() < deadline) {
      const batch = this.#drainStartupPush(session);
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
      const hasControlAdapter = observed.has("control.adapter_authorized.session-start")
        && observed.has("control.adapter_authorized.voice-start");
      if (hasControlAdapter && hasHarness && hasCredentials && hasMedia && hasProviderReceipt && hasStreaming) return drained;
      await waitOnWorkerClock(100);
    }
    const routeState = await classifySessionVoiceRoute(session.page, frontendOrigin, this.config.startButtonName);
    throw new VoiceLabError(labError("VOICE_START_TIMEOUT", "The ordinary voice UI did not prove the page-owned synthetic stream, credentials, and provider readiness before timeout.", "product", true, {
      control_adapter_session_start_authorized: observed.has("control.adapter_authorized.session-start"),
      control_adapter_voice_start_authorized: observed.has("control.adapter_authorized.voice-start"),
      authorized_action_invoking: observed.has("product.voice-lab-control.authorized-action-invoking"),
      authorized_action_completed: observed.has("product.voice-lab-control.authorized-action-completed"),
      authorized_action_failed: observed.has("product.voice-lab-control.authorized-action-failed"),
      start_talking_requested: observed.has("product.voice-session.start-talking-requested"),
      start_talking_rejected: observed.has("product.voice-session.start-talking-rejected"),
      start_talking_ignored: observed.has("product.voice-session.start-talking-ignored"),
      start_talking_failed: observed.has("product.voice-session.start-talking-failed"),
      credentials_received: observed.has("session.credentials_received"),
      harness_initialized: observed.has("harness.initialized"),
      replacement_stream_issued: issuedIdentity !== null,
      product_stream_acquired: productIdentity !== null,
      provider_connection_epoch: observed.has("provider.connection_epoch"),
      provider_streaming_observed: observed.has("provider.connection_observability") || observed.has("provider.streaming_ready"),
      synthetic_stream_correlated: issuedIdentity !== null && productIdentity !== null && issuedIdentity.stream === productIdentity.stream && JSON.stringify(issuedIdentity.tracks) === JSON.stringify(productIdentity.tracks),
      route_state: routeState,
      client_page_error: clientPageErrorDiagnostic(),
      client_console_error_frames: clientConsoleErrorFrames(),
      session_navigation_response: sessionNavigationResponse(),
    }));
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

/** The frontend grant is idempotent for one exact capability. Retry only one
 * transport failure or 5xx response, reusing that same capability so an
 * uncertain first attempt cannot allocate a second logical session. */
export async function requestBoundJsonWithOneTransientRetry(
  request: Pick<APIRequestContext, "get" | "post">,
  method: "GET" | "POST",
  expectedUrl: string,
  timeoutMs: number,
  capability: string,
  retryDelayMs = 250,
): Promise<{ response: APIResponse; payload: Record<string, unknown> | null }> {
  let first: { response: APIResponse; payload: Record<string, unknown> | null } | null = null;
  try {
    first = await requestBoundJson(request, method, expectedUrl, timeoutMs, capability);
  } catch (error) {
    if (error instanceof VoiceLabError) throw error;
  }
  if (first && first.response.status() < 500) return first;
  if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  return requestBoundJson(request, method, expectedUrl, timeoutMs, capability);
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
