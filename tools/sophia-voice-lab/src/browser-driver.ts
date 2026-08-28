import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";

import { chromium, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Locator, type Page, type Response as PlaywrightResponse } from "playwright";

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

export const RECOVERABLE_DASHBOARD_LOAD_ERROR = /^This page couldn['’]t load\.?$/;
export const RECOVERABLE_DASHBOARD_RELOAD_BUTTON = "Reload";

type ClientPageErrorDiagnostic = {
  error_class: string;
  safe_signature: string;
  next_chunk: string | null;
  next_frames: Array<{ chunk: string; line: number; column: number }>;
  digest: string | null;
  effect_probe?: ClientEffectProbe;
  effect_probe_status?: ClientEffectProbeStatus;
};
type ClientChunkFrame = { chunk: string; line: number; column: number };
type ClientValueType = "undefined" | "function" | "object" | "boolean" | "number" | "string" | "symbol" | "bigint" | "other";
type ClientEffectProbe = {
  create_type: ClientValueType;
  destroy_type?: ClientValueType;
  effect_tag: number | null;
  owner_fiber_tag: number | null;
  owner_props: "on_ready" | "on_authenticated" | "children_only" | "no_props" | "other" | "unavailable";
  owner_frame: ClientChunkFrame | null;
};
type ClientEffectProbeStatus = {
  preloaded_candidates: number;
  preloaded_resolved_locations: number;
  dynamic_breakpoints_installed: number;
  breakpoint_pauses: number;
  exception_pauses: number;
  evaluation_attempts: number;
  effect_record_matches: number;
  snapshot_count: number;
};
type TimedClientChunkFrames = { observedAt: number; frames: ClientChunkFrame[]; effectProbe?: ClientEffectProbe };
type PassiveEffectBreakpointBase = {
  line_number: number;
  column_number: number;
  effect_variable: string;
  owner_variable: string;
};
type PassiveEffectBreakpoint = (PassiveEffectBreakpointBase & {
  probe_kind: "create";
  create_variable: string;
}) | (PassiveEffectBreakpointBase & {
  probe_kind: "create_catch";
  exception_variable: string;
}) | (PassiveEffectBreakpointBase & {
  probe_kind: "destroy";
  instance_variable: string;
  destroy_variable: string;
});
type PreloadedPassiveEffectBreakpoint = PassiveEffectBreakpoint & {
  url_regex: string;
};

/** Locate React's minified passive-effect create call without depending on a
 * build-specific chunk name or byte offset. The returned identifiers are
 * restricted to JavaScript identifiers before they are used by CDP. */
export function findPassiveEffectCreateBreakpoint(source: string): PassiveEffectBreakpoint | null {
  if (source.length === 0 || source.length > 5_000_000) return null;
  const createCall = /var ([A-Za-z_$][A-Za-z0-9_$]*)=([A-Za-z_$][A-Za-z0-9_$]*)\.create;\2\.inst\.destroy=([A-Za-z_$][A-Za-z0-9_$]*)=\1\(\)/.exec(source);
  if (createCall?.index === undefined) return null;
  const functionWindow = source.slice(Math.max(0, createCall.index - 1_000), createCall.index);
  const functionPattern = /function [A-Za-z_$][A-Za-z0-9_$]*\(([^)]{1,160})\)\{/g;
  let enclosing: RegExpExecArray | null = null;
  for (let match = functionPattern.exec(functionWindow); match; match = functionPattern.exec(functionWindow)) enclosing = match;
  const parameters = enclosing?.[1]?.split(",").map((value) => value.trim()) ?? [];
  const ownerVariable = parameters[1];
  const createVariable = createCall[1];
  const effectVariable = createCall[2];
  if (!createVariable || !effectVariable || !ownerVariable
    || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(createVariable)
    || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(effectVariable)
    || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ownerVariable)) return null;
  const before = source.slice(0, createCall.index);
  const lineNumber = (before.match(/\n/g) ?? []).length;
  const lastNewline = before.lastIndexOf("\n");
  // Break at the destroy-assignment target rather than the invocation. At this
  // location V8 has assigned the create local but has not called it yet; a
  // breakpoint placed on the call identifier may resolve only after a
  // successful invocation and therefore miss the non-callable fault itself.
  const assignmentOffset = createCall[0].indexOf(`;${effectVariable}.inst.destroy`) + 1;
  return {
    probe_kind: "create",
    line_number: lineNumber,
    column_number: createCall.index - lastNewline - 1 + assignmentOffset,
    create_variable: createVariable,
    effect_variable: effectVariable,
    owner_variable: ownerVariable,
  };
}

/** Locate React's passive-effect cleanup call. A valid create callback may
 * return a non-function value; React stores it as `inst.destroy` and the fault
 * appears only when cleanup later invokes that value. */
export function findPassiveEffectDestroyBreakpoint(source: string): PassiveEffectBreakpoint | null {
  if (source.length === 0 || source.length > 5_000_000) return null;
  const destroyCall = /var ([A-Za-z_$][A-Za-z0-9_$]*)=([A-Za-z_$][A-Za-z0-9_$]*)\.inst,([A-Za-z_$][A-Za-z0-9_$]*)=\1\.destroy;if\(void 0!==\3\)\{\1\.destroy=void 0,([A-Za-z_$][A-Za-z0-9_$]*)=([A-Za-z_$][A-Za-z0-9_$]*);try\{\3\(\)/.exec(source);
  if (destroyCall?.index === undefined) return null;
  const instanceVariable = destroyCall[1];
  const effectVariable = destroyCall[2];
  const destroyVariable = destroyCall[3];
  const ownerVariable = destroyCall[5];
  if (!instanceVariable || !effectVariable || !destroyVariable || !ownerVariable
    || ![instanceVariable, effectVariable, destroyVariable, ownerVariable].every((value) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value))) return null;
  const before = source.slice(0, destroyCall.index);
  const lineNumber = (before.match(/\n/g) ?? []).length;
  const lastNewline = before.lastIndexOf("\n");
  const invocationOffset = destroyCall[0].lastIndexOf(`${destroyVariable}()`);
  return {
    probe_kind: "destroy",
    line_number: lineNumber,
    // V8 can resolve a breakpoint on `try` to the function entry, before the
    // cleanup local exists. Stop on the actual invocation instead, where both
    // the saved cleanup and its exact effect/instance locals are in scope.
    column_number: destroyCall.index - lastNewline - 1 + invocationOffset,
    instance_variable: instanceVariable,
    destroy_variable: destroyVariable,
    effect_variable: effectVariable,
    owner_variable: ownerVariable,
  };
}

/** Locate React's passive-effect mount catch handler. The effect callback can
 * itself be callable yet throw from product code; stopping only when React
 * enters this catch avoids pausing the many successful effects on the page. */
export function findPassiveEffectCreateCatchBreakpoint(source: string): PassiveEffectBreakpoint | null {
  const create = findPassiveEffectCreateBreakpoint(source);
  if (!create || create.probe_kind !== "create") return null;
  const createCall = /var ([A-Za-z_$][A-Za-z0-9_$]*)=([A-Za-z_$][A-Za-z0-9_$]*)\.create;\2\.inst\.destroy=([A-Za-z_$][A-Za-z0-9_$]*)=\1\(\)/.exec(source);
  if (createCall?.index === undefined) return null;
  const ownerVariable = create.owner_variable;
  const catchWindow = source.slice(createCall.index, Math.min(source.length, createCall.index + 2_000));
  const identifierSource = "[A-Za-z_$][A-Za-z0-9_$]*";
  const catchHandler = new RegExp(`\\}\\}catch\\((${identifierSource})\\)\\{(${identifierSource})\\(${ownerVariable},${ownerVariable}\\.return,\\1\\)`).exec(catchWindow);
  const handlerVariable = catchHandler?.[2];
  if (catchHandler?.index === undefined || !handlerVariable) return null;
  const absoluteIndex = createCall.index + catchHandler.index + catchHandler[0].lastIndexOf(`${handlerVariable}(`);
  const before = source.slice(0, absoluteIndex);
  return {
    probe_kind: "create_catch",
    line_number: (before.match(/\n/g) ?? []).length,
    column_number: absoluteIndex - before.lastIndexOf("\n") - 1,
    exception_variable: catchHandler[1]!,
    effect_variable: create.effect_variable,
    owner_variable: ownerVariable,
  };
}

/** A non-callable create value is itself the fault, so one observation is
 * conclusive. Callable creates must remain armed because the product error can
 * be thrown from inside a later effect callback; the most recent bounded owner
 * probe is then correlated with the page error. */
export function shouldReleasePassiveEffectBreakpoint(createType: ClientEffectProbe["create_type"]): boolean {
  return createType !== "function";
}

/** Pause only for the contract violation we are trying to identify. React runs
 * many valid passive effects during startup; stopping on every callable effect
 * can starve the worker heartbeat and turn a diagnostic into a harness outage. */
export function passiveEffectBreakpointCondition(breakpoint: PassiveEffectBreakpoint): string {
  return breakpoint.probe_kind === "create"
    ? `typeof ${breakpoint.create_variable} !== "function"`
    : breakpoint.probe_kind === "create_catch"
      ? "true"
    : `typeof ${breakpoint.destroy_variable} !== "undefined" && typeof ${breakpoint.destroy_variable} !== "function"`;
}

/** Extract only bounded, same-origin Next.js chunk script URLs from the
 * server-rendered document. This lets the worker arm a URL breakpoint before
 * Chromium evaluates React instead of racing Debugger.scriptParsed. */
export function extractNextChunkScriptUrls(html: string, frontendOrigin: string): string[] {
  if (html.length === 0 || html.length > 2_000_000) return [];
  const urls: string[] = [];
  const scriptSource = /<script\b[^>]*\bsrc=(["'])([^"']+)\1/gi;
  for (let match = scriptSource.exec(html); match && urls.length < 32; match = scriptSource.exec(html)) {
    const raw = match[2]!.replaceAll("&amp;", "&");
    try {
      const url = new URL(raw, frontendOrigin);
      if (url.origin !== frontendOrigin || !/^\/_next\/static\/chunks\/[A-Za-z0-9._~-]{1,160}\.js$/.test(url.pathname)) continue;
      const serialized = url.toString();
      if (!urls.includes(serialized)) urls.push(serialized);
    } catch {
      // Ignore malformed and cross-origin script attributes.
    }
  }
  return urls;
}

async function preloadPassiveEffectBreakpoints(request: APIRequestContext, frontendOrigin: string): Promise<PreloadedPassiveEffectBreakpoint[]> {
  const documentResponse = await request.get(new URL("/", frontendOrigin).toString(), {
    failOnStatusCode: false,
    maxRedirects: 0,
    timeout: 10_000,
  });
  if (!documentResponse.ok()) return [];
  const documentBytes = await documentResponse.body();
  if (documentBytes.byteLength === 0 || documentBytes.byteLength > 2_000_000) return [];
  const scriptUrls = extractNextChunkScriptUrls(documentBytes.toString("utf8"), frontendOrigin);
  const breakpoints: PreloadedPassiveEffectBreakpoint[] = [];
  for (const scriptUrl of scriptUrls) {
    try {
      const response = await request.get(scriptUrl, { failOnStatusCode: false, maxRedirects: 0, timeout: 10_000 });
      if (!response.ok()) continue;
      const bytes = await response.body();
      if (bytes.byteLength === 0 || bytes.byteLength > 5_000_000) continue;
      const source = bytes.toString("utf8");
      const candidates = [findPassiveEffectCreateBreakpoint(source), findPassiveEffectCreateCatchBreakpoint(source), findPassiveEffectDestroyBreakpoint(source)].filter((value): value is PassiveEffectBreakpoint => value !== null);
      if (candidates.length === 0) continue;
      const parsed = new URL(scriptUrl);
      const escapedPath = `${parsed.origin}${parsed.pathname}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const breakpoint of candidates) breakpoints.push({ ...breakpoint, url_regex: `^${escapedPath}(?:\\?.*)?$` });
    } catch {
      // Preloading is diagnostic-only and remains fail-open.
    }
  }
  return breakpoints;
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

/** Chromium's Runtime.exceptionThrown event can preserve call frames when the
 * Playwright Error.stack and console location are incomplete. Project only a
 * same-origin Next chunk coordinate; never retain exception text or raw URLs. */
export function classifyClientCdpExceptionFrames(details: unknown, expectedOrigin: string): ClientChunkFrame[] {
  const record = details && typeof details === "object" ? details as Record<string, unknown> : null;
  const stackTrace = record?.stackTrace && typeof record.stackTrace === "object"
    ? record.stackTrace as Record<string, unknown>
    : null;
  const callFrames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames.slice(0, 40) : [];
  const safeFrames: ClientChunkFrame[] = [];
  for (const candidate of callFrames) {
    if (!candidate || typeof candidate !== "object") continue;
    const frame = candidate as Record<string, unknown>;
    const safe = classifyClientConsoleErrorLocation({
      ...(typeof frame.url === "string" ? { url: frame.url } : {}),
      ...(typeof frame.lineNumber === "number" ? { lineNumber: frame.lineNumber } : {}),
      ...(typeof frame.columnNumber === "number" ? { columnNumber: frame.columnNumber } : {}),
    }, expectedOrigin);
    if (safe && !safeFrames.some((existing) => existing.chunk === safe.chunk && existing.line === safe.line && existing.column === safe.column)) {
      safeFrames.push(safe);
      if (safeFrames.length === 5) return safeFrames;
    }
  }
  const root = classifyClientConsoleErrorLocation({
    ...(typeof record?.url === "string" ? { url: record.url } : {}),
    ...(typeof record?.lineNumber === "number" ? { lineNumber: record.lineNumber } : {}),
    ...(typeof record?.columnNumber === "number" ? { columnNumber: record.columnNumber } : {}),
  }, expectedOrigin);
  if (root && !safeFrames.some((existing) => existing.chunk === root.chunk && existing.line === root.line && existing.column === root.column)) safeFrames.push(root);
  return safeFrames.slice(0, 5);
}

/** Debugger.paused observes an uncaught exception at its throw site, before
 * React's effect machinery catches and rethrows it from framework internals.
 * Retain only same-origin Next chunk coordinates and resume immediately. */
export function classifyClientCdpPausedFrames(details: unknown, expectedOrigin: string): ClientChunkFrame[] {
  const record = details && typeof details === "object" ? details as Record<string, unknown> : null;
  const callFrames = Array.isArray(record?.callFrames) ? record.callFrames.slice(0, 40) : [];
  const safeFrames: ClientChunkFrame[] = [];
  for (const candidate of callFrames) {
    if (!candidate || typeof candidate !== "object") continue;
    const frame = candidate as Record<string, unknown>;
    const location = frame.location && typeof frame.location === "object"
      ? frame.location as Record<string, unknown>
      : null;
    const safe = classifyClientConsoleErrorLocation({
      ...(typeof frame.url === "string" ? { url: frame.url } : {}),
      ...(typeof location?.lineNumber === "number" ? { lineNumber: location.lineNumber } : {}),
      ...(typeof location?.columnNumber === "number" ? { columnNumber: location.columnNumber } : {}),
    }, expectedOrigin);
    if (safe && !safeFrames.some((existing) => existing.chunk === safe.chunk && existing.line === safe.line && existing.column === safe.column)) {
      safeFrames.push(safe);
      if (safeFrames.length === 5) break;
    }
  }
  return safeFrames;
}

/** Pair the pageerror with only the immediately preceding pause cluster. One
 * top frame per pause is kept first so a later React rethrow cannot crowd out
 * the earlier application throw site; remaining safe callers fill the bound. */
export function selectRecentClientPausedFrames(
  snapshots: TimedClientChunkFrames[],
  pageErrorObservedAt: number,
  windowMs = 1_500,
): ClientChunkFrame[] {
  const recent = snapshots
    .filter((snapshot) => snapshot.observedAt <= pageErrorObservedAt && snapshot.observedAt >= pageErrorObservedAt - windowMs)
    .slice(-20)
    .reverse();
  const selected: ClientChunkFrame[] = [];
  const add = (frame: ClientChunkFrame | undefined) => {
    if (frame && !selected.some((existing) => existing.chunk === frame.chunk && existing.line === frame.line && existing.column === frame.column)) selected.push(frame);
  };
  for (const snapshot of recent) {
    add(snapshot.frames[0]);
    if (selected.length === 5) return selected;
  }
  for (const snapshot of recent) {
    for (const frame of snapshot.frames.slice(1)) {
      add(frame);
      if (selected.length === 5) return selected;
    }
  }
  return selected;
}

export function selectRecentClientEffectProbe(
  snapshots: TimedClientChunkFrames[],
  pageErrorObservedAt: number,
  windowMs = 1_500,
): ClientEffectProbe | null {
  return snapshots
    .filter((snapshot) => snapshot.observedAt <= pageErrorObservedAt && snapshot.observedAt >= pageErrorObservedAt - windowMs)
    .sort((left, right) => right.observedAt - left.observedAt)
    .find((snapshot) => snapshot.effectProbe !== undefined)?.effectProbe ?? null;
}

export function withClientEffectProbe(
  diagnostic: ClientPageErrorDiagnostic | null,
  effectProbe: ClientEffectProbe | null,
): ClientPageErrorDiagnostic | null {
  return diagnostic && effectProbe ? { ...diagnostic, effect_probe: effectProbe } : diagnostic;
}

export function withClientDiagnosticFrames(
  diagnostic: ClientPageErrorDiagnostic | null,
  frames: ClientChunkFrame[],
  preferCorrelatedFrames = false,
): ClientPageErrorDiagnostic | null {
  if (!diagnostic || frames.length === 0) return diagnostic;
  if (preferCorrelatedFrames) {
    const nextFrames = [...frames, ...diagnostic.next_frames]
      .filter((frame, index, all) => all.findIndex((candidate) => candidate.chunk === frame.chunk && candidate.line === frame.line && candidate.column === frame.column) === index)
      .slice(0, 5);
    return { ...diagnostic, next_chunk: nextFrames[0]?.chunk ?? diagnostic.next_chunk, next_frames: nextFrames };
  }
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

const CONSENT_ACCEPT_SELECTOR = '[data-voice-lab="consent-accept"]';
export const DASHBOARD_ROUTE_TIMEOUT_MS = 60_000;

export async function resolveDashboardMicButton(page: Page, micAnchor: Locator): Promise<Locator> {
  // MicCTA renders the stable onboarding anchor as a sibling of the actual
  // button so the spotlight can cover the full breathing-ring stage. Prefer
  // that structural relationship: the button's accessible label can
  // legitimately change while the dashboard is hydrating.
  const siblingButton = micAnchor.locator("xpath=../button[1]");
  if (await siblingButton.count() > 0) return siblingButton;
  return page.getByRole("button", { name: /^Start (?:open session|prepare|debrief|reset|vent)$/i }).first();
}

export async function activateDashboardMicButton(page: Page, button: Locator): Promise<void> {
  await button.waitFor({ state: "visible", timeout: 5_000 });
  const deadline = Date.now() + 10_000;
  while (!await button.isEnabled()) {
    if (Date.now() >= deadline) throw new Error("The ordinary dashboard microphone control did not become enabled.");
    await page.waitForTimeout(100);
  }
  // The dashboard deliberately animates the microphone stage and may place
  // non-interactive visual layers above it. Keyboard activation exercises the
  // same native button/onClick path without depending on a stable hit-test
  // point. It does not call product handlers or navigation directly.
  await button.focus();
  await button.press("Enter");
}

export async function establishDashboardMicRoute(input: {
  isMicVisible: () => Promise<boolean>;
  isConsentVisible: () => Promise<boolean>;
  isConsentEnabled: () => Promise<boolean>;
  acceptConsent: () => Promise<void>;
  isRecoverableLoadErrorVisible?: () => Promise<boolean>;
  reload?: () => Promise<void>;
  wait: () => Promise<void>;
  timeoutMs: number;
  now?: () => number;
}): Promise<"already_consented" | "accepted"> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.timeoutMs;
  let reloadAttempted = false;
  while (now() < deadline) {
    if (await input.isMicVisible()) return "already_consented";
    if (await input.isConsentVisible() && await input.isConsentEnabled()) {
      await input.acceptConsent();
      while (now() < deadline) {
        if (await input.isMicVisible()) return "accepted";
        await input.wait();
      }
      throw new Error("The ordinary privacy-consent UI did not release the dashboard microphone route.");
    }
    // Next.js can render its same-origin, recoverable navigation error shell
    // even though the document request itself returned HTTP 200. Honor that
    // ordinary UI's Reload affordance exactly once, then continue the same
    // bounded route wait. Never reload an unknown page or loop indefinitely.
    if (!reloadAttempted && input.isRecoverableLoadErrorVisible && input.reload
      && await input.isRecoverableLoadErrorVisible()) {
      reloadAttempted = true;
      await input.reload();
      continue;
    }
    await input.wait();
  }
  throw new Error(`Neither the ordinary privacy-consent UI nor the dashboard microphone route became available. recoverable_reload_attempted=${reloadAttempted}`);
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
    let ordinaryRouteStage = "frontend_auth_grant";
    let latestClientPageError: ClientPageErrorDiagnostic | null = null;
    let latestClientConsoleFrames: ClientChunkFrame[] = [];
    let latestClientPausedFrames: ClientChunkFrame[] = [];
    let latestClientEffectProbe: ClientEffectProbe | null = null;
    let latestClientPageErrorObservedAt: number | null = null;
    const recentClientPausedFrameSets: TimedClientChunkFrames[] = [];
    // Invalid effect probes are rare and causally important. Keep them in a
    // separate bounded buffer so concurrently completing callable-effect
    // evaluations cannot evict the invalid record before pageerror arrives.
    const recentInvalidClientEffectProbeSets: TimedClientChunkFrames[] = [];
    const effectProbeStatus: ClientEffectProbeStatus = {
      preloaded_candidates: 0,
      preloaded_resolved_locations: 0,
      dynamic_breakpoints_installed: 0,
      breakpoint_pauses: 0,
      exception_pauses: 0,
      evaluation_attempts: 0,
      effect_record_matches: 0,
      snapshot_count: 0,
    };
    const bumpEffectProbeStatus = (key: keyof ClientEffectProbeStatus, amount = 1) => {
      effectProbeStatus[key] = Math.min(255, effectProbeStatus[key] + amount);
    };
    const currentClientPageErrorDiagnostic = (): ClientPageErrorDiagnostic | null => {
      if (latestClientPageErrorObservedAt !== null) {
        // The paused-handler enrichment is asynchronous. Re-select here so a
        // probe that completed after pageerror was emitted is not lost.
        latestClientPausedFrames = selectRecentClientPausedFrames(recentClientPausedFrameSets, latestClientPageErrorObservedAt);
        latestClientEffectProbe = selectRecentClientEffectProbe(
          [...recentClientPausedFrameSets, ...recentInvalidClientEffectProbeSets],
          latestClientPageErrorObservedAt,
        );
      }
      const enriched = withClientEffectProbe(
        withClientDiagnosticFrames(
          latestClientPageError,
          latestClientPausedFrames.length > 0 ? latestClientPausedFrames : latestClientConsoleFrames,
          latestClientPausedFrames.length > 0,
        ),
        latestClientEffectProbe,
      );
      return enriched ? { ...enriched, effect_probe_status: { ...effectProbeStatus } } : enriched;
    };
    try {
      // No OS/browser microphone permission is granted. The init script's
      // page-owned MediaStreamDestination is the only accepted audio stream;
      // if that replacement is absent, native gUM stays denied and startup
      // cannot allocate a provider from a physical microphone.
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
      ordinaryRouteStage = "frontend_auth_session";
      const { response: authSession, payload: authIdentity } = await requestBoundJson(context.request, "GET", authSessionUrl, 10_000);
      const authUser = authIdentity?.user as Record<string, unknown> | undefined;
      if (!authSession.ok() || authUser?.id !== run.principalId) throw new VoiceLabError(labError("AUTH_PRINCIPAL_MISMATCH", "The browser session is not bound to the exact dedicated Voice Lab principal.", "authorization", false, { observed_principal_sha256: typeof authUser?.id === "string" ? sha256(authUser.id) : null }));
      ordinaryRouteStage = "browser_init_script";
      await context.addInitScript({ content: buildVoiceLabInitScript({ pageOrigin: frontendOrigin, websocketOrigins: [...this.config.websocketOrigins], maxAudioBytes: this.config.maxAudioBytes, testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId }) });
      const preloadedPassiveEffectBreakpoints = await preloadPassiveEffectBreakpoints(context.request, frontendOrigin).catch(() => []);
      effectProbeStatus.preloaded_candidates = Math.min(32, preloadedPassiveEffectBreakpoints.length);
      ordinaryRouteStage = "frontend_home_navigation";
      const page = await context.newPage();
      page.on("pageerror", (error) => {
        const observedAt = Date.now();
        latestClientPageErrorObservedAt = observedAt;
        latestClientPageError = classifyClientPageError(error);
        latestClientPausedFrames = selectRecentClientPausedFrames(recentClientPausedFrameSets, observedAt);
        latestClientEffectProbe = selectRecentClientEffectProbe(
          [...recentClientPausedFrameSets, ...recentInvalidClientEffectProbeSets],
          observedAt,
        );
      });
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const frame = classifyClientConsoleErrorLocation(message.location(), frontendOrigin);
        if (frame) latestClientConsoleFrames = [frame];
      });
      try {
        const cdp = await context.newCDPSession(page);
        const scriptUrls = new Map<string, string>();
        const passiveEffectBreakpoints = new Map<string, PassiveEffectBreakpoint>();
        const passiveEffectScriptInspections = new Map<string, Promise<boolean>>();
        const installPassiveEffectBreakpoint = (scriptId: string, scriptUrlValue: string): Promise<boolean> => {
          const existing = passiveEffectScriptInspections.get(scriptId);
          if (existing) return existing;
          const inspection = (async () => {
            try {
              const scriptUrl = new URL(scriptUrlValue);
              if (scriptUrl.origin !== frontendOrigin || !/^\/_next\/static\/chunks\/[A-Za-z0-9._-]{1,160}\.js$/.test(scriptUrl.pathname)) return false;
              const sourceResult = await cdp.send("Debugger.getScriptSource", { scriptId });
              const breakpoints = [
                findPassiveEffectCreateBreakpoint(sourceResult.scriptSource),
                findPassiveEffectCreateCatchBreakpoint(sourceResult.scriptSource),
                findPassiveEffectDestroyBreakpoint(sourceResult.scriptSource),
              ].filter((value): value is PassiveEffectBreakpoint => value !== null);
              for (const breakpoint of breakpoints) {
                const installed = await cdp.send("Debugger.setBreakpoint", {
                  location: {
                    scriptId,
                    lineNumber: breakpoint.line_number,
                    columnNumber: breakpoint.column_number,
                  },
                  condition: passiveEffectBreakpointCondition(breakpoint),
                });
                passiveEffectBreakpoints.set(installed.breakpointId, breakpoint);
                bumpEffectProbeStatus("dynamic_breakpoints_installed");
              }
              return breakpoints.length > 0;
            } catch {
              // Passive-effect diagnostics are best-effort and never block load.
              return false;
            }
          })();
          passiveEffectScriptInspections.set(scriptId, inspection);
          return inspection;
        };
        cdp.on("Debugger.scriptParsed", (event) => {
          if (typeof event.scriptId !== "string" || typeof event.url !== "string") return;
          scriptUrls.set(event.scriptId, event.url);
          // Always inspect dynamically parsed chunks. A server-rendered document
          // may preload one React runtime while navigation executes another.
          void installPassiveEffectBreakpoint(event.scriptId, event.url);
        });
        await cdp.send("Runtime.enable");
        cdp.on("Runtime.exceptionThrown", (event) => {
          const frames = classifyClientCdpExceptionFrames(event.exceptionDetails, frontendOrigin);
          if (frames.length > 0 && latestClientPausedFrames.length === 0) latestClientConsoleFrames = frames;
        });
        await cdp.send("Debugger.enable");
        for (const preloadedPassiveEffectBreakpoint of preloadedPassiveEffectBreakpoints) {
          const installed = await cdp.send("Debugger.setBreakpointByUrl", {
            lineNumber: preloadedPassiveEffectBreakpoint.line_number,
            columnNumber: preloadedPassiveEffectBreakpoint.column_number,
            urlRegex: preloadedPassiveEffectBreakpoint.url_regex,
            condition: passiveEffectBreakpointCondition(preloadedPassiveEffectBreakpoint),
          });
          passiveEffectBreakpoints.set(installed.breakpointId, preloadedPassiveEffectBreakpoint);
          bumpEffectProbeStatus("preloaded_resolved_locations", Array.isArray(installed.locations) ? installed.locations.length : 0);
        }
        // Caught framework exceptions are numerous and do not become page
        // failures. Runtime.exceptionThrown still captures their bounded
        // frames, while the debugger pauses only for an uncaught product fault.
        await cdp.send("Debugger.setPauseOnExceptions", { state: "uncaught" });
        cdp.on("Debugger.paused", (event) => {
          // Capture correlation time synchronously. CDP evaluation below is
          // asynchronous and can finish after Playwright emits pageerror even
          // though this pause causally preceded it.
          const pausedObservedAt = Date.now();
          const hitBreakpoints = Array.isArray(event.hitBreakpoints) ? event.hitBreakpoints : [];
          if (hitBreakpoints.some((breakpointId) => passiveEffectBreakpoints.has(breakpointId))) bumpEffectProbeStatus("breakpoint_pauses");
          if (event.reason === "exception") bumpEffectProbeStatus("exception_pauses");
          const frames = classifyClientCdpPausedFrames(event, frontendOrigin);
          void (async () => {
            let effectProbe: ClientEffectProbe | undefined;
            const passiveBreakpointId = hitBreakpoints.find((breakpointId) => passiveEffectBreakpoints.has(breakpointId));
            const passiveBinding = passiveBreakpointId ? passiveEffectBreakpoints.get(passiveBreakpointId) : undefined;
            try {
              const callFrames = Array.isArray(event.callFrames) ? event.callFrames.slice(0, 12) : [];
              let effectFrame: (typeof callFrames)[number] | undefined;
              const knownPassiveBinding = passiveBinding ?? passiveEffectBreakpoints.values().next().value;
              const allowedTypes = new Set<ClientValueType>(["undefined", "function", "object", "boolean", "number", "string", "symbol", "bigint", "other"]);
              const acceptCreateRecord = (candidate: (typeof callFrames)[number], createValue: unknown): boolean => {
                if (!createValue || typeof createValue !== "object") return false;
                const createRecord = createValue as Record<string, unknown>;
                const createType = createRecord.createType;
                const destroyType = createRecord.destroyType;
                if (typeof createType !== "string" || !allowedTypes.has(createType as ClientValueType)
                  || (destroyType !== undefined && (typeof destroyType !== "string" || !allowedTypes.has(destroyType as ClientValueType)))) return false;
                bumpEffectProbeStatus("effect_record_matches");
                effectProbe = {
                  create_type: createType as ClientValueType,
                  ...(destroyType === undefined ? {} : { destroy_type: destroyType as ClientValueType }),
                  effect_tag: Number.isInteger(createRecord.effectTag) ? Number(createRecord.effectTag) : null,
                  owner_fiber_tag: null,
                  owner_props: "unavailable",
                  owner_frame: null,
                };
                effectFrame = candidate;
                return true;
              };
              if (knownPassiveBinding?.probe_kind === "create") {
                // At the failing `a()` call the effect record can be shadowed by
                // unrelated minified `n` bindings in earlier frames. Scan every
                // frame for the exact local create binding first and require it
                // to be identical to the effect record's create value. An
                // undeclared local throws only inside this silent diagnostic
                // evaluation and cannot be mistaken for an undefined create.
                for (const candidate of callFrames) {
                  if (typeof candidate.callFrameId !== "string") continue;
                  bumpEffectProbeStatus("evaluation_attempts");
                  const { create_variable: createVariable, effect_variable: effectVariable } = knownPassiveBinding;
                  const localCreateResult = await cdp.send("Debugger.evaluateOnCallFrame", {
                    callFrameId: candidate.callFrameId,
                    expression: `(() => { if (typeof ${effectVariable} !== "object" || ${effectVariable} === null || !("create" in ${effectVariable}) || ${effectVariable}.create !== ${createVariable}) return null; const rawType = typeof ${createVariable}; const allowed = ["undefined","function","object","boolean","number","string","symbol","bigint"]; return { createType: allowed.includes(rawType) ? rawType : "other", effectTag: Number.isSafeInteger(${effectVariable}.tag) && ${effectVariable}.tag >= 0 && ${effectVariable}.tag <= 255 ? ${effectVariable}.tag : null }; })()`,
                    returnByValue: true,
                    silent: true,
                    throwOnSideEffect: false,
                  });
                  if (acceptCreateRecord(candidate, localCreateResult?.result?.value)) break;
                }
              }
              if (!effectProbe && knownPassiveBinding?.probe_kind === "destroy") {
                // At cleanup, require the local destroy binding to be identical
                // to the value React stored on this exact effect record. This
                // distinguishes the invalid return value from unrelated
                // minified locals without serializing the value itself.
                for (const candidate of callFrames) {
                  if (typeof candidate.callFrameId !== "string") continue;
                  bumpEffectProbeStatus("evaluation_attempts");
                  const { instance_variable: instanceVariable, destroy_variable: destroyVariable, effect_variable: effectVariable } = knownPassiveBinding;
                  const localDestroyResult = await cdp.send("Debugger.evaluateOnCallFrame", {
                    callFrameId: candidate.callFrameId,
                    // React intentionally clears inst.destroy before invoking
                    // the saved local. Bind through the still-identical effect
                    // instance instead of comparing against the cleared field.
                    expression: `(() => { if (typeof ${effectVariable} !== "object" || ${effectVariable} === null || typeof ${effectVariable}.inst !== "object" || ${effectVariable}.inst === null || ${effectVariable}.inst !== ${instanceVariable}) return null; const rawCreateType = typeof ${effectVariable}.create; const rawDestroyType = typeof ${destroyVariable}; const allowed = ["undefined","function","object","boolean","number","string","symbol","bigint"]; return { createType: allowed.includes(rawCreateType) ? rawCreateType : "other", destroyType: allowed.includes(rawDestroyType) ? rawDestroyType : "other", effectTag: Number.isSafeInteger(${effectVariable}.tag) && ${effectVariable}.tag >= 0 && ${effectVariable}.tag <= 255 ? ${effectVariable}.tag : null }; })()`,
                    returnByValue: true,
                    silent: true,
                    throwOnSideEffect: false,
                  });
                  if (acceptCreateRecord(candidate, localDestroyResult?.result?.value)) break;
                }
              }
              if (!effectProbe && knownPassiveBinding?.probe_kind !== "destroy") {
                // Retain the record-only fallback for callable effects and for
                // runtime variants where the local binding is unavailable.
                for (const candidate of callFrames) {
                  if (typeof candidate.callFrameId !== "string") continue;
                  bumpEffectProbeStatus("evaluation_attempts");
                  const effectVariable = knownPassiveBinding?.effect_variable ?? "n";
                  const createResult = await cdp.send("Debugger.evaluateOnCallFrame", {
                    callFrameId: candidate.callFrameId,
                    expression: `(() => { if (typeof ${effectVariable} !== "object" || ${effectVariable} === null || !("create" in ${effectVariable})) return null; const rawType = typeof ${effectVariable}.create; const allowed = ["undefined","function","object","boolean","number","string","symbol","bigint"]; return { createType: allowed.includes(rawType) ? rawType : "other", effectTag: Number.isSafeInteger(${effectVariable}.tag) && ${effectVariable}.tag >= 0 && ${effectVariable}.tag <= 255 ? ${effectVariable}.tag : null }; })()`,
                    returnByValue: true,
                    silent: true,
                    // This expression only reads the paused React effect record and
                    // returns bounded primitives. Chromium cannot prove an IIFE is
                    // side-effect free, so throwOnSideEffect would suppress the probe.
                    throwOnSideEffect: false,
                  });
                  if (acceptCreateRecord(candidate, createResult?.result?.value)) break;
                }
              }
              if (effectProbe && effectFrame && typeof effectFrame.callFrameId === "string") {
                // In React's passive-effect mount frame, `n` is the effect record
                // and `t` is its owning fiber. They live in the same frame. If an
                // effect body throws, that React frame may be below the throw site,
                // which is why the scan above is not limited to callFrames[0].
                const caller = effectFrame;
                const ownerVariable = knownPassiveBinding?.owner_variable ?? "t";
                const ownerResult = await cdp.send("Debugger.evaluateOnCallFrame", {
                  callFrameId: caller.callFrameId,
                  expression: `(() => { if (typeof ${ownerVariable} !== "object" || ${ownerVariable} === null || !Number.isInteger(${ownerVariable}.tag) || !("memoizedProps" in ${ownerVariable})) return null; const props = ${ownerVariable}.memoizedProps; const keys = props && typeof props === "object" ? Object.keys(props).sort() : []; let ownerProps = "other"; if (keys.length === 0) ownerProps = "no_props"; else if (keys.length === 1 && keys[0] === "onReady") ownerProps = "on_ready"; else if (keys.length === 1 && keys[0] === "children") ownerProps = "children_only"; else if (keys.length === 2 && keys[0] === "children" && keys[1] === "onAuthenticated") ownerProps = "on_authenticated"; return { ownerFiberTag: ${ownerVariable}.tag >= 0 && ${ownerVariable}.tag <= 255 ? ${ownerVariable}.tag : null, ownerProps }; })()`,
                  returnByValue: true,
                  silent: true,
                  throwOnSideEffect: false,
                });
                const ownerValue = ownerResult?.result?.value;
                if (ownerValue && typeof ownerValue === "object") {
                  const ownerRecord = ownerValue as Record<string, unknown>;
                  const ownerProps = ownerRecord.ownerProps;
                  effectProbe.owner_fiber_tag = Number.isInteger(ownerRecord.ownerFiberTag) ? Number(ownerRecord.ownerFiberTag) : null;
                  effectProbe.owner_props = ownerProps === "on_ready" || ownerProps === "on_authenticated" || ownerProps === "children_only" || ownerProps === "no_props" || ownerProps === "other"
                    ? ownerProps
                    : "unavailable";
                  const functionResult = await cdp.send("Debugger.evaluateOnCallFrame", {
                    callFrameId: caller.callFrameId,
                    expression: `typeof ${ownerVariable}.elementType === "function" ? ${ownerVariable}.elementType : (${ownerVariable}.elementType && typeof ${ownerVariable}.elementType.type === "function" ? ${ownerVariable}.elementType.type : (typeof ${ownerVariable}.type === "function" ? ${ownerVariable}.type : (${ownerVariable}.type && typeof ${ownerVariable}.type.type === "function" ? ${ownerVariable}.type.type : null)))`,
                    returnByValue: false,
                    silent: true,
                    throwOnSideEffect: true,
                  });
                  const objectId = functionResult?.result?.objectId;
                  if (typeof objectId === "string") {
                    try {
                      const properties = await cdp.send("Runtime.getProperties", { objectId, ownProperties: false, accessorPropertiesOnly: false, generatePreview: false });
                      const functionLocation = Array.isArray(properties?.internalProperties)
                        ? properties.internalProperties.find((property: { name?: unknown }) => property?.name === "[[FunctionLocation]]")?.value?.value
                        : null;
                      if (functionLocation && typeof functionLocation === "object") {
                        const location = functionLocation as Record<string, unknown>;
                        const url = typeof location.scriptId === "string" ? scriptUrls.get(location.scriptId) : undefined;
                        effectProbe.owner_frame = classifyClientConsoleErrorLocation({
                          ...(url !== undefined ? { url } : {}),
                          ...(typeof location.lineNumber === "number" ? { lineNumber: location.lineNumber } : {}),
                          ...(typeof location.columnNumber === "number" ? { columnNumber: location.columnNumber } : {}),
                        }, frontendOrigin);
                      }
                    } finally {
                      await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
                    }
                  }
                }
              }
              if (effectFrame && typeof effectFrame.callFrameId === "string" && knownPassiveBinding?.probe_kind === "create_catch") {
                // React has already unwound the throwing product callback by
                // the time its passive-effect catch handler runs, but the
                // caught Error retains the original stack. Project only
                // bounded same-origin Next chunk coordinates and discard the
                // raw stack immediately; this recovers the product throw site
                // without pausing every ordinary caught exception.
                const caughtStackResult = await cdp.send("Debugger.evaluateOnCallFrame", {
                  callFrameId: effectFrame.callFrameId,
                  expression: `(() => { const value = ${knownPassiveBinding.exception_variable}; return value && typeof value === "object" && typeof value.stack === "string" ? value.stack.slice(0, 20000) : null; })()`,
                  returnByValue: true,
                  silent: true,
                  throwOnSideEffect: false,
                });
                const caughtStack = caughtStackResult?.result?.value;
                if (typeof caughtStack === "string") {
                  const caughtFrames = classifyClientPageError({ name: "Error", message: "caught_effect", stack: caughtStack }).next_frames;
                  for (const frame of caughtFrames.reverse()) {
                    if (!frames.some((existing) => existing.chunk === frame.chunk && existing.line === frame.line && existing.column === frame.column)) frames.unshift(frame);
                  }
                  if (frames.length > 5) frames.splice(5);
                }
              }
              const conclusiveEffectProbe = effectProbe !== undefined && (
                passiveBinding?.probe_kind === "create_catch"
                ||
                shouldReleasePassiveEffectBreakpoint(effectProbe.create_type)
                || (effectProbe.destroy_type !== undefined && effectProbe.destroy_type !== "undefined" && effectProbe.destroy_type !== "function")
              );
              if (conclusiveEffectProbe && passiveBreakpointId) {
                await cdp.send("Debugger.removeBreakpoint", { breakpointId: passiveBreakpointId }).catch(() => undefined);
                passiveEffectBreakpoints.delete(passiveBreakpointId);
              }
            } catch {
              // Safe effect diagnostics are fail-open and never block resume.
            } finally {
              if ((!passiveBinding && frames.length > 0) || effectProbe) {
                const snapshot = { observedAt: pausedObservedAt, frames, ...(effectProbe ? { effectProbe } : {}) };
                recentClientPausedFrameSets.push(snapshot);
                if (effectProbe && (
                  passiveBinding?.probe_kind === "create_catch"
                  ||
                  shouldReleasePassiveEffectBreakpoint(effectProbe.create_type)
                  || (effectProbe.destroy_type !== undefined && effectProbe.destroy_type !== "undefined" && effectProbe.destroy_type !== "function")
                )) {
                  recentInvalidClientEffectProbeSets.push(snapshot);
                  if (recentInvalidClientEffectProbeSets.length > 5) recentInvalidClientEffectProbeSets.splice(0, recentInvalidClientEffectProbeSets.length - 5);
                }
                bumpEffectProbeStatus("snapshot_count");
                if (recentClientPausedFrameSets.length > 20) recentClientPausedFrameSets.splice(0, recentClientPausedFrameSets.length - 20);
              }
              await cdp.send("Debugger.resume").catch(() => undefined);
            }
          })();
        });
      } catch {
        // Diagnostic enrichment is fail-open and must not alter product flow.
      }
      const session: BrowserSession = { context, page, harnessCursor: 0, productCursor: null, latestProviderReceipt: null, contextExpiresAt: Number(grantReceipt.expires_at), expectedBinding: { testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, principalId: run.principalId, scenarioId: run.scenarioId, scenarioVersion: run.scenarioVersion, environment: run.environment, retentionHours: run.capturePolicy.retentionHours, providerExpiresAt: run.expiresAt.toISOString(), ...(exactBrowserContextBinding === undefined ? {} : { browserContextBinding: exactBrowserContextBinding }) } };
      this.#sessions.set(run.id, session);
      this.#pendingContexts.delete(run.id);
      await page.goto(new URL("/", frontendOrigin).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      assertPageLocation(page.url(), frontendOrigin, (pathname) => pathname === "/", "ORDINARY_UI_ORIGIN_DRIFT");
      const micAnchor = page.locator(this.config.onboardingMicSelector).first();
      const consentAccept = page.locator(CONSENT_ACCEPT_SELECTOR).first();
      const recoverableLoadError = page.getByText(RECOVERABLE_DASHBOARD_LOAD_ERROR).first();
      const recoverableLoadReload = page.getByRole("button", { name: RECOVERABLE_DASHBOARD_RELOAD_BUTTON, exact: true }).first();
      ordinaryRouteStage = "dashboard_privacy_consent";
      await establishDashboardMicRoute({
        isMicVisible: () => micAnchor.isVisible(),
        isConsentVisible: () => consentAccept.isVisible(),
        isConsentEnabled: () => consentAccept.isEnabled(),
        acceptConsent: () => consentAccept.click({ timeout: 20_000 }),
        isRecoverableLoadErrorVisible: () => recoverableLoadError.isVisible(),
        reload: async () => {
          await recoverableLoadReload.click({ timeout: 20_000 });
          assertPageLocation(page.url(), frontendOrigin, (pathname) => pathname === "/", "ORDINARY_UI_ORIGIN_DRIFT");
        },
        wait: () => page.waitForTimeout(100),
        timeoutMs: DASHBOARD_ROUTE_TIMEOUT_MS,
      });
      ordinaryRouteStage = "dashboard_microphone_cta";
      const dashboardButton = await resolveDashboardMicButton(page, micAnchor);
      await activateDashboardMicButton(page, dashboardButton);
      ordinaryRouteStage = "fresh_session_choice";
      const fresh = page.getByRole("button", { name: new RegExp(`^${escapeRegex(this.config.freshButtonName)}$`, "i") }).first();
      if (await fresh.isVisible({ timeout: 1_200 }).catch(() => false)) await fresh.click();
      ordinaryRouteStage = "session_navigation";
      await page.waitForURL((url) => url.origin === frontendOrigin && /^\/session(?:\/|$)/.test(url.pathname) && url.hash === "", { timeout: 20_000 });
      assertPageLocation(page.url(), frontendOrigin, (pathname) => /^\/session(?:\/|$)/.test(pathname), "ORDINARY_UI_ORIGIN_DRIFT");
      ordinaryRouteStage = "voice_tab_selection";
      const voiceTab = page.getByRole("tab", { name: /^voice$/i }).first();
      if (await voiceTab.isVisible({ timeout: 2_000 }).catch(() => false) && await voiceTab.getAttribute("aria-selected") !== "true") await voiceTab.click();
      ordinaryRouteStage = "voice_start_button";
      const startButton = page.getByRole("button", { name: this.config.startButtonName, exact: true }).first();
      await activateDashboardMicButton(page, startButton);
      ordinaryRouteStage = "voice_startup_readiness";
      const events = await this.#waitForStartupReadiness(run.id, session, 45_000);
      events.push(...await this.drain(run.id));
      events.push({ kind: "deployment.verified", source: "canonical", payload: deployment.components, dedupeKey: `deployment:${run.id}:startup` });
      events.push(await this.#snapshotEvent(session, "startup"));
      return { observedDeployment, events, ...(exactBrowserContextBinding === undefined ? {} : { browserContextBinding: exactBrowserContextBinding }) };
    } catch (error) {
      // A validated grant has allocated a Better Auth session. Retain that
      // context for worker.abort(), which owns the separately minted cleanup
      // capability and must revoke the login before closing the browser.
      if (this.#sessions.get(run.id)?.context === context) {
        if (error instanceof VoiceLabError) throw error;
        throw new VoiceLabError(labError("ORDINARY_UI_ROUTE_FAILED", "The ordinary deployed Sophia voice route could not be established.", "harness", false, { stage: ordinaryRouteStage, cause: classifyBrowserStartCause(error), client_page_error: currentClientPageErrorDiagnostic() }));
      }
      const closed = await closeContextWithProof(context, () => this.#browser?.contexts() ?? []);
      if (closed.closed) { this.#sessions.delete(run.id); this.#pendingContexts.delete(run.id); }
      else throw new VoiceLabError(labError("BROWSER_CONTEXT_CLOSE_FAILED", "Failed start left a browser context that could not be proven closed.", "harness", true, { original_error_class: error instanceof VoiceLabError ? error.detail.code : error instanceof Error ? error.name : "Error", close_error_class: closed.errorClass }));
      if (error instanceof VoiceLabError) throw error;
      throw new VoiceLabError(labError("ORDINARY_UI_ROUTE_FAILED", "The ordinary deployed Sophia voice route could not be established.", "harness", false, { stage: ordinaryRouteStage, cause: classifyBrowserStartCause(error), client_page_error: currentClientPageErrorDiagnostic() }));
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
      return { events: [{ kind: "cleanup.recovery", source: "canonical", payload: redact({ complete: liveComplete, pending, live_cleanup_complete: liveComplete, retention_purge_pending: retentionPending, retention_purged: retentionPurged, retention_purge_due_at: purgeDueValid ? purgeDueRaw : null, http_status: response.status, receipt }), dedupeKey: `recovery:${run.id}:${recoveryState}` }], artifacts: [] };
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
