import { createHash, createPublicKey } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VoiceLabError, labError, type TargetSpec } from "./domain.js";
import type { CallerPartitionKeyRing } from "./caller-partition.js";

const CONFIG_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const VOICE_LAB_PACKAGE_ROOT = path.basename(path.dirname(CONFIG_MODULE_DIR)) === "dist" ? path.resolve(CONFIG_MODULE_DIR, "../..") : path.resolve(CONFIG_MODULE_DIR, "..");
export const BUNDLED_FIXTURE_MANIFEST_PATH = path.join(VOICE_LAB_PACKAGE_ROOT, "fixtures/manifest.json");
export const BUNDLED_FIXTURE_ROOT = path.join(VOICE_LAB_PACKAGE_ROOT, "fixtures/audio");
export const BUNDLED_FIXTURE_MANIFEST_SHA256 = "574806ada0f6450c097bffe6aa50c469c03bcc55cd21c8f5c78e9c9ef72073b8";

// SemVer 2.0.0, including optional pre-release and build metadata. The
// plugin-creator cachebuster uses the build form `<base>+codex.<token>`.
export const STRICT_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
// Exact output of update_plugin_cachebuster.py: a valid SemVer base (with an
// optional prerelease), one `codex` build identifier, and one lower-case
// sanitized token with no leading, trailing, or repeated hyphens.
export const FINAL_CODEX_PLUGIN_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?\+codex\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new VoiceLabError(labError("CONFIG_MISSING", `Required configuration ${name} is missing.`, "internal"));
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new VoiceLabError(labError("CONFIG_INVALID", `${name} must be an integer from ${min} to ${max}.`, "internal"));
  }
  return parsed;
}

export const ATTESTATION_AUTHORITIES = ["external_mcp_client", "deployment_control", "platform_plugin"] as const;
export type AttestationAuthority = typeof ATTESTATION_AUTHORITIES[number];

const TEST_ATTESTATION_PUBLIC_KEYS = {
  external_mcp_client: { issuer: "sophia-voice-lab-external-client-controller", subject: "voice-lab-attester.external-client", key_id: "test-external-client-v1", public_key_spki_base64: "MCowBQYDK2VwAyEAFE2HUVER8I2XbnQ3BPiTxu4yb5yp2ELz6Eb68QQH0a8=" },
  deployment_control: { issuer: "sophia-voice-lab-deployment-controller", subject: "voice-lab-attester.deployment-control", key_id: "test-deployment-control-v1", public_key_spki_base64: "MCowBQYDK2VwAyEA/tVcU3FChyJeJaYsle+tU0MkxigqyYhcQdcUBgOwMts=" },
  platform_plugin: { issuer: "sophia-platform-plugin-controller", subject: "voice-lab-attester.platform-plugin", key_id: "test-platform-plugin-v1", public_key_spki_base64: "MCowBQYDK2VwAyEAXxzDPsnrvq/fFy9zMNXnW0Z6DHOKupqlJGalxVCufso=" },
} as const;

const TEST_ATTESTATION_TRANSPORT_TOKENS: Record<AttestationAuthority, string> = {
  external_mcp_client: "external-client-attestation-transport-000001",
  deployment_control: "deployment-control-attestation-transport-01",
  platform_plugin: "platform-plugin-attestation-transport-00001",
};

function parseAttestationAuthorities(raw: string | undefined, nodeEnv: string): VoiceLabConfig["attestationAuthorities"] {
  let value: unknown;
  try { value = JSON.parse(raw?.trim() || (nodeEnv === "test" ? JSON.stringify(TEST_ATTESTATION_PUBLIC_KEYS) : required({ SOPHIA_VOICE_LAB_ATTESTATION_PUBLIC_KEYS_JSON: raw }, "SOPHIA_VOICE_LAB_ATTESTATION_PUBLIC_KEYS_JSON"))); }
  catch { throw new VoiceLabError(labError("CONFIG_INVALID", "Attestation public-key configuration must be strict JSON.", "internal")); }
  const authorities = ATTESTATION_AUTHORITIES;
  if (!value || typeof value !== "object" || Object.keys(value as Record<string, unknown>).sort().join(",") !== [...authorities].sort().join(",")) throw new VoiceLabError(labError("CONFIG_INVALID", "Attestation public-key configuration must contain exactly the three source authorities.", "internal"));
  const result = {} as VoiceLabConfig["attestationAuthorities"];
  const fingerprints = new Set<string>();
  for (const authority of authorities) {
    const entry = (value as Record<string, unknown>)[authority];
    if (!entry || typeof entry !== "object" || Object.keys(entry as Record<string, unknown>).sort().join(",") !== "issuer,key_id,public_key_spki_base64,subject") throw new VoiceLabError(labError("CONFIG_INVALID", `Attestation public key ${authority} is malformed.`, "internal"));
    const issuer = (entry as Record<string, unknown>).issuer;
    const subject = (entry as Record<string, unknown>).subject;
    const keyId = (entry as Record<string, unknown>).key_id;
    const encoded = (entry as Record<string, unknown>).public_key_spki_base64;
    if (typeof issuer !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(issuer) || typeof subject !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(subject)
      || typeof keyId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(keyId) || typeof encoded !== "string" || encoded.length > 512 || Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new VoiceLabError(labError("CONFIG_INVALID", `Attestation public key ${authority} has an invalid issuer, subject, identifier, or encoding.`, "internal"));
    try {
      const key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    } catch { throw new VoiceLabError(labError("CONFIG_INVALID", `Attestation public key ${authority} is not Ed25519 SPKI.`, "internal")); }
    const fingerprint = createHash("sha256").update(Buffer.from(encoded, "base64")).digest("hex");
    if (fingerprints.has(fingerprint)) throw new VoiceLabError(labError("CONFIG_INVALID", "Each attestation authority must use a distinct public key.", "internal"));
    fingerprints.add(fingerprint);
    result[authority] = { issuer, subject, keyId, publicKeySpkiBase64: encoded };
  }
  if (new Set(Object.values(result).map((entry) => entry.issuer)).size !== authorities.length || new Set(Object.values(result).map((entry) => entry.subject)).size !== authorities.length) throw new VoiceLabError(labError("CONFIG_INVALID", "Each attestation authority must use a distinct issuer and transport subject.", "internal"));
  return result;
}

function parseAttestationTransportTokens(raw: string | undefined, nodeEnv: string): Record<AttestationAuthority, string> {
  let value: unknown;
  try { value = JSON.parse(raw?.trim() || (nodeEnv === "test" ? JSON.stringify(TEST_ATTESTATION_TRANSPORT_TOKENS) : required({ SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON: raw }, "SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON"))); }
  catch { throw new VoiceLabError(labError("CONFIG_INVALID", "Attestation transport credentials must be strict JSON.", "internal")); }
  if (!value || typeof value !== "object" || Object.keys(value as Record<string, unknown>).sort().join(",") !== [...ATTESTATION_AUTHORITIES].sort().join(",")) throw new VoiceLabError(labError("CONFIG_INVALID", "Attestation transport credentials must contain exactly the three source authorities.", "internal"));
  const result = {} as Record<AttestationAuthority, string>;
  for (const authority of ATTESTATION_AUTHORITIES) {
    const token = (value as Record<string, unknown>)[authority];
    if (typeof token !== "string" || Buffer.byteLength(token) < 32 || Buffer.byteLength(token) > 512) throw new VoiceLabError(labError("CONFIG_INVALID", `Attestation transport credential ${authority} is invalid.`, "internal"));
    result[authority] = token;
  }
  if (new Set(Object.values(result)).size !== ATTESTATION_AUTHORITIES.length) throw new VoiceLabError(labError("CONFIG_INVALID", "Each attestation authority must use a distinct transport credential.", "internal"));
  return result;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new VoiceLabError(labError("CONFIG_INVALID", `${name} must be true/false.`, "internal"));
}

function parseCallerPartitionKeys(raw: string | undefined, nodeEnv: string): CallerPartitionKeyRing {
  const fallback = { active_key_id: "test-v1", keys: { "test-v1": "caller-partition-test-secret-00000000000001" } };
  let value: unknown;
  try { value = JSON.parse(raw?.trim() || (nodeEnv === "test" ? JSON.stringify(fallback) : required({ SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON: raw }, "SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON"))); }
  catch { throw new VoiceLabError(labError("CONFIG_INVALID", "Caller-partition HMAC key ring must be strict JSON.", "internal")); }
  if (!value || typeof value !== "object" || Object.keys(value as Record<string, unknown>).sort().join(",") !== "active_key_id,keys") throw new VoiceLabError(labError("CONFIG_INVALID", "Caller-partition key ring must contain exactly active_key_id and keys.", "internal"));
  const activeKeyId = (value as Record<string, unknown>).active_key_id;
  const keys = (value as Record<string, unknown>).keys;
  if (typeof activeKeyId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(activeKeyId) || !keys || typeof keys !== "object" || Array.isArray(keys)) throw new VoiceLabError(labError("CONFIG_INVALID", "Caller-partition key ring identifiers are invalid.", "internal"));
  const entries = Object.entries(keys as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 4 || !(activeKeyId in (keys as Record<string, unknown>)) || entries.some(([keyId, secret]) => !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) || typeof secret !== "string" || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512)
    || new Set(entries.map(([, secret]) => secret)).size !== entries.length) throw new VoiceLabError(labError("CONFIG_INVALID", "Caller-partition key ring values are invalid.", "internal"));
  return { activeKeyId, keys: Object.fromEntries(entries) as Record<string, string> };
}

function origins(env: NodeJS.ProcessEnv): Set<string> {
  const raw = required(env, "SOPHIA_VOICE_LAB_ALLOWED_ORIGINS");
  const result = new Set<string>();
  for (const candidate of raw.split(",")) {
    const url = new URL(candidate.trim());
    if (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && url.protocol === "http:")) {
      throw new VoiceLabError(labError("CONFIG_INVALID", "Allowed origins must use HTTPS in production.", "internal"));
    }
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new VoiceLabError(labError("CONFIG_INVALID", "Allowed origins must be bare origins.", "internal"));
    }
    result.add(url.origin);
  }
  return result;
}

export interface VoiceLabConfig {
  nodeEnv: string;
  serviceVersion: string;
  harnessVersion: string;
  mcpVersion: string;
  pluginVersion: string;
  pluginPackageSha256: string;
  repositoryBaseSha: string;
  repositoryCandidateSha: string;
  repositoryRollbackSha: string;
  registeredAppId: string | null;
  environment: "production" | "staging";
  port: number;
  allowedHosts: string[];
  databaseUrl: string | null;
  bearerToken: string;
  faultBearerToken: string | null;
  /** Web-only one-purpose credential for the principal provisioning endpoint. */
  provisionOperatorBearerToken: string | null;
  /** Web-only transport credentials. The evaluator worker loads this as null
   * and fails startup if the secrets are present in its environment. */
  attestationTransportTokens: Record<AttestationAuthority, string> | null;
  attestationAuthorities: Record<AttestationAuthority, { issuer: string; subject: string; keyId: string; publicKeySpkiBase64: string }>;
  bearerSubject: string;
  principalId: string;
  capabilitySecret: string;
  grantSecret: string;
  recoveryInternalSecret: string;
  /** Web/product-plane only. This credential authorizes exact D02 Gateway
   * freeze/settlement requests; the browser worker and deployment controller
   * must never receive it. */
  d02GatewayCapabilitySecret: string | null;
  /** Web-only public verification authority for Gateway-authored D02 receipts.
   * Retained keys keep immutable response-loss readback valid across rotation. */
  d02GatewayReceiptAuthority: { keyId: string; publicKeySpkiBase64: string; publicKeysById: Readonly<Record<string, string>> } | null;
  callerPartitionKeys: CallerPartitionKeyRing;
  capabilityIssuer: string;
  capabilityTtlSeconds: number;
  allowedOrigins: Set<string>;
  websocketOrigins: Set<string>;
  authGrantPath: string;
  authRefreshPath: string;
  authContinuePath: string;
  authCleanupPath: string;
  authSessionPath: string;
  authReadinessPath: string;
  authProvisionPath: string;
  recoveryPathPrefix: string;
  storageStateCiphertext: string | null;
  storageStateKey: string | null;
  fixtureManifestPath: string;
  fixtureRoot: string;
  fixtureManifestSha256: string;
  maxConcurrentRuns: number;
  maxRunsPerCaller: number;
  maxTextCharacters: number;
  maxAudioBytes: number;
  maxAudioDurationMs: number;
  maxUtterancesPerRun: number;
  maxInjectedDurationMs: number;
  maxInjectedBytes: number;
  admissionWindowSeconds: number;
  maxRollingRunStarts: number;
  maxRollingRunStartsPerCaller: number;
  maxRollingProviderSeconds: number;
  maxRollingProviderSecondsPerCaller: number;
  maxRollingSuites: number;
  maxRollingSuitesPerCaller: number;
  maxRollingSuiteChildren: number;
  maxRollingSuiteChildrenPerCaller: number;
  maxRollingInjectedDurationMs: number;
  maxRollingInjectedDurationMsPerCaller: number;
  maxRollingInjectedBytes: number;
  maxRollingInjectedBytesPerCaller: number;
  minUtteranceIntervalMs: number;
  ttsTimeoutMs: number;
  ttsExpectedVersion: string;
  maxRunSeconds: number;
  maxOperationSeconds: number;
  startOperationSeconds: number;
  endOperationSeconds: number;
  faultOperationSeconds: number;
  maxWaitMs: number;
  operationLeaseSeconds: number;
  browserLeaseSeconds: number;
  workerPollMs: number;
  killSwitch: boolean;
  provisioningEnabled: boolean;
  allowRawAudio: boolean;
  logLevel: string;
  onboardingMicSelector: string;
  freshButtonName: string;
  startButtonName: string;
  stopButtonName: string;
  readinessTarget: TargetSpec | null;
  oauth: {
    issuer: string;
    resource: string;
    metadataUrl: string;
    clientMetadataUrl: string;
    clientRedirectUri: string;
    operatorSubject: string;
    consentSecret: string;
    tokenPepper: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    endpointWindowSeconds: number;
    authorizeRequestsPerWindow: number;
    tokenRequestsPerWindow: number;
    revokeRequestsPerWindow: number;
    purgeBatchSize: number;
    admissionRetentionSeconds: number;
  } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, processRole: "web" | "worker" = "web"): VoiceLabConfig {
  const nodeEnv = env.NODE_ENV ?? "production";
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  const environment = env.SOPHIA_VOICE_LAB_ENVIRONMENT?.trim() || "production";
  if (environment !== "production" && environment !== "staging") throw new VoiceLabError(labError("CONFIG_INVALID", "SOPHIA_VOICE_LAB_ENVIRONMENT must be production or staging.", "internal"));
  const fixtureManifestOverride = env.SOPHIA_VOICE_LAB_FIXTURE_MANIFEST?.trim();
  const fixtureRootOverride = env.SOPHIA_VOICE_LAB_FIXTURE_ROOT?.trim();
  const fixtureDigestOverride = env.SOPHIA_VOICE_LAB_FIXTURE_MANIFEST_SHA256?.trim()?.toLowerCase();
  if (nodeEnv !== "test" && (fixtureManifestOverride || fixtureRootOverride)) throw new VoiceLabError(labError("CONFIG_INVALID", "Production fixture manifest/root paths are immutable bundled release assets and cannot be overridden.", "internal"));
  if (fixtureDigestOverride && !/^[a-f0-9]{64}$/.test(fixtureDigestOverride)) throw new VoiceLabError(labError("CONFIG_INVALID", "SOPHIA_VOICE_LAB_FIXTURE_MANIFEST_SHA256 must be one exact lowercase SHA-256 digest.", "internal"));
  if (nodeEnv !== "test" && fixtureDigestOverride && fixtureDigestOverride !== BUNDLED_FIXTURE_MANIFEST_SHA256) throw new VoiceLabError(labError("CONFIG_INVALID", "The configured fixture manifest digest conflicts with the compiled release pin.", "internal"));
  const allowedHosts = (env.SOPHIA_VOICE_LAB_ALLOWED_HOSTS ?? env.RENDER_EXTERNAL_HOSTNAME ?? "localhost,127.0.0.1").split(",").map((value) => value.trim()).filter(Boolean);
  const serviceVersion = env.RENDER_GIT_COMMIT?.trim() || env.COMMIT_SHA?.trim() || "development";
  const repositoryBaseSha = campaignValue(env, nodeEnv, "SOPHIA_VOICE_LAB_REPOSITORY_BASE_SHA", "41a9b127af780bbe9d88acf34566a6aaf443e6b0");
  const repositoryCandidateSha = campaignValue(env, nodeEnv, "SOPHIA_VOICE_LAB_REPOSITORY_CANDIDATE_SHA", serviceVersion);
  const repositoryRollbackSha = campaignValue(env, nodeEnv, "SOPHIA_VOICE_LAB_REPOSITORY_ROLLBACK_SHA", "a793100008f7ccb5a25e9e018f896e7ec9dc2a3d");
  for (const [name, value] of [["service deployment", serviceVersion], ["repository base", repositoryBaseSha], ["repository candidate", repositoryCandidateSha], ["repository rollback", repositoryRollbackSha]] as const) {
    if (!/^[a-f0-9]{40}$/i.test(value)) throw new VoiceLabError(labError("CONFIG_INVALID", `${name} identity must be an exact 40-character commit SHA.`, "internal"));
  }
  if (serviceVersion.toLowerCase() !== repositoryCandidateSha.toLowerCase()) {
    const identityDigest = (value: string) => createHash("sha256").update(value.toLowerCase()).digest("hex");
    throw new VoiceLabError(labError(
      "CONFIG_INVALID",
      "Repository candidate SHA must equal the exact running service commit.",
      "internal",
      false,
      {
        service_version_source: env.RENDER_GIT_COMMIT?.trim()
          ? "RENDER_GIT_COMMIT"
          : env.COMMIT_SHA?.trim()
            ? "COMMIT_SHA"
            : "development_fallback",
        service_version_sha256: identityDigest(serviceVersion),
        repository_candidate_sha256: identityDigest(repositoryCandidateSha),
        service_version_length: serviceVersion.length,
        repository_candidate_length: repositoryCandidateSha.length,
        raw_commit_identities_excluded: true,
      },
    ));
  }
  const harnessVersion = campaignValue(env, nodeEnv, "SOPHIA_VOICE_LAB_HARNESS_VERSION", "0.1.0");
  const mcpVersion = campaignValue(env, nodeEnv, "SOPHIA_VOICE_LAB_MCP_VERSION", "0.1.0");
  const pluginVersion = campaignValue(env, nodeEnv, "SOPHIA_VOICE_LAB_PLUGIN_VERSION", "0.1.0");
  for (const [name, value] of [["harness", harnessVersion], ["MCP", mcpVersion], ["plugin", pluginVersion]] as const) {
    if (!STRICT_SEMVER_PATTERN.test(value)) throw new VoiceLabError(labError("CONFIG_INVALID", `${name} version must be an exact SemVer 2.0.0 version.`, "internal"));
  }
  const pluginPackageSha256 = campaignValue(env, nodeEnv, "SOPHIA_VOICE_LAB_PLUGIN_PACKAGE_SHA256", "d".repeat(64));
  if (!/^[a-f0-9]{64}$/.test(pluginPackageSha256)) throw new VoiceLabError(labError("CONFIG_INVALID", "Plugin package identity must be an exact SHA-256 digest.", "internal"));
  const registeredAppId = env.SOPHIA_VOICE_LAB_REGISTERED_APP_ID?.trim() || null;
  if (registeredAppId !== null && !/^plugin_asdk_app[0-9A-Za-z_-]{4,112}$/.test(registeredAppId)) throw new VoiceLabError(labError("CONFIG_INVALID", "Registered app ID must be the exact plugin_asdk_app technical identity.", "internal"));
  if (registeredAppId !== null && !FINAL_CODEX_PLUGIN_VERSION_PATTERN.test(pluginVersion)) throw new VoiceLabError(labError("CONFIG_INVALID", "A registered plugin version must be the exact plugin-creator SemVer cachebuster form +codex.<sanitized-token>.", "internal"));
  const targetValues = [
    env.SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL,
    env.SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL,
    env.SOPHIA_VOICE_LAB_TARGET_VOICE_URL,
    env.SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL,
  ].map((value) => value?.trim() || null);
  const expectedValues = [
    env.SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA,
    env.SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA,
    env.SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA,
    env.SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA,
  ].map((value) => value?.trim() || null);
  const readinessValues = [...targetValues, ...expectedValues];
  const hasReadinessTarget = readinessValues.some((value) => value !== null);
  if (hasReadinessTarget && readinessValues.some((value) => value === null)) throw new VoiceLabError(labError("CONFIG_INVALID", "All readiness target URLs, product deployment SHAs, and dependency SHAs must be configured together.", "internal"));
  if (hasReadinessTarget && expectedValues.some((value) => !/^[a-f0-9]{40}$/i.test(value!))) throw new VoiceLabError(labError("CONFIG_INVALID", "Readiness expected deployment and dependency values must be exact 40-character SHAs.", "internal"));
  if (nodeEnv !== "test" && !hasReadinessTarget) throw new VoiceLabError(labError("CONFIG_MISSING", "The exact Voice Lab readiness target and expected component identities are required outside tests.", "internal"));
  if (nodeEnv !== "test" && !databaseUrl) {
    throw new VoiceLabError(labError("CONFIG_MISSING", "DATABASE_URL is required outside tests; production cannot use the memory ledger.", "internal"));
  }
  const bearerToken = required(env, "SOPHIA_VOICE_LAB_BEARER_TOKEN");
  const faultBearerToken = env.SOPHIA_VOICE_LAB_FAULT_BEARER_TOKEN?.trim() || null;
  const provisionOperatorRaw = env.SOPHIA_VOICE_LAB_PROVISION_OPERATOR_BEARER_TOKEN?.trim()
    || (nodeEnv === 'test' && processRole === 'web' ? 'principal-provision-operator-test-token-0001' : null);
  if (processRole === 'worker' && provisionOperatorRaw !== null) throw new VoiceLabError(labError('CONFIG_SECRET_EXPOSURE', 'The principal provision operator bearer must not be mounted in the evaluator worker environment.', 'internal'));
  if (processRole === 'web' && nodeEnv !== 'test' && provisionOperatorRaw === null) throw new VoiceLabError(labError('CONFIG_MISSING', 'The web-only principal provision operator bearer is required outside tests.', 'internal'));
  const provisionOperatorBearerToken = processRole === 'web' ? provisionOperatorRaw : null;
  const attestationAuthorities = parseAttestationAuthorities(env.SOPHIA_VOICE_LAB_ATTESTATION_PUBLIC_KEYS_JSON, nodeEnv);
  const attestationTransportRaw = env.SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON?.trim();
  if (processRole === "worker" && attestationTransportRaw) throw new VoiceLabError(labError("CONFIG_SECRET_EXPOSURE", "Attestation transport credentials must not be mounted in the evaluator worker environment.", "internal"));
  const attestationTransportTokens = processRole === "web" ? parseAttestationTransportTokens(attestationTransportRaw, nodeEnv) : null;
  if (Buffer.byteLength(bearerToken) < 32 || (faultBearerToken !== null && Buffer.byteLength(faultBearerToken) < 32) || (provisionOperatorBearerToken !== null && (Buffer.byteLength(provisionOperatorBearerToken) < 32 || Buffer.byteLength(provisionOperatorBearerToken) > 512))) throw new VoiceLabError(labError("CONFIG_INVALID", "Voice Lab bearer credentials must contain at least 32 bytes and the provision operator bearer must not exceed 512 bytes.", "internal"));
  const capabilitySecret = required(env, "SOPHIA_VOICE_LAB_CAPABILITY_SECRET");
  const grantSecret = required(env, "SOPHIA_VOICE_LAB_GRANT_SECRET");
  const recoveryInternalSecret = required(env, "SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET");
  const d02GatewayCapabilitySecret = env.SOPHIA_VOICE_LAB_D02_GATEWAY_CAPABILITY_SECRET?.trim()
    || (nodeEnv === "test" && processRole === "web" ? "test-d02-gateway-capability-secret-000001" : null);
  if (processRole === "worker" && d02GatewayCapabilitySecret !== null) throw new VoiceLabError(labError("CONFIG_SECRET_EXPOSURE", "The D02 Gateway capability secret must not be mounted in the evaluator worker environment.", "internal"));
  if (processRole === "web" && nodeEnv !== "test" && d02GatewayCapabilitySecret === null) throw new VoiceLabError(labError("CONFIG_MISSING", "The product-owned D02 Gateway capability secret is required by the web process.", "internal"));
  if (d02GatewayCapabilitySecret !== null && Buffer.byteLength(d02GatewayCapabilitySecret) < 32) throw new VoiceLabError(labError("CONFIG_INVALID", "The D02 Gateway capability secret must contain at least 32 bytes.", "internal"));
  const d02ReceiptPublicRaw = env.SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEY_SPKI_BASE64?.trim()
    || (nodeEnv === "test" && processRole === "web" ? TEST_ATTESTATION_PUBLIC_KEYS.platform_plugin.public_key_spki_base64 : null);
  const d02ReceiptKeyId = env.SOPHIA_VOICE_LAB_D02_SETTLEMENT_AUTHORITY_KEY_ID?.trim()
    || (nodeEnv === "test" && processRole === "web" ? "test-sophia-gateway-d02-v1" : null);
  const d02ReceiptKeyringRaw = env.SOPHIA_VOICE_LAB_D02_SETTLEMENT_ED25519_PUBLIC_KEYRING_JSON?.trim() || null;
  if (processRole === "worker" && (d02ReceiptPublicRaw !== null || d02ReceiptKeyId !== null || d02ReceiptKeyringRaw !== null)) throw new VoiceLabError(labError("CONFIG_SECRET_EXPOSURE", "D02 Gateway receipt authority configuration belongs only on the product web service.", "internal"));
  if (processRole === "web" && nodeEnv !== "test" && (d02ReceiptPublicRaw === null || d02ReceiptKeyId === null || d02ReceiptKeyringRaw === null)) throw new VoiceLabError(labError("CONFIG_MISSING", "The D02 Gateway receipt public key, retained keyring, and authority key ID are required by the web process.", "internal"));
  let d02GatewayReceiptAuthority: VoiceLabConfig["d02GatewayReceiptAuthority"] = null;
  if (d02ReceiptPublicRaw !== null && d02ReceiptKeyId !== null) {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(d02ReceiptKeyId) || Buffer.from(d02ReceiptPublicRaw, "base64").toString("base64") !== d02ReceiptPublicRaw) throw new VoiceLabError(labError("CONFIG_INVALID", "The D02 Gateway receipt authority key ID or public-key encoding is invalid.", "internal"));
    try {
      const key = createPublicKey({ key: Buffer.from(d02ReceiptPublicRaw, "base64"), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    } catch {
      throw new VoiceLabError(labError("CONFIG_INVALID", "The D02 Gateway receipt public key is not Ed25519 SPKI.", "internal"));
    }
    let parsedKeyring: unknown;
    try { parsedKeyring = JSON.parse(d02ReceiptKeyringRaw ?? JSON.stringify({ [d02ReceiptKeyId]: d02ReceiptPublicRaw })); }
    catch { throw new VoiceLabError(labError("CONFIG_INVALID", "The D02 Gateway receipt public-key ring must be strict JSON.", "internal")); }
    if (!parsedKeyring || typeof parsedKeyring !== "object" || Array.isArray(parsedKeyring)) throw new VoiceLabError(labError("CONFIG_INVALID", "The D02 Gateway receipt public-key ring must be an object.", "internal"));
    const keyEntries = Object.entries(parsedKeyring as Record<string, unknown>);
    if (keyEntries.length < 1 || keyEntries.length > 8) throw new VoiceLabError(labError("CONFIG_INVALID", "The D02 Gateway receipt public-key ring must retain one to eight keys.", "internal"));
    const publicKeysById: Record<string, string> = {};
    const fingerprints = new Set<string>();
    for (const [keyId, encoded] of keyEntries) {
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(keyId) || typeof encoded !== "string" || encoded.length > 512 || Buffer.from(encoded, "base64").toString("base64") !== encoded) throw new VoiceLabError(labError("CONFIG_INVALID", "The D02 Gateway receipt keyring contains an invalid identifier or encoding.", "internal"));
      try {
        const key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
        if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
      } catch { throw new VoiceLabError(labError("CONFIG_INVALID", "Every D02 Gateway retained receipt key must be Ed25519 SPKI.", "internal")); }
      const fingerprint = createHash("sha256").update(Buffer.from(encoded, "base64")).digest("hex");
      if (fingerprints.has(fingerprint)) throw new VoiceLabError(labError("CONFIG_INVALID", "D02 Gateway retained receipt keys must have distinct key IDs and public keys.", "internal"));
      fingerprints.add(fingerprint);
      publicKeysById[keyId] = encoded;
    }
    if (publicKeysById[d02ReceiptKeyId] !== d02ReceiptPublicRaw) throw new VoiceLabError(labError("CONFIG_INVALID", "The current D02 Gateway receipt key must exactly match its retained-keyring entry.", "internal"));
    if (nodeEnv !== "test" && Object.values(publicKeysById).some((encoded) => Object.values(attestationAuthorities).some((entry) => entry.publicKeySpkiBase64 === encoded))) throw new VoiceLabError(labError("CONFIG_INVALID", "Gateway D02 receipt keys must be distinct from all external attestation authorities.", "internal"));
    d02GatewayReceiptAuthority = { keyId: d02ReceiptKeyId, publicKeySpkiBase64: d02ReceiptPublicRaw, publicKeysById };
  }
  const callerPartitionKeys = parseCallerPartitionKeys(env.SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON, nodeEnv);
  if (Buffer.byteLength(capabilitySecret) < 32 || Buffer.byteLength(grantSecret) < 32 || Buffer.byteLength(recoveryInternalSecret) < 32) throw new VoiceLabError(labError("CONFIG_INVALID", "Grant, capability, recovery, and caller-partition secrets must contain at least 32 bytes.", "internal"));
  const credentials = [bearerToken, faultBearerToken, provisionOperatorBearerToken, ...(attestationTransportTokens ? Object.values(attestationTransportTokens) : []), grantSecret, capabilitySecret, recoveryInternalSecret, d02GatewayCapabilitySecret, ...Object.values(callerPartitionKeys.keys)].filter((value): value is string => value !== null);
  if (new Set(credentials).size !== credentials.length) throw new VoiceLabError(labError("CONFIG_INVALID", "Bearer, provision operator, frontend grant, capability, recovery, D02 Gateway, and caller-partition credentials must all be distinct.", "internal"));
  const ttsExpectedVersion = env.SOPHIA_VOICE_LAB_ESPEAK_VERSION?.trim() || "1.51";
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(ttsExpectedVersion)) throw new VoiceLabError(labError("CONFIG_INVALID", "SOPHIA_VOICE_LAB_ESPEAK_VERSION must be an exact numeric engine version.", "internal"));
  const oauthNames = ["SOPHIA_VOICE_LAB_OAUTH_ISSUER", "SOPHIA_VOICE_LAB_OAUTH_RESOURCE", "SOPHIA_VOICE_LAB_OAUTH_RESOURCE_METADATA_URL", "SOPHIA_VOICE_LAB_OAUTH_CLIENT_METADATA_URL", "SOPHIA_VOICE_LAB_OAUTH_CLIENT_REDIRECT_URI", "SOPHIA_VOICE_LAB_OAUTH_OPERATOR_SUBJECT", "SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET", "SOPHIA_VOICE_LAB_OAUTH_TOKEN_PEPPER"] as const;
  const oauthValues = oauthNames.map((name) => env[name]?.trim() || null);
  const anyOauth = oauthValues.some((value) => value !== null);
  if ((nodeEnv !== "test" || anyOauth) && oauthValues.some((value) => value === null)) throw new VoiceLabError(labError("CONFIG_MISSING", `OAuth registered-app configuration must provide all of: ${oauthNames.join(", ")}.`, "internal"));
  const oauth = oauthValues.every((value): value is string => value !== null) ? {
    issuer: oauthValues[0]!, resource: oauthValues[1]!, metadataUrl: oauthValues[2]!, clientMetadataUrl: oauthValues[3]!, clientRedirectUri: oauthValues[4]!, operatorSubject: oauthValues[5]!, consentSecret: oauthValues[6]!, tokenPepper: oauthValues[7]!,
    accessTokenTtlSeconds: integer(env, "SOPHIA_VOICE_LAB_OAUTH_ACCESS_TOKEN_TTL_SECONDS", 300, 30, 900),
    refreshTokenTtlSeconds: integer(env, "SOPHIA_VOICE_LAB_OAUTH_REFRESH_TOKEN_TTL_SECONDS", 604_800, 60, 2_592_000),
    endpointWindowSeconds: integer(env, "SOPHIA_VOICE_LAB_OAUTH_ENDPOINT_WINDOW_SECONDS", 900, 60, 3_600),
    authorizeRequestsPerWindow: integer(env, "SOPHIA_VOICE_LAB_OAUTH_AUTHORIZE_REQUESTS_PER_WINDOW", 30, 1, 100_000),
    tokenRequestsPerWindow: integer(env, "SOPHIA_VOICE_LAB_OAUTH_TOKEN_REQUESTS_PER_WINDOW", 120, 1, 100_000),
    revokeRequestsPerWindow: integer(env, "SOPHIA_VOICE_LAB_OAUTH_REVOKE_REQUESTS_PER_WINDOW", 120, 1, 100_000),
    purgeBatchSize: integer(env, "SOPHIA_VOICE_LAB_OAUTH_PURGE_BATCH_SIZE", 500, 1, 10_000),
    admissionRetentionSeconds: integer(env, "SOPHIA_VOICE_LAB_OAUTH_ADMISSION_RETENTION_SECONDS", 86_400, 3_600, 604_800),
  } : null;
  if (oauth && [oauth.consentSecret, oauth.tokenPepper, ...credentials].some((value, index, values) => values.indexOf(value) !== index)) throw new VoiceLabError(labError("CONFIG_INVALID", "OAuth, bearer, grant, capability, and recovery credentials must all be distinct.", "internal"));
  return {
    nodeEnv,
    serviceVersion,
    harnessVersion,
    mcpVersion,
    pluginVersion,
    pluginPackageSha256,
    repositoryBaseSha,
    repositoryCandidateSha,
    repositoryRollbackSha,
    registeredAppId,
    environment,
    port: integer(env, "PORT", 8787, 1, 65_535),
    allowedHosts,
    databaseUrl,
    bearerToken,
    faultBearerToken,
    provisionOperatorBearerToken,
    attestationTransportTokens,
    attestationAuthorities,
    bearerSubject: env.SOPHIA_VOICE_LAB_BEARER_SUBJECT?.trim() || "private-codex-desktop",
    principalId: required(env, "SOPHIA_VOICE_LAB_PRINCIPAL_ID"),
    capabilitySecret,
    grantSecret,
    recoveryInternalSecret,
    d02GatewayCapabilitySecret,
    d02GatewayReceiptAuthority,
    callerPartitionKeys,
    capabilityIssuer: env.SOPHIA_VOICE_LAB_CAPABILITY_ISSUER?.trim() || "sophia-voice-lab",
    capabilityTtlSeconds: integer(env, "SOPHIA_VOICE_LAB_CAPABILITY_TTL_SECONDS", 120, 30, 300),
    allowedOrigins: origins(env),
    websocketOrigins: new Set((env.SOPHIA_VOICE_LAB_WEBSOCKET_ORIGINS ?? "wss://generativelanguage.googleapis.com").split(",").map((v) => new URL(v.trim()).origin)),
    authGrantPath: env.SOPHIA_VOICE_LAB_AUTH_GRANT_PATH?.trim() || "/api/voice-lab/auth/grant",
    authRefreshPath: env.SOPHIA_VOICE_LAB_AUTH_REFRESH_PATH?.trim() || "/api/voice-lab/auth/refresh",
    authContinuePath: env.SOPHIA_VOICE_LAB_AUTH_CONTINUE_PATH?.trim() || "/api/voice-lab/auth/continue",
    authCleanupPath: env.SOPHIA_VOICE_LAB_AUTH_CLEANUP_PATH?.trim() || "/api/voice-lab/auth/cleanup",
    authSessionPath: env.SOPHIA_VOICE_LAB_AUTH_SESSION_PATH?.trim() || "/api/auth/get-session",
    authReadinessPath: env.SOPHIA_VOICE_LAB_AUTH_READINESS_PATH?.trim() || "/api/voice-lab/auth/readiness",
    authProvisionPath: env.SOPHIA_VOICE_LAB_AUTH_PROVISION_PATH?.trim() || "/api/voice-lab/auth/provision",
    recoveryPathPrefix: env.SOPHIA_VOICE_LAB_RECOVERY_PATH_PREFIX?.trim() || "/internal/voice-lab/runs",
    storageStateCiphertext: env.SOPHIA_VOICE_LAB_STORAGE_STATE_ENCRYPTED?.trim() || null,
    storageStateKey: env.SOPHIA_VOICE_LAB_STORAGE_STATE_KEY?.trim() || null,
    fixtureManifestPath: nodeEnv === "test" && fixtureManifestOverride ? path.resolve(fixtureManifestOverride) : BUNDLED_FIXTURE_MANIFEST_PATH,
    fixtureRoot: nodeEnv === "test" && fixtureRootOverride ? path.resolve(fixtureRootOverride) : BUNDLED_FIXTURE_ROOT,
    fixtureManifestSha256: nodeEnv === "test" && fixtureDigestOverride ? fixtureDigestOverride : BUNDLED_FIXTURE_MANIFEST_SHA256,
    // The dedicated principal is a single product session owner. Until the
    // product supports per-run principals, any value above one would create
    // cross-run replacement and false isolation.
    maxConcurrentRuns: integer(env, "SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS", 1, 1, 1),
    maxRunsPerCaller: integer(env, "SOPHIA_VOICE_LAB_MAX_RUNS_PER_CALLER", 1, 1, 1),
    maxTextCharacters: integer(env, "SOPHIA_VOICE_LAB_MAX_TEXT_CHARACTERS", 2_000, 1, 10_000),
    maxAudioBytes: integer(env, "SOPHIA_VOICE_LAB_MAX_AUDIO_BYTES", 8_000_000, 64_000, 50_000_000),
    maxAudioDurationMs: integer(env, "SOPHIA_VOICE_LAB_MAX_AUDIO_DURATION_MS", 30_000, 500, 120_000),
    maxUtterancesPerRun: integer(env, "SOPHIA_VOICE_LAB_MAX_UTTERANCES_PER_RUN", 20, 1, 100),
    maxInjectedDurationMs: integer(env, "SOPHIA_VOICE_LAB_MAX_INJECTED_DURATION_MS", 180_000, 1_000, 600_000),
    maxInjectedBytes: integer(env, "SOPHIA_VOICE_LAB_MAX_INJECTED_BYTES", 32_000_000, 64_000, 200_000_000),
    admissionWindowSeconds: integer(env, "SOPHIA_VOICE_LAB_ADMISSION_WINDOW_SECONDS", 86_400, 60, 604_800),
    maxRollingRunStarts: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_RUN_STARTS", 25, 1, 1_000),
    maxRollingRunStartsPerCaller: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_RUN_STARTS_PER_CALLER", 25, 1, 1_000),
    maxRollingProviderSeconds: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_PROVIDER_SECONDS", 144_000, 60, 604_800),
    maxRollingProviderSecondsPerCaller: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_PROVIDER_SECONDS_PER_CALLER", 144_000, 60, 604_800),
    maxRollingSuites: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_SUITES", 1, 1, 100),
    maxRollingSuitesPerCaller: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_SUITES_PER_CALLER", 1, 1, 100),
    maxRollingSuiteChildren: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_SUITE_CHILDREN", 20, 1, 2_100),
    maxRollingSuiteChildrenPerCaller: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_SUITE_CHILDREN_PER_CALLER", 20, 1, 2_100),
    maxRollingInjectedDurationMs: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_INJECTED_DURATION_MS", 3_600_000, 1_000, 86_400_000),
    maxRollingInjectedDurationMsPerCaller: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_INJECTED_DURATION_MS_PER_CALLER", 3_600_000, 1_000, 86_400_000),
    maxRollingInjectedBytes: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_INJECTED_BYTES", 640_000_000, 64_000, 2_000_000_000),
    maxRollingInjectedBytesPerCaller: integer(env, "SOPHIA_VOICE_LAB_MAX_ROLLING_INJECTED_BYTES_PER_CALLER", 640_000_000, 64_000, 2_000_000_000),
    minUtteranceIntervalMs: integer(env, "SOPHIA_VOICE_LAB_MIN_UTTERANCE_INTERVAL_MS", 250, 0, 10_000),
    ttsTimeoutMs: integer(env, "SOPHIA_VOICE_LAB_TTS_TIMEOUT_MS", 10_000, 500, 30_000),
    ttsExpectedVersion,
    maxRunSeconds: integer(env, "SOPHIA_VOICE_LAB_MAX_RUN_SECONDS", 1_800, 60, 7_200),
    maxOperationSeconds: integer(env, "SOPHIA_VOICE_LAB_MAX_OPERATION_SECONDS", 45, 5, 300),
    startOperationSeconds: integer(env, "SOPHIA_VOICE_LAB_START_OPERATION_SECONDS", 300, 90, 300),
    endOperationSeconds: integer(env, "SOPHIA_VOICE_LAB_END_OPERATION_SECONDS", 120, 75, 300),
    faultOperationSeconds: integer(env, "SOPHIA_VOICE_LAB_FAULT_OPERATION_SECONDS", 60, 35, 300),
    maxWaitMs: integer(env, "SOPHIA_VOICE_LAB_MAX_WAIT_MS", 30_000, 100, 60_000),
    operationLeaseSeconds: integer(env, "SOPHIA_VOICE_LAB_OPERATION_LEASE_SECONDS", 60, 10, 300),
    browserLeaseSeconds: integer(env, "SOPHIA_VOICE_LAB_BROWSER_LEASE_SECONDS", 30, 10, 120),
    workerPollMs: integer(env, "SOPHIA_VOICE_LAB_WORKER_POLL_MS", 250, 50, 5_000),
    killSwitch: boolean(env, "SOPHIA_VOICE_LAB_KILL_SWITCH", nodeEnv !== "test"),
    provisioningEnabled: boolean(env, 'SOPHIA_VOICE_LAB_PROVISIONING_ENABLED', false),
    allowRawAudio: boolean(env, "SOPHIA_VOICE_LAB_ALLOW_RAW_AUDIO", false),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    onboardingMicSelector: env.SOPHIA_VOICE_LAB_ONBOARDING_MIC_SELECTOR?.trim() || '[data-onboarding="mic-cta"]',
    freshButtonName: env.SOPHIA_VOICE_LAB_FRESH_BUTTON_NAME?.trim() || "Start fresh",
    startButtonName: env.SOPHIA_VOICE_LAB_START_BUTTON_NAME?.trim() || "Tap to speak",
    stopButtonName: env.SOPHIA_VOICE_LAB_STOP_BUTTON_NAME?.trim() || "Stop recording",
    readinessTarget: hasReadinessTarget ? {
      frontendUrl: targetValues[0]!, gatewayUrl: targetValues[1]!, voiceUrl: targetValues[2]!, langgraphUrl: targetValues[3]!,
      expectedDeployment: { frontend: expectedValues[0]!, backend: expectedValues[1]!, voice: expectedValues[2]! },
      expectedDependencies: { langgraph: expectedValues[3]! },
    } : null,
    oauth,
  };
}

function campaignValue(env: NodeJS.ProcessEnv, nodeEnv: string, name: string, testFallback: string): string {
  const value = env[name]?.trim();
  if (value) return value;
  if (nodeEnv === "test") return testFallback;
  throw new VoiceLabError(labError("CONFIG_MISSING", `Required campaign provenance ${name} is missing.`, "internal"));
}

export function configFingerprint(config: VoiceLabConfig): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: config.serviceVersion,
      origins: [...config.allowedOrigins].sort(),
      maxConcurrentRuns: config.maxConcurrentRuns,
      maxRunSeconds: config.maxRunSeconds,
      rawAudio: config.allowRawAudio,
    }))
    .digest("hex");
}
