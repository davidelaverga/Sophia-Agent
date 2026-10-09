import { VoiceLabError, labError } from "../domain.js";
import { LEGACY_TARGET_KIND, STUDIO_G7_TARGET_KIND, TARGET_KINDS, type TargetKind } from "./contract.js";

/**
 * Studio G7 target configuration. Every value except the principal email and
 * password is non-secret. The password exists only in the environment and in
 * this in-memory object; it is excluded from `projectStudioG7Config`, from
 * every error, and from every event.
 */
export interface StudioG7Config {
  studioOrigin: string;
  apiOrigin: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  projectId: string;
  principalEmail: string;
  principalPassword: string;
  expected: { studio: string; api: string; bridge: string };
  /** Bounded wait for the grant-bound `mic_published` receipt before opening an exchange. */
  grantWaitMs: number;
  /** Interval after which the driver leaves and rejoins to refetch the room token. */
  grantRejoinIntervalMs: number;
  /**
   * Origins of the signed object-store URLs `GET /sources/{id}/content`
   * returns. Artifact bytes are downloaded and hashed only from these; an
   * empty list types every byte check `unavailable`.
   */
  objectStoreOrigins: string[];
  /**
   * Upper bound of a Supabase access JWT's lifetime. Global sign-out revokes
   * refresh tokens, not issued JWTs, so a dead foreign worker's Studio lease
   * is released only after this much time has passed since the first
   * confirmed global sign-out that followed the lease's expiry.
   */
  accessTokenMaxLifetimeMs: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/;

function value(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name]?.trim();
  if (!raw) throw new VoiceLabError(labError("CONFIG_MISSING", `Required Studio G7 configuration ${name} is missing.`, "internal"));
  return raw;
}

function bareOrigin(env: NodeJS.ProcessEnv, name: string, allowedOrigins: ReadonlySet<string>, nodeEnv: string): string {
  let url: URL;
  try { url = new URL(value(env, name)); } catch { throw new VoiceLabError(labError("CONFIG_INVALID", `${name} must be an absolute origin.`, "internal")); }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new VoiceLabError(labError("CONFIG_INVALID", `${name} must be a bare origin.`, "internal"));
  if (url.protocol !== "https:" && !(nodeEnv !== "production" && url.protocol === "http:")) throw new VoiceLabError(labError("CONFIG_INVALID", `${name} must use HTTPS.`, "internal"));
  if (!allowedOrigins.has(url.origin)) throw new VoiceLabError(labError("CONFIG_INVALID", `${name} must be listed in SOPHIA_VOICE_LAB_ALLOWED_ORIGINS.`, "internal"));
  return url.origin;
}

function origins(env: NodeJS.ProcessEnv, name: string, allowedOrigins: ReadonlySet<string>, nodeEnv: string): string[] {
  const raw = env[name]?.trim();
  if (!raw) return [];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length > 8) throw new VoiceLabError(labError("CONFIG_INVALID", `${name} accepts at most 8 origins.`, "internal"));
  return [...new Set(values.map((value) => bareOrigin({ [name]: value }, name, allowedOrigins, nodeEnv)))];
}

function commit(env: NodeJS.ProcessEnv, name: string): string {
  const raw = value(env, name).toLowerCase();
  if (!COMMIT.test(raw)) throw new VoiceLabError(labError("CONFIG_INVALID", `${name} must be an exact 40-character commit SHA.`, "internal"));
  return raw;
}

function seconds(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new VoiceLabError(labError("CONFIG_INVALID", `${name} must be an integer from ${min} to ${max}.`, "internal"));
  return parsed;
}

export function parseTargetKind(env: NodeJS.ProcessEnv): TargetKind {
  const raw = env.SOPHIA_VOICE_LAB_TARGET_KIND?.trim();
  if (!raw) return LEGACY_TARGET_KIND;
  if (!(TARGET_KINDS as readonly string[]).includes(raw)) throw new VoiceLabError(labError("CONFIG_INVALID", `SOPHIA_VOICE_LAB_TARGET_KIND must be one of ${TARGET_KINDS.join(", ")}.`, "internal"));
  return raw as TargetKind;
}

export function loadStudioG7Config(env: NodeJS.ProcessEnv, allowedOrigins: ReadonlySet<string>, nodeEnv: string): StudioG7Config {
  const projectId = value(env, "SOPHIA_VOICE_LAB_STUDIO_PROJECT_ID").toLowerCase();
  if (!UUID.test(projectId)) throw new VoiceLabError(labError("CONFIG_INVALID", "SOPHIA_VOICE_LAB_STUDIO_PROJECT_ID must be a UUID.", "internal"));
  const principalEmail = value(env, "SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_EMAIL");
  if (!/^[^\s@]{1,128}@[^\s@]{1,253}$/.test(principalEmail)) throw new VoiceLabError(labError("CONFIG_INVALID", "SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_EMAIL must be one address.", "internal"));
  const principalPassword = env.SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_PASSWORD ?? "";
  if (principalPassword.length < 12 || principalPassword.length > 1_024) throw new VoiceLabError(labError("CONFIG_INVALID", "SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_PASSWORD must be configured (12 to 1024 characters).", "internal"));
  const publishableKey = value(env, "SOPHIA_VOICE_LAB_STUDIO_SUPABASE_PUBLISHABLE_KEY");
  if (!/^[A-Za-z0-9._-]{16,2048}$/.test(publishableKey)) throw new VoiceLabError(labError("CONFIG_INVALID", "SOPHIA_VOICE_LAB_STUDIO_SUPABASE_PUBLISHABLE_KEY is malformed.", "internal"));
  const grantWaitSeconds = seconds(env, "SOPHIA_VOICE_LAB_STUDIO_GRANT_WAIT_SECONDS", 120, 5, 240);
  const rejoinSeconds = seconds(env, "SOPHIA_VOICE_LAB_STUDIO_GRANT_REJOIN_SECONDS", 15, 5, 120);
  const config: StudioG7Config = {
    studioOrigin: bareOrigin(env, "SOPHIA_VOICE_LAB_STUDIO_ORIGIN", allowedOrigins, nodeEnv),
    apiOrigin: bareOrigin(env, "SOPHIA_VOICE_LAB_STUDIO_API_ORIGIN", allowedOrigins, nodeEnv),
    supabaseUrl: bareOrigin(env, "SOPHIA_VOICE_LAB_STUDIO_SUPABASE_URL", allowedOrigins, nodeEnv),
    supabasePublishableKey: publishableKey,
    projectId,
    principalEmail,
    principalPassword,
    expected: {
      studio: commit(env, "SOPHIA_VOICE_LAB_STUDIO_EXPECTED_STUDIO_SHA"),
      api: commit(env, "SOPHIA_VOICE_LAB_STUDIO_EXPECTED_API_SHA"),
      bridge: commit(env, "SOPHIA_VOICE_LAB_STUDIO_EXPECTED_BRIDGE_SHA"),
    },
    grantWaitMs: grantWaitSeconds * 1_000,
    grantRejoinIntervalMs: Math.min(rejoinSeconds, grantWaitSeconds) * 1_000,
    objectStoreOrigins: origins(env, "SOPHIA_VOICE_LAB_STUDIO_OBJECT_STORE_ORIGINS", allowedOrigins, nodeEnv),
    accessTokenMaxLifetimeMs: seconds(env, "SOPHIA_VOICE_LAB_STUDIO_ACCESS_TOKEN_MAX_SECONDS", 3_600, 60, 86_400) * 1_000,
  };
  return config;
}

/** Public, credential-free projection for capabilities and evidence. */
export function projectStudioG7Config(config: StudioG7Config): Record<string, unknown> {
  return {
    target_kind: STUDIO_G7_TARGET_KIND,
    studio_origin: config.studioOrigin,
    api_origin: config.apiOrigin,
    supabase_origin: config.supabaseUrl,
    project_id: config.projectId,
    expected_deployment: { studio: config.expected.studio, api: config.expected.api, bridge: config.expected.bridge },
    grant_wait_ms: config.grantWaitMs,
    object_store_origins: [...config.objectStoreOrigins],
    access_token_max_lifetime_ms: config.accessTokenMaxLifetimeMs,
    principal_credentials: "environment_only_never_projected",
  };
}
