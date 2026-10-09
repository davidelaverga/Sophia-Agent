import { VoiceLabError, labError } from "../domain.js";

/**
 * Supabase Auth for the dedicated synthetic Studio principal.
 *
 * Secrets handled here (password, access token, refresh token) never appear
 * in an error message, an error detail, a log line, an event or a manifest.
 * Errors carry only fixed codes, HTTP status numbers and enumerated
 * Supabase error codes that match a strict word pattern.
 */

export type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;

export interface SupabaseAuthTarget {
  /** Bare origin of the Supabase project, e.g. `https://abc.supabase.co`. */
  supabaseUrl: string;
  /** The project's publishable (anon) key. Not secret, but never logged. */
  publishableKey: string;
}

export interface StudioUserSession {
  accessToken: string;
  refreshToken: string;
  tokenType: "bearer";
  expiresIn: number;
  /** Epoch seconds. */
  expiresAt: number;
  userId: string;
  /** The exact supabase-js session object, as the Studio persists it. */
  storageValue: Record<string, unknown>;
}

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** supabase-js default storage key: `sb-<first DNS label of the project host>-auth-token`. */
export function supabaseStorageKey(supabaseUrl: string): string {
  const host = new URL(supabaseUrl).hostname;
  const label = host.split(".")[0] ?? "";
  if (!/^[A-Za-z0-9-]{1,63}$/.test(label)) throw new VoiceLabError(labError("STUDIO_CONFIG_INVALID", "The Supabase URL host does not yield a supabase-js storage key.", "internal"));
  return `sb-${label}-auth-token`;
}

function authEndpoint(target: SupabaseAuthTarget, pathname: string, search: Record<string, string>): URL {
  const base = new URL(target.supabaseUrl);
  if (base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
    throw new VoiceLabError(labError("STUDIO_CONFIG_INVALID", "The Supabase URL must be a bare origin.", "internal"));
  }
  const url = new URL(pathname, base.origin);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  return url;
}

function safeErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["error_code", "error"]) {
    const value = record[key];
    if (typeof value === "string" && SAFE_ERROR_CODE.test(value)) return value;
  }
  return null;
}

export function studioAuthError(code: string, message: string, status: number | null, errorCode: string | null, retryable = false): VoiceLabError {
  return new VoiceLabError(labError(code, message, "authorization", retryable, { http_status: status, supabase_error_code: errorCode }));
}

/**
 * Password grant against `{supabaseUrl}/auth/v1/token?grant_type=password`.
 * A rejected credential is a typed authorization failure; the message never
 * contains the email, password or any token.
 */
export async function passwordGrant(
  target: SupabaseAuthTarget,
  credentials: { email: string; password: string },
  options: { fetchImpl?: FetchLike; timeoutMs?: number; expectedUserId?: string; nowSeconds?: () => number } = {},
): Promise<StudioUserSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = authEndpoint(target, "/auth/v1/token", { grant_type: "password" });
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: { apikey: target.publishableKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    });
  } catch (error) {
    throw studioAuthError("STUDIO_AUTH_UNAVAILABLE", "The Supabase password grant could not be reached.", null, null, true);
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const errorCode = safeErrorCode(body);
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) {
      throw studioAuthError("STUDIO_AUTH_REJECTED", "The Supabase password grant rejected the synthetic principal credentials.", response.status, errorCode);
    }
    throw studioAuthError("STUDIO_AUTH_UNAVAILABLE", "The Supabase password grant failed.", response.status, errorCode, response.status >= 500 || response.status === 429);
  }
  const session = validateSessionBody(body, options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000)));
  if (options.expectedUserId !== undefined && session.userId.toLowerCase() !== options.expectedUserId.toLowerCase()) {
    // Revoke only the session just issued (scope=local): a global sign-out
    // would touch every session of a principal this Lab does not own.
    const revoked = await signOut(target, session.accessToken, "local", { fetchImpl, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    throw new VoiceLabError(labError("STUDIO_AUTH_PRINCIPAL_MISMATCH", "The Supabase session is not bound to the configured synthetic principal.", "authorization", false, { http_status: response.status, supabase_error_code: null, issued_session_revoked: revoked.confirmed }));
  }
  return session;
}

function validateSessionBody(body: Record<string, unknown> | null, nowSeconds: () => number): StudioUserSession {
  const user = body?.user && typeof body.user === "object" && !Array.isArray(body.user) ? body.user as Record<string, unknown> : null;
  const accessToken = body?.access_token;
  const refreshToken = body?.refresh_token;
  const tokenType = typeof body?.token_type === "string" ? body.token_type.toLowerCase() : null;
  const expiresIn = body?.expires_in;
  const now = nowSeconds();
  const expiresAt = typeof body?.expires_at === "number" ? body.expires_at : typeof expiresIn === "number" ? now + expiresIn : null;
  if (typeof accessToken !== "string" || accessToken.length < 16 || accessToken.length > 16_384
    || typeof refreshToken !== "string" || refreshToken.length < 8 || refreshToken.length > 4_096
    || tokenType !== "bearer" || typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0
    || expiresAt === null || !Number.isSafeInteger(expiresAt) || expiresAt <= now
    || !user || typeof user.id !== "string" || !UUID.test(user.id)) {
    throw studioAuthError("STUDIO_AUTH_SESSION_INVALID", "The Supabase password grant did not return a complete bearer session.", 200, null);
  }
  const storageValue: Record<string, unknown> = { ...body, expires_at: expiresAt };
  return { accessToken, refreshToken, tokenType: "bearer", expiresIn, expiresAt, userId: user.id, storageValue };
}

export interface SignOutReceipt {
  schema: "sophia_voice_lab_studio_sign_out_v1";
  scope: "global" | "local";
  confirmed: boolean;
  http_status: number | null;
  /** Fixed basis code; never a token. */
  basis: "global_logout_accepted" | "local_logout_accepted" | "session_already_revoked" | "rejected" | "unreachable" | "no_session_issued";
}

/**
 * Global sign-out (`POST /auth/v1/logout?scope=global`) revokes every refresh
 * token of the principal, including sessions the Studio itself rotated.
 * 204/200 confirms. 401/403 means the presented access token is no longer
 * valid; that alone does NOT prove the session family is revoked, so it is
 * unconfirmed and the caller must retry with a fresh grant.
 */
export async function globalSignOut(target: SupabaseAuthTarget, accessToken: string, options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<SignOutReceipt> {
  return signOut(target, accessToken, "global", options);
}

export async function signOut(target: SupabaseAuthTarget, accessToken: string, scope: "global" | "local", options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<SignOutReceipt> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = authEndpoint(target, "/auth/v1/logout", { scope });
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { apikey: target.publishableKey, authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    await response.arrayBuffer().catch(() => undefined);
    if (response.status === 204 || response.status === 200) return { schema: "sophia_voice_lab_studio_sign_out_v1", scope, confirmed: true, http_status: response.status, basis: scope === "global" ? "global_logout_accepted" : "local_logout_accepted" };
    return { schema: "sophia_voice_lab_studio_sign_out_v1", scope, confirmed: false, http_status: response.status, basis: response.status === 401 || response.status === 403 ? "session_already_revoked" : "rejected" };
  } catch {
    return { schema: "sophia_voice_lab_studio_sign_out_v1", scope, confirmed: false, http_status: null, basis: "unreachable" };
  }
}

/**
 * Init script that seeds the Studio's Supabase session and the mic-on-arrival
 * preference BEFORE application code runs. It seeds once per tab: once the
 * Studio owns the session (and may rotate its refresh token) a reload must not
 * restore the stale seeded value, which Supabase would treat as token reuse.
 * The script runs only in the exact Studio origin's top-level document.
 */
export function buildStudioSessionSeedScript(input: { studioOrigin: string; storageKey: string; session: StudioUserSession }): string {
  const payload = JSON.stringify({
    origin: new URL(input.studioOrigin).origin,
    key: input.storageKey,
    value: JSON.stringify(input.session.storageValue),
  }).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `(() => {
    'use strict';
    const seed = ${payload};
    if (location.origin !== seed.origin || window.top !== window) return;
    try {
      const marker = 'sophia.voice-lab.session-seeded.v1';
      if (sessionStorage.getItem(marker) === '1') return;
      if (localStorage.getItem(seed.key) === null) localStorage.setItem(seed.key, seed.value);
      localStorage.setItem('sophia.mic.v1', 'on');
      sessionStorage.setItem(marker, '1');
    } catch {}
  })();`;
}
