import { loadConfig } from "../config.js";
import { createHttpApp, createWebBootIdentity, listen, probeTarget } from "../http-server.js";
import { createAudioResolver, createLedger } from "../runtime.js";
import { StaticAttestationAuthenticator, StaticBearerAuthenticator } from "../security.js";
import { CompositeRequestAuthenticator } from "../security.js";
import { VoiceLabService } from "../service.js";
import { CHATGPT_CLIENT_METADATA_URL, CHATGPT_STABLE_REDIRECT_URI, OAuthAuthorizationServer } from "../oauth.js";
import { PostgresOAuthLedgerStore } from "../oauth-postgres-store.js";
import { OAuthMaintenanceLoop } from "../oauth-maintenance.js";

const config = loadConfig();
const ledger = createLedger(config);
await ledger.initialize();
const audio = await createAudioResolver(config);
const service = new VoiceLabService(ledger, config, async () => audio.summaries(), async () => audio.ttsInfo(), async () => {
  if (!config.readinessTarget) return { ok: false, status: "unconfigured", builds: null, reason: "target_configuration_missing" };
  return probeTarget(config);
});
if (!config.oauth || !config.databaseUrl) throw new Error("OAuth and DATABASE_URL are required for the registered production MCP lane.");
const oauthStore = new PostgresOAuthLedgerStore(config.databaseUrl, 5, config.oauth.admissionRetentionSeconds, config.callerPartitionKeys, config.oauth.operatorSubject);
const oauth = new OAuthAuthorizationServer({
  issuer: config.oauth.issuer,
  resource: config.oauth.resource,
  metadataUrl: config.oauth.metadataUrl,
  clientMetadataUrl: config.oauth.clientMetadataUrl || CHATGPT_CLIENT_METADATA_URL,
  clientRedirectUri: config.oauth.clientRedirectUri || CHATGPT_STABLE_REDIRECT_URI,
  operatorSubject: config.oauth.operatorSubject,
  consentSecret: config.oauth.consentSecret,
  tokenPepper: config.oauth.tokenPepper,
  staticBearerToken: config.bearerToken,
  supportedScopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"],
  // Fault remains independently enforced per tool, while the registered app
  // is consented once before an autonomous certification campaign.
  defaultScopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"],
  accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
  refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
  endpointWindowSeconds: config.oauth.endpointWindowSeconds,
  authorizeRequestsPerWindow: config.oauth.authorizeRequestsPerWindow,
  tokenRequestsPerWindow: config.oauth.tokenRequestsPerWindow,
  revokeRequestsPerWindow: config.oauth.revokeRequestsPerWindow,
  purgeBatchSize: config.oauth.purgeBatchSize,
}, oauthStore);
const directBearer = new StaticBearerAuthenticator(config.bearerToken, config.bearerSubject, config.faultBearerToken);
if (!config.attestationTransportTokens) throw new Error("Source-specific attestation transport credentials are required by the web process.");
const attestationBearer = new StaticAttestationAuthenticator(Object.fromEntries(Object.entries(config.attestationAuthorities).map(([authority, entry]) => [authority, { token: config.attestationTransportTokens![authority as keyof typeof config.attestationTransportTokens], subject: entry.subject }])) as ConstructorParameters<typeof StaticAttestationAuthenticator>[0]);
const authenticator = new CompositeRequestAuthenticator([oauth, directBearer, attestationBearer]);
const oauthMaintenance = new OAuthMaintenanceLoop(oauthStore, config.oauth.purgeBatchSize);
oauthMaintenance.start();
const webBoot = createWebBootIdentity(config);
await ledger.recordAuthAudit({
  runId: null,
  callerId: "system.web",
  action: "service:web_boot",
  argumentHash: webBoot.bootIdSha256,
  outcome: "allowed",
  detail: { service_version: config.serviceVersion, instance_id_sha256: webBoot.instanceIdSha256, version_response_sha256: webBoot.versionResponseSha256, raw_instance_identifier_excluded: true },
  observedAt: webBoot.observedAt,
});
const server = await listen(createHttpApp(config, service, ledger, authenticator, oauth, oauthMaintenance, webBoot), config.port);

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await oauthMaintenance.close();
  await oauthStore.close();
  await ledger.close();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
