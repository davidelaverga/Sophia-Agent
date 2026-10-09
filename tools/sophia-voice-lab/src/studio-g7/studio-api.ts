import { VoiceLabError, labError } from "../domain.js";
import { validateAllowedOrigin } from "../security.js";
import { StudioContractViolation, parseQualificationEvidence, type ParsedQualificationEvidence } from "./contract.js";
import type { FetchLike } from "./supabase-session.js";

/**
 * Member-API reads and the one mutation (End) the Studio adapter performs.
 * Every request goes to an allowlisted bare origin, never follows redirects,
 * and carries the principal's own Supabase access JWT. No response body is
 * retained beyond the typed fields extracted here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/;

export type IdentityObservation =
  | { status: "observed"; commit: string }
  | { status: "unavailable"; reason: "identity_not_published" | "identity_endpoint_unavailable" | "identity_malformed"; http_status: number | null };

export interface StudioRoomSnapshot {
  roomIdPresent: boolean;
  /** LiveKit room identifier (a member-visible id, kept only for joins). */
  roomId: string | null;
  exchangeId: string | null;
  inputEpoch: number | null;
}

export type EvidenceRead =
  | { status: "available"; evidence: ParsedQualificationEvidence; http_status: number }
  | { status: "unavailable"; reason: "not_answered_to_principal" | "endpoint_unavailable" | "auth_rejected"; http_status: number | null }
  | { status: "rejected"; reason: string; path: string | null; http_status: number };

export class StudioApiClient {
  readonly apiOrigin: string;
  readonly studioOrigin: string;

  constructor(
    apiOrigin: string,
    studioOrigin: string,
    allowedOrigins: ReadonlySet<string>,
    readonly fetchImpl: FetchLike = fetch,
    readonly timeoutMs = 10_000,
  ) {
    this.apiOrigin = validateAllowedOrigin(apiOrigin, allowedOrigins).origin;
    this.studioOrigin = validateAllowedOrigin(studioOrigin, allowedOrigins).origin;
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
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return projectRoomSnapshot(body);
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
    const body = await response.json().catch(() => undefined);
    try {
      const evidence = parseQualificationEvidence(body);
      if (evidence.exchangeId !== exchangeId.toLowerCase()) return { status: "rejected", reason: "evidence_exchange_mismatch", path: "exchangeId", http_status: response.status };
      return { status: "available", evidence, http_status: response.status };
    } catch (error) {
      if (error instanceof StudioContractViolation) return { status: "rejected", reason: error.reason, path: error.path, http_status: response.status };
      throw error;
    }
  }

  /** `POST /api/v1/exchanges/{id}/end` (idempotent, any member). */
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

  async #request(method: "GET" | "POST", pathname: string, accessToken: string): Promise<Response> {
    const url = new URL(pathname, this.apiOrigin);
    if (url.origin !== this.apiOrigin) throw new VoiceLabError(labError("TARGET_NOT_ALLOWED", "Studio API path escaped the allowlisted origin.", "authorization"));
    // A bodyless POST deliberately carries no content-type: Fastify rejects an
    // empty body declared as JSON.
    return this.fetchImpl(url, { method, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json", authorization: `Bearer ${accessToken}` } });
  }
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

/** Extract only the joins the adapter needs from the member snapshot. */
export function projectRoomSnapshot(body: unknown): StudioRoomSnapshot {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const room = record.room && typeof record.room === "object" && !Array.isArray(record.room) ? record.room as Record<string, unknown> : null;
  const sophia = room?.sophia && typeof room.sophia === "object" && !Array.isArray(room.sophia) ? room.sophia as Record<string, unknown> : null;
  const roomId = typeof room?.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(room.id) ? room.id : null;
  const exchangeId = typeof sophia?.exchangeId === "string" && UUID.test(sophia.exchangeId) ? sophia.exchangeId.toLowerCase() : null;
  const inputEpoch = typeof sophia?.inputEpoch === "number" && Number.isSafeInteger(sophia.inputEpoch) && sophia.inputEpoch >= 0 ? sophia.inputEpoch : null;
  return { roomIdPresent: roomId !== null, roomId, exchangeId, inputEpoch };
}
