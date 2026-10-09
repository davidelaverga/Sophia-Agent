import type { VoiceLabConfig } from "../config.js";
import { STUDIO_G7_TARGET_KIND } from "./contract.js";
import type { StudioG7Config } from "./config.js";
import { StudioApiClient, type IdentityObservation } from "./studio-api.js";
import type { FetchLike } from "./supabase-session.js";

/**
 * Target-aware readiness for a studio-livekit-g7-v1 deployment, without any
 * credential and without allocating anything: the Studio document (and its
 * build meta), the API's /health identity and /ready, and Supabase Auth's
 * public health endpoint (publishable key only). A published identity that
 * differs from the pinned commit is not ready; an unpublished one is typed
 * unavailable and does not block readiness (a run types it again).
 */
export async function probeStudioReadiness(config: Pick<VoiceLabConfig, "allowedOrigins">, studio: StudioG7Config, fetchImpl: FetchLike = fetch): Promise<Record<string, unknown> & { ok: boolean; status: string }> {
  const api = new StudioApiClient(studio.apiOrigin, studio.studioOrigin, config.allowedOrigins, fetchImpl, 5_000, studio.objectStoreOrigins ?? []);
  const [studioIdentity, apiIdentity, apiReady, auth] = await Promise.all([api.studioIdentity(), api.apiIdentity(), api.apiReady(), authHealth(studio, fetchImpl)]);
  const identity = (component: "api" | "studio", observation: IdentityObservation) => observation.status === "observed"
    ? { status: observation.commit === studio.expected[component] ? "verified" : "mismatch", commit: observation.commit, expected: studio.expected[component] }
    : { status: "unavailable", reason: observation.reason, http_status: observation.http_status, expected: studio.expected[component] };
  const studioProjection = identity("studio", studioIdentity);
  const apiProjection = identity("api", apiIdentity);
  const studioReachable = studioIdentity.status === "observed" || studioIdentity.reason !== "identity_endpoint_unavailable";
  const ok = studioReachable && apiReady.ok && auth.ok && studioProjection.status !== "mismatch" && apiProjection.status !== "mismatch";
  return {
    ok,
    status: ok ? "ready" : studioProjection.status === "mismatch" || apiProjection.status === "mismatch" ? "deployment_mismatch" : "not_ready",
    target_kind: STUDIO_G7_TARGET_KIND,
    studio: { reachable: studioReachable, identity: studioProjection },
    api: { ready: apiReady.ok, ready_http_status: apiReady.http_status, identity: apiProjection },
    supabase_auth: auth,
    bridge: { identity: { status: "from_provider_receipts", expected: studio.expected.bridge } },
    evidence_route: { status: "not_probed_without_principal", path: "/api/v1/exchanges/{id}/qualification-evidence" },
    credentials_used: false,
  };
}

async function authHealth(studio: StudioG7Config, fetchImpl: FetchLike): Promise<{ ok: boolean; http_status: number | null }> {
  try {
    const response = await fetchImpl(new URL("/auth/v1/health", studio.supabaseUrl), { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json", apikey: studio.supabasePublishableKey } });
    await response.arrayBuffer().catch(() => undefined);
    return { ok: response.ok, http_status: response.status };
  } catch {
    return { ok: false, http_status: null };
  }
}
