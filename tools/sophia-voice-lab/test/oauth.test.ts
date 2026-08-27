import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHATGPT_CLIENT_METADATA_URL,
  CHATGPT_STABLE_REDIRECT_URI,
  OAUTH_LEDGER_SCHEMA_SQL,
  OAUTH_REQUIRED_CONFIG_KEYS,
  OAuthAuthorizationServer,
  OAuthJwtAuthenticator,
  buildBearerChallenge,
  pkceS256,
  protectedResourceMetadataUrl,
  type OAuthAccessTokenRecord,
  type OAuthAuthorizationCodeRecord,
  type OAuthAuthorizationRequestRecord,
  type OAuthAuthorizationServerConfig,
  type OAuthEndpointAdmission,
  type OAuthHttpResult,
  type OAuthLedgerStore,
  type OAuthRefreshRotationResult,
  type OAuthRefreshTokenRecord,
} from "../src/oauth.js";
import { VoiceLabError } from "../src/domain.js";
import { OAuthMaintenanceLoop } from "../src/oauth-maintenance.js";

const ISSUER = "https://oauth.test";
const RESOURCE = "https://voice-lab.test/mcp";
const METADATA_URL = "https://voice-lab.test/.well-known/oauth-protected-resource/mcp";
const OPERATOR = "voice-lab-private-operator";
const CONSENT_SECRET = "consent-ADMIN-0123456789-abcdefghijklmnopqrstuvwxyz";
const TOKEN_PEPPER = "token-PEPPER-9876543210-ZYXWVUTSRQPONMLKJIHG";
const STATIC_BEARER = "static-BEARER-unique-0123456789-QWERTYUIOPASDF";
const VERIFIER = "v".repeat(64);
const STATE = "state-0123456789-abcdef";
const NOW = 1_787_486_400;

const { privateKey: clientPrivateKey, publicKey: clientPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const clientPublicJwk = { ...clientPublicKey.export({ format: "jwk" }), kid: "chatgpt-test-key", alg: "RS256", use: "sig" };

const CLIENT_METADATA = {
  client_id: CHATGPT_CLIENT_METADATA_URL,
  client_uri: "https://chatgpt.com/",
  redirect_uris: [CHATGPT_STABLE_REDIRECT_URI],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "ChatGPT",
  token_endpoint_auth_signing_alg: "RS256",
  jwks_uri: "https://chatgpt.com/oauth/jwks.json",
};

class DurableTestStore implements OAuthLedgerStore {
  readonly authorizationRequests = new Map<string, OAuthAuthorizationRequestRecord>();
  readonly authorizationCodes = new Map<string, OAuthAuthorizationCodeRecord>();
  readonly accessTokens = new Map<string, OAuthAccessTokenRecord>();
  readonly refreshTokens = new Map<string, OAuthRefreshTokenRecord>();
  readonly assertionJtis = new Map<string, number>();
  readonly endpointAdmissions = new Map<string, number>();
  ready = true;

  async readiness(): Promise<boolean> { return this.ready; }

  async reserveEndpointAdmission(admission: OAuthEndpointAdmission): Promise<boolean> {
    const key = `${admission.action}:${admission.subjectHash}:${admission.windowStartedAt}`;
    const count = this.endpointAdmissions.get(key) ?? 0;
    if (count >= admission.limit) return false;
    this.endpointAdmissions.set(key, count + 1);
    return true;
  }

  async purgeExpired(now: number, _limit: number): Promise<number> {
    let deleted = 0;
    for (const [key, record] of this.authorizationRequests) if (record.expiresAt <= now) { this.authorizationRequests.delete(key); deleted += 1; }
    for (const [key, record] of this.authorizationCodes) if (record.expiresAt <= now) { this.authorizationCodes.delete(key); deleted += 1; }
    for (const [key, record] of this.accessTokens) if (record.expiresAt <= now) { this.accessTokens.delete(key); deleted += 1; }
    for (const [key, record] of this.refreshTokens) if (record.expiresAt <= now) { this.refreshTokens.delete(key); deleted += 1; }
    for (const [key, expiresAt] of this.assertionJtis) if (expiresAt <= now) { this.assertionJtis.delete(key); deleted += 1; }
    return deleted;
  }

  async putAuthorizationRequest(record: OAuthAuthorizationRequestRecord): Promise<void> {
    if (this.authorizationRequests.has(record.requestHash)) throw new Error("duplicate");
    this.authorizationRequests.set(record.requestHash, structuredClone(record));
  }

  async consumeAuthorizationRequest(requestHash: string, csrfHash: string, now: number): Promise<OAuthAuthorizationRequestRecord | null> {
    const record = this.authorizationRequests.get(requestHash);
    if (record === undefined || record.csrfHash !== csrfHash || record.consumedAt !== null || record.expiresAt <= now) return null;
    record.consumedAt = now;
    return structuredClone(record);
  }

  async putAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<void> {
    if (this.authorizationCodes.has(record.codeHash)) throw new Error("duplicate");
    this.authorizationCodes.set(record.codeHash, structuredClone(record));
  }

  async consumeAuthorizationCode(codeHash: string, now: number): Promise<OAuthAuthorizationCodeRecord | null> {
    const record = this.authorizationCodes.get(codeHash);
    if (record === undefined || record.consumedAt !== null || record.revokedAt !== null || record.expiresAt <= now) return null;
    record.consumedAt = now;
    return structuredClone(record);
  }

  async putAccessToken(record: OAuthAccessTokenRecord): Promise<void> {
    if (this.accessTokens.has(record.tokenHash)) throw new Error("duplicate");
    this.accessTokens.set(record.tokenHash, structuredClone(record));
  }

  async getAccessToken(tokenHash: string): Promise<OAuthAccessTokenRecord | null> {
    const record = this.accessTokens.get(tokenHash);
    return record === undefined ? null : structuredClone(record);
  }

  async putRefreshToken(record: OAuthRefreshTokenRecord): Promise<void> {
    if (this.refreshTokens.has(record.tokenHash)) throw new Error("duplicate");
    this.refreshTokens.set(record.tokenHash, structuredClone(record));
  }

  async getRefreshToken(tokenHash: string): Promise<OAuthRefreshTokenRecord | null> {
    const record = this.refreshTokens.get(tokenHash);
    return record === undefined ? null : structuredClone(record);
  }

  async putInitialTokenPair(authorizationCodeHash: string, refresh: OAuthRefreshTokenRecord, access: OAuthAccessTokenRecord): Promise<void> {
    if (refresh.familyId !== access.familyId) throw new Error("OAuth token family mismatch");
    const code = this.authorizationCodes.get(authorizationCodeHash);
    if (!code || code.clientId !== refresh.clientId || code.consumedAt === null || code.revokedAt !== null || code.familyId !== null) throw new Error("OAuth authorization code cannot publish a token family");
    await this.putRefreshToken(refresh);
    await this.putAccessToken(access);
    code.familyId = refresh.familyId;
  }

  async rotateRefreshToken(currentHash: string, expectedJti: string, replacement: OAuthRefreshTokenRecord, access: OAuthAccessTokenRecord, now: number): Promise<OAuthRefreshRotationResult> {
    const current = this.refreshTokens.get(currentHash);
    if (current === undefined) return { status: "invalid" };
    if (current.usedAt !== null || current.replacementTokenHash !== null) {
      await this.revokeTokenFamily(current.familyId, now);
      return { status: "replayed", familyId: current.familyId };
    }
    if (current.revokedAt !== null || current.expiresAt <= now || current.jti !== expectedJti) return { status: "invalid" };
    current.usedAt = now;
    current.replacementTokenHash = replacement.tokenHash;
    this.refreshTokens.set(replacement.tokenHash, structuredClone(replacement));
    this.accessTokens.set(access.tokenHash, structuredClone(access));
    return { status: "rotated", current: structuredClone(current) };
  }

  async revokeToken(tokenHash: string, clientId: string, now: number): Promise<import("../src/oauth.js").OAuthRevocationReceipt> {
    const authorization = this.authorizationCodes.get(tokenHash);
    if (authorization !== undefined && authorization.clientId === clientId) {
      authorization.revokedAt = now;
      if (authorization.familyId !== null) await this.revokeTokenFamily(authorization.familyId, now);
      return { matched: true, kind: "authorization_code", familyTerminal: true };
    }
    const access = this.accessTokens.get(tokenHash);
    if (access !== undefined && access.clientId === clientId) { access.revokedAt = now; return { matched: true, kind: "access_token", familyTerminal: false }; }
    const refresh = this.refreshTokens.get(tokenHash);
    if (refresh !== undefined && refresh.clientId === clientId) { await this.revokeTokenFamily(refresh.familyId, now); return { matched: true, kind: "refresh_token", familyTerminal: true }; }
    return { matched: false, kind: null, familyTerminal: false };
  }

  async revokeTokenFamily(familyId: string, now: number): Promise<void> {
    for (const record of this.accessTokens.values()) if (record.familyId === familyId) record.revokedAt = now;
    for (const record of this.refreshTokens.values()) if (record.familyId === familyId) record.revokedAt = now;
  }

  async claimClientAssertionJti(clientId: string, jti: string, expiresAt: number, now: number): Promise<boolean> {
    for (const [key, expiry] of this.assertionJtis) if (expiry <= now) this.assertionJtis.delete(key);
    const key = `${clientId}\u0000${jti}`;
    if (this.assertionJtis.has(key)) return false;
    this.assertionJtis.set(key, expiresAt);
    return true;
  }
}

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, { status: 200, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } });
}

function makeFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  const documents: Record<string, unknown> = {
    [CHATGPT_CLIENT_METADATA_URL]: CLIENT_METADATA,
    "https://chatgpt.com/oauth/jwks.json": { keys: [clientPublicJwk] },
    ...overrides,
  };
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!(url in documents)) return new Response("not found", { status: 404 });
    return jsonResponse(documents[url]);
  }) as unknown as typeof fetch;
}

function config(fetchImpl = makeFetch(), now = NOW): OAuthAuthorizationServerConfig {
  return {
    issuer: ISSUER,
    resource: RESOURCE,
    metadataUrl: METADATA_URL,
    clientMetadataUrl: CHATGPT_CLIENT_METADATA_URL,
    clientRedirectUri: CHATGPT_STABLE_REDIRECT_URI,
    operatorSubject: OPERATOR,
    consentSecret: CONSENT_SECRET,
    tokenPepper: TOKEN_PEPPER,
    staticBearerToken: STATIC_BEARER,
    supportedScopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"],
    defaultScopes: ["voice_lab:read", "voice_lab:run"],
    accessTokenTtlSeconds: 120,
    refreshTokenTtlSeconds: 3_600,
    authorizationCodeTtlSeconds: 90,
    authorizationRequestTtlSeconds: 180,
    fetchImpl,
    now: () => new Date(now * 1_000),
  };
}

function authorizationParams(state = STATE, scope = "voice_lab:read voice_lab:run"): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_CLIENT_METADATA_URL,
    redirect_uri: CHATGPT_STABLE_REDIRECT_URI,
    scope,
    state,
    code_challenge: pkceS256(VERIFIER),
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
}

function hidden(body: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(body);
  if (match?.[1] === undefined) throw new Error(`missing ${name}`);
  return match[1];
}

async function authorize(server: OAuthAuthorizationServer, state = STATE, scope = "voice_lab:read voice_lab:run"): Promise<{ code: string; authorization: OAuthHttpResult }> {
  const authorization = await server.handleAuthorizationRequest(authorizationParams(state, scope));
  const requestId = hidden(authorization.body, "request_id");
  const csrf = hidden(authorization.body, "csrf_token");
  const cookie = authorization.headers["set-cookie"]?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("missing cookie");
  const decision = await server.handleAuthorizationDecision(new URLSearchParams({
    request_id: requestId,
    csrf_token: csrf,
    consent_secret: CONSENT_SECRET,
    decision: "approve",
  }), cookie);
  const location = new URL(decision.headers.location ?? "");
  const code = location.searchParams.get("code");
  if (code === null) throw new Error("missing code");
  return { code, authorization: decision };
}

async function tokenForCode(server: OAuthAuthorizationServer, code: string, extra: Record<string, string> = {}): Promise<OAuthHttpResult> {
  return server.handleTokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CHATGPT_STABLE_REDIRECT_URI,
    client_id: CHATGPT_CLIENT_METADATA_URL,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...extra,
  }));
}

async function errorResult(server: OAuthAuthorizationServer, operation: () => Promise<OAuthHttpResult>): Promise<OAuthHttpResult> {
  try { return await operation(); } catch (error) { return server.oauthError(error); }
}

function tokenBody(result: OAuthHttpResult): { access_token: string; refresh_token: string; scope: string; resource: string } {
  return JSON.parse(result.body) as { access_token: string; refresh_token: string; scope: string; resource: string };
}

function compactJwt(claims: Record<string, unknown>, key = clientPrivateKey, kid = "chatgpt-test-key"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url")}`;
}

describe("OAuth 2.1 authorization server", () => {
  let store: DurableTestStore;
  let server: OAuthAuthorizationServer;

  beforeEach(() => {
    store = new DurableTestStore();
    server = new OAuthAuthorizationServer(config(), store);
  });

  it("purges the durable OAuth ledger periodically without any public endpoint traffic", async () => {
    let calls = 0;
    const maintenance = new OAuthMaintenanceLoop({ purgeExpired: async () => { calls += 1; return calls; } }, 25, 10);
    maintenance.start();
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(calls).toBeGreaterThanOrEqual(2);
    // A timer callback can increment the store call count just before its
    // resolved promise updates the maintenance success timestamp. Synchronize
    // with that exact in-flight pass so this assertion observes a completed
    // durable purge rather than an event-loop scheduling race.
    await maintenance.runOnce();
    expect(maintenance.readiness()).toMatchObject({ ready: true, running: true, consecutive_failures: 0 });
    await maintenance.close();
    const stoppedAt = calls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(stoppedAt);
    expect(maintenance.readiness().running).toBe(false);
  });

  it("publishes RFC 8414/RFC 9728 metadata and a standards-shaped challenge without registration or secrets", async () => {
    const authorization = server.authorizationServerMetadata();
    const resource = server.protectedResourceMetadata();
    expect(authorization).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      revocation_endpoint: `${ISSUER}/revoke`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(authorization).not.toHaveProperty("registration_endpoint");
    expect(resource).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ["header"] });
    expect(protectedResourceMetadataUrl(RESOURCE)).toBe(METADATA_URL);
    expect(server.challenge(["voice_lab:run"], "invalid_token", "Authorization required")).toBe(
      `Bearer resource_metadata="${METADATA_URL}", scope="voice_lab:run", error="invalid_token", error_description="Authorization required"`,
    );
    expect(server.challenge(["voice_lab:run"], "insufficient_scope")).toContain(
      'error_description="The OAuth access token lacks a required scope."',
    );
    const readiness = await server.readiness();
    expect(readiness).toMatchObject({ ready: true, checks: { metadata: true, durable_store: true, cimd: true, redirect: true }, errors: [] });
    const serialized = JSON.stringify({ authorization, resource, readiness, challenge: server.challenge() });
    expect(serialized).not.toContain(CONSENT_SECRET);
    expect(serialized).not.toContain(TOKEN_PEPPER);
    expect(OAUTH_REQUIRED_CONFIG_KEYS).toContain("SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET");
    expect(OAUTH_LEDGER_SCHEMA_SQL).toContain("sophia_voice_lab.oauth_refresh_tokens");
    expect(OAUTH_LEDGER_SCHEMA_SQL).toContain("sophia_voice_lab.oauth_client_assertion_jtis");
  });

  it("validates the fetched ChatGPT CIMD and the one exact stable redirect", async () => {
    const wrongFetch = makeFetch({
      [CHATGPT_CLIENT_METADATA_URL]: { ...CLIENT_METADATA, redirect_uris: ["https://chatgpt.com/not-the-registered-redirect"] },
    });
    const wrongServer = new OAuthAuthorizationServer(config(wrongFetch), new DurableTestStore());
    expect((await wrongServer.readiness()).ready).toBe(false);
    const rejected = await errorResult(wrongServer, () => wrongServer.handleAuthorizationRequest(authorizationParams()));
    expect(rejected.status).toBe(401);
    expect(rejected.body).toBe('{"error":"invalid_client","error_description":"OAuth client authentication failed."}');

    const changedRedirect = authorizationParams();
    changedRedirect.set("redirect_uri", "https://chatgpt.com/another-redirect");
    const invalid = await errorResult(server, () => server.handleAuthorizationRequest(changedRedirect));
    expect(invalid.status).toBe(400);
    expect(invalid.body).not.toContain("another-redirect");
    expect(() => new OAuthAuthorizationServer({ ...config(), clientRedirectUri: "https://chatgpt.com/another-redirect" }, new DurableTestStore())).toThrow(VoiceLabError);
    expect(() => new OAuthAuthorizationServer({ ...config(), issuer: `${ISSUER}/nested` }, new DurableTestStore())).toThrow(VoiceLabError);
    expect(() => new OAuthAuthorizationServer({ ...config(), tokenPepper: STATIC_BEARER }, new DurableTestStore())).toThrow(VoiceLabError);
  });

  it("accepts ChatGPT's bounded ui_locales hint without persisting it as authorization state", async () => {
    const localized = authorizationParams();
    localized.set("ui_locales", "en-US it-IT");
    const authorization = await server.handleAuthorizationRequest(localized);
    expect(authorization.status).toBe(200);
    expect(store.authorizationRequests.size).toBe(1);
    expect(JSON.stringify([...store.authorizationRequests.values()])).not.toContain("en-US");

    for (const invalid of ["en-US en-US", "en_US", "en-US <script>", "x".repeat(36), Array.from({ length: 11 }, (_, index) => `en-${index}`).join(" ")]) {
      const malformed = authorizationParams(`state-ui-locales-${createHash("sha256").update(invalid).digest("hex").slice(0, 16)}`);
      malformed.set("ui_locales", invalid);
      const denied = await errorResult(server, () => server.handleAuthorizationRequest(malformed));
      expect(denied.status).toBe(400);
      expect(JSON.parse(denied.body)).toMatchObject({ error: "invalid_request" });
      expect(denied.body).not.toContain(invalid);
    }
    expect(store.authorizationRequests.size).toBe(1);
  });

  it("durably rate-fences public OAuth endpoints before request allocation and purges expired rows", async () => {
    const limitedStore = new DurableTestStore();
    const limitedServer = new OAuthAuthorizationServer({ ...config(), authorizeRequestsPerWindow: 1 }, limitedStore);
    expect((await limitedServer.handleAuthorizationRequest(authorizationParams(), "198.51.100.20")).status).toBe(200);
    const rejected = await errorResult(limitedServer, () => limitedServer.handleAuthorizationRequest(authorizationParams("state-rate-second-123"), "198.51.100.20"));
    expect(rejected.status).toBe(429);
    expect(JSON.parse(rejected.body)).toMatchObject({ error: "temporarily_unavailable" });
    expect(limitedStore.authorizationRequests.size).toBe(1);
    expect(limitedStore.endpointAdmissions.size).toBe(1);

    const expired = structuredClone([...limitedStore.authorizationRequests.values()][0]!);
    expired.requestHash = "f".repeat(64);
    expired.expiresAt = NOW - 1;
    limitedStore.authorizationRequests.set(expired.requestHash, expired);
    expect(await limitedStore.purgeExpired(NOW, 100)).toBeGreaterThan(0);
    expect(limitedStore.authorizationRequests.has(expired.requestHash)).toBe(false);
  });

  it("supports response_mode=query and redirects trusted authorization errors with state and issuer only to the pinned callback", async () => {
    const queryMode = authorizationParams("state-query-mode-123");
    queryMode.set("response_mode", "query");
    await expect(server.handleAuthorizationRequest(queryMode)).resolves.toMatchObject({ status: 200 });

    const unsupported = authorizationParams("state-trusted-error-123");
    unsupported.set("scope", "voice_lab:admin");
    let thrown: unknown;
    try { await server.handleAuthorizationRequest(unsupported); } catch (error) { thrown = error; }
    const redirected = server.authorizationError(thrown, unsupported);
    expect(redirected.status).toBe(303);
    const location = new URL(redirected.headers.location!);
    expect(location.origin + location.pathname).toBe(CHATGPT_STABLE_REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("state")).toBe("state-trusted-error-123");
    expect(location.searchParams.get("iss")).toBe(ISSUER);

    const untrusted = new URLSearchParams(unsupported);
    untrusted.set("redirect_uri", "https://attacker.invalid/callback");
    const local = server.authorizationError(thrown, untrusted);
    expect(local.status).toBe(400);
    expect(local.headers).not.toHaveProperty("location");
    expect(local.body).not.toContain("attacker.invalid");

    for (const unsafeState of [null, "short"] as const) {
      const trusted = authorizationParams("state-temporary-value");
      trusted.set("scope", "voice_lab:admin");
      if (unsafeState === null) trusted.delete("state");
      else trusted.set("state", unsafeState);
      const redirect = server.authorizationError(thrown, trusted);
      expect(redirect.status).toBe(303);
      const redirectUrl = new URL(redirect.headers.location!);
      expect(redirectUrl.origin + redirectUrl.pathname).toBe(CHATGPT_STABLE_REDIRECT_URI);
      expect(redirectUrl.searchParams.get("iss")).toBe(ISSUER);
      expect(redirectUrl.searchParams.has("state")).toBe(false);
    }
  });

  it("uses a CSRF-safe POST consent form and never returns the operator secret", async () => {
    const page = await server.handleAuthorizationRequest(authorizationParams());
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(page.headers["set-cookie"]).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(page.body).toContain('method="post"');
    expect(page.body).not.toContain(CONSENT_SECRET);
    expect(page.body).not.toContain(CHATGPT_STABLE_REDIRECT_URI);
    expect(page.body).not.toContain(STATE);

    const requestId = hidden(page.body, "request_id");
    const csrf = hidden(page.body, "csrf_token");
    const cookielessBrowser = await server.handleAuthorizationDecision(new URLSearchParams({
      request_id: requestId,
      csrf_token: csrf,
      consent_secret: CONSENT_SECRET,
      decision: "approve",
    }), undefined);
    expect(cookielessBrowser.status).toBe(303);
    expect(cookielessBrowser.body).not.toContain(CONSENT_SECRET);

    const wrongSecretPage = await server.handleAuthorizationRequest(authorizationParams("state-wrong-secret-123"));
    const wrongSecret = await errorResult(server, () => server.handleAuthorizationDecision(new URLSearchParams({
      request_id: hidden(wrongSecretPage.body, "request_id"),
      csrf_token: hidden(wrongSecretPage.body, "csrf_token"),
      consent_secret: "incorrect-secret-never-reflect-0123456789",
      decision: "approve",
    }), wrongSecretPage.headers["set-cookie"]?.split(";", 1)[0]));
    expect(wrongSecret.status).toBe(403);
    expect(wrongSecret.body).not.toContain("incorrect-secret");
    expect(wrongSecret.headers).not.toHaveProperty("location");
  });

  it("keeps concurrent authorization tabs independently CSRF-bound", async () => {
    const firstPage = await server.handleAuthorizationRequest(authorizationParams("state-concurrent-first-123"));
    const secondPage = await server.handleAuthorizationRequest(authorizationParams("state-concurrent-second-123"));
    const firstCookie = firstPage.headers["set-cookie"]?.split(";", 1)[0];
    const secondCookie = secondPage.headers["set-cookie"]?.split(";", 1)[0];
    if (!firstCookie || !secondCookie) throw new Error("missing concurrent authorization cookie");
    expect(firstCookie.split("=", 1)[0]).not.toBe(secondCookie.split("=", 1)[0]);
    const browserCookieHeader = `${firstCookie}; ${secondCookie}`;

    const first = await server.handleAuthorizationDecision(new URLSearchParams({
      request_id: hidden(firstPage.body, "request_id"),
      csrf_token: hidden(firstPage.body, "csrf_token"),
      consent_secret: CONSENT_SECRET,
      decision: "approve",
    }), browserCookieHeader);
    expect(first.status).toBe(303);
    expect(first.headers["set-cookie"]).toContain(`${firstCookie.split("=", 1)[0]}=`);

    const second = await server.handleAuthorizationDecision(new URLSearchParams({
      request_id: hidden(secondPage.body, "request_id"),
      csrf_token: hidden(secondPage.body, "csrf_token"),
      consent_secret: CONSENT_SECRET,
      decision: "approve",
    }), browserCookieHeader);
    expect(second.status).toBe(303);
    expect(second.headers["set-cookie"]).toContain(`${secondCookie.split("=", 1)[0]}=`);
  });

  it("accepts a valid one-time synchronizer token when the hardened cookie is unavailable", async () => {
    const page = await server.handleAuthorizationRequest(authorizationParams("state-cookieless-browser-123"));
    const result = await server.handleAuthorizationDecision(new URLSearchParams({
      request_id: hidden(page.body, "request_id"),
      csrf_token: hidden(page.body, "csrf_token"),
      consent_secret: CONSENT_SECRET,
      decision: "approve",
    }), undefined);
    expect(result.status).toBe(303);
    expect(new URL(result.headers.location ?? "").searchParams.get("code")).not.toBeNull();
  });

  it("rejects a cookieless consent with a tampered synchronizer token", async () => {
    const page = await server.handleAuthorizationRequest(authorizationParams("state-tampered-csrf-browser-123"));
    const result = await errorResult(server, () => server.handleAuthorizationDecision(new URLSearchParams({
      request_id: hidden(page.body, "request_id"),
      csrf_token: "csrf_tampered-browser-token-0123456789abcdef",
      consent_secret: CONSENT_SECRET,
      decision: "approve",
    }), undefined));
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toMatchObject({ error: "invalid_request" });
  });

  it("rejects a poisoned consumed authorization request before redirect or code issuance", async () => {
    const authorization = await server.handleAuthorizationRequest(authorizationParams("state-poisoned-request"));
    const requestId = hidden(authorization.body, "request_id");
    const csrf = hidden(authorization.body, "csrf_token");
    const request = [...store.authorizationRequests.values()][0];
    if (!request) throw new Error("missing authorization request");
    request.redirectUri = "https://attacker.invalid/callback";
    request.scopes = ["voice_lab:fault"];
    const result = await errorResult(server, () => server.handleAuthorizationDecision(new URLSearchParams({
      request_id: requestId,
      csrf_token: csrf,
      consent_secret: CONSENT_SECRET,
      decision: "approve",
    }), authorization.headers["set-cookie"]?.split(";", 1)[0]));
    expect(result.status).toBe(403);
    expect(result.headers).not.toHaveProperty("location");
    expect(result.body).not.toContain("attacker.invalid");
    expect(store.authorizationCodes.size).toBe(0);
  });

  it("binds state, issuer, resource, scopes, redirect, and S256 PKCE to a one-time authorization code", async () => {
    const { code, authorization } = await authorize(server);
    const redirect = new URL(authorization.headers.location ?? "");
    expect(redirect.origin + redirect.pathname).toBe(CHATGPT_STABLE_REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe(STATE);
    expect(redirect.searchParams.get("iss")).toBe(ISSUER);
    expect(redirect.searchParams.get("resource")).toBe(RESOURCE);

    const token = await tokenForCode(server, code);
    expect(token.status).toBe(200);
    expect(token.headers).toMatchObject({ "cache-control": "no-store", pragma: "no-cache" });
    const issued = tokenBody(token);
    expect(issued.resource).toBe(RESOURCE);
    expect(issued.scope.split(" ").sort()).toEqual(["voice_lab:read", "voice_lab:run"]);
    const caller = await server.authenticate(`Bearer ${issued.access_token}`);
    expect(caller).toMatchObject({ subject: OPERATOR, clientId: CHATGPT_CLIENT_METADATA_URL, authorizationKind: "oauth" });
    expect(caller.scopes.has("voice_lab:run")).toBe(true);

    const replay = await errorResult(server, () => tokenForCode(server, code));
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.body)).toMatchObject({ error: "invalid_grant" });

    const second = await authorize(server, "state-pkce-one-time-123");
    const wrongPkce = await errorResult(server, () => server.handleTokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      code: second.code,
      redirect_uri: CHATGPT_STABLE_REDIRECT_URI,
      client_id: CHATGPT_CLIENT_METADATA_URL,
      code_verifier: "x".repeat(64),
      resource: RESOURCE,
    })));
    expect(JSON.parse(wrongPkce.body)).toMatchObject({ error: "invalid_grant" });
    const afterWrongVerifier = await errorResult(server, () => tokenForCode(server, second.code));
    expect(JSON.parse(afterWrongVerifier.body)).toMatchObject({ error: "invalid_grant" });
  });

  it("uses the authorization code as a durable family-cleanup handle after a lost token response", async () => {
    const { code } = await authorize(server, "state-lost-token-response-cleanup");
    const committedResponse = await tokenForCode(server, code);
    const committed = tokenBody(committedResponse);

    // A client can lose the response after the server commits both tokens. The
    // already-known authorization code remains a safe, one-shot cleanup handle
    // and does not require either raw token to have reached the client.
    const cleanup = await server.handleRevocationRequest(new URLSearchParams({
      token: code,
      token_type_hint: "authorization_code",
      client_id: CHATGPT_CLIENT_METADATA_URL,
    }));
    expect(cleanup).toMatchObject({
      status: 200,
      headers: { "x-sophia-oauth-revocation-receipt": "authorization_code" },
    });
    await expect(server.authenticate(`Bearer ${committed.access_token}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
    const refresh = await errorResult(server, () => server.handleTokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: committed.refresh_token,
      client_id: CHATGPT_CLIENT_METADATA_URL,
      resource: RESOURCE,
    })));
    expect(refresh.status).toBe(400);
    expect(JSON.parse(refresh.body)).toMatchObject({ error: "invalid_grant" });

    const blocked = await authorize(server, "state-preexchange-cleanup");
    const preexchange = await server.handleRevocationRequest(new URLSearchParams({ token: blocked.code, token_type_hint: "authorization_code", client_id: CHATGPT_CLIENT_METADATA_URL }));
    expect(preexchange.headers["x-sophia-oauth-revocation-receipt"]).toBe("authorization_code");
    const denied = await errorResult(server, () => tokenForCode(server, blocked.code));
    expect(denied.status).toBe(400);
    expect(JSON.parse(denied.body)).toMatchObject({ error: "invalid_grant" });
  });

  it("supports one up-front registered-app consent for read, run, and governed fault tools", async () => {
    const oneTimeServer = new OAuthAuthorizationServer({
      ...config(),
      defaultScopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"],
    }, new DurableTestStore());
    const { code } = await authorize(oneTimeServer, "state-one-time-campaign-consent", "voice_lab:read voice_lab:run voice_lab:fault");
    const issued = tokenBody(await tokenForCode(oneTimeServer, code));
    expect(issued.scope.split(" ").sort()).toEqual(["voice_lab:fault", "voice_lab:read", "voice_lab:run"]);
    const autonomousCaller = await oneTimeServer.authenticate(`Bearer ${issued.access_token}`);
    expect([...autonomousCaller.scopes].sort()).toEqual(["voice_lab:fault", "voice_lab:read", "voice_lab:run"]);
    expect(oneTimeServer.challenge(undefined)).toContain('scope="voice_lab:fault voice_lab:read voice_lab:run"');
  });

  it("rotates refresh tokens, detects replay, revokes the family, and supports explicit revocation", async () => {
    const first = tokenBody(await tokenForCode(server, (await authorize(server)).code));
    const rotatedResult = await server.handleTokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: CHATGPT_CLIENT_METADATA_URL,
      resource: RESOURCE,
      scope: "voice_lab:read",
    }));
    const rotated = tokenBody(rotatedResult);
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    expect(rotated.scope).toBe("voice_lab:read");
    await expect(server.authenticate(`Bearer ${rotated.access_token}`)).resolves.toMatchObject({ subject: OPERATOR });

    const replay = await errorResult(server, () => server.handleTokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: CHATGPT_CLIENT_METADATA_URL,
      resource: RESOURCE,
    })));
    expect(JSON.parse(replay.body)).toMatchObject({ error: "invalid_grant" });
    await expect(server.authenticate(`Bearer ${rotated.access_token}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });

    const fresh = tokenBody(await tokenForCode(server, (await authorize(server, "state-explicit-revoke-123")).code));
    const revoked = await server.handleRevocationRequest(new URLSearchParams({
      token: fresh.access_token,
      token_type_hint: "access_token",
      client_id: CHATGPT_CLIENT_METADATA_URL,
    }));
    expect(revoked).toMatchObject({ status: 200, body: "" });
    await expect(server.authenticate(`Bearer ${fresh.access_token}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
    await expect(server.authenticate(`Bearer ${"unknown".repeat(8)}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
  });

  it("validates private_key_jwt client assertions once and rejects their replay", async () => {
    const first = await authorize(server, "state-private-jwt-assertion-1");
    const assertion = compactJwt({
      iss: CHATGPT_CLIENT_METADATA_URL,
      sub: CHATGPT_CLIENT_METADATA_URL,
      aud: `${ISSUER}/token`,
      iat: NOW,
      nbf: NOW - 1,
      exp: NOW + 120,
      jti: "client-assertion-jti-000001",
    });
    const token = await tokenForCode(server, first.code, {
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });
    expect(token.status).toBe(200);

    const second = await authorize(server, "state-private-jwt-assertion-2");
    const replay = await errorResult(server, () => tokenForCode(server, second.code, {
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    }));
    expect(replay.status).toBe(401);
    expect(JSON.parse(replay.body)).toMatchObject({ error: "invalid_client" });

    const invalidTimeAuthorization = await authorize(server, "state-private-jwt-invalid-time");
    const invalidTime = compactJwt({ iss: CHATGPT_CLIENT_METADATA_URL, sub: CHATGPT_CLIENT_METADATA_URL, aud: `${ISSUER}/token`, iat: NOW + 20, nbf: NOW + 20, exp: NOW + 10, jti: "client-assertion-jti-invalid-time" });
    const invalidTimeResult = await errorResult(server, () => tokenForCode(server, invalidTimeAuthorization.code, {
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: invalidTime,
    }));
    expect(invalidTimeResult.status).toBe(401);
    expect(JSON.parse(invalidTimeResult.body)).toMatchObject({ error: "invalid_client" });
  });

  it("maps malformed and bad-signature private_key_jwt assertions to invalid_client without a 500", async () => {
    const malformedAuthorization = await authorize(server, "state-private-jwt-malformed");
    const malformed = await errorResult(server, () => tokenForCode(server, malformedAuthorization.code, {
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: "not-a-jwt",
    }));
    expect(malformed.status).toBe(401);
    expect(JSON.parse(malformed.body)).toEqual({ error: "invalid_client", error_description: "OAuth client authentication failed." });

    const { privateKey: wrongKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const badSignature = compactJwt({
      iss: CHATGPT_CLIENT_METADATA_URL,
      sub: CHATGPT_CLIENT_METADATA_URL,
      aud: `${ISSUER}/token`,
      iat: NOW,
      exp: NOW + 120,
      jti: "client-assertion-jti-bad-signature",
    }, wrongKey);
    const badSignatureAuthorization = await authorize(server, "state-private-jwt-bad-signature");
    const rejected = await errorResult(server, () => tokenForCode(server, badSignatureAuthorization.code, {
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: badSignature,
    }));
    expect(rejected.status).toBe(401);
    expect(JSON.parse(rejected.body)).toMatchObject({ error: "invalid_client" });
  });

  it("fails OAuth readiness closed when the injected store has no durable readiness proof", async () => {
    const missingReadiness = new DurableTestStore() as OAuthLedgerStore & { readiness?: undefined };
    (missingReadiness as { readiness?: unknown }).readiness = undefined;
    const unverified = new OAuthAuthorizationServer(config(), missingReadiness as OAuthLedgerStore);
    await expect(unverified.readiness()).resolves.toMatchObject({ ready: false, checks: { durable_store: false } });
  });

  it("rejects poisoned authorization-code and refresh-token rows before issuing elevated tokens", async () => {
    const poisonedCode = await authorize(server, "state-poisoned-code-row");
    const codeRow = [...store.authorizationCodes.values()][0];
    if (!codeRow) throw new Error("missing authorization code row");
    codeRow.scopes = ["voice_lab:fault"];
    const deniedCode = await errorResult(server, () => tokenForCode(server, poisonedCode.code));
    expect(JSON.parse(deniedCode.body)).toMatchObject({ error: "invalid_grant" });

    const issued = tokenBody(await tokenForCode(server, (await authorize(server, "state-poisoned-refresh-row")).code));
    const refreshRow = [...store.refreshTokens.values()].find((candidate) => candidate.usedAt === null);
    if (!refreshRow) throw new Error("missing refresh row");
    refreshRow.scopes = ["voice_lab:read", "voice_lab:fault"];
    const deniedRefresh = await errorResult(server, () => server.handleTokenRequest(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: CHATGPT_CLIENT_METADATA_URL,
      resource: RESOURCE,
    })));
    expect(JSON.parse(deniedRefresh.body)).toMatchObject({ error: "invalid_grant" });
    expect(store.accessTokens.size).toBe(1);
  });

  it("rejects a one-field scope escalation in an otherwise valid persisted access token", async () => {
    const issued = tokenBody(await tokenForCode(server, (await authorize(server, "state-poisoned-access-row")).code));
    const row = [...store.accessTokens.values()][0];
    if (!row) throw new Error("missing access row");
    row.scopes = ["voice_lab:read", "voice_lab:run", "voice_lab:fault"];
    await expect(server.authenticate(`Bearer ${issued.access_token}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
  });

  it("rejects non-finite durable epochs for every OAuth grant/token row", async () => {
    const requestPage = await server.handleAuthorizationRequest(authorizationParams("state-nan-request-row"));
    const requestRow = [...store.authorizationRequests.values()][0]!;
    requestRow.expiresAt = Number.NaN;
    const deniedRequest = await errorResult(server, () => server.handleAuthorizationDecision(new URLSearchParams({ request_id: hidden(requestPage.body, "request_id"), csrf_token: hidden(requestPage.body, "csrf_token"), consent_secret: CONSENT_SECRET, decision: "approve" }), requestPage.headers["set-cookie"]?.split(";", 1)[0]));
    expect(deniedRequest.status).toBe(403);

    const codeGrant = await authorize(server, "state-nan-code-row");
    const codeRow = [...store.authorizationCodes.values()].find((row) => row.consumedAt === null)!;
    codeRow.expiresAt = Number.POSITIVE_INFINITY;
    expect(JSON.parse((await errorResult(server, () => tokenForCode(server, codeGrant.code))).body)).toMatchObject({ error: "invalid_grant" });

    const accessGrant = tokenBody(await tokenForCode(server, (await authorize(server, "state-nan-access-row")).code));
    const accessRow = [...store.accessTokens.values()].find((row) => row.revokedAt === null)!;
    accessRow.expiresAt = Number.NaN;
    await expect(server.authenticate(`Bearer ${accessGrant.access_token}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });

    const refreshGrant = tokenBody(await tokenForCode(server, (await authorize(server, "state-nan-refresh-row")).code));
    const refreshRow = [...store.refreshTokens.values()].at(-1)!;
    refreshRow.issuedAt = Number.NEGATIVE_INFINITY;
    const deniedRefresh = await errorResult(server, () => server.handleTokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshGrant.refresh_token, client_id: CHATGPT_CLIENT_METADATA_URL, resource: RESOURCE })));
    expect(JSON.parse(deniedRefresh.body)).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects unsupported scopes, wrong resources, duplicate fields, malformed and oversized inputs without reflecting content", async () => {
    const unsupported = await errorResult(server, () => server.handleAuthorizationRequest(authorizationParams(STATE, "voice_lab:admin")));
    expect(JSON.parse(unsupported.body)).toMatchObject({ error: "invalid_scope" });

    const wrongResource = authorizationParams();
    wrongResource.set("resource", "https://attacker.invalid/mcp");
    const deniedResource = await errorResult(server, () => server.handleAuthorizationRequest(wrongResource));
    expect(deniedResource.status).toBe(400);
    expect(deniedResource.body).not.toContain("attacker.invalid");

    const duplicate = authorizationParams();
    duplicate.append("state", "duplicate-secret-looking-state");
    const deniedDuplicate = await errorResult(server, () => server.handleAuthorizationRequest(duplicate));
    expect(deniedDuplicate.status).toBe(400);
    expect(deniedDuplicate.body).not.toContain("duplicate-secret-looking-state");

    const oversized = await errorResult(server, () => server.handleTokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      code: "a".repeat(9_000),
      redirect_uri: CHATGPT_STABLE_REDIRECT_URI,
      client_id: CHATGPT_CLIENT_METADATA_URL,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    })));
    expect(oversized.status).toBe(400);
    expect(oversized.body.length).toBeLessThan(200);
    expect(JSON.stringify([unsupported, deniedResource, deniedDuplicate, oversized])).not.toContain(CONSENT_SECRET);
    expect(() => buildBearerChallenge(METADATA_URL, [], "invalid_token", "bad\r\nInjected: secret")).not.toThrow();
  });
});

describe("external authorization-server JWT verifier", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "issuer-key-1", alg: "RS256", use: "sig" };
  const JWKS_URI = "https://issuer.test/jwks";
  const EXTERNAL_ISSUER = "https://issuer.test";
  const externalMetadata = {
    issuer: EXTERNAL_ISSUER,
    authorization_endpoint: `${EXTERNAL_ISSUER}/authorize`,
    token_endpoint: `${EXTERNAL_ISSUER}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    jwks_uri: JWKS_URI,
  };

  function jwt(claims: Record<string, unknown>): string {
    return compactJwt(claims, privateKey, "issuer-key-1");
  }

  function validClaims(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      iss: EXTERNAL_ISSUER,
      sub: OPERATOR,
      aud: RESOURCE,
      resource: RESOURCE,
      client_id: CHATGPT_CLIENT_METADATA_URL,
      scope: "voice_lab:read voice_lab:run",
      iat: NOW,
      nbf: NOW - 1,
      exp: NOW + 120,
      jti: "access-token-jti-00000001",
      ...patch,
    };
  }

  function authenticator(patch: Partial<ConstructorParameters<typeof OAuthJwtAuthenticator>[0]> = {}): OAuthJwtAuthenticator {
    const fetchImpl = makeFetch({
      [`${EXTERNAL_ISSUER}/.well-known/oauth-authorization-server`]: externalMetadata,
      [JWKS_URI]: { keys: [publicJwk] },
    });
    return new OAuthJwtAuthenticator({
      issuer: EXTERNAL_ISSUER,
      resource: RESOURCE,
      jwksUri: JWKS_URI,
      allowedSubject: OPERATOR,
      allowedClientId: CHATGPT_CLIENT_METADATA_URL,
      maxTokenTtlSeconds: 300,
      metadataUrl: METADATA_URL,
      requiredScopes: ["voice_lab:read", "voice_lab:run"],
      allowedRedirectUri: CHATGPT_STABLE_REDIRECT_URI,
      fetchImpl,
      now: () => new Date(NOW * 1_000),
      ...patch,
    });
  }

  it("validates discovery, exact issuer, S256, CIMD, redirect, JWKS and returns no secret-bearing readiness data", async () => {
    const auth = authenticator();
    const readiness = await auth.readiness();
    expect(readiness).toMatchObject({
      ready: true,
      checks: { configuration: true, metadata: true, jwks: true, client_registration: true },
      errors: [],
    });
    expect(auth.protectedResourceMetadata()).toMatchObject({ resource: RESOURCE, authorization_servers: [EXTERNAL_ISSUER] });
    expect(auth.challenge()).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(JSON.stringify(readiness)).not.toContain(CONSENT_SECRET);
    expect(JSON.stringify(readiness)).not.toContain(TOKEN_PEPPER);
    expect(JSON.stringify(readiness)).not.toContain(STATIC_BEARER);
  });

  it("fails external-AS readiness for DCR-only metadata or missing RFC 9207 issuer response support", async () => {
    for (const metadata of [
      { ...externalMetadata, client_id_metadata_document_supported: false, registration_endpoint: `${EXTERNAL_ISSUER}/register` },
      { ...externalMetadata, authorization_response_iss_parameter_supported: false },
    ]) {
      const auth = authenticator({ fetchImpl: makeFetch({ [`${EXTERNAL_ISSUER}/.well-known/oauth-authorization-server`]: metadata, [JWKS_URI]: { keys: [publicJwk] } }) });
      await expect(auth.readiness()).resolves.toMatchObject({ ready: false });
    }
  });

  it("discovers a valid RFC 8414 authorization server whose issuer contains a path", async () => {
    const issuer = "https://issuer.test/tenant";
    const jwksUri = `${issuer}/jwks`;
    const metadata = {
      ...externalMetadata,
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: jwksUri,
    };
    const auth = new OAuthJwtAuthenticator({
      issuer,
      resource: RESOURCE,
      jwksUri,
      allowedSubject: OPERATOR,
      allowedClientId: CHATGPT_CLIENT_METADATA_URL,
      maxTokenTtlSeconds: 300,
      metadataUrl: METADATA_URL,
      requiredScopes: ["voice_lab:read", "voice_lab:run"],
      allowedRedirectUri: CHATGPT_STABLE_REDIRECT_URI,
      fetchImpl: makeFetch({
        [`https://issuer.test/.well-known/oauth-authorization-server/tenant`]: metadata,
        [jwksUri]: { keys: [publicJwk] },
      }),
      now: () => new Date(NOW * 1_000),
    });
    await expect(auth.readiness()).resolves.toMatchObject({ ready: true });
  });

  it("verifies signature, issuer, audience/resource, subject, client, scopes, exp, nbf, iat, ttl and JTI every time", async () => {
    const auth = authenticator();
    const valid = jwt(validClaims());
    const caller = await auth.authenticate(`Bearer ${valid}`);
    expect(caller).toMatchObject({ subject: OPERATOR, clientId: CHATGPT_CLIENT_METADATA_URL, tokenId: "access-token-jti-00000001" });
    expect(caller.scopes.has("voice_lab:run")).toBe(true);

    const invalidClaims: Record<string, Record<string, unknown>> = {
      issuer: { iss: "https://other-issuer.test" },
      audience: { aud: "https://other-resource.test/mcp" },
      resource: { resource: "https://other-resource.test/mcp" },
      subject: { sub: "ordinary-user" },
      client: { client_id: "different-client" },
      scope: { scope: "voice_lab:read" },
      expired: { exp: NOW },
      not_before: { nbf: NOW + 60 },
      future_iat: { iat: NOW + 60, nbf: NOW + 60, exp: NOW + 120 },
      excessive_ttl: { exp: NOW + 301 },
      missing_jti: { jti: "short" },
    };
    for (const patch of Object.values(invalidClaims)) {
      await expect(auth.authenticate(`Bearer ${jwt(validClaims(patch))}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
    }
    await expect(auth.authenticate(`Bearer ${valid.slice(0, -1)}x`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
    await expect(auth.authenticate(undefined)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
    await expect(auth.authenticate(`Bearer ${"x".repeat(9_000)}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
  });

  it("checks revocation on every tool authentication without treating normal bearer reuse as replay", async () => {
    let revoked = false;
    const check = vi.fn(async () => revoked);
    const auth = authenticator({ isJtiRevoked: check });
    const token = jwt(validClaims());
    await expect(auth.authenticate(`Bearer ${token}`)).resolves.toMatchObject({ subject: OPERATOR });
    await expect(auth.authenticate(`Bearer ${token}`)).resolves.toMatchObject({ subject: OPERATOR });
    expect(check).toHaveBeenCalledTimes(2);
    revoked = true;
    await expect(auth.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ detail: { code: "UNAUTHORIZED" } });
  });
});
