import { loadConfig } from "../config.js";
import { createHttpApp, createWebBootIdentity, listen, probeTarget } from "../http-server.js";
import { createAudioResolver, createLedger } from "../runtime.js";
import { StaticAttestationAuthenticator, StaticBearerAuthenticator } from "../security.js";
import { CompositeRequestAuthenticator } from "../security.js";
import { VoiceLabService } from "../service.js";
import { CHATGPT_CLIENT_METADATA_URL, CHATGPT_STABLE_REDIRECT_URI, OAuthAuthorizationServer } from "../oauth.js";
import { PostgresOAuthLedgerStore } from "../oauth-postgres-store.js";
import { OAuthMaintenanceLoop } from "../oauth-maintenance.js";

function logWebBootStage(stage: string): void {
  console.log(JSON.stringify({ event: "voice_lab_web_boot_stage", stage }));
}

const config = loadConfig();
logWebBootStage("config_loaded");
const ledger = createLedger(config);
logWebBootStage("ledger_initializing");
await ledger.initialize();
logWebBootStage("ledger_initialized");
logWebBootStage("audio_initializing");
const audio = await createAudioResolver(config);
logWebBootStage("audio_initialized");
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
logWebBootStage("oauth_maintenance_started");
const webBoot = createWebBootIdentity(config);
logWebBootStage("boot_audit_recording");
await ledger.recordAuthAudit({
  runId: null,
  callerId: "system.web",
  action: "service:web_boot",
  argumentHash: webBoot.bootIdSha256,
  outcome: "allowed",
  detail: { service_version: config.serviceVersion, instance_id_sha256: webBoot.instanceIdSha256, version_response_sha256: webBoot.versionResponseSha256, raw_instance_identifier_excluded: true },
  observedAt: webBoot.observedAt,
});
logWebBootStage("boot_audit_recorded");
const server = await listen(createHttpApp(config, service, ledger, authenticator, oauth, oauthMaintenance, webBoot), config.port);
logWebBootStage("http_listening");
await logStartupReadiness(config.port);

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await oauthMaintenance.close();
  await oauthStore.close();
  await ledger.close();
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

async function logStartupReadiness(port: number): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    const body = await response.json() as {
      status?: string;
      components?: {
        database?: { ready?: boolean };
        browser_worker?: { ready?: boolean; execution_gate_settled?: boolean };
        target_environment?: { ok?: boolean; status?: string };
        test_auth?: { ok?: boolean; status?: string; mutation_gate_order_safe?: boolean };
        principal_provision?: { ready?: boolean; status?: string };
        oauth?: { ready?: boolean; maintenance?: { ready?: boolean } };
      };
    };
    console.log(JSON.stringify({
      event: "voice_lab_web_startup_readiness",
      http_status: response.status,
      status: body.status ?? "unknown",
      checks: {
        database_ready: body.components?.database?.ready === true,
        browser_worker_ready: body.components?.browser_worker?.ready === true,
        worker_gate_settled: body.components?.browser_worker?.execution_gate_settled === true,
        target_ready: body.components?.target_environment?.ok === true,
        target_status: body.components?.target_environment?.status ?? "unknown",
        test_auth_ready: body.components?.test_auth?.ok === true,
        test_auth_status: body.components?.test_auth?.status ?? "unknown",
        mutation_gate_order_safe: body.components?.test_auth?.mutation_gate_order_safe === true,
        principal_ready: body.components?.principal_provision?.ready === true,
        principal_status: body.components?.principal_provision?.status ?? "unknown",
        oauth_ready: body.components?.oauth?.ready === true,
        oauth_maintenance_ready: body.components?.oauth?.maintenance?.ready === true,
      },
    }));
  } catch (error) {
    console.log(JSON.stringify({ event: "voice_lab_web_startup_readiness", http_status: null, status: "probe_failed", error_class: error instanceof Error ? error.name : "Error" }));
  }
}
