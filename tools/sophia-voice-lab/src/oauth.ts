import {
  constants as cryptoConstants,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response, type Router } from "express";
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { VoiceLabError, labError } from "./domain.js";
import type { AuthenticatedCaller, RequestAuthenticator } from "./security.js";

/**
 * Public client-id metadata document used by ChatGPT's registered MCP lane.
 * This is an identifier and contains no credential.
 */
export const CHATGPT_CLIENT_METADATA_URL = "https://chatgpt.com/oauth/client.json" as const;
export const CHATGPT_STABLE_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect" as const;

export const OAUTH_REQUIRED_CONFIG_KEYS = [
  "SOPHIA_VOICE_LAB_OAUTH_ISSUER",
  "SOPHIA_VOICE_LAB_OAUTH_RESOURCE",
  "SOPHIA_VOICE_LAB_OAUTH_RESOURCE_METADATA_URL",
  "SOPHIA_VOICE_LAB_OAUTH_CLIENT_METADATA_URL",
  "SOPHIA_VOICE_LAB_OAUTH_CLIENT_REDIRECT_URI",
  "SOPHIA_VOICE_LAB_OAUTH_OPERATOR_SUBJECT",
  "SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET",
  "SOPHIA_VOICE_LAB_OAUTH_TOKEN_PEPPER",
] as const;

/**
 * Reference PostgreSQL contract for an OAuthLedgerStore implementation.
 * Implementations MUST make consume/rotate/claim operations atomic (normally
 * with UPDATE ... WHERE ... RETURNING or SELECT ... FOR UPDATE).
 */
export const OAUTH_LEDGER_SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS sophia_voice_lab.oauth_authorization_requests (
  request_hash text PRIMARY KEY CHECK (length(request_hash) = 64),
  csrf_hash text NOT NULL CHECK (length(csrf_hash) = 64),
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  state text,
  scopes text[] NOT NULL,
  code_challenge text NOT NULL,
  subject text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > issued_at)
);

CREATE TABLE IF NOT EXISTS sophia_voice_lab.oauth_authorization_codes (
  code_hash text PRIMARY KEY CHECK (length(code_hash) = 64),
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  code_challenge text NOT NULL,
  subject text NOT NULL,
  jti text NOT NULL UNIQUE,
  family_id text,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS voice_lab_oauth_code_family_idx
  ON sophia_voice_lab.oauth_authorization_codes (family_id) WHERE family_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sophia_voice_lab.oauth_access_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  issuer text NOT NULL,
  subject text NOT NULL,
  client_id text NOT NULL,
  audience text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  family_id text NOT NULL,
  jti text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (not_before <= issued_at)
);

CREATE INDEX IF NOT EXISTS voice_lab_oauth_access_family_idx
  ON sophia_voice_lab.oauth_access_tokens (family_id);
CREATE INDEX IF NOT EXISTS voice_lab_oauth_access_expiry_idx
  ON sophia_voice_lab.oauth_access_tokens (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS sophia_voice_lab.oauth_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  issuer text NOT NULL,
  subject text NOT NULL,
  client_id text NOT NULL,
  audience text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  family_id text NOT NULL,
  parent_token_hash text,
  replacement_token_hash text,
  jti text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS voice_lab_oauth_refresh_family_idx
  ON sophia_voice_lab.oauth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS voice_lab_oauth_refresh_expiry_idx
  ON sophia_voice_lab.oauth_refresh_tokens (expires_at)
  WHERE revoked_at IS NULL AND used_at IS NULL;

CREATE TABLE IF NOT EXISTS sophia_voice_lab.oauth_client_assertion_jtis (
  client_id text NOT NULL,
  jti text NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL,
  PRIMARY KEY (client_id, jti)
);
CREATE INDEX IF NOT EXISTS voice_lab_oauth_assertion_expiry_idx
  ON sophia_voice_lab.oauth_client_assertion_jtis (expires_at);

CREATE TABLE IF NOT EXISTS sophia_voice_lab.oauth_endpoint_admissions (
  action text NOT NULL CHECK (action IN ('authorize_get','authorize_post','token','revoke')),
  subject_hash text NOT NULL CHECK (length(subject_hash) = 64),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (action, subject_hash, window_started_at)
);
CREATE INDEX IF NOT EXISTS voice_lab_oauth_endpoint_admission_expiry_idx
  ON sophia_voice_lab.oauth_endpoint_admissions (updated_at);
`;

export interface OAuthAuthorizationRequestRecord {
  requestHash: string;
  csrfHash: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  state: string | null;
  scopes: string[];
  codeChallenge: string;
  subject: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface OAuthAuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  subject: string;
  jti: string;
  familyId: string | null;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

export interface OAuthAccessTokenRecord {
  tokenHash: string;
  issuer: string;
  subject: string;
  clientId: string;
  audience: string;
  resource: string;
  scopes: string[];
  familyId: string;
  jti: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface OAuthRefreshTokenRecord {
  tokenHash: string;
  issuer: string;
  subject: string;
  clientId: string;
  audience: string;
  resource: string;
  scopes: string[];
  familyId: string;
  parentTokenHash: string | null;
  replacementTokenHash: string | null;
  jti: string;
  issuedAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

type OAuthBoundRecord = OAuthAuthorizationRequestRecord | OAuthAuthorizationCodeRecord | OAuthAccessTokenRecord | OAuthRefreshTokenRecord;
type OAuthBoundRecordKind = "authorization_request" | "authorization_code" | "access_token" | "refresh_token";

export type OAuthRefreshRotationResult =
  | { status: "rotated"; current: OAuthRefreshTokenRecord }
  | { status: "invalid" }
  | { status: "replayed"; familyId: string | null };

export type OAuthEndpointAction = "authorize_get" | "authorize_post" | "token" | "revoke";
export interface OAuthEndpointAdmission {
  action: OAuthEndpointAction;
  subjectHash: string;
  windowStartedAt: number;
  limit: number;
  observedAt: number;
}

export interface OAuthRevocationReceipt {
  matched: boolean;
  kind: "authorization_code" | "access_token" | "refresh_token" | null;
  familyTerminal: boolean;
}

/**
 * Durable OAuth ledger. No production in-memory fallback is provided.
 */
export interface OAuthLedgerStore {
  /** Production OAuth authorization is never ready without a positively
   * verified durable store. Implementations must fail closed on schema or
   * connectivity drift. */
  readiness(): Promise<boolean>;
  reserveEndpointAdmission(admission: OAuthEndpointAdmission): Promise<boolean>;
  purgeExpired(now: number, limit: number): Promise<number>;
  putAuthorizationRequest(record: OAuthAuthorizationRequestRecord): Promise<void>;
  consumeAuthorizationRequest(requestHash: string, csrfHash: string, now: number): Promise<OAuthAuthorizationRequestRecord | null>;
  putAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<void>;
  consumeAuthorizationCode(codeHash: string, now: number): Promise<OAuthAuthorizationCodeRecord | null>;
  putAccessToken(record: OAuthAccessTokenRecord): Promise<void>;
  getAccessToken(tokenHash: string): Promise<OAuthAccessTokenRecord | null>;
  putRefreshToken(record: OAuthRefreshTokenRecord): Promise<void>;
  getRefreshToken(tokenHash: string): Promise<OAuthRefreshTokenRecord | null>;
  /** Atomically publishes the first refresh/access pair while holding the
   * same durable family fence used by rotation and revocation. */
  putInitialTokenPair(authorizationCodeHash: string, refresh: OAuthRefreshTokenRecord, access: OAuthAccessTokenRecord): Promise<void>;
  rotateRefreshToken(currentHash: string, expectedJti: string, replacement: OAuthRefreshTokenRecord, access: OAuthAccessTokenRecord, now: number): Promise<OAuthRefreshRotationResult>;
  revokeToken(tokenHash: string, clientId: string, now: number): Promise<OAuthRevocationReceipt>;
  revokeTokenFamily(familyId: string, now: number): Promise<void>;
  claimClientAssertionJti(clientId: string, jti: string, expiresAt: number, now: number): Promise<boolean>;
}

export interface OAuthAuthorizationServerConfig {
  issuer: string;
  resource: string;
  metadataUrl: string;
  clientMetadataUrl: string;
  clientRedirectUri: string;
  operatorSubject: string;
  consentSecret: string;
  tokenPepper: string;
  staticBearerToken?: string;
  supportedScopes: readonly string[];
  defaultScopes: readonly string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authorizationCodeTtlSeconds?: number;
  authorizationRequestTtlSeconds?: number;
  clientMetadataCacheSeconds?: number;
  endpointWindowSeconds?: number;
  authorizeRequestsPerWindow?: number;
  tokenRequestsPerWindow?: number;
  revokeRequestsPerWindow?: number;
  purgeBatchSize?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface OAuthAuthenticatedCaller extends AuthenticatedCaller {
  authorizationKind: "oauth";
  clientId: string;
  tokenId: string;
  challenge: string;
}

export interface OAuthHttpResult {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface OAuthReadiness {
  ready: boolean;
  checks: Readonly<Record<string, boolean>>;
  errors: readonly string[];
  authorizationServerMetadata: OAuthMetadata;
  protectedResourceMetadata: OAuthProtectedResourceMetadata;
}

export interface ValidatedClientMetadata {
  clientId: string;
  redirectUris: readonly string[];
  grantTypes: readonly string[];
  responseTypes: readonly string[];
  tokenEndpointAuthMethods: readonly ("none" | "private_key_jwt")[];
  preferredTokenEndpointAuthMethod: "none" | "private_key_jwt";
  tokenEndpointAuthSigningAlg: "RS256" | null;
  jwksUri: string | null;
}

interface TokenResponseBody {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  resource: string;
}

type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_response_type"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "access_denied"
  | "temporarily_unavailable"
  | "server_error";

class OAuthProtocolError extends Error {
  readonly error: OAuthErrorCode;
  readonly status: number;

  constructor(error: OAuthErrorCode, status = 400) {
    super(OAUTH_ERROR_DESCRIPTIONS[error]);
    this.name = "OAuthProtocolError";
    this.error = error;
    this.status = status;
  }
}

const OAUTH_ERROR_DESCRIPTIONS: Readonly<Record<OAuthErrorCode, string>> = {
  invalid_request: "The OAuth request is invalid.",
  invalid_client: "OAuth client authentication failed.",
  invalid_grant: "The OAuth grant is invalid.",
  unauthorized_client: "The OAuth client is not authorized.",
  unsupported_response_type: "The OAuth response type is unsupported.",
  unsupported_grant_type: "The OAuth grant type is unsupported.",
  invalid_scope: "The requested OAuth scope is invalid.",
  access_denied: "The authorization request was denied.",
  temporarily_unavailable: "The OAuth endpoint rate limit is temporarily exhausted.",
  server_error: "The OAuth service could not complete the request.",
};

const TOKEN_ENDPOINT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const CSRF_COOKIE_PREFIX = "__Host-sophia_voice_lab_oauth_csrf_";
const MAX_FORM_BYTES = 8_192;
const MAX_TOKEN_BYTES = 8_192;
const MAX_JSON_BYTES = 65_536;
const FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SECONDS = 30;

export class OAuthAuthorizationServer implements RequestAuthenticator, OAuthTokenVerifier {
  readonly #store: OAuthLedgerStore;
  readonly #config: Required<Pick<OAuthAuthorizationServerConfig,
    "issuer" | "resource" | "metadataUrl" | "clientMetadataUrl" | "clientRedirectUri" | "operatorSubject" |
    "tokenPepper" | "supportedScopes" | "defaultScopes" | "accessTokenTtlSeconds" |
    "refreshTokenTtlSeconds" | "authorizationCodeTtlSeconds" | "authorizationRequestTtlSeconds" |
    "clientMetadataCacheSeconds" | "endpointWindowSeconds" | "authorizeRequestsPerWindow" |
    "tokenRequestsPerWindow" | "revokeRequestsPerWindow" | "purgeBatchSize" | "fetchImpl" | "now">>;
  readonly #consentSecretHash: Buffer;
  readonly #authorizationMetadata: OAuthMetadata;
  readonly #resourceMetadata: OAuthProtectedResourceMetadata;
  #clientCache: { metadata: ValidatedClientMetadata; expiresAt: number } | null = null;
  #clientJwksCache: { keys: readonly JsonWebKey[]; expiresAt: number; uri: string } | null = null;
  #lastPurgeAt = 0;

  constructor(config: OAuthAuthorizationServerConfig, store: OAuthLedgerStore) {
    this.#store = store;
    const issuer = normalizeIssuer(config.issuer);
    if (new URL(issuer).pathname !== "/") throw configError("The local OAuth authorization server issuer must be an HTTPS origin without a path.");
    const resource = normalizeResource(config.resource);
    const metadataUrl = normalizeHttpsUrl(config.metadataUrl, "metadata");
    const expectedMetadataUrl = protectedResourceMetadataUrl(resource);
    if (metadataUrl !== expectedMetadataUrl) throw configError("OAuth resource metadata URL does not match the RFC 9728 resource path.");
    const clientMetadataUrl = normalizeHttpsUrl(config.clientMetadataUrl, "client metadata");
    const clientRedirectUri = normalizeRedirectUri(config.clientRedirectUri);
    if (clientMetadataUrl !== CHATGPT_CLIENT_METADATA_URL || clientRedirectUri !== CHATGPT_STABLE_REDIRECT_URI) {
      throw configError("The registered OAuth lane must use the pinned ChatGPT client metadata and redirect identifiers.");
    }
    validateIdentifier(config.operatorSubject, 200, "operator subject");
    validateStrongSecret(config.consentSecret, "consent secret");
    validateStrongSecret(config.tokenPepper, "token pepper");
    if (safeEqual(config.consentSecret, config.tokenPepper)
      || (config.staticBearerToken !== undefined && (safeEqual(config.consentSecret, config.staticBearerToken) || safeEqual(config.tokenPepper, config.staticBearerToken)))) {
      throw configError("OAuth consent credentials must be distinct from token and static bearer credentials.");
    }
    validateTtl(config.accessTokenTtlSeconds, 30, 900, "access token");
    validateTtl(config.refreshTokenTtlSeconds, 60, 2_592_000, "refresh token");
    const authorizationCodeTtlSeconds = config.authorizationCodeTtlSeconds ?? 120;
    const authorizationRequestTtlSeconds = config.authorizationRequestTtlSeconds ?? 300;
    const clientMetadataCacheSeconds = config.clientMetadataCacheSeconds ?? 300;
    const endpointWindowSeconds = config.endpointWindowSeconds ?? 900;
    const authorizeRequestsPerWindow = config.authorizeRequestsPerWindow ?? 30;
    const tokenRequestsPerWindow = config.tokenRequestsPerWindow ?? 120;
    const revokeRequestsPerWindow = config.revokeRequestsPerWindow ?? 120;
    const purgeBatchSize = config.purgeBatchSize ?? 500;
    validateTtl(authorizationCodeTtlSeconds, 30, 300, "authorization code");
    validateTtl(authorizationRequestTtlSeconds, 60, 600, "authorization request");
    validateTtl(clientMetadataCacheSeconds, 30, 3_600, "client metadata cache");
    validateTtl(endpointWindowSeconds, 60, 3_600, "endpoint admission window");
    for (const value of [authorizeRequestsPerWindow, tokenRequestsPerWindow, revokeRequestsPerWindow, purgeBatchSize]) validateBoundedCount(value);
    const supportedScopes = validateScopeSet(config.supportedScopes, false);
    const defaultScopes = validateScopeSet(config.defaultScopes, false);
    if (defaultScopes.some((scope) => !supportedScopes.includes(scope))) throw configError("Default OAuth scopes must be supported.");

    this.#config = {
      issuer,
      resource,
      metadataUrl,
      clientMetadataUrl,
      clientRedirectUri,
      operatorSubject: config.operatorSubject,
      tokenPepper: config.tokenPepper,
      supportedScopes,
      defaultScopes,
      accessTokenTtlSeconds: config.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
      authorizationCodeTtlSeconds,
      authorizationRequestTtlSeconds,
      clientMetadataCacheSeconds,
      endpointWindowSeconds,
      authorizeRequestsPerWindow,
      tokenRequestsPerWindow,
      revokeRequestsPerWindow,
      purgeBatchSize,
      fetchImpl: config.fetchImpl ?? fetch,
      now: config.now ?? (() => new Date()),
    };
    this.#consentSecretHash = createHash("sha256").update(config.consentSecret).digest();
    this.#authorizationMetadata = OAuthMetadataSchema.parse({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      revocation_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: supportedScopes,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    this.#resourceMetadata = OAuthProtectedResourceMetadataSchema.parse({
      resource,
      authorization_servers: [issuer],
      scopes_supported: supportedScopes,
      bearer_methods_supported: ["header"],
      resource_name: "Sophia Voice Lab",
    });
  }

  authorizationServerMetadata(): OAuthMetadata {
    return structuredClone(this.#authorizationMetadata);
  }

  protectedResourceMetadata(): OAuthProtectedResourceMetadata {
    return structuredClone(this.#resourceMetadata);
  }

  challenge(scopes: readonly string[] = this.#config.defaultScopes, error?: "invalid_token" | "insufficient_scope", description?: string): string {
    return buildBearerChallenge(this.#config.metadataUrl, scopes, error, description);
  }

  async readiness(): Promise<OAuthReadiness> {
    const checks: Record<string, boolean> = { configuration: true, metadata: true, durable_store: false, cimd: false, redirect: false };
    const errors: string[] = [];
    try {
      OAuthMetadataSchema.parse(this.#authorizationMetadata);
      OAuthProtectedResourceMetadataSchema.parse(this.#resourceMetadata);
      checks.metadata = this.#authorizationMetadata.issuer === this.#config.issuer
        && this.#authorizationMetadata.code_challenge_methods_supported?.includes("S256") === true
        && this.#authorizationMetadata.client_id_metadata_document_supported === true
        && this.#resourceMetadata.resource === this.#config.resource;
      if (!checks.metadata) errors.push("metadata_contract_invalid");
    } catch {
      checks.metadata = false;
      errors.push("metadata_contract_invalid");
    }
    try {
      checks.durable_store = await this.#store.readiness();
      if (!checks.durable_store) errors.push("durable_store_unavailable");
    } catch {
      errors.push("durable_store_unavailable");
    }
    try {
      const client = await this.#loadClientMetadata(true);
      checks.cimd = client.clientId === this.#config.clientMetadataUrl;
      checks.redirect = client.redirectUris.length === 1 && client.redirectUris[0] === this.#config.clientRedirectUri;
      if (!checks.cimd) errors.push("client_metadata_invalid");
      if (!checks.redirect) errors.push("redirect_contract_invalid");
      if (client.preferredTokenEndpointAuthMethod === "private_key_jwt") await this.#loadClientJwks(client, true);
    } catch {
      errors.push("client_metadata_unavailable");
    }
    return {
      ready: Object.values(checks).every(Boolean) && errors.length === 0,
      checks,
      errors: [...new Set(errors)],
      authorizationServerMetadata: this.authorizationServerMetadata(),
      protectedResourceMetadata: this.protectedResourceMetadata(),
    };
  }

  async authenticate(authorization: string | undefined): Promise<OAuthAuthenticatedCaller> {
    const token = extractBearerToken(authorization);
    const info = await this.verifyAccessToken(token);
    const tokenId = typeof info.extra?.jti === "string" ? info.extra.jti : "unavailable";
    const subject = typeof info.extra?.subject === "string" ? info.extra.subject : "unavailable";
    return {
      subject,
      scopes: new Set(info.scopes),
      authorizationKind: "oauth",
      clientId: info.clientId,
      tokenId,
      challenge: this.challenge(info.scopes),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!isBoundedOpaqueToken(token)) throw oauthUnauthorized();
    const record = await this.#store.getAccessToken(this.#tokenHash(token));
    const now = this.#now();
    try {
      if (record === null || record.tokenHash !== this.#tokenHash(token) || !this.#verifyRecordToken("access_token", token, record)
        || !safeEpoch(record.issuedAt) || !safeEpoch(record.notBefore) || !safeEpoch(record.expiresAt) || !safeOptionalEpoch(record.revokedAt)
        || record.revokedAt !== null || record.notBefore > now || record.expiresAt <= now
        || record.issuer !== this.#config.issuer || record.audience !== this.#config.resource || record.resource !== this.#config.resource
        || record.subject !== this.#config.operatorSubject || record.clientId !== this.#config.clientMetadataUrl
        || record.issuedAt > now || record.notBefore !== record.issuedAt || record.expiresAt <= record.issuedAt || record.expiresAt - record.issuedAt > this.#config.accessTokenTtlSeconds
        || !validJti(record.jti) || !validJti(record.familyId)
        || !sameScopeSet(record.scopes, validateScopeSet(record.scopes, false)) || record.scopes.some((scope) => !this.#config.supportedScopes.includes(scope))) {
        throw oauthUnauthorized();
      }
    } catch {
      throw oauthUnauthorized();
    }
    return {
      token,
      clientId: record.clientId,
      scopes: [...record.scopes],
      expiresAt: record.expiresAt,
      resource: new URL(record.resource),
      extra: { subject: record.subject, jti: record.jti, issuer: record.issuer, audience: record.audience, authorization_kind: "oauth" },
    };
  }

  async handleAuthorizationRequest(params: URLSearchParams, admissionSubject = "direct-client"): Promise<OAuthHttpResult> {
    await this.#admitEndpoint("authorize_get", admissionSubject);
    rejectDuplicateOrUnknownParameters(params, ["response_type", "response_mode", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource", "ui_locales"]);
    if (single(params, "response_type", 20) !== "code") throw new OAuthProtocolError("unsupported_response_type");
    if (params.has("response_mode") && single(params, "response_mode", 20) !== "query") throw new OAuthProtocolError("invalid_request");
    if (params.has("ui_locales")) validateUiLocales(single(params, "ui_locales", 256));
    const clientId = single(params, "client_id", 500);
    if (clientId !== this.#config.clientMetadataUrl) throw new OAuthProtocolError("unauthorized_client");
    const client = await this.#loadClientMetadata();
    const redirectUri = normalizeRedirectUri(single(params, "redirect_uri", 1_024));
    if (!client.redirectUris.includes(redirectUri) || redirectUri !== this.#config.clientRedirectUri) throw new OAuthProtocolError("invalid_request");
    const resource = normalizeResource(single(params, "resource", 1_024));
    if (resource !== this.#config.resource) throw new OAuthProtocolError("invalid_request");
    const state = single(params, "state", 512);
    if (state.length < 8) throw new OAuthProtocolError("invalid_request");
    const codeChallenge = single(params, "code_challenge", 128);
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || single(params, "code_challenge_method", 20) !== "S256") {
      throw new OAuthProtocolError("invalid_request");
    }
    const scopes = this.#parseRequestedScopes(params.get("scope"));
    const requestTokenId = randomOpaque("oar", 32);
    const csrfToken = randomOpaque("csrf", 32);
    const now = this.#now();
    const request: OAuthAuthorizationRequestRecord = {
      requestHash: "",
      csrfHash: this.#tokenHash(csrfToken),
      clientId,
      redirectUri,
      resource,
      state,
      scopes,
      codeChallenge,
      subject: this.#config.operatorSubject,
      issuedAt: now,
      expiresAt: now + this.#config.authorizationRequestTtlSeconds,
      consumedAt: null,
    };
    const requestToken = this.#sealRecordToken("authorization_request", requestTokenId, request);
    request.requestHash = this.#tokenHash(requestToken);
    await this.#store.putAuthorizationRequest(request);
    const csrfCookie = csrfCookieName(request.requestHash);
    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "set-cookie": `${csrfCookie}=${csrfToken}; Path=/; Max-Age=${this.#config.authorizationRequestTtlSeconds}; Secure; HttpOnly; SameSite=Lax`,
      },
      body: renderConsentPage(requestToken, csrfToken, scopes),
    };
  }

  async handleAuthorizationDecision(body: URLSearchParams, cookieHeader: string | undefined, admissionSubject = "direct-client"): Promise<OAuthHttpResult> {
    await this.#admitEndpoint("authorize_post", admissionSubject);
    rejectDuplicateOrUnknownParameters(body, ["request_id", "csrf_token", "consent_secret", "decision"]);
    const requestToken = single(body, "request_id", 256);
    const csrfToken = single(body, "csrf_token", 256);
    const suppliedSecret = single(body, "consent_secret", 512);
    const decision = single(body, "decision", 20);
    if (!isBoundedOpaqueToken(requestToken) || !isBoundedOpaqueToken(csrfToken) || !["approve", "deny"].includes(decision)) {
      throw new OAuthProtocolError("invalid_request");
    }
    const requestHash = this.#tokenHash(requestToken);
    const csrfCookie = parseCookie(cookieHeader, csrfCookieName(requestHash));
    // The durable, one-time synchronizer token is the canonical CSRF proof.
    // Some privacy-preserving browser contexts omit the additional hardened
    // cookie; when it is supplied it must still match exactly.
    if (csrfCookie !== null && !safeEqual(csrfCookie, csrfToken)) throw new OAuthProtocolError("invalid_request", 403);
    const now = this.#now();
    const csrfHash = this.#tokenHash(csrfToken);
    const request = await this.#store.consumeAuthorizationRequest(requestHash, csrfHash, now);
    if (request === null || request.requestHash !== requestHash || !this.#verifyRecordToken("authorization_request", requestToken, request) || request.csrfHash !== csrfHash
      || !safeEpoch(request.issuedAt) || !safeEpoch(request.expiresAt) || !safeOptionalEpoch(request.consumedAt)
      || request.clientId !== this.#config.clientMetadataUrl || request.redirectUri !== this.#config.clientRedirectUri
      || request.resource !== this.#config.resource || request.subject !== this.#config.operatorSubject
      || !validConfiguredScopeSet(request.scopes, this.#config.supportedScopes)
      || !/^[A-Za-z0-9_-]{43,128}$/.test(request.codeChallenge)
      || request.state === null || request.state.length < 8 || request.state.length > 512
      || request.issuedAt > now || request.expiresAt <= now || request.expiresAt <= request.issuedAt
      || request.expiresAt - request.issuedAt > this.#config.authorizationRequestTtlSeconds
      || request.consumedAt !== now) throw new OAuthProtocolError("invalid_request", 403);
    const suppliedHash = createHash("sha256").update(suppliedSecret).digest();
    if (suppliedHash.length !== this.#consentSecretHash.length || !timingSafeEqual(suppliedHash, this.#consentSecretHash)) {
      throw new OAuthProtocolError("access_denied", 403);
    }
    if (decision === "deny") return this.#authorizationRedirect(request, { error: "access_denied" });

    const codeId = randomOpaque("oac", 32);
    const authorizationCode: OAuthAuthorizationCodeRecord = {
      codeHash: "",
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      resource: request.resource,
      scopes: [...request.scopes],
      codeChallenge: request.codeChallenge,
      subject: request.subject,
      jti: randomId(),
      familyId: null,
      issuedAt: now,
      expiresAt: now + this.#config.authorizationCodeTtlSeconds,
      consumedAt: null,
      revokedAt: null,
    };
    const code = this.#sealRecordToken("authorization_code", codeId, authorizationCode);
    authorizationCode.codeHash = this.#tokenHash(code);
    await this.#store.putAuthorizationCode(authorizationCode);
    return this.#authorizationRedirect(request, { code });
  }

  async handleTokenRequest(body: URLSearchParams, admissionSubject = "direct-client"): Promise<OAuthHttpResult> {
    if (serializedFormBytes(body) > MAX_FORM_BYTES) throw new OAuthProtocolError("invalid_request");
    await this.#admitEndpoint("token", admissionSubject);
    const grantType = single(body, "grant_type", 64);
    if (grantType === "authorization_code") return this.#exchangeAuthorizationCode(body);
    if (grantType === "refresh_token") return this.#exchangeRefreshToken(body);
    throw new OAuthProtocolError("unsupported_grant_type");
  }

  async handleRevocationRequest(body: URLSearchParams, admissionSubject = "direct-client"): Promise<OAuthHttpResult> {
    if (serializedFormBytes(body) > MAX_FORM_BYTES) throw new OAuthProtocolError("invalid_request");
    await this.#admitEndpoint("revoke", admissionSubject);
    rejectDuplicateOrUnknownParameters(body, ["token", "token_type_hint", "client_id", "client_assertion_type", "client_assertion"]);
    const client = await this.#authenticateClient(body, `${this.#config.issuer}/revoke`);
    const token = single(body, "token", MAX_TOKEN_BYTES);
    if (token.length === 0) throw new OAuthProtocolError("invalid_request");
    const receipt = await this.#store.revokeToken(this.#tokenHash(token), client.clientId, this.#now());
    return { status: 200, headers: { "cache-control": "no-store", pragma: "no-cache", "x-sophia-oauth-revocation-receipt": receipt.matched && receipt.familyTerminal ? receipt.kind ?? "matched" : "unknown_or_pending" }, body: "" };
  }

  oauthError(error: unknown): OAuthHttpResult {
    const protocol = error instanceof OAuthProtocolError ? error : new OAuthProtocolError("server_error", 500);
    return jsonResult(protocol.status, { error: protocol.error, error_description: OAUTH_ERROR_DESCRIPTIONS[protocol.error] }, { "cache-control": "no-store", pragma: "no-cache" });
  }

  readonly authorizationMetadataHandler: RequestHandler = (_req, res) => {
    sendExpressResult(res, jsonResult(200, this.authorizationServerMetadata()));
  };

  readonly protectedResourceMetadataHandler: RequestHandler = (_req, res) => {
    sendExpressResult(res, jsonResult(200, this.protectedResourceMetadata()));
  };

  readonly authorizationGetHandler: RequestHandler = async (req, res) => {
    try {
      sendExpressResult(res, await this.handleAuthorizationRequest(queryParams(req), requestAdmissionSubject(req)));
    } catch (error) {
      sendExpressResult(res, this.authorizationError(error, queryParams(req)));
    }
  };

  readonly authorizationPostHandler: RequestHandler = async (req, res) => {
    try {
      sendExpressResult(res, await this.handleAuthorizationDecision(bodyParams(req), req.header("cookie"), requestAdmissionSubject(req)));
    } catch (error) {
      sendExpressResult(res, this.oauthError(error));
    }
  };

  readonly tokenHandler: RequestHandler = async (req, res) => {
    try {
      sendExpressResult(res, await this.handleTokenRequest(bodyParams(req), requestAdmissionSubject(req)));
    } catch (error) {
      sendExpressResult(res, this.oauthError(error));
    }
  };

  readonly revocationHandler: RequestHandler = async (req, res) => {
    try {
      sendExpressResult(res, await this.handleRevocationRequest(bodyParams(req), requestAdmissionSubject(req)));
    } catch (error) {
      sendExpressResult(res, this.oauthError(error));
    }
  };

  readonly routerErrorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
    if (res.headersSent) return;
    sendExpressResult(res, jsonResult(400, {
      error: "invalid_request",
      error_description: OAUTH_ERROR_DESCRIPTIONS.invalid_request,
    }, { "cache-control": "no-store", pragma: "no-cache" }));
  };

  createRouter(): Router {
    const router = express.Router();
    router.use(express.urlencoded({ extended: false, limit: `${MAX_FORM_BYTES}b`, parameterLimit: 12 }));
    router.get(authorizationServerMetadataPath(this.#config.issuer), this.authorizationMetadataHandler);
    router.get(new URL(this.#config.metadataUrl).pathname, this.protectedResourceMetadataHandler);
    router.get("/authorize", this.authorizationGetHandler);
    router.post("/authorize", this.authorizationPostHandler);
    router.post("/token", this.tokenHandler);
    router.post("/revoke", this.revocationHandler);
    router.use(this.routerErrorHandler);
    return router;
  }

  authorizationError(error: unknown, params: URLSearchParams): OAuthHttpResult {
    const protocol = error instanceof OAuthProtocolError ? error : new OAuthProtocolError("server_error", 500);
    let trusted = false;
    let state: string | null = null;
    try {
      const clientIds = params.getAll("client_id");
      const redirects = params.getAll("redirect_uri");
      const states = params.getAll("state");
      trusted = clientIds.length === 1 && clientIds[0] === this.#config.clientMetadataUrl
        && redirects.length === 1 && normalizeRedirectUri(redirects[0]!) === this.#config.clientRedirectUri;
      state = trusted && states.length === 1 && states[0]!.length >= 8 && states[0]!.length <= 512 ? states[0]! : null;
    } catch { trusted = false; }
    if (!trusted || protocol.error === "invalid_client" || protocol.error === "unauthorized_client") return this.oauthError(protocol);
    const location = new URL(this.#config.clientRedirectUri);
    location.searchParams.set("error", protocol.error);
    location.searchParams.set("error_description", OAUTH_ERROR_DESCRIPTIONS[protocol.error]);
    if (state !== null) location.searchParams.set("state", state);
    location.searchParams.set("iss", this.#config.issuer);
    location.searchParams.set("resource", this.#config.resource);
    return { status: 303, headers: { location: location.toString(), "cache-control": "no-store", pragma: "no-cache" }, body: "" };
  }

  async #exchangeAuthorizationCode(body: URLSearchParams): Promise<OAuthHttpResult> {
    rejectDuplicateOrUnknownParameters(body, ["grant_type", "code", "redirect_uri", "client_id", "code_verifier", "resource", "client_assertion_type", "client_assertion"]);
    const client = await this.#authenticateClient(body, `${this.#config.issuer}/token`);
    const resource = normalizeResource(single(body, "resource", 1_024));
    if (resource !== this.#config.resource) throw new OAuthProtocolError("invalid_grant");
    const redirectUri = normalizeRedirectUri(single(body, "redirect_uri", 1_024));
    if (redirectUri !== this.#config.clientRedirectUri) throw new OAuthProtocolError("invalid_grant");
    const code = single(body, "code", MAX_TOKEN_BYTES);
    const verifier = single(body, "code_verifier", 128);
    if (!isBoundedOpaqueToken(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthProtocolError("invalid_grant");
    const now = this.#now();
    const codeHash = this.#tokenHash(code);
    const authorization = await this.#store.consumeAuthorizationCode(codeHash, now);
    if (authorization === null || !safeEpoch(authorization.issuedAt) || !safeEpoch(authorization.expiresAt) || !safeOptionalEpoch(authorization.consumedAt) || authorization.expiresAt <= now
      || authorization.clientId !== client.clientId || authorization.redirectUri !== redirectUri || authorization.resource !== resource
      || authorization.codeHash !== codeHash || !this.#verifyRecordToken("authorization_code", code, authorization) || authorization.codeChallenge !== pkceS256(verifier)
      || !/^[A-Za-z0-9_-]{43,128}$/.test(authorization.codeChallenge)
      || authorization.subject !== this.#config.operatorSubject || !validJti(authorization.jti)
      || authorization.issuedAt > now || authorization.expiresAt <= authorization.issuedAt
      || authorization.expiresAt - authorization.issuedAt > this.#config.authorizationCodeTtlSeconds
      || authorization.consumedAt !== now || authorization.familyId !== null || authorization.revokedAt !== null
      || !validConfiguredScopeSet(authorization.scopes, this.#config.supportedScopes)) {
      throw new OAuthProtocolError("invalid_grant");
    }
    return this.#issueInitialTokenPair(authorization, now);
  }

  async #exchangeRefreshToken(body: URLSearchParams): Promise<OAuthHttpResult> {
    rejectDuplicateOrUnknownParameters(body, ["grant_type", "refresh_token", "scope", "client_id", "resource", "client_assertion_type", "client_assertion"]);
    const client = await this.#authenticateClient(body, `${this.#config.issuer}/token`);
    const resource = normalizeResource(single(body, "resource", 1_024));
    if (resource !== this.#config.resource) throw new OAuthProtocolError("invalid_grant");
    const refreshToken = single(body, "refresh_token", MAX_TOKEN_BYTES);
    if (!isBoundedOpaqueToken(refreshToken)) throw new OAuthProtocolError("invalid_grant");
    const currentHash = this.#tokenHash(refreshToken);
    const current = await this.#store.getRefreshToken(currentHash);
    const now = this.#now();
    if (current === null) throw new OAuthProtocolError("invalid_grant");
    if (current.tokenHash !== currentHash || !this.#verifyRecordToken("refresh_token", refreshToken, current)
      || !safeEpoch(current.issuedAt) || !safeEpoch(current.expiresAt) || !safeOptionalEpoch(current.usedAt) || !safeOptionalEpoch(current.revokedAt)
      || current.revokedAt !== null || current.expiresAt <= now || current.clientId !== client.clientId
      || current.resource !== resource || current.audience !== resource || current.issuer !== this.#config.issuer
      || current.subject !== this.#config.operatorSubject || !validJti(current.jti) || !validJti(current.familyId)
      || current.issuedAt > now || current.expiresAt <= current.issuedAt
      || current.expiresAt - current.issuedAt > this.#config.refreshTokenTtlSeconds
      || current.parentTokenHash !== null && !isTokenHash(current.parentTokenHash)
      || current.replacementTokenHash !== null && !isTokenHash(current.replacementTokenHash)
      || current.usedAt !== null && (current.usedAt < current.issuedAt || current.usedAt > now)
      || !validConfiguredScopeSet(current.scopes, this.#config.supportedScopes)) {
      throw new OAuthProtocolError("invalid_grant");
    }
    const requestedScopes = body.has("scope") ? this.#parseRequestedScopes(body.get("scope")) : [...current.scopes];
    if (requestedScopes.some((scope) => !current.scopes.includes(scope))) throw new OAuthProtocolError("invalid_scope");
    const nextTokenId = randomOpaque("ort", 32);
    const replacement: OAuthRefreshTokenRecord = {
      tokenHash: "",
      issuer: current.issuer,
      subject: current.subject,
      clientId: current.clientId,
      audience: current.audience,
      resource: current.resource,
      scopes: requestedScopes,
      familyId: current.familyId,
      parentTokenHash: currentHash,
      replacementTokenHash: null,
      jti: randomId(),
      issuedAt: now,
      expiresAt: Math.min(current.expiresAt, now + this.#config.refreshTokenTtlSeconds),
      usedAt: null,
      revokedAt: null,
    };
    const nextToken = this.#sealRecordToken("refresh_token", nextTokenId, replacement);
    replacement.tokenHash = this.#tokenHash(nextToken);
    const { token: accessToken, record: access } = this.#newAccessToken(replacement, now);
    const rotation = await this.#store.rotateRefreshToken(currentHash, current.jti, replacement, access, now);
    if (rotation.status === "replayed") {
      throw new OAuthProtocolError("invalid_grant");
    }
    if (rotation.status === "invalid") throw new OAuthProtocolError("invalid_grant");
    return this.#tokenResult({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.#config.accessTokenTtlSeconds,
      refresh_token: nextToken,
      scope: requestedScopes.join(" "),
      resource,
    });
  }

  async #issueInitialTokenPair(code: OAuthAuthorizationCodeRecord, now: number): Promise<OAuthHttpResult> {
    const familyId = randomId();
    const refreshTokenId = randomOpaque("ort", 32);
    const refresh: OAuthRefreshTokenRecord = {
      tokenHash: "",
      issuer: this.#config.issuer,
      subject: code.subject,
      clientId: code.clientId,
      audience: code.resource,
      resource: code.resource,
      scopes: [...code.scopes],
      familyId,
      parentTokenHash: null,
      replacementTokenHash: null,
      jti: randomId(),
      issuedAt: now,
      expiresAt: now + this.#config.refreshTokenTtlSeconds,
      usedAt: null,
      revokedAt: null,
    };
    const refreshToken = this.#sealRecordToken("refresh_token", refreshTokenId, refresh);
    refresh.tokenHash = this.#tokenHash(refreshToken);
    const { token: accessToken, record: access } = this.#newAccessToken(refresh, now);
    try {
      await this.#store.putInitialTokenPair(code.codeHash, refresh, access);
    } catch {
      throw new OAuthProtocolError("server_error", 500);
    }
    return this.#tokenResult({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.#config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: code.scopes.join(" "),
      resource: code.resource,
    });
  }

  #newAccessToken(refresh: OAuthRefreshTokenRecord, now: number): { token: string; record: OAuthAccessTokenRecord } {
    const tokenId = randomOpaque("oat", 32);
    const record: OAuthAccessTokenRecord = {
      tokenHash: "",
      issuer: this.#config.issuer,
      subject: refresh.subject,
      clientId: refresh.clientId,
      audience: refresh.audience,
      resource: refresh.resource,
      scopes: [...refresh.scopes],
      familyId: refresh.familyId,
      jti: randomId(),
      issuedAt: now,
      notBefore: now,
      expiresAt: now + this.#config.accessTokenTtlSeconds,
      revokedAt: null,
    };
    const token = this.#sealRecordToken("access_token", tokenId, record);
    record.tokenHash = this.#tokenHash(token);
    return { token, record };
  }

  #tokenResult(body: TokenResponseBody): OAuthHttpResult {
    return jsonResult(200, body, { "cache-control": "no-store", pragma: "no-cache" });
  }

  #authorizationRedirect(request: OAuthAuthorizationRequestRecord, result: { code: string } | { error: "access_denied" }): OAuthHttpResult {
    const location = new URL(request.redirectUri);
    if ("code" in result) location.searchParams.set("code", result.code);
    else location.searchParams.set("error", result.error);
    if (request.state !== null) location.searchParams.set("state", request.state);
    location.searchParams.set("iss", this.#config.issuer);
    location.searchParams.set("resource", request.resource);
    return {
      status: 303,
      headers: {
        location: location.toString(),
        "cache-control": "no-store",
        pragma: "no-cache",
        "set-cookie": `${csrfCookieName(request.requestHash)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
      },
      body: "",
    };
  }

  async #authenticateClient(body: URLSearchParams, audience: string): Promise<ValidatedClientMetadata> {
    const clientId = single(body, "client_id", 500);
    if (clientId !== this.#config.clientMetadataUrl) throw new OAuthProtocolError("invalid_client", 401);
    const client = await this.#loadClientMetadata();
    const assertion = body.get("client_assertion");
    const assertionType = body.get("client_assertion_type");
    if (assertion === null && assertionType === null) {
      if (!client.tokenEndpointAuthMethods.includes("none")) throw new OAuthProtocolError("invalid_client", 401);
      return client;
    }
    if (assertion === null || assertionType !== TOKEN_ENDPOINT_ASSERTION_TYPE || assertion.length > MAX_TOKEN_BYTES
      || client.jwksUri === null || !client.tokenEndpointAuthMethods.includes("private_key_jwt")) {
      throw new OAuthProtocolError("invalid_client", 401);
    }
    let jwks = await this.#loadClientJwks(client);
    let verified: ReturnType<typeof verifyJwt>;
    try {
      try {
        verified = verifyJwt(assertion, jwks, new Set(["RS256"]));
      } catch {
        const kid = jwtKid(assertion);
        if (jwks.some((key) => key.kid === kid)) throw new OAuthProtocolError("invalid_client", 401);
        jwks = await this.#loadClientJwks(client, true);
        verified = verifyJwt(assertion, jwks, new Set(["RS256"]));
      }
    } catch (error) {
      if (error instanceof OAuthProtocolError) throw error;
      throw new OAuthProtocolError("invalid_client", 401);
    }
    const now = this.#now();
    let jti: string;
    let exp: number;
    try {
      const claims = verified.claims;
      jti = stringClaim(claims.jti);
      exp = integerClaim(claims.exp);
      const iat = integerClaim(claims.iat);
      const nbf = claims.nbf === undefined ? iat : integerClaim(claims.nbf);
      if (stringClaim(claims.iss) !== client.clientId || stringClaim(claims.sub) !== client.clientId
        || !exactAudience(claims.aud, audience) || !validJti(jti)
        || exp <= now || exp > now + 300 || exp <= iat || exp <= nbf
        || iat > now + CLOCK_SKEW_SECONDS || iat < now - 300 || nbf > now + CLOCK_SKEW_SECONDS || nbf > iat) {
        throw new OAuthProtocolError("invalid_client", 401);
      }
    } catch (error) {
      if (error instanceof OAuthProtocolError) throw error;
      throw new OAuthProtocolError("invalid_client", 401);
    }
    if (!await this.#store.claimClientAssertionJti(client.clientId, jti, exp, now)) throw new OAuthProtocolError("invalid_client", 401);
    return client;
  }

  async #loadClientMetadata(force = false): Promise<ValidatedClientMetadata> {
    const now = this.#now();
    if (!force && this.#clientCache !== null && this.#clientCache.expiresAt > now) return this.#clientCache.metadata;
    const raw = await fetchJson(this.#config.fetchImpl, this.#config.clientMetadataUrl, 16_384);
    const metadata = validateClientMetadataDocument(raw, this.#config.clientMetadataUrl, this.#config.clientRedirectUri);
    this.#clientCache = { metadata, expiresAt: now + this.#config.clientMetadataCacheSeconds };
    return metadata;
  }

  async #loadClientJwks(client: ValidatedClientMetadata, force = false): Promise<readonly JsonWebKey[]> {
    if (client.jwksUri === null) throw new OAuthProtocolError("invalid_client", 401);
    const now = this.#now();
    if (!force && this.#clientJwksCache !== null && this.#clientJwksCache.uri === client.jwksUri && this.#clientJwksCache.expiresAt > now) {
      return this.#clientJwksCache.keys;
    }
    const raw = await fetchJson(this.#config.fetchImpl, client.jwksUri, MAX_JSON_BYTES);
    const keys = validateJwks(raw);
    this.#clientJwksCache = { keys, uri: client.jwksUri, expiresAt: now + this.#config.clientMetadataCacheSeconds };
    return keys;
  }

  #parseRequestedScopes(raw: string | null): string[] {
    const scopes = raw === null || raw.trim() === "" ? [...this.#config.defaultScopes] : validateScopeSet(raw.split(" ").filter(Boolean), false);
    if (scopes.some((scope) => !this.#config.supportedScopes.includes(scope))) throw new OAuthProtocolError("invalid_scope");
    return scopes;
  }

  #tokenHash(token: string): string {
    return createHmac("sha256", this.#config.tokenPepper).update(token).digest("hex");
  }

  async #admitEndpoint(action: OAuthEndpointAction, subject: string): Promise<void> {
    const now = this.#now();
    if (now - this.#lastPurgeAt >= 60) {
      await this.#store.purgeExpired(now, this.#config.purgeBatchSize);
      this.#lastPurgeAt = now;
    }
    const limit = action === "token" ? this.#config.tokenRequestsPerWindow : action === "revoke" ? this.#config.revokeRequestsPerWindow : this.#config.authorizeRequestsPerWindow;
    const windowStartedAt = Math.floor(now / this.#config.endpointWindowSeconds) * this.#config.endpointWindowSeconds;
    const subjectHash = this.#tokenHash(`oauth-endpoint-admission\n${action}\n${subject.slice(0, 512)}`);
    if (!await this.#store.reserveEndpointAdmission({ action, subjectHash, windowStartedAt, limit, observedAt: now })) throw new OAuthProtocolError("temporarily_unavailable", 429);
  }

  #sealRecordToken(kind: OAuthBoundRecordKind, tokenId: string, record: OAuthBoundRecord): string {
    const signature = createHmac("sha256", this.#config.tokenPepper).update(`${kind}\n${tokenId}\n${oauthBoundRecordJson(record)}`).digest("base64url");
    return `${tokenId}.${signature}`;
  }

  #verifyRecordToken(kind: OAuthBoundRecordKind, token: string, record: OAuthBoundRecord): boolean {
    const separator = token.lastIndexOf(".");
    if (separator <= 0) return false;
    const tokenId = token.slice(0, separator);
    return safeEqual(this.#sealRecordToken(kind, tokenId, record), token);
  }

  #now(): number {
    return Math.floor(this.#config.now().getTime() / 1_000);
  }
}

export function createOAuthRouter(server: OAuthAuthorizationServer): Router {
  return server.createRouter();
}

export interface OAuthJwtAuthenticatorOptions {
  issuer: string;
  resource: string;
  jwksUri: string;
  allowedSubject: string;
  allowedClientId?: string;
  maxTokenTtlSeconds: number;
  metadataUrl: string;
  fetchImpl?: typeof fetch;
  requiredScopes?: readonly string[];
  allowedRedirectUri?: string;
  now?: () => Date;
  isJtiRevoked?: (jti: string) => Promise<boolean>;
}

/**
 * Resource-server verifier for an external OAuth 2.1 AS. Every authenticate
 * call verifies the JWT signature and all bindings; no positive token cache is
 * used. JWKS documents alone are bounded and briefly cached by key id.
 */
export class OAuthJwtAuthenticator implements RequestAuthenticator, OAuthTokenVerifier {
  readonly #issuer: string;
  readonly #resource: string;
  readonly #jwksUri: string;
  readonly #allowedSubject: string;
  readonly #allowedClientId: string | null;
  readonly #maxTokenTtlSeconds: number;
  readonly #metadataUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requiredScopes: readonly string[];
  readonly #allowedRedirectUri: string | null;
  readonly #nowFn: () => Date;
  readonly #isJtiRevoked: ((jti: string) => Promise<boolean>) | null;
  readonly #resourceMetadata: OAuthProtectedResourceMetadata;
  #jwksCache: { keys: readonly JsonWebKey[]; expiresAt: number } | null = null;

  constructor(options: OAuthJwtAuthenticatorOptions) {
    this.#issuer = normalizeIssuer(options.issuer);
    this.#resource = normalizeResource(options.resource);
    this.#jwksUri = normalizeHttpsUrl(options.jwksUri, "JWKS");
    this.#metadataUrl = normalizeHttpsUrl(options.metadataUrl, "resource metadata");
    if (this.#metadataUrl !== protectedResourceMetadataUrl(this.#resource)) throw configError("OAuth resource metadata URL is not bound to the resource.");
    validateIdentifier(options.allowedSubject, 200, "allowed subject");
    this.#allowedSubject = options.allowedSubject;
    this.#allowedClientId = options.allowedClientId === undefined ? null : validateClientId(options.allowedClientId);
    validateTtl(options.maxTokenTtlSeconds, 30, 3_600, "JWT access token");
    this.#maxTokenTtlSeconds = options.maxTokenTtlSeconds;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#requiredScopes = validateScopeSet(options.requiredScopes ?? [], true);
    this.#allowedRedirectUri = options.allowedRedirectUri === undefined ? null : normalizeRedirectUri(options.allowedRedirectUri);
    this.#nowFn = options.now ?? (() => new Date());
    this.#isJtiRevoked = options.isJtiRevoked ?? null;
    this.#resourceMetadata = OAuthProtectedResourceMetadataSchema.parse({
      resource: this.#resource,
      authorization_servers: [this.#issuer],
      scopes_supported: this.#requiredScopes,
      bearer_methods_supported: ["header"],
      resource_name: "Sophia Voice Lab",
    });
  }

  protectedResourceMetadata(): OAuthProtectedResourceMetadata {
    return structuredClone(this.#resourceMetadata);
  }

  challenge(scopes: readonly string[] = this.#requiredScopes, error?: "invalid_token" | "insufficient_scope", description?: string): string {
    return buildBearerChallenge(this.#metadataUrl, scopes, error, description);
  }

  async authenticate(authorization: string | undefined): Promise<OAuthAuthenticatedCaller> {
    const token = extractBearerToken(authorization);
    const info = await this.verifyAccessToken(token);
    return {
      subject: this.#allowedSubject,
      scopes: new Set(info.scopes),
      authorizationKind: "oauth",
      clientId: info.clientId,
      tokenId: typeof info.extra?.jti === "string" ? info.extra.jti : "unavailable",
      challenge: this.challenge(info.scopes),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      if (Buffer.byteLength(token) > MAX_TOKEN_BYTES || token.split(".").length !== 3) throw new Error("invalid");
      let keys = await this.#loadJwks();
      let verified: ReturnType<typeof verifyJwt>;
      try {
        verified = verifyJwt(token, keys, new Set(["RS256", "PS256", "ES256"]));
      } catch (error) {
        const kid = jwtKid(token);
        if (keys.some((key) => key.kid === kid)) throw error;
        keys = await this.#loadJwks(true);
        verified = verifyJwt(token, keys, new Set(["RS256", "PS256", "ES256"]));
      }
      const claims = verified.claims;
      const now = Math.floor(this.#nowFn().getTime() / 1_000);
      const issuer = stringClaim(claims.iss);
      const subject = stringClaim(claims.sub);
      const resource = stringClaim(claims.resource);
      const exp = integerClaim(claims.exp);
      const nbf = integerClaim(claims.nbf);
      const iat = integerClaim(claims.iat);
      const jti = stringClaim(claims.jti);
      const clientId = claims.client_id === undefined ? stringClaim(claims.azp) : stringClaim(claims.client_id);
      const scopes = jwtScopes(claims);
      if (issuer !== this.#issuer || subject !== this.#allowedSubject || resource !== this.#resource || !exactAudience(claims.aud, this.#resource)
        || exp <= now || nbf > now + CLOCK_SKEW_SECONDS || iat > now + CLOCK_SKEW_SECONDS || nbf > iat
        || exp <= iat || exp - iat > this.#maxTokenTtlSeconds || exp - nbf > this.#maxTokenTtlSeconds + CLOCK_SKEW_SECONDS
        || !validJti(jti) || (this.#allowedClientId !== null && clientId !== this.#allowedClientId)
        || this.#requiredScopes.some((scope) => !scopes.includes(scope))) throw new Error("invalid");
      if (this.#isJtiRevoked !== null && await this.#isJtiRevoked(jti)) throw new Error("invalid");
      return {
        token,
        clientId,
        scopes,
        expiresAt: exp,
        resource: new URL(this.#resource),
        extra: { subject, jti, issuer, audience: this.#resource, authorization_kind: "oauth_jwt" },
      };
    } catch {
      throw oauthUnauthorized();
    }
  }

  async readiness(): Promise<OAuthReadiness> {
    const checks: Record<string, boolean> = { configuration: true, metadata: false, jwks: false, client_registration: false };
    const errors: string[] = [];
    let metadata: OAuthMetadata | null = null;
    try {
      const issuerUrl = new URL(this.#issuer);
      const discoveryUrl = `${issuerUrl.origin}${authorizationServerMetadataPath(this.#issuer)}`;
      const raw = await fetchJson(this.#fetchImpl, discoveryUrl, MAX_JSON_BYTES);
      metadata = OAuthMetadataSchema.parse(raw);
      checks.metadata = normalizeIssuer(metadata.issuer) === this.#issuer
        && metadata.code_challenge_methods_supported?.includes("S256") === true
        && metadata.response_types_supported.includes("code")
        && metadata.authorization_response_iss_parameter_supported === true
        && metadata.authorization_endpoint.startsWith("https://")
        && metadata.token_endpoint.startsWith("https://")
        && isPlainObject(raw) && (raw.jwks_uri === undefined || raw.jwks_uri === this.#jwksUri);
      if (!checks.metadata) errors.push("authorization_server_metadata_invalid");
      const cimd = metadata.client_id_metadata_document_supported === true;
      if (this.#allowedClientId !== null && this.#allowedClientId.startsWith("https://") && cimd) {
        const rawClient = await fetchJson(this.#fetchImpl, this.#allowedClientId, 16_384);
        validateClientMetadataDocument(rawClient, this.#allowedClientId, this.#allowedRedirectUri);
        checks.client_registration = true;
      } else {
        checks.client_registration = cimd;
      }
      if (!checks.client_registration) errors.push("client_registration_discovery_missing");
    } catch {
      errors.push("authorization_server_metadata_unavailable");
    }
    try {
      checks.jwks = (await this.#loadJwks(true)).length > 0;
      if (!checks.jwks) errors.push("jwks_invalid");
    } catch {
      errors.push("jwks_unavailable");
    }
    const authorizationMetadata = metadata ?? OAuthMetadataSchema.parse({
      issuer: this.#issuer,
      authorization_endpoint: `${this.#issuer}/authorize`,
      token_endpoint: `${this.#issuer}/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
    return {
      ready: Object.values(checks).every(Boolean) && errors.length === 0,
      checks,
      errors: [...new Set(errors)],
      authorizationServerMetadata: authorizationMetadata,
      protectedResourceMetadata: this.protectedResourceMetadata(),
    };
  }

  async #loadJwks(force = false): Promise<readonly JsonWebKey[]> {
    const now = Math.floor(this.#nowFn().getTime() / 1_000);
    if (!force && this.#jwksCache !== null && this.#jwksCache.expiresAt > now) return this.#jwksCache.keys;
    const raw = await fetchJson(this.#fetchImpl, this.#jwksUri, MAX_JSON_BYTES);
    const keys = validateJwks(raw);
    this.#jwksCache = { keys, expiresAt: now + 300 };
    return keys;
  }
}

export function buildBearerChallenge(
  metadataUrl: string,
  scopes: readonly string[] = [],
  error?: "invalid_token" | "insufficient_scope",
  description?: string,
): string {
  const url = normalizeHttpsUrl(metadataUrl, "resource metadata");
  const parameters = [`resource_metadata="${escapeChallenge(url)}"`];
  const normalizedScopes = validateScopeSet(scopes, true);
  if (normalizedScopes.length > 0) parameters.push(`scope="${escapeChallenge(normalizedScopes.join(" "))}"`);
  if (error !== undefined) parameters.push(`error="${error}"`);
  const effectiveDescription = description ?? (error === "invalid_token"
    ? "The OAuth access token is missing, invalid, expired, or revoked."
    : error === "insufficient_scope" ? "The OAuth access token lacks a required scope." : undefined);
  if (effectiveDescription !== undefined) {
    const safe = effectiveDescription.replace(/[^\x20-\x21\x23-\x5B\x5D-\x7E]/g, "").slice(0, 200);
    if (safe.length > 0) parameters.push(`error_description="${escapeChallenge(safe)}"`);
  }
  return `Bearer ${parameters.join(", ")}`;
}

export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(normalizeResource(resource));
  const suffix = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${suffix}`;
}

export function authorizationServerMetadataPath(issuer: string): string {
  const url = new URL(normalizeIssuer(issuer));
  const suffix = url.pathname === "/" ? "" : url.pathname;
  return `/.well-known/oauth-authorization-server${suffix}`;
}

export function pkceS256(verifier: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthProtocolError("invalid_grant");
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function validateClientMetadataDocument(raw: unknown, expectedClientId: string, expectedRedirectUri: string | null): ValidatedClientMetadata {
  if (!isPlainObject(raw)) throw new OAuthProtocolError("invalid_client", 401);
  const clientId = stringClaim(raw.client_id);
  if (clientId !== expectedClientId || normalizeHttpsUrl(clientId, "client id") !== expectedClientId) throw new OAuthProtocolError("invalid_client", 401);
  if (!Array.isArray(raw.redirect_uris) || raw.redirect_uris.length !== 1 || raw.redirect_uris.some((value) => typeof value !== "string")) {
    throw new OAuthProtocolError("invalid_client", 401);
  }
  const redirectUris = raw.redirect_uris.map((value) => normalizeRedirectUri(value as string));
  if (expectedRedirectUri !== null && (redirectUris.length !== 1 || redirectUris[0] !== expectedRedirectUri)) throw new OAuthProtocolError("invalid_client", 401);
  const grantTypes = stringArray(raw.grant_types);
  const responseTypes = stringArray(raw.response_types);
  if (!grantTypes.includes("authorization_code") || !grantTypes.includes("refresh_token") || !responseTypes.includes("code")) {
    throw new OAuthProtocolError("invalid_client", 401);
  }
  const advertisedMethods = stringArray(raw.token_endpoint_auth_methods_supported);
  const preferredRaw = raw.token_endpoint_auth_method;
  const preferred = preferredRaw === "none" || preferredRaw === "private_key_jwt" ? preferredRaw : null;
  const methods = advertisedMethods.filter((method): method is "none" | "private_key_jwt" => method === "none" || method === "private_key_jwt");
  if (preferred === null || !methods.includes(preferred) || !methods.includes("none")) throw new OAuthProtocolError("invalid_client", 401);
  const signingAlg = raw.token_endpoint_auth_signing_alg === undefined ? null : raw.token_endpoint_auth_signing_alg;
  if (preferred === "private_key_jwt" && signingAlg !== "RS256") throw new OAuthProtocolError("invalid_client", 401);
  let jwksUri: string | null = null;
  if (raw.jwks_uri !== undefined) {
    jwksUri = normalizeHttpsUrl(stringClaim(raw.jwks_uri), "client JWKS");
    if (new URL(jwksUri).origin !== new URL(expectedClientId).origin) throw new OAuthProtocolError("invalid_client", 401);
  }
  if (preferred === "private_key_jwt" && jwksUri === null) throw new OAuthProtocolError("invalid_client", 401);
  return {
    clientId,
    redirectUris,
    grantTypes,
    responseTypes,
    tokenEndpointAuthMethods: methods,
    preferredTokenEndpointAuthMethod: preferred,
    tokenEndpointAuthSigningAlg: signingAlg === "RS256" ? signingAlg : null,
    jwksUri,
  };
}

function renderConsentPage(requestToken: string, csrfToken: string, scopes: readonly string[]): string {
  const scopeItems = scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Sophia Voice Lab</title></head><body><main><h1>Authorize Sophia Voice Lab</h1><p>Approve the private operator connection for these scopes:</p><ul>${scopeItems}</ul><form method="post" action="/authorize" autocomplete="off"><input type="hidden" name="request_id" value="${escapeHtml(requestToken)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><label>Private operator secret <input type="password" name="consent_secret" required autocomplete="current-password" maxlength="512"></label><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`;
}

function queryParams(req: Request): URLSearchParams {
  const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?") + 1) : "";
  if (Buffer.byteLength(query) > MAX_FORM_BYTES) throw new OAuthProtocolError("invalid_request");
  return new URLSearchParams(query);
}

function bodyParams(req: Request): URLSearchParams {
  if (!isPlainObject(req.body)) throw new OAuthProtocolError("invalid_request");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.body)) {
    if (typeof value !== "string") throw new OAuthProtocolError("invalid_request");
    params.append(key, value);
  }
  if (serializedFormBytes(params) > MAX_FORM_BYTES) throw new OAuthProtocolError("invalid_request");
  return params;
}

function sendExpressResult(res: Response, result: OAuthHttpResult): void {
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  res.status(result.status).send(result.body);
}

function jsonResult(status: number, value: unknown, additionalHeaders: Record<string, string> = {}): OAuthHttpResult {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...additionalHeaders },
    body: JSON.stringify(value),
  };
}

function rejectDuplicateOrUnknownParameters(params: URLSearchParams, allowed: readonly string[]): void {
  const keys = [...params.keys()];
  if (keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length) throw new OAuthProtocolError("invalid_request");
}

function single(params: URLSearchParams, name: string, maxBytes: number): string {
  const values = params.getAll(name);
  if (values.length !== 1 || Buffer.byteLength(values[0] ?? "") > maxBytes) throw new OAuthProtocolError("invalid_request");
  return values[0] ?? "";
}

function serializedFormBytes(params: URLSearchParams): number {
  return Buffer.byteLength(params.toString());
}

function validateUiLocales(value: string): void {
  const locales = value.split(" ");
  if (locales.length === 0 || locales.length > 10 || new Set(locales).size !== locales.length
    || locales.some((locale) => locale.length === 0 || locale.length > 35 || !/^[A-Za-z0-9-]+$/.test(locale))) {
    throw new OAuthProtocolError("invalid_request");
  }
  try {
    for (const locale of locales) new Intl.Locale(locale);
  } catch {
    throw new OAuthProtocolError("invalid_request");
  }
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || Buffer.byteLength(header) > 4_096) return null;
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]?.slice(name.length + 1) ?? "";
  return isBoundedOpaqueToken(value) ? value : null;
}

function csrfCookieName(requestHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new OAuthProtocolError("invalid_request", 403);
  return `${CSRF_COOKIE_PREFIX}${requestHash.slice(0, 24)}`;
}

function normalizeIssuer(value: string): string {
  const normalized = normalizeHttpsUrl(value, "issuer");
  const url = new URL(normalized);
  if (url.search || url.hash || url.username || url.password) throw configError("OAuth issuer is invalid.");
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function normalizeResource(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OAuthProtocolError("invalid_request"); }
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) throw new OAuthProtocolError("invalid_request");
  const normalized = url.toString();
  return normalized.endsWith("/") && url.pathname !== "/" ? normalized.slice(0, -1) : normalized;
}

function normalizeRedirectUri(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OAuthProtocolError("invalid_request"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || value !== url.toString()) throw new OAuthProtocolError("invalid_request");
  return url.toString();
}

function normalizeHttpsUrl(value: string, _label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw configError("OAuth URL configuration is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw configError("OAuth URL configuration is invalid.");
  }
  return url.toString();
}

function validateClientId(value: string): string {
  if (value.startsWith("https://")) return normalizeHttpsUrl(value, "client id");
  validateIdentifier(value, 500, "client id");
  return value;
}

function validateIdentifier(value: string, maxLength: number, _label: string): void {
  if (value.length === 0 || value.length > maxLength || !/^[A-Za-z0-9._:/-]+$/.test(value)) throw configError("OAuth identifier configuration is invalid.");
}

function validateStrongSecret(value: string, _label: string): void {
  if (Buffer.byteLength(value) < 32 || Buffer.byteLength(value) > 512 || new Set(value).size < 8) throw configError("OAuth secret configuration is not sufficiently strong.");
}

function validateTtl(value: number, min: number, max: number, _label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw configError("OAuth TTL configuration is invalid.");
}

function validateBoundedCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw configError("OAuth endpoint admission configuration is invalid.");
}

function requestAdmissionSubject(request: Request): string {
  const address = request.socket.remoteAddress;
  return typeof address === "string" && address.length > 0 && address.length <= 128 ? address : "unknown-peer";
}

function validateScopeSet(values: readonly string[], allowEmpty: boolean): string[] {
  if ((!allowEmpty && values.length === 0) || values.length > 16 || new Set(values).size !== values.length
    || values.some((scope) => scope.length === 0 || scope.length > 100 || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) {
    throw new OAuthProtocolError("invalid_scope");
  }
  return [...values].sort();
}

function sameScopeSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function validConfiguredScopeSet(scopes: readonly string[], supported: readonly string[]): boolean {
  try {
    const normalized = validateScopeSet(scopes, false);
    return sameScopeSet(scopes, normalized) && normalized.every((scope) => supported.includes(scope));
  } catch {
    return false;
  }
}

function isTokenHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function safeEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safeOptionalEpoch(value: unknown): value is number | null {
  return value === null || safeEpoch(value);
}

function oauthBoundRecordJson(record: OAuthBoundRecord): string {
  const mutableOrDerived = new Set(["requestHash", "codeHash", "tokenHash", "consumedAt", "usedAt", "revokedAt", "replacementTokenHash", "familyId"]);
  const projected = Object.fromEntries(Object.entries(record).filter(([key]) => !mutableOrDerived.has(key)));
  return canonicalOAuthValue(projected);
}

function canonicalOAuthValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOAuthValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalOAuthValue(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function exactAudience(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.length === 1 && value[0] === expected);
}

function jwtScopes(claims: Record<string, unknown>): string[] {
  const source = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : claims.scp;
  if (!Array.isArray(source) || source.some((entry) => typeof entry !== "string")) throw new Error("invalid");
  return validateScopeSet(source as string[], false);
}

function randomOpaque(prefix: string, bytes: number): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

function randomId(): string {
  return randomBytes(16).toString("hex");
}

function isBoundedOpaqueToken(value: string): boolean {
  return value.length >= 16 && Buffer.byteLength(value) <= MAX_TOKEN_BYTES && /^[A-Za-z0-9._~-]+$/.test(value);
}

function validJti(value: string): boolean {
  return value.length >= 16 && value.length <= 200 && /^[A-Za-z0-9._~-]+$/.test(value);
}

function extractBearerToken(authorization: string | undefined): string {
  if (authorization === undefined || Buffer.byteLength(authorization) > MAX_TOKEN_BYTES + 16) throw oauthUnauthorized();
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  if (match?.[1] === undefined || !isBoundedOpaqueToken(match[1])) throw oauthUnauthorized();
  return match[1];
}

function oauthUnauthorized(): VoiceLabError {
  return new VoiceLabError(labError("UNAUTHORIZED", "OAuth bearer authorization is invalid.", "authorization"));
}

function configError(message: string): VoiceLabError {
  return new VoiceLabError(labError("CONFIG_INVALID", message, "internal"));
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? "");
}

function escapeChallenge(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function stringClaim(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) throw new Error("invalid");
  return value;
}

function integerClaim(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error("invalid");
  return value as number;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16 || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 500)) {
    throw new OAuthProtocolError("invalid_client", 401);
  }
  return [...new Set(value as string[])];
}

async function fetchJson(fetchImpl: typeof fetch, url: string, maxBytes: number): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || response.url !== "" && response.url !== url) throw new Error("metadata unavailable");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("metadata too large");
  const bytes = await readBoundedBody(response, maxBytes);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { throw new Error("metadata invalid"); }
}

async function readBoundedBody(response: globalThis.Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("metadata too large");
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateJwks(raw: unknown): readonly JsonWebKey[] {
  if (!isPlainObject(raw) || !Array.isArray(raw.keys) || raw.keys.length === 0 || raw.keys.length > 20) throw new Error("JWKS invalid");
  const keys: JsonWebKey[] = [];
  for (const candidate of raw.keys) {
    if (!isPlainObject(candidate) || typeof candidate.kty !== "string" || typeof candidate.kid !== "string"
      || candidate.kid.length === 0 || candidate.kid.length > 200 || candidate.use !== undefined && candidate.use !== "sig") throw new Error("JWKS invalid");
    try { createPublicKey({ key: candidate as JsonWebKey, format: "jwk" }); } catch { throw new Error("JWKS invalid"); }
    keys.push(candidate as JsonWebKey);
  }
  return keys;
}

function verifyJwt(token: string, jwks: readonly JsonWebKey[], allowedAlgorithms: ReadonlySet<string>): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || Buffer.from(part, "base64url").toString("base64url") !== part)) {
    throw new Error("JWT invalid");
  }
  const header = decodeJwtPart(parts[0] ?? "");
  const claims = decodeJwtPart(parts[1] ?? "");
  const algorithm = stringClaim(header.alg);
  const kid = stringClaim(header.kid);
  if (!allowedAlgorithms.has(algorithm) || header.typ !== undefined && !["JWT", "at+jwt"].includes(stringClaim(header.typ))
    || header.crit !== undefined || header.b64 !== undefined) throw new Error("JWT invalid");
  const candidates = jwks.filter((key) => key.kid === kid && (key.alg === undefined || key.alg === algorithm));
  if (candidates.length !== 1) throw new Error("JWT invalid");
  const key = createPublicKey({ key: candidates[0] as JsonWebKey, format: "jwk" });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
  const signature = Buffer.from(parts[2] ?? "", "base64url");
  if (!verifyJwtSignature(algorithm, data, key, signature)) throw new Error("JWT invalid");
  return { header, claims };
}

function jwtKid(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT invalid");
  return stringClaim(decodeJwtPart(parts[0] ?? "").kid);
}

function verifyJwtSignature(algorithm: string, data: Buffer, key: KeyObject, signature: Buffer): boolean {
  if (algorithm === "RS256") return verifySignature("RSA-SHA256", data, key, signature);
  if (algorithm === "PS256") return verifySignature("sha256", data, { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
  if (algorithm === "ES256") return verifySignature("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
  return false;
}

function decodeJwtPart(part: string): Record<string, unknown> {
  if (Buffer.from(part, "base64url").toString("base64url") !== part) throw new Error("JWT invalid");
  const bytes = Buffer.from(part, "base64url");
  if (bytes.length === 0 || bytes.length > 16_384) throw new Error("JWT invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { throw new Error("JWT invalid"); }
  if (!isPlainObject(parsed)) throw new Error("JWT invalid");
  return parsed;
}
