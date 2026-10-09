import { createHash } from "node:crypto";

import { VoiceLabError, labError } from "../domain.js";
import { validateAllowedOrigin } from "../security.js";
import { StudioContractViolation, parseQualificationEvidence, type ParsedQualificationEvidence } from "./contract.js";
import type { FetchLike } from "./supabase-session.js";

/**
 * Member-API reads and the few mutations the Studio adapter performs, always
 * as the synthetic principal with its own Supabase access JWT. Every request
 * goes to an allowlisted bare origin and never follows redirects.
 *
 * Projections keep only ids, enumerated states, counts, hex digests and
 * timestamps. Free text the product returns (task instructions, research
 * Markdown, titles, filenames, limitations, note and decision words, error
 * messages) is dropped at the boundary and never reaches an event. The
 * principal's JWT, a withdrawal `previewToken` and a signed object-store
 * download URL stay in memory for the one request that needs them.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WORD = /^[a-z][a-z0-9_]{0,63}$/;
const SECTION = /^[a-z][a-z0-9-]{0,63}$/;
const PREVIEW_PROOF = /^v1\.[0-9]{1,12}\.[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_ARTIFACT_DOWNLOAD_BYTES = 32 * 1024 * 1024;

export type IdentityObservation =
  | { status: "observed"; commit: string }
  | { status: "unavailable"; reason: "identity_not_published" | "identity_endpoint_unavailable" | "identity_malformed"; http_status: number | null };

export interface ProjectedTask {
  id: string;
  kind: "draft_brief" | "research" | "design";
  state: string;
  phase: string;
  actorId: string;
  commandId: string | null;
  createdAt: string | null;
  artifactId: string | null;
  resultSourceId: string | null;
}

export interface StudioRoomSnapshot {
  roomIdPresent: boolean;
  /** LiveKit room identifier (a member-visible id, kept only for joins). */
  roomId: string | null;
  /** The room's live exchange (open or paused), or null. One per room (0013 `one_live_exchange`). */
  exchangeId: string | null;
  exchangeState: "none" | "open" | "paused" | null;
  inputEpoch: number | null;
  /** The live exchange's floor holder (a Supabase `sub`), or null. */
  inputActorId: string | null;
  /** Native tasks of the project, projected to ids and states. */
  work: ProjectedTask[];
}

export type EvidenceRead =
  | { status: "available"; evidence: ParsedQualificationEvidence; http_status: number }
  | { status: "unavailable"; reason: "not_answered_to_principal" | "endpoint_unavailable" | "auth_rejected"; http_status: number | null }
  | { status: "rejected"; reason: string; path: string | null; http_status: number };

export interface ProjectedTaskDetail {
  task: ProjectedTask;
  research: { htmlState: string | null; designTaskId: string | null; amendsTaskId: string | null; rootTaskId: string | null } | null;
  design: {
    state: string; mode: string | null; artifactId: string | null; baseVersionId: string | null; publishedVersionId: string | null;
    researchTaskId: string | null; revisions: number | null; sections: string[];
  } | null;
  outputs: Array<{ artifactVersionId: string; format: string; sourceId: string; sha256: string; byteLength: number | null }>;
}

export interface ProjectedArtifactVersion {
  id: string;
  artifactId: string;
  parentId: string | null;
  sourceId: string;
  sourceHash: string | null;
  state: string;
  format: string;
  versionNumber: number | null;
  renditions: Array<{ format: string; sourceId: string; sha256: string; byteLength: number }>;
}

export interface SourceContentRead {
  sourceId: string;
  sha256: string;
  byteLength: number;
  mime: string | null;
  /** In memory only: a signed object-store URL is a bearer capability. */
  downloadUrl: string | null;
  /** In memory only: inline source text, hashed and dropped. */
  inlineText: string | null;
}

export interface ProjectedMissionEntry { id: string; state: string; actorId: string | null; origin: string | null; exchangeId: string | null }

export interface WithdrawalPreview {
  entryId: string;
  entryIds: string[];
  decisions: Array<{ id: string; revision: number }>;
  /** In memory only (an HMAC proof bound to the principal); never persisted. */
  previewProof: string;
  expiresAt: string | null;
}

export type MemberRead<T> = { status: "available"; value: T; http_status: number } | { status: "unavailable"; reason: string; http_status: number | null };

export interface MutationAnswer<T> {
  /** 2xx */
  accepted: boolean;
  http_status: number | null;
  /** The product's enumerated error code (e.g. `stale_revision`), never its message. */
  code: string | null;
  receipt: T | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function uuidOrNull(value: unknown): string | null { return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null; }
function wordOrNull(value: unknown): string | null { return typeof value === "string" && WORD.test(value) ? value : null; }
function intOrNull(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function isoOrNull(value: unknown): string | null { return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null; }

export function projectTask(raw: unknown): ProjectedTask | null {
  const task = record(raw);
  if (!task) return null;
  const id = uuidOrNull(task.id);
  const actorId = uuidOrNull(task.actorId);
  const kind = task.kind;
  const state = wordOrNull(task.state);
  const phase = wordOrNull(task.phase);
  if (!id || !actorId || (kind !== "draft_brief" && kind !== "research" && kind !== "design") || !state || !phase) return null;
  return { id, kind, state, phase, actorId, commandId: uuidOrNull(task.commandId), createdAt: isoOrNull(task.createdAt), artifactId: uuidOrNull(task.artifactId), resultSourceId: uuidOrNull(task.resultSourceId) };
}

export function projectTaskDetail(raw: unknown): ProjectedTaskDetail | null {
  const body = record(raw);
  const task = projectTask(body?.task);
  if (!body || !task) return null;
  const research = record(body.research);
  const html = record(research?.html);
  const design = record(body.design);
  const result = record(body.result);
  const outputs = Array.isArray(result?.outputs) ? result!.outputs as unknown[] : [];
  return {
    task,
    research: research ? { htmlState: wordOrNull(html?.state), designTaskId: uuidOrNull(html?.designTaskId), amendsTaskId: uuidOrNull(research.amendsTaskId), rootTaskId: uuidOrNull(research.rootTaskId) } : null,
    design: design && wordOrNull(design.state) ? {
      state: wordOrNull(design.state)!, mode: wordOrNull(design.mode), artifactId: uuidOrNull(design.artifactId), baseVersionId: uuidOrNull(design.baseVersionId),
      publishedVersionId: uuidOrNull(design.publishedVersionId), researchTaskId: uuidOrNull(design.researchTaskId), revisions: intOrNull(design.revisions),
      sections: Array.isArray(design.sections) ? (design.sections as unknown[]).filter((value): value is string => typeof value === "string" && SECTION.test(value)).slice(0, 16) : [],
    } : null,
    outputs: outputs.slice(0, 8).flatMap((value) => {
      const output = record(value);
      const artifactVersionId = uuidOrNull(output?.artifactVersionId);
      const sourceId = uuidOrNull(output?.sourceId);
      const sha256 = typeof output?.sha256 === "string" && SHA256.test(output.sha256) ? output.sha256 : null;
      const format = wordOrNull(output?.format);
      return artifactVersionId && sourceId && sha256 && format ? [{ artifactVersionId, format, sourceId, sha256, byteLength: intOrNull(output!.byteLength) }] : [];
    }),
  };
}

export function projectArtifactVersion(raw: unknown): ProjectedArtifactVersion | null {
  const version = record(raw);
  const id = uuidOrNull(version?.id);
  const artifactId = uuidOrNull(version?.artifactId);
  const sourceId = uuidOrNull(version?.sourceId);
  const state = wordOrNull(version?.state);
  const format = wordOrNull(version?.format);
  if (!version || !id || !artifactId || !sourceId || !state || !format) return null;
  const renditions = Array.isArray(version.renditions) ? version.renditions as unknown[] : [];
  return {
    id, artifactId, parentId: uuidOrNull(version.parentId), sourceId,
    sourceHash: typeof version.sourceHash === "string" && SHA256.test(version.sourceHash) ? version.sourceHash : null,
    state, format, versionNumber: intOrNull(version.versionNumber),
    renditions: renditions.slice(0, 8).flatMap((value) => {
      const rendition = record(value);
      const renditionSource = uuidOrNull(rendition?.sourceId);
      const sha256 = typeof rendition?.sha256 === "string" && SHA256.test(rendition.sha256) ? rendition.sha256 : null;
      const renditionFormat = wordOrNull(rendition?.format);
      const byteLength = intOrNull(rendition?.byteLength);
      return renditionSource && sha256 && renditionFormat && byteLength !== null ? [{ format: renditionFormat, sourceId: renditionSource, sha256, byteLength }] : [];
    }),
  };
}

export class StudioApiClient {
  readonly apiOrigin: string;
  readonly studioOrigin: string;
  readonly objectStoreOrigins: ReadonlySet<string>;

  constructor(
    apiOrigin: string,
    studioOrigin: string,
    allowedOrigins: ReadonlySet<string>,
    readonly fetchImpl: FetchLike = fetch,
    readonly timeoutMs = 10_000,
    objectStoreOrigins: readonly string[] = [],
  ) {
    this.apiOrigin = validateAllowedOrigin(apiOrigin, allowedOrigins).origin;
    this.studioOrigin = validateAllowedOrigin(studioOrigin, allowedOrigins).origin;
    this.objectStoreOrigins = new Set(objectStoreOrigins.map((origin) => validateAllowedOrigin(origin, allowedOrigins).origin));
  }

  /** `GET /health` → `{ ok, commit }`; a null commit is typed unavailable. */
  async apiIdentity(): Promise<IdentityObservation> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/health", this.apiOrigin), { redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json" } });
    } catch {
      return { status: "unavailable", reason: "identity_endpoint_unavailable", http_status: null };
    }
    if (!response.ok) return { status: "unavailable", reason: "identity_endpoint_unavailable", http_status: response.status };
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return { status: "unavailable", reason: "identity_malformed", http_status: response.status };
    if (body.commit === null || body.commit === undefined) return { status: "unavailable", reason: "identity_not_published", http_status: response.status };
    if (typeof body.commit !== "string" || !COMMIT.test(body.commit.toLowerCase())) return { status: "unavailable", reason: "identity_malformed", http_status: response.status };
    return { status: "observed", commit: body.commit.toLowerCase() };
  }

  /** `GET /ready` (the API's own readiness), status only. */
  async apiReady(): Promise<{ ok: boolean; http_status: number | null }> {
    try {
      const response = await this.fetchImpl(new URL("/ready", this.apiOrigin), { redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json" } });
      await response.arrayBuffer().catch(() => undefined);
      return { ok: response.ok, http_status: response.status };
    } catch {
      return { ok: false, http_status: null };
    }
  }

  /** `<meta name="sophia-build" content="<commit>">` in the served Studio document. */
  async studioIdentity(): Promise<IdentityObservation> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/", this.studioOrigin), { redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "text/html" } });
    } catch {
      return { status: "unavailable", reason: "identity_endpoint_unavailable", http_status: null };
    }
    if (!response.ok) return { status: "unavailable", reason: "identity_endpoint_unavailable", http_status: response.status };
    const html = (await response.text().catch(() => "")).slice(0, 262_144);
    return parseStudioBuildMeta(html, response.status);
  }

  async snapshot(projectId: string, accessToken: string): Promise<StudioRoomSnapshot> {
    if (!UUID.test(projectId)) throw new VoiceLabError(labError("STUDIO_CONFIG_INVALID", "The synthetic project id must be a UUID.", "internal"));
    const response = await this.#request("GET", `/api/v1/projects/${encodeURIComponent(projectId)}/snapshot`, accessToken);
    if (response.status === 401 || response.status === 403) throw new VoiceLabError(labError("STUDIO_API_AUTH_REJECTED", "The member API rejected the synthetic principal's session.", "authorization", true, { http_status: response.status }));
    if (!response.ok) throw new VoiceLabError(labError("STUDIO_SNAPSHOT_UNAVAILABLE", "The project snapshot could not be read.", "product", true, { http_status: response.status }));
    try { return projectRoomSnapshot(await readJson(response)); }
    catch (error) {
      // A 200 without a well-formed room answers nothing about the exchange:
      // unknown, never "no live exchange".
      if (error instanceof StudioContractViolation) throw new VoiceLabError(labError("STUDIO_SNAPSHOT_MALFORMED", "The project snapshot did not carry a well-formed room exchange state.", "product", true, { http_status: response.status, reason: error.reason, path: error.path }));
      throw error;
    }
  }

  async qualificationEvidence(exchangeId: string, accessToken: string): Promise<EvidenceRead> {
    if (!UUID.test(exchangeId)) throw new VoiceLabError(labError("STUDIO_EXCHANGE_ID_INVALID", "The exchange id must be a UUID.", "harness"));
    let response: Response;
    try {
      response = await this.#request("GET", `/api/v1/exchanges/${encodeURIComponent(exchangeId)}/qualification-evidence`, accessToken);
    } catch {
      return { status: "unavailable", reason: "endpoint_unavailable", http_status: null };
    }
    if (response.status === 404) return { status: "unavailable", reason: "not_answered_to_principal", http_status: 404 };
    if (response.status === 401 || response.status === 403) return { status: "unavailable", reason: "auth_rejected", http_status: response.status };
    if (!response.ok) return { status: "unavailable", reason: "endpoint_unavailable", http_status: response.status };
    const body = await readJson(response);
    try {
      const evidence = parseQualificationEvidence(body);
      if (evidence.exchangeId !== exchangeId.toLowerCase()) return { status: "rejected", reason: "evidence_exchange_mismatch", path: "exchangeId", http_status: response.status };
      return { status: "available", evidence, http_status: response.status };
    } catch (error) {
      if (error instanceof StudioContractViolation) return { status: "rejected", reason: error.reason, path: error.path, http_status: response.status };
      throw error;
    }
  }

  /** `POST /api/v1/exchanges/{id}/end` (idempotent). Called only for an exchange whose ownership is proven. */
  async endExchange(exchangeId: string, accessToken: string): Promise<{ accepted: boolean; http_status: number | null }> {
    if (!UUID.test(exchangeId)) throw new VoiceLabError(labError("STUDIO_EXCHANGE_ID_INVALID", "The exchange id must be a UUID.", "harness"));
    try {
      const response = await this.#request("POST", `/api/v1/exchanges/${encodeURIComponent(exchangeId)}/end`, accessToken);
      await response.arrayBuffer().catch(() => undefined);
      return { accepted: response.status >= 200 && response.status < 300, http_status: response.status };
    } catch {
      return { accepted: false, http_status: null };
    }
  }

  /** `GET /api/v1/projects/{p}/native-tasks/{t}`: instruction and result Markdown are dropped. */
  async nativeTask(projectId: string, taskId: string, accessToken: string): Promise<MemberRead<ProjectedTaskDetail>> {
    if (!UUID.test(projectId) || !UUID.test(taskId)) return { status: "unavailable", reason: "id_invalid", http_status: null };
    return this.#read(`/api/v1/projects/${encodeURIComponent(projectId)}/native-tasks/${encodeURIComponent(taskId)}`, accessToken, projectTaskDetail);
  }

  /** `GET /api/v1/artifacts/{a}/versions` (newest first): titles, notes and limitations are dropped. */
  async artifactVersions(artifactId: string, accessToken: string): Promise<MemberRead<ProjectedArtifactVersion[]>> {
    if (!UUID.test(artifactId)) return { status: "unavailable", reason: "id_invalid", http_status: null };
    return this.#read(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/versions`, accessToken, (body) => Array.isArray(body) ? body.slice(0, 500).map(projectArtifactVersion).filter((value): value is ProjectedArtifactVersion => value !== null) : null);
  }

  /** `GET /api/v1/sources/{s}/content`: the filename is dropped; the signed URL and inline text stay in memory. */
  async sourceContent(sourceId: string, accessToken: string): Promise<MemberRead<SourceContentRead>> {
    if (!UUID.test(sourceId)) return { status: "unavailable", reason: "id_invalid", http_status: null };
    return this.#read(`/api/v1/sources/${encodeURIComponent(sourceId)}/content`, accessToken, (raw) => {
      const body = record(raw);
      const id = uuidOrNull(body?.sourceId);
      const sha256 = typeof body?.sha256 === "string" && SHA256.test(body.sha256) ? body.sha256 : null;
      const byteLength = intOrNull(body?.byteLength);
      if (!body || !id || !sha256 || byteLength === null) return null;
      return {
        sourceId: id, sha256, byteLength,
        mime: typeof body.mime === "string" && /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,96}(?:;\s?charset=[a-z0-9-]{1,32})?$/i.test(body.mime) ? body.mime.toLowerCase() : null,
        downloadUrl: typeof body.downloadUrl === "string" && body.downloadUrl.length <= 8_192 ? body.downloadUrl : null,
        inlineText: typeof body.text === "string" ? body.text : null,
      };
    });
  }

  /**
   * Download a source's bytes through its signed URL, only from an
   * allowlisted object-store origin, and hash them. The URL is never
   * returned, logged or persisted; only the digest and length are.
   */
  async downloadSha256(downloadUrl: string, maxBytes = MAX_ARTIFACT_DOWNLOAD_BYTES): Promise<{ status: "downloaded"; sha256: string; byteLength: number } | { status: "unavailable"; reason: string; http_status: number | null }> {
    let url: URL;
    try { url = new URL(downloadUrl); } catch { return { status: "unavailable", reason: "download_url_malformed", http_status: null }; }
    if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) return { status: "unavailable", reason: "download_url_malformed", http_status: null };
    if (!this.objectStoreOrigins.has(url.origin)) return { status: "unavailable", reason: "object_store_origin_not_allowlisted", http_status: null };
    let response: Response;
    try {
      response = await this.fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(this.timeoutMs * 3) });
    } catch {
      return { status: "unavailable", reason: "download_failed", http_status: null };
    }
    if (!response.ok) { await response.arrayBuffer().catch(() => undefined); return { status: "unavailable", reason: "download_rejected", http_status: response.status }; }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel().catch(() => undefined); return { status: "unavailable", reason: "download_too_large", http_status: response.status }; }
    if (!response.body) return { status: "unavailable", reason: "download_failed", http_status: response.status };
    const digest = createHash("sha256");
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => undefined); return { status: "unavailable", reason: "download_too_large", http_status: response.status }; }
      digest.update(value);
    }
    return { status: "downloaded", sha256: digest.digest("hex"), byteLength: total };
  }

  /** `GET /api/v1/projects/{p}/mission`: entries projected to ids, states and joins; their words are dropped. */
  async missionEntries(projectId: string, accessToken: string): Promise<MemberRead<ProjectedMissionEntry[]>> {
    if (!UUID.test(projectId)) return { status: "unavailable", reason: "id_invalid", http_status: null };
    return this.#read(`/api/v1/projects/${encodeURIComponent(projectId)}/mission`, accessToken, (raw) => {
      const body = record(raw);
      if (!body) return null;
      const all = [...(Array.isArray(body.entries) ? body.entries : []), ...(Array.isArray(body.history) ? body.history : [])] as unknown[];
      const seen = new Set<string>();
      return all.slice(0, 200).flatMap((value) => {
        const entry = record(value);
        const id = uuidOrNull(entry?.id);
        const state = wordOrNull(entry?.state);
        if (!entry || !id || !state || seen.has(id)) return [];
        seen.add(id);
        return [{ id, state, actorId: uuidOrNull(entry.actorId), origin: wordOrNull(entry.origin), exchangeId: uuidOrNull(entry.exchangeId) }];
      });
    });
  }

  /** `GET .../mission/entries/{e}/withdrawal`: ids, revisions and the preview proof; the words are dropped. */
  async withdrawalPreview(projectId: string, entryId: string, accessToken: string): Promise<MemberRead<WithdrawalPreview>> {
    if (!UUID.test(projectId) || !UUID.test(entryId)) return { status: "unavailable", reason: "id_invalid", http_status: null };
    return this.#read(`/api/v1/projects/${encodeURIComponent(projectId)}/mission/entries/${encodeURIComponent(entryId)}/withdrawal`, accessToken, (raw) => {
      const body = record(raw);
      const id = uuidOrNull(body?.entryId);
      const proof = typeof body?.previewToken === "string" && PREVIEW_PROOF.test(body.previewToken) ? body.previewToken : null;
      if (!body || !id || !proof || !Array.isArray(body.entries) || !Array.isArray(body.decisions)) return null;
      const entryIds = (body.entries as unknown[]).map((value) => uuidOrNull(record(value)?.id));
      const decisions = (body.decisions as unknown[]).map((value) => ({ id: uuidOrNull(record(value)?.id), revision: intOrNull(record(value)?.revision) }));
      if (entryIds.some((value) => value === null) || decisions.some((value) => value.id === null || value.revision === null || value.revision < 1)) return null;
      return { entryId: id, entryIds: entryIds as string[], decisions: decisions as Array<{ id: string; revision: number }>, previewProof: proof, expiresAt: isoOrNull(body.expiresAt) };
    });
  }

  /** `POST .../mission/entries/{e}/withdrawal` with exactly what the preview listed. */
  async withdraw(projectId: string, preview: WithdrawalPreview, accessToken: string, idempotencyKey: string): Promise<MutationAnswer<{ status: string; operation: string; entryId: string | null; affectedCount: number; ledgerRevision: number | null }>> {
    const body = { expectedAffected: { entryIds: preview.entryIds, decisions: preview.decisions }, previewToken: preview.previewProof };
    return this.#mutate(`/api/v1/projects/${encodeURIComponent(projectId)}/mission/entries/${encodeURIComponent(preview.entryId)}/withdrawal`, accessToken, idempotencyKey, body, (raw) => {
      const receipt = record(raw);
      const status = wordOrNull(receipt?.status);
      const operation = wordOrNull(receipt?.operation);
      if (!receipt || !status || !operation) return null;
      return { status, operation, entryId: uuidOrNull(receipt.entryId), affectedCount: Array.isArray(receipt.affected) ? receipt.affected.length : 0, ledgerRevision: intOrNull(receipt.ledgerRevision) };
    });
  }

  /** `POST /api/v1/projects/{p}/html-edits`: a section-only revision of a version's designed page. */
  async htmlEdit(projectId: string, request: { versionId: string; sections: string[]; instruction: string }, accessToken: string, idempotencyKey: string): Promise<MutationAnswer<{ taskId: string; state: string; versionId: string; baseCandidateId: string | null; sections: string[] }>> {
    if (!UUID.test(request.versionId) || request.sections.length < 1 || request.sections.length > 16 || request.sections.some((section) => !SECTION.test(section))) {
      throw new VoiceLabError(labError("STUDIO_HTML_EDIT_INVALID", "A section-only revision needs a version id and 1..16 section names.", "validation"));
    }
    return this.#mutate(`/api/v1/projects/${encodeURIComponent(projectId)}/html-edits`, accessToken, idempotencyKey, { versionId: request.versionId, sections: request.sections, instruction: request.instruction }, (raw) => {
      const receipt = record(raw);
      const taskId = uuidOrNull(receipt?.taskId);
      const state = wordOrNull(receipt?.state);
      const versionId = uuidOrNull(receipt?.versionId);
      if (!receipt || !taskId || !state || !versionId) return null;
      return { taskId, state, versionId, baseCandidateId: uuidOrNull(receipt.baseCandidateId), sections: Array.isArray(receipt.sections) ? (receipt.sections as unknown[]).filter((value): value is string => typeof value === "string" && SECTION.test(value)) : [] };
    });
  }

  async #read<T>(pathname: string, accessToken: string, project: (body: unknown) => T | null): Promise<MemberRead<T>> {
    let response: Response;
    try { response = await this.#request("GET", pathname, accessToken); }
    catch { return { status: "unavailable", reason: "endpoint_unavailable", http_status: null }; }
    if (response.status === 401 || response.status === 403) { await response.arrayBuffer().catch(() => undefined); return { status: "unavailable", reason: "auth_rejected", http_status: response.status }; }
    if (response.status === 404) { await response.arrayBuffer().catch(() => undefined); return { status: "unavailable", reason: "not_found_for_principal", http_status: 404 }; }
    if (!response.ok) { await response.arrayBuffer().catch(() => undefined); return { status: "unavailable", reason: "endpoint_unavailable", http_status: response.status }; }
    const value = project(await readJson(response));
    return value === null ? { status: "unavailable", reason: "answer_malformed", http_status: response.status } : { status: "available", value, http_status: response.status };
  }

  async #mutate<T>(pathname: string, accessToken: string, idempotencyKey: string, body: unknown, project: (body: unknown) => T | null): Promise<MutationAnswer<T>> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey)) throw new VoiceLabError(labError("STUDIO_IDEMPOTENCY_KEY_INVALID", "Studio mutation idempotency key is malformed.", "harness"));
    let response: Response;
    try { response = await this.#request("POST", pathname, accessToken, body, idempotencyKey); }
    catch { return { accepted: false, http_status: null, code: null, receipt: null }; }
    const parsed = await readJson(response);
    if (response.status >= 200 && response.status < 300) return { accepted: true, http_status: response.status, code: null, receipt: project(parsed) };
    return { accepted: false, http_status: response.status, code: wordOrNull(record(parsed)?.code), receipt: null };
  }

  async #request(method: "GET" | "POST", pathname: string, accessToken: string, body?: unknown, idempotencyKey?: string): Promise<Response> {
    const url = new URL(pathname, this.apiOrigin);
    if (url.origin !== this.apiOrigin) throw new VoiceLabError(labError("TARGET_NOT_ALLOWED", "Studio API path escaped the allowlisted origin.", "authorization"));
    // A bodyless POST deliberately carries no content-type: Fastify rejects an
    // empty body declared as JSON.
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${accessToken}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
    return this.fetchImpl(url, { method, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) { await response.body?.cancel().catch(() => undefined); return undefined; }
  const text = await response.text().catch(() => "");
  if (text.length > MAX_JSON_BYTES) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

export function parseStudioBuildMeta(html: string, httpStatus: number | null = null): IdentityObservation {
  const tags = html.match(/<meta\b[^>]{0,512}>/gi) ?? [];
  for (const tag of tags) {
    const name = /\bname\s*=\s*["']([^"']{0,64})["']/i.exec(tag)?.[1];
    if (name !== "sophia-build") continue;
    const content = /\bcontent\s*=\s*["']([^"']{0,128})["']/i.exec(tag)?.[1]?.toLowerCase();
    if (content !== undefined && COMMIT.test(content)) return { status: "observed", commit: content };
    return { status: "unavailable", reason: "identity_malformed", http_status: httpStatus };
  }
  return { status: "unavailable", reason: "identity_not_published", http_status: httpStatus };
}

/**
 * Extract only the joins the adapter needs from the member snapshot.
 *
 * The room's Sophia presence (`room.sophia.exchange`, always one of
 * none/open/paused in the product contract) is required: a body without it,
 * or a live state without a UUID exchange id, throws StudioContractViolation
 * so the caller types the exchange state unknown rather than "none".
 */
export function projectRoomSnapshot(body: unknown): StudioRoomSnapshot {
  const root = record(body);
  const room = record(root?.room);
  const sophia = record(room?.sophia);
  if (!root || !room) throw new StudioContractViolation("snapshot_room_missing", "room");
  if (!sophia) throw new StudioContractViolation("snapshot_sophia_presence_missing", "room.sophia");
  const roomId = typeof room.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(room.id) ? room.id : null;
  const exchangeState = sophia.exchange === "none" || sophia.exchange === "open" || sophia.exchange === "paused" ? sophia.exchange : null;
  if (exchangeState === null) throw new StudioContractViolation("snapshot_exchange_state_malformed", "room.sophia.exchange");
  const rawExchangeId = uuidOrNull(sophia.exchangeId);
  if (exchangeState !== "none" && rawExchangeId === null) throw new StudioContractViolation("snapshot_exchange_id_malformed", "room.sophia.exchangeId");
  // `exchange: none` means no live exchange whatever id is echoed.
  const exchangeId = exchangeState === "none" ? null : rawExchangeId;
  const inputEpoch = typeof sophia.inputEpoch === "number" && Number.isSafeInteger(sophia.inputEpoch) && sophia.inputEpoch >= 0 ? sophia.inputEpoch : null;
  const work = Array.isArray(root.work) ? (root.work as unknown[]).slice(0, 200).map(projectTask).filter((task): task is ProjectedTask => task !== null) : [];
  return { roomIdPresent: roomId !== null, roomId, exchangeId, exchangeState, inputEpoch, inputActorId: uuidOrNull(sophia.inputActorId), work };
}
