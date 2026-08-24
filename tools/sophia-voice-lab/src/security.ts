import { createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { DeploymentIdentity } from "./domain.js";
import { VoiceLabError, labError } from "./domain.js";
import type { AttestationAuthority } from "./config.js";

export interface AuthenticatedCaller {
  subject: string;
  scopes: ReadonlySet<string>;
  authorizationKind?: "oauth" | "static" | "attestation";
  clientId?: string;
  tokenId?: string;
}

export interface RequestAuthenticator {
  authenticate(authorization: string | undefined): Promise<AuthenticatedCaller>;
}

/** OAuth is the registered-app lane; static bearer remains a separately
 * scoped direct-client preflight lane. Neither credential is transformed or
 * forwarded, and every candidate performs its own constant-time validation. */
export class CompositeRequestAuthenticator implements RequestAuthenticator {
  constructor(readonly authenticators: readonly RequestAuthenticator[]) {
    if (authenticators.length === 0) throw new VoiceLabError(labError("CONFIG_INVALID", "At least one request authenticator is required.", "internal"));
  }

  async authenticate(authorization: string | undefined): Promise<AuthenticatedCaller> {
    for (const authenticator of this.authenticators) {
      try { return await authenticator.authenticate(authorization); }
      catch (error) {
        if (!(error instanceof VoiceLabError) || error.detail.category !== "authorization") throw error;
      }
    }
    throw unauthorized("Bearer authorization is invalid.");
  }
}

export class StaticBearerAuthenticator implements RequestAuthenticator {
  readonly #expectedHash: Buffer;
  readonly #faultHash: Buffer | null;
  readonly #subject: string;
  readonly #scopes: ReadonlySet<string>;

  constructor(token: string, subject: string, faultToken: string | null = null) {
    if (Buffer.byteLength(token) < 32 || (faultToken !== null && Buffer.byteLength(faultToken) < 32)) throw new VoiceLabError(labError("CONFIG_INVALID", "Bearer credentials must contain at least 32 bytes.", "internal"));
    if (faultToken === token) throw new VoiceLabError(labError("CONFIG_INVALID", "Fault bearer credential must be distinct from the base credential.", "internal"));
    this.#expectedHash = createHash("sha256").update(token).digest();
    this.#faultHash = faultToken === null ? null : createHash("sha256").update(faultToken).digest();
    this.#subject = subject;
    this.#scopes = new Set(["voice_lab:read", "voice_lab:run"]);
  }

  async authenticate(authorization: string | undefined): Promise<AuthenticatedCaller> {
    if (!authorization?.startsWith("Bearer ")) throw unauthorized("Bearer authorization is required.");
    const token = authorization.slice("Bearer ".length);
    const actual = createHash("sha256").update(token).digest();
    const baseMatch = timingSafeEqual(this.#expectedHash, actual);
    const faultMatch = this.#faultHash === null ? false : timingSafeEqual(this.#faultHash, actual);
    if (!baseMatch && !faultMatch) throw unauthorized("Bearer authorization is invalid.");
    return { subject: this.#subject, scopes: faultMatch ? new Set([...this.#scopes, "voice_lab:fault"]) : this.#scopes, authorizationKind: "static" };
  }
}

/** A one-purpose web-only credential. It cannot authenticate MCP tools,
 * registered-app OAuth, fault injection, or external attestation traffic. */
export class ProvisionOperatorBearerAuthenticator implements RequestAuthenticator {
  readonly #expectedHash: Buffer;

  constructor(token: string) {
    if (Buffer.byteLength(token) < 32 || Buffer.byteLength(token) > 512) {
      throw new VoiceLabError(labError('CONFIG_INVALID', 'Provision operator bearer credential must contain 32 to 512 bytes.', 'internal'));
    }
    this.#expectedHash = createHash('sha256').update(token).digest();
  }

  async authenticate(authorization: string | undefined): Promise<AuthenticatedCaller> {
    if (!authorization?.startsWith('Bearer ')) throw unauthorized('Provision operator bearer authorization is required.');
    const actual = createHash('sha256').update(authorization.slice('Bearer '.length)).digest();
    if (!timingSafeEqual(this.#expectedHash, actual)) throw unauthorized('Provision operator bearer authorization is invalid.');
    return {
      subject: 'system.principal-provision-operator',
      scopes: new Set(['voice_lab:provision']),
      authorizationKind: 'static',
    };
  }
}

/** A separate direct-only evidence lane. Registered OAuth tokens, the base
 * diagnostic bearer, and the fault bearer can never acquire attestation
 * authority; only this independently configured credential can submit
 * externally authored campaign facts. */
export class StaticAttestationAuthenticator implements RequestAuthenticator {
  readonly #authorities: ReadonlyArray<{ authority: AttestationAuthority; subject: string; expectedHash: Buffer }>;
  constructor(entries: Record<AttestationAuthority, { token: string; subject: string }>) {
    const authorities = Object.entries(entries) as Array<[AttestationAuthority, { token: string; subject: string }]>;
    if (authorities.length !== 3 || new Set(authorities.map(([, entry]) => entry.token)).size !== authorities.length || new Set(authorities.map(([, entry]) => entry.subject)).size !== authorities.length
      || authorities.some(([, entry]) => Buffer.byteLength(entry.token) < 32 || !/^[A-Za-z0-9._:-]{8,128}$/.test(entry.subject))) {
      throw new VoiceLabError(labError("CONFIG_INVALID", "Source-specific attestation transport credentials or subjects are invalid.", "internal"));
    }
    this.#authorities = authorities.map(([authority, entry]) => ({ authority, subject: entry.subject, expectedHash: createHash("sha256").update(entry.token).digest() }));
  }
  async authenticate(authorization: string | undefined): Promise<AuthenticatedCaller> {
    if (!authorization?.startsWith("Bearer ")) throw unauthorized("Attestation bearer authorization is required.");
    const actual = createHash("sha256").update(authorization.slice("Bearer ".length)).digest();
    const match = this.#authorities.find((entry) => timingSafeEqual(entry.expectedHash, actual));
    if (!match) throw unauthorized("Attestation bearer authorization is invalid.");
    return { subject: match.subject, scopes: new Set(["voice_lab:attest", `voice_lab:attest:${match.authority}`]), authorizationKind: "attestation" };
  }
}

function unauthorized(message: string): VoiceLabError {
  return new VoiceLabError(labError("UNAUTHORIZED", message, "authorization"));
}

export function requireScope(caller: AuthenticatedCaller, scope: string): void {
  if (!caller.scopes.has(scope)) throw new VoiceLabError(labError("SCOPE_REQUIRED", `Scope ${scope} is required.`, "authorization"));
}

export interface CapabilityClaims {
  v: 1;
  iss: string;
  sub: string;
  principal_id: string;
  test_run_id: string;
  cleanup_obligation_id: string;
  scenario_id?: string;
  scenario_version?: string;
  voice_lab_run_id_sha256?: string;
  browser_worker_id_sha256?: string;
  browser_lease_epoch?: number;
  browser_context_id_sha256?: string;
  synthetic: true;
  environment: string;
  retention_hours: number;
  provider_expires_at: string;
  allowed_ops: string[];
  expected_deployment: DeploymentIdentity;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  nonce: string;
  aud: "sophia-voice-lab-frontend" | "sophia-voice-gateway" | "sophia-voice-runtime" | "sophia-voice-lab-recovery";
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export class CapabilityCodec {
  readonly #secret: Buffer;
  readonly #issuer: string;
  readonly #ttlSeconds: number;

  constructor(secret: string, issuer: string, ttlSeconds: number) {
    if (Buffer.byteLength(secret) < 32) throw new VoiceLabError(labError("CONFIG_INVALID", "Capability secret must contain at least 32 bytes.", "internal"));
    this.#secret = Buffer.from(secret);
    this.#issuer = issuer;
    this.#ttlSeconds = ttlSeconds;
  }

  mint(
    input: Omit<CapabilityClaims, "v" | "iss" | "iat" | "nbf" | "exp" | "jti" | "nonce">,
    now = new Date(),
    entropy: { jti: string; nonce: string } | null = null,
  ): { token: string; claims: CapabilityClaims; tokenHash: string } {
    if (entropy && (!/^[a-f0-9]{32}$/.test(entropy.jti) || !/^[a-f0-9]{32}$/.test(entropy.nonce))) {
      throw new VoiceLabError(labError("CAPABILITY_ENTROPY_INVALID", "Stored capability entropy is invalid.", "internal"));
    }
    const seconds = Math.floor(now.getTime() / 1_000);
    const claims: CapabilityClaims = {
      v: 1,
      iss: this.#issuer,
      ...input,
      iat: seconds,
      nbf: seconds - 2,
      exp: seconds + this.#ttlSeconds,
      jti: entropy?.jti ?? randomBytes(16).toString("hex"),
      nonce: entropy?.nonce ?? randomBytes(16).toString("hex"),
    };
    const payload = b64url(JSON.stringify(claims));
    const mac = b64url(createHmac("sha256", this.#secret).update(payload).digest());
    const token = `${payload}.${mac}`;
    return { token, claims, tokenHash: sha256(token) };
  }

  verify(token: string, expected: { audience: CapabilityClaims["aud"]; operation: string; principalId: string; testRunId: string; cleanupObligationId: string; environment: string; retentionHours: number; providerExpiresAt: string; expectedDeployment: DeploymentIdentity; scenarioId?: string | null; scenarioVersion?: string | null; voiceLabRunIdSha256?: string; browserWorkerIdSha256?: string; browserLeaseEpoch?: number; browserContextIdSha256?: string }, now = new Date()): CapabilityClaims {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) throw unauthorized("Capability format is invalid.");
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature) || Buffer.from(payload, "base64url").toString("base64url") !== payload || Buffer.from(signature, "base64url").toString("base64url") !== signature) throw unauthorized("Capability encoding is not canonical base64url.");
    const expectedMac = createHmac("sha256", this.#secret).update(payload).digest();
    let actualMac: Buffer;
    try { actualMac = Buffer.from(signature, "base64url"); } catch { throw unauthorized("Capability signature is invalid."); }
    if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) throw unauthorized("Capability signature is invalid.");
    let claims: CapabilityClaims;
    try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CapabilityClaims; } catch { throw unauthorized("Capability payload is invalid."); }
    const seconds = Math.floor(now.getTime() / 1_000);
    const allowedKeys = new Set(["v", "iss", "sub", "principal_id", "test_run_id", "cleanup_obligation_id", "scenario_id", "scenario_version", "voice_lab_run_id_sha256", "browser_worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256", "synthetic", "environment", "retention_hours", "provider_expires_at", "allowed_ops", "expected_deployment", "iat", "nbf", "exp", "jti", "nonce", "aud"]);
    if (!claims || typeof claims !== "object" || Object.keys(claims).some((key) => !allowedKeys.has(key))) throw unauthorized("Capability claim set is invalid.");
    const safeId = (value: unknown, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9._:-]+$/.test(value);
    const deployment = claims.expected_deployment;
    const exactDeployment = deployment && (["frontend", "backend", "voice"] as const).every((key) => typeof deployment[key] === "string" && /^[a-f0-9]{40}$/i.test(deployment[key]) && deployment[key] === expected.expectedDeployment[key]);
    const integerTimes = [claims.iat, claims.nbf, claims.exp].every((value) => Number.isSafeInteger(value));
    const operationsValid = Array.isArray(claims.allowed_ops) && claims.allowed_ops.length > 0 && claims.allowed_ops.length <= 16 && new Set(claims.allowed_ops).size === claims.allowed_ops.length && claims.allowed_ops.every((value) => safeId(value, 80));
    const d02ClaimValues = [claims.voice_lab_run_id_sha256, claims.browser_worker_id_sha256, claims.browser_lease_epoch, claims.browser_context_id_sha256];
    const d02ExpectedValues = [expected.voiceLabRunIdSha256, expected.browserWorkerIdSha256, expected.browserLeaseEpoch, expected.browserContextIdSha256];
    const d02ClaimCount = d02ClaimValues.filter((value) => value !== undefined).length;
    const d02ExpectedCount = d02ExpectedValues.filter((value) => value !== undefined).length;
    const d02ClaimsValid = claims.scenario_id === "V-D02"
      ? d02ClaimCount === 4 && SHA256.test(claims.voice_lab_run_id_sha256!) && SHA256.test(claims.browser_worker_id_sha256!) && Number.isSafeInteger(claims.browser_lease_epoch) && Number(claims.browser_lease_epoch) > 0 && SHA256.test(claims.browser_context_id_sha256!)
      : d02ClaimCount === 0;
    const d02ExpectationsValid = (expected.scenarioId ?? null) === "V-D02"
      ? d02ExpectedCount === 4 && SHA256.test(expected.voiceLabRunIdSha256!) && SHA256.test(expected.browserWorkerIdSha256!) && Number.isSafeInteger(expected.browserLeaseEpoch) && Number(expected.browserLeaseEpoch) > 0 && SHA256.test(expected.browserContextIdSha256!)
      : d02ExpectedCount === 0;
    if (claims.v !== 1 || claims.iss !== this.#issuer || claims.synthetic !== true || !safeId(claims.sub) || !safeId(claims.principal_id) || !safeId(claims.test_run_id) || !UUID_V4.test(claims.cleanup_obligation_id) || !safeId(claims.jti) || !safeId(claims.nonce) || !Number.isSafeInteger(claims.retention_hours) || claims.retention_hours < 1 || claims.retention_hours > 168 || !canonicalUtcMillis(claims.provider_expires_at) || !integerTimes || !operationsValid || !exactDeployment || !d02ClaimsValid || !d02ExpectationsValid) throw unauthorized("Capability contract is invalid.");
    if (claims.nbf > seconds || claims.exp <= seconds || claims.iat > seconds + 5 || claims.nbf > claims.iat || claims.iat - claims.nbf > 5 || claims.exp <= claims.iat || claims.exp - claims.iat > this.#ttlSeconds) throw unauthorized("Capability is not currently valid.");
    if (claims.aud !== expected.audience || claims.principal_id !== expected.principalId || claims.sub !== expected.principalId || claims.test_run_id !== expected.testRunId || claims.cleanup_obligation_id !== expected.cleanupObligationId || claims.environment !== expected.environment || claims.retention_hours !== expected.retentionHours || claims.provider_expires_at !== expected.providerExpiresAt || !claims.allowed_ops.includes(expected.operation) || (expected.scenarioId ?? null) !== (claims.scenario_id ?? null) || (expected.scenarioVersion ?? null) !== (claims.scenario_version ?? null)
      || claims.voice_lab_run_id_sha256 !== expected.voiceLabRunIdSha256 || claims.browser_worker_id_sha256 !== expected.browserWorkerIdSha256 || claims.browser_lease_epoch !== expected.browserLeaseEpoch || claims.browser_context_id_sha256 !== expected.browserContextIdSha256) {
      throw unauthorized("Capability binding is invalid.");
    }
    return claims;
  }
}

function canonicalUtcMillis(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalRequestHash(input: unknown): string {
  const state = { nodes: 0, characters: 0, seen: new WeakSet<object>() };
  const canonical = stableJson(input, 0, state);
  if (Buffer.byteLength(canonical) > 1_000_000) throw new VoiceLabError(labError("ARGUMENT_BOUNDS", "Canonical request exceeded the bounded one-megabyte hashing contract.", "validation"));
  return sha256(canonical);
}

function stableJson(input: unknown, depth: number, state: { nodes: number; characters: number; seen: WeakSet<object> }): string {
  state.nodes += 1;
  if (depth > 64 || state.nodes > 50_000) throw new VoiceLabError(labError("ARGUMENT_BOUNDS", "Canonical request exceeded the bounded depth or node contract.", "validation"));
  if (typeof input === "string") {
    state.characters += input.length;
    if (state.characters > 1_000_000) throw new VoiceLabError(labError("ARGUMENT_BOUNDS", "Canonical request exceeded the bounded text contract.", "validation"));
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    if (input.length > 10_000) throw new VoiceLabError(labError("ARGUMENT_BOUNDS", "Canonical request array exceeded the bounded item contract.", "validation"));
    if (state.seen.has(input)) throw new VoiceLabError(labError("ARGUMENT_BOUNDS", "Canonical request contains a cycle.", "validation"));
    state.seen.add(input);
    const result = `[${input.map((value) => stableJson(value, depth + 1, state)).join(",")}]`;
    state.seen.delete(input);
    return result;
  }
  if (input && typeof input === "object") {
    if (state.seen.has(input)) throw new VoiceLabError(labError("ARGUMENT_BOUNDS", "Canonical request contains a cycle.", "validation"));
    state.seen.add(input);
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > 1_000) throw new VoiceLabError(labError("ARGUMENT_BOUNDS", "Canonical request object exceeded the bounded key contract.", "validation"));
    const result = `{${entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value, depth + 1, state)}`).join(",")}}`;
    state.seen.delete(input);
    return result;
  }
  return JSON.stringify(input);
}

export function validateAllowedOrigin(rawUrl: string, allowed: ReadonlySet<string>): URL {
  const url = new URL(rawUrl);
  if (url.username || url.password || url.hash || url.search || url.pathname !== "/" || !allowed.has(url.origin)) {
    throw new VoiceLabError(labError("TARGET_NOT_ALLOWED", "Target URL is outside the exact origin allowlist.", "authorization"));
  }
  return url;
}

/** Resolve a service path only after proving it is origin-relative and cannot
 * redirect a signed capability to another authority. */
export function resolveAllowedOriginPath(rawOrigin: string, rawPath: string, allowed: ReadonlySet<string>): URL {
  const origin = validateAllowedOrigin(rawOrigin, allowed).origin;
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) {
    throw new VoiceLabError(labError("TARGET_NOT_ALLOWED", "Target path must be origin-relative.", "authorization"));
  }
  const endpoint = new URL(rawPath, `${origin}/`);
  if (endpoint.origin !== origin || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new VoiceLabError(labError("TARGET_NOT_ALLOWED", "Target path escaped the exact origin allowlist.", "authorization"));
  }
  return endpoint;
}

export function decryptStorageState(ciphertext: string, keyBase64: string): unknown {
  const packed = Buffer.from(ciphertext, "base64");
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32 || packed.length < 29) throw new VoiceLabError(labError("STORAGE_STATE_INVALID", "Encrypted storage state configuration is invalid.", "authorization"));
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const body = packed.subarray(28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  } catch {
    throw new VoiceLabError(labError("STORAGE_STATE_DECRYPT_FAILED", "Encrypted storage state could not be decrypted.", "authorization"));
  }
}

const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|storage.?state|capability|api[_-]?key|client[_-]?secret|resumption[_-]?handle|continuation[_-]?handle|ephemeral[_-]?(?:credential|token)|signed[_-]?url)/i;
const SECRET_VALUE = /(bearer\s+[a-z0-9._~+\/-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,}|https?:\/\/[^\s"']+[?&](?:token|access_token|api[_-]?key|key|signature|sig|credential|x-amz-signature)=)/i;
const SECRET_KEY_IN_JSON = /"(?:authorization|cookie|token|secret|password|capability|api[_-]?key|client[_-]?secret|resumption[_-]?handle|continuation[_-]?handle|ephemeral[_-]?(?:credential|token)|signed[_-]?url)"\s*:/i;

export function redact<T>(value: T): T {
  return redactInner(value, new WeakSet<object>()) as T;
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "[REDACTED]" : value;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactInner(item, seen));
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record)
    .filter(([key]) => key !== "cleanup_obligation_id" && !(key === "cleanup_obligation_id_sha256" && typeof record.cleanup_obligation_id === "string"))
    .map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactInner(entry, seen)] as const);
  // The raw cleanup obligation is recovery authority. It may cross only the
  // authenticated control-plane boundary; event/evidence projections retain
  // a one-way join and can never become a second cleanup credential store.
  if (typeof record.cleanup_obligation_id === "string") entries.push(["cleanup_obligation_id_sha256", sha256(record.cleanup_obligation_id)]);
  return Object.fromEntries(entries);
}

export function assertNoSecret(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (SECRET_VALUE.test(serialized) || SECRET_KEY_IN_JSON.test(serialized)) {
    throw new VoiceLabError(labError("SECRET_IN_EVIDENCE", "Potential secret material was detected before publication.", "evidence"));
  }
}

const CONTENT_KEY = /(^|_)(text|transcript|message|content|body|prompt|response)(_|$)/i;

export function projectPublicData(value: unknown, key = "root", depth = 0): unknown {
  if (depth > 12) return "[DEPTH_LIMIT]";
  if (typeof value === "string") {
    if (CONTENT_KEY.test(key)) return { redacted: true, sha256: sha256(value), character_length: [...value].length };
    return value.length > 1_000 ? { redacted: true, sha256: sha256(value), character_length: [...value].length, reason: "value_limit" } : value;
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => projectPublicData(item, key, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(redact(value as Record<string, unknown>)).slice(0, 300).map(([childKey, child]) => [childKey, projectPublicData(child, childKey, depth + 1)]));
}
