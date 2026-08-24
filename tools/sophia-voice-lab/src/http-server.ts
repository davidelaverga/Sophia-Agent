import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import type { ErrorRequestHandler } from "express";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";

import type { VoiceLabConfig } from "./config.js";
import { VoiceLabError, labError } from "./domain.js";
import type { VoiceLabLedger, WorkerHeartbeat } from "./ledger.js";
import { createVoiceLabMcpServer } from "./mcp-server.js";
import {
  PRINCIPAL_PROVISION_IDEMPOTENCY_HEADER,
  PRINCIPAL_PROVISION_PATH,
  principalProvisionArgumentBinding,
  provisionVoiceLabPrincipal,
} from './principal-provision.js';
import type { RequestAuthenticator } from "./security.js";
import { CapabilityCodec, canonicalRequestHash, ProvisionOperatorBearerAuthenticator, resolveAllowedOriginPath, sha256, validateAllowedOrigin } from "./security.js";
import { targetAdmissionBinding, type VoiceLabService } from "./service.js";
import type { OAuthAuthorizationServer } from "./oauth.js";
import type { OAuthMaintenanceLoop } from "./oauth-maintenance.js";
import { validateWorkerHeartbeat, workerDeploymentIdentitySha256 } from "./worker-heartbeat.js";

export interface WebBootIdentity {
  bootIdSha256: string;
  instanceIdSha256: string;
  versionResponseSha256: string;
  observedAt: Date;
}

export function createWebBootIdentity(config: VoiceLabConfig, bootId = randomUUID(), instanceId = process.env.RENDER_INSTANCE_ID?.trim() || randomUUID(), observedAt = new Date()): WebBootIdentity {
  const bootIdSha256 = sha256(bootId);
  const instanceIdSha256 = sha256(instanceId);
  const versionResponseSha256 = canonicalRequestHash({ service: "sophia-voice-lab-mcp", commit_sha: config.serviceVersion, boot_id_sha256: bootIdSha256, instance_id_sha256: instanceIdSha256 });
  return { bootIdSha256, instanceIdSha256, versionResponseSha256, observedAt };
}

interface WorkerReadinessAssessment {
  heartbeat: WorkerHeartbeat | null;
  runtimeReady: boolean;
  gateSettled: boolean;
  safeForWeb: boolean;
  component: Record<string, unknown>;
}

export function assessWorkerReadiness(config: VoiceLabConfig, workers: readonly WorkerHeartbeat[], webBoot: WebBootIdentity): WorkerReadinessAssessment {
  const expectedKillSwitchEngaged = config.killSwitch;
  const expectedDeploymentIdentitySha256 = workerDeploymentIdentitySha256(config, expectedKillSwitchEngaged);
  if (workers.length !== 1) {
    return {
      heartbeat: null,
      runtimeReady: false,
      gateSettled: false,
      safeForWeb: false,
      component: {
        ready: false,
        runtime_ready: false,
        live_workers: workers.length,
        execution_gate_settled: false,
        expected_kill_switch_engaged: expectedKillSwitchEngaged,
        observed_kill_switch_engaged: null,
        expected_deployment_identity_sha256: expectedDeploymentIdentitySha256,
        heartbeat_attestation: null,
        detail: { reason: workers.length === 0 ? "heartbeat_missing" : "live_worker_cardinality_invalid" },
      },
    };
  }
  const heartbeat = workers[0]!;
  const validation = validateWorkerHeartbeat(heartbeat, config, webBoot.observedAt);
  if (!validation.ok) {
    return {
      heartbeat: null,
      runtimeReady: false,
      gateSettled: false,
      safeForWeb: false,
      component: {
        ready: false,
        runtime_ready: false,
        live_workers: 1,
        execution_gate_settled: false,
        expected_kill_switch_engaged: expectedKillSwitchEngaged,
        observed_kill_switch_engaged: null,
        expected_deployment_identity_sha256: expectedDeploymentIdentitySha256,
        heartbeat_attestation: null,
        detail: { reason: validation.reason },
      },
    };
  }
  const attestation = validation.attestation;
  const runtimeReady = heartbeat.browserReady && heartbeat.detail.fixtures_ready === true;
  const gateSettled = attestation.effective_kill_switch_engaged === expectedKillSwitchEngaged
    && attestation.deployment_identity_sha256 === expectedDeploymentIdentitySha256;
  // Closing the MCP admission gate first is safe and must remain deployable:
  // once web admission is closed, /readyz stays health-readable while the
  // operator drains and closes worker execution. Opening is the inverse: the
  // worker must already attest the exact open state before web can be ready.
  const safeForWeb = runtimeReady && (expectedKillSwitchEngaged || gateSettled);
  return {
    heartbeat,
    runtimeReady,
    gateSettled,
    safeForWeb,
    component: {
      ready: safeForWeb,
      runtime_ready: runtimeReady,
      live_workers: 1,
      execution_gate_settled: gateSettled,
      expected_kill_switch_engaged: expectedKillSwitchEngaged,
      observed_kill_switch_engaged: attestation.effective_kill_switch_engaged,
      expected_deployment_identity_sha256: expectedDeploymentIdentitySha256,
      heartbeat_attestation: {
        ...attestation,
        observed_at: heartbeat.observedAt.toISOString(),
      },
      detail: runtimeReady ? heartbeat.detail : { ...heartbeat.detail, reason: "browser_or_fixtures_unready" },
    },
  };
}

export function createHttpApp(config: VoiceLabConfig, service: VoiceLabService, ledger: VoiceLabLedger, authenticator: RequestAuthenticator, oauth?: OAuthAuthorizationServer, oauthMaintenance?: OAuthMaintenanceLoop, webBoot = createWebBootIdentity(config)) {
  const logger = pino({ level: config.logLevel, base: { service: "sophia-voice-lab-mcp" } });
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts: config.allowedHosts });
  const provisionAuthenticator = config.provisionOperatorBearerToken
    ? new ProvisionOperatorBearerAuthenticator(config.provisionOperatorBearerToken)
    : null;
  let readinessCache: { expiresAt: number; status: number; body: Record<string, unknown> } | null = null;
  app.disable("x-powered-by");
  if (oauth) app.use(oauth.createRouter());
  app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok", service: "sophia-voice-lab-mcp", version: config.serviceVersion, boot_id_sha256: webBoot.bootIdSha256 }));
  app.get("/version", (_req, res) => res.status(200).json({ service: "sophia-voice-lab-mcp", commit_sha: config.serviceVersion, boot_id_sha256: webBoot.bootIdSha256, instance_id_sha256: webBoot.instanceIdSha256, version_response_sha256: webBoot.versionResponseSha256 }));
  app.get("/readyz", async (_req, res) => {
    if (readinessCache && readinessCache.expiresAt > Date.now()) return res.status(readinessCache.status).json(readinessCache.body);
    const health = await ledger.health();
    const workers = health.ok ? await ledger.listLiveWorkers(new Date(Date.now() - 10_000)) : [];
    const workerReadiness = assessWorkerReadiness(config, workers, webBoot);
    const [target, testAuth, oauthReadiness] = await Promise.all([
      config.readinessTarget ? probeTarget(config) : Promise.resolve({ ok: false, status: "unconfigured", builds: null, reason: "target_configuration_missing" }),
      config.readinessTarget ? probeTestAuth(config) : Promise.resolve({ ok: false, status: "unverified", reason: "target_configuration_missing" }),
      oauth ? oauth.readiness() : Promise.resolve({ ready: config.nodeEnv === "test", checks: { configured: false }, errors: config.nodeEnv === "test" ? [] : ["oauth_not_configured"] }),
    ]);
    const active = health.ok ? await ledger.countActiveRuns() : null;
    const principalProvision = health.ok
      ? await ledger.getPrincipalProvisionReadiness(new Date()).catch(() => ({ status: 'invalid' as const }))
      : { status: 'invalid' as const };
    const maintenance = oauthMaintenance?.readiness() ?? { ready: config.nodeEnv === "test", running: false, last_attempt_at: null, last_success_at: null, last_deleted_count: 0, consecutive_failures: 0, error: oauthMaintenance ? "not_started" : "not_configured" };
    const frontendKillSwitchEngaged = 'frontend_kill_switch_engaged' in testAuth
      && testAuth.ok
      && typeof testAuth.frontend_kill_switch_engaged === 'boolean'
      ? testAuth.frontend_kill_switch_engaged
      : null;
    const mutationGateOrderSafe = 'mutation_gate_order_safe' in testAuth
      && testAuth.mutation_gate_order_safe === true;
    const productMutationGatesOpen = target.ok && 'product_mutation_gates_open' in target && target.product_mutation_gates_open === true;
    const productMutationGateOrderSafe = config.killSwitch || productMutationGatesOpen;
    const baseReady = health.ok && workerReadiness.safeForWeb && target.ok && productMutationGateOrderSafe && oauthReadiness.ready && maintenance.ready;
    const ready = baseReady
      && testAuth.ok
      && mutationGateOrderSafe
      && !config.provisioningEnabled
      && principalProvision.status === 'completed';
    const provisioningRequired = baseReady
      && config.killSwitch
      && config.provisioningEnabled
      && active === 0
      && workerReadiness.gateSettled
      && (principalProvision.status === 'absent' || principalProvision.status === 'prepared')
      && testAuth.status === 'provisioning_required'
      && mutationGateOrderSafe;
    const healthStatus = ready ? 'ready' : provisioningRequired ? 'provisioning_required' : 'not_ready';
    const body = {
      status: healthStatus,
      components: {
        api: { ready: true },
        database: { ready: health.ok, detail: health.detail },
        browser_worker: workerReadiness.component,
        target_environment: target,
        test_auth: testAuth,
        principal_provision: { ready: principalProvision.status === 'completed', status: principalProvision.status },
        oauth: { ready: oauthReadiness.ready && maintenance.ready, checks: oauthReadiness.checks, errors: oauthReadiness.errors, maintenance },
      },
      active_runs: active,
      capacity: 1,
      execution: config.killSwitch ? "kill_switch_engaged" : "enabled",
      product_mutation_gates_open: productMutationGatesOpen,
      mutation_ready: ready && !config.killSwitch && workerReadiness.gateSettled && frontendKillSwitchEngaged === false && productMutationGatesOpen,
      version: config.serviceVersion,
    };
    const httpStatus = ready || provisioningRequired ? 200 : 503;
    readinessCache = { expiresAt: Date.now() + 5_000, status: httpStatus, body };
    return res.status(httpStatus).json(body);
  });
  app.post(PRINCIPAL_PROVISION_PATH, async (req, res) => {
    const requestIdHash = sha256(randomUUID());
    let callerId = 'unauthenticated';
    let argumentHash = sha256('bounded-principal-provision-request');
    try {
      if (!config.provisioningEnabled) {
        return res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).status(404).json({ ok: false, error: 'PRINCIPAL_PROVISION_DISABLED' });
      }
      if (!provisionAuthenticator) throw new VoiceLabError(labError('PRINCIPAL_PROVISION_AUTHORITY_UNAVAILABLE', 'Principal provision authority is unavailable.', 'internal'));
      const caller = await provisionAuthenticator.authenticate(req.header('authorization'));
      callerId = caller.subject;
      if (!caller.scopes.has('voice_lab:provision')) throw new VoiceLabError(labError('SCOPE_REQUIRED', 'Principal provision scope is required.', 'authorization'));
      const contentLength = req.header('content-length');
      if (req.body !== undefined || req.header('transfer-encoding') !== undefined || contentLength !== undefined && contentLength.trim() !== '0') {
        throw new VoiceLabError(labError('PRINCIPAL_PROVISION_BODY_NOT_ALLOWED', 'Principal provision requests do not accept a body.', 'validation'));
      }
      const idempotencyKey = req.header(PRINCIPAL_PROVISION_IDEMPOTENCY_HEADER);
      if (!idempotencyKey) throw new VoiceLabError(labError('PRINCIPAL_PROVISION_IDEMPOTENCY_INVALID', 'A stable idempotency key is required.', 'validation'));
      argumentHash = principalProvisionArgumentBinding(config, idempotencyKey).argumentHash;
      const receipt = await provisionVoiceLabPrincipal(config, ledger, callerId, idempotencyKey);
      return res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).status(200).json(receipt);
    } catch (caught) {
      const detail = caught instanceof VoiceLabError ? caught.detail : null;
      await ledger.recordAuthAudit({
        runId: null,
        callerId,
        action: 'principal.provision',
        argumentHash,
        outcome: 'denied',
        detail: { request_id_hash: requestIdHash, error_class: detail?.code ?? (caught instanceof Error ? caught.name : 'Error') },
        observedAt: new Date(),
      }).catch(() => undefined);
      const status = callerId === 'unauthenticated' ? 401
        : detail?.code === 'PRINCIPAL_PROVISION_KILL_SWITCH_REQUIRED' ? 409
          : detail?.category === 'conflict' ? 409
          : detail?.code === 'PRINCIPAL_PROVISION_FRONTEND_REJECTED' ? 502
            : detail?.category === 'validation' ? 400
              : detail?.category === 'authorization' ? 403
                : 503;
      if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="sophia-voice-lab-principal-provision"');
      return res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).status(status).json({ ok: false, error: status === 401 ? 'UNAUTHORIZED' : detail?.code ?? 'PRINCIPAL_PROVISION_FAILED' });
    }
  });
  app.post("/internal/voice-lab/d02/browser-continuity", async (req, res) => {
    const requestIdHash = sha256(randomUUID());
    let callerId = "unauthenticated";
    let argumentHash = sha256("bounded-unparsed-request");
    try {
      const caller = await authenticator.authenticate(req.header("authorization"));
      callerId = caller.subject;
      argumentHash = canonicalRequestHash(req.body ?? null);
      const proof = await service.getD02BrowserContinuity(caller, req.body);
      await ledger.recordAuthAudit({ runId: null, callerId, action: "external_attestation.d02_browser_continuity", argumentHash, outcome: "allowed", detail: { request_id_hash: requestIdHash, proof_sha256: proof.proof_sha256, run_id_sha256: proof.run_id_sha256, operation_id_sha256: proof.operation_id_sha256, restart_request_id_sha256: proof.restart_request_id_sha256 }, observedAt: new Date() });
      return res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).status(200).json(proof);
    } catch (error) {
      const detail = error instanceof VoiceLabError ? error.detail : null;
      await ledger.recordAuthAudit({ runId: null, callerId, action: "external_attestation.d02_browser_continuity", argumentHash, outcome: "denied", detail: { request_id_hash: requestIdHash, error_class: detail?.code ?? (error instanceof Error ? error.name : "Error") }, observedAt: new Date() }).catch(() => undefined);
      const status = callerId === "unauthenticated" ? 401 : detail?.category === "authorization" ? 403 : detail?.code === "ATTESTATION_CROSS_JOIN_FAILED" ? 409 : 404;
      if (status === 401) res.set("WWW-Authenticate", 'Bearer realm="sophia-voice-lab-attestation"');
      return res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).status(status).json({ error: { code: status === 409 ? "D02_CONTINUITY_PENDING" : status === 401 ? "UNAUTHORIZED" : "D02_CONTINUITY_UNAVAILABLE", message: status === 409 ? "Owning browser continuity proof is not yet available." : "D02 browser continuity proof is unavailable." } });
    }
  });
  app.post("/internal/voice-lab/d02/browser-worker-loss-observation", async (req, res) => {
    const requestIdHash = sha256(randomUUID());
    let callerId = "unauthenticated";
    let argumentHash = sha256("bounded-unparsed-request");
    try {
      const caller = await authenticator.authenticate(req.header("authorization"));
      callerId = caller.subject;
      argumentHash = canonicalRequestHash(req.body ?? null);
      const proof = await service.getD02BrowserWorkerLossObservation(caller, req.body);
      await ledger.recordAuthAudit({ runId: null, callerId, action: "external_attestation.d02_browser_worker_loss_observation", argumentHash, outcome: "allowed", detail: { request_id_hash: requestIdHash, proof_sha256: proof.proof_sha256, run_id_sha256: proof.run_id_sha256, termination_request_id_sha256: proof.termination_request_id_sha256, loss_event_seq: proof.loss_event_seq }, observedAt: new Date() });
      return res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).status(200).json(proof);
    } catch (error) {
      const detail = error instanceof VoiceLabError ? error.detail : null;
      await ledger.recordAuthAudit({ runId: null, callerId, action: "external_attestation.d02_browser_worker_loss_observation", argumentHash, outcome: "denied", detail: { request_id_hash: requestIdHash, error_class: detail?.code ?? (error instanceof Error ? error.name : "Error") }, observedAt: new Date() }).catch(() => undefined);
      const status = callerId === "unauthenticated" ? 401 : detail?.category === "authorization" ? 403 : detail?.code === "ATTESTATION_CROSS_JOIN_FAILED" ? 409 : 404;
      if (status === 401) res.set("WWW-Authenticate", 'Bearer realm="sophia-voice-lab-attestation"');
      return res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).status(status).json({ error: { code: status === 409 ? "D02_WORKER_LOSS_PENDING" : status === 401 ? "UNAUTHORIZED" : "D02_WORKER_LOSS_UNAVAILABLE", message: status === 409 ? "Owning browser-worker loss observation is not yet available." : "D02 browser-worker loss observation is unavailable." } });
    }
  });
  app.post("/internal/voice-lab/d02/render-worker-dispatch-claims", async (req, res) => {
    const requestIdHash = sha256(randomUUID());
    let callerId = "unauthenticated";
    let argumentHash = sha256("bounded-unparsed-request");
    try {
      const caller = await authenticator.authenticate(req.header("authorization"));
      callerId = caller.subject;
      argumentHash = canonicalRequestHash(req.body ?? null);
      const claim = await service.claimD02RenderWorkerDispatch(caller, req.body);
      await ledger.recordAuthAudit({ runId: null, callerId, action: "external_attestation.d02_render_worker_dispatch_claim", argumentHash, outcome: "allowed", detail: { request_id_hash: requestIdHash, termination_request_id_sha256: claim.termination_request_id_sha256, dispatch_attempt_id_sha256: claim.dispatch_attempt_id_sha256, dispatch_claim_sha256: claim.dispatch_claim_sha256, event_seq: claim.event_seq, idempotent_replay: claim.idempotent_replay }, observedAt: new Date() });
      return res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).status(claim.idempotent_replay ? 200 : 201).json(claim);
    } catch (error) {
      const detail = error instanceof VoiceLabError ? error.detail : null;
      await ledger.recordAuthAudit({ runId: null, callerId, action: "external_attestation.d02_render_worker_dispatch_claim", argumentHash, outcome: "denied", detail: { request_id_hash: requestIdHash, error_class: detail?.code ?? (error instanceof Error ? error.name : "Error") }, observedAt: new Date() }).catch(() => undefined);
      const status = callerId === "unauthenticated" ? 401 : detail?.category === "authorization" ? 403 : detail?.code === "ATTESTATION_CROSS_JOIN_FAILED" || detail?.code === "DEDUPE_CONFLICT" ? 409 : 400;
      if (status === 401) res.set("WWW-Authenticate", 'Bearer realm="sophia-voice-lab-attestation"');
      return res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).status(status).json({ error: { code: status === 409 ? "D02_RENDER_DISPATCH_ALREADY_CLAIMED" : status === 401 ? "UNAUTHORIZED" : "D02_RENDER_DISPATCH_REJECTED", message: status === 409 ? "The one-shot D02 Render dispatch was already claimed." : "The D02 Render dispatch claim was rejected." } });
    }
  });
  app.post("/internal/voice-lab/attestations", async (req, res) => {
    const requestId = randomUUID();
    let callerId = "unauthenticated";
    let authenticated = false;
    let argumentHash = sha256("bounded-unparsed-request");
    try {
      const caller = await authenticator.authenticate(req.header("authorization"));
      authenticated = true;
      callerId = caller.subject;
      argumentHash = canonicalRequestHash(req.body ?? null);
      const result = await service.attachExternalAttestation(caller, req.body, { argumentHash, requestIdHash: sha256(requestId) });
      await ledger.recordAuthAudit({ runId: result.run_id, callerId, action: "external_attestation.attach", argumentHash, outcome: "allowed", detail: { request_id_hash: sha256(requestId), attestation_id_hash: typeof result.data.attestation_id === "string" ? sha256(result.data.attestation_id) : null, content_sha256: result.data.content_sha256 ?? null }, observedAt: new Date() });
      return res.status(200).json(result);
    } catch (error) {
      const detail = error instanceof VoiceLabError ? error.detail : null;
      const candidateRunId = req.body && typeof req.body === "object" && typeof (req.body as Record<string, unknown>).run_id === "string" && /^[a-f0-9-]{36}$/i.test(String((req.body as Record<string, unknown>).run_id)) ? String((req.body as Record<string, unknown>).run_id) : null;
      await ledger.recordAuthAudit({ runId: null, callerId, action: "external_attestation.attach", argumentHash, outcome: "denied", detail: { request_id_hash: sha256(requestId), error_class: detail?.code ?? (error instanceof Error ? error.name : "Error"), candidate_run_id_sha256: candidateRunId ? sha256(candidateRunId) : null }, observedAt: new Date() }).catch(() => undefined);
      const status = !authenticated ? 401 : detail?.category === "authorization" ? 403 : detail?.code?.includes("CONFLICT") ? 409 : 400;
      return res.status(status).json({ error: { code: detail?.code ?? "ATTESTATION_REJECTED", message: status === 401 ? "Attestation authorization is required." : "External attestation was rejected." } });
    }
  });
  app.post("/mcp", async (req, res) => {
    const requestId = randomUUID();
    const probeIdHash = governedProbeIdHash(req.header("x-sophia-voice-lab-probe-id"));
    const clientRequestIdHash = governedClientRequestIdHash(req.header("x-sophia-voice-lab-client-request-id"));
    let argumentHash = sha256("bounded-unparsed-request");
    let auditCaller = "unauthenticated";
    let authenticated = false;
    try {
      const caller = await authenticator.authenticate(req.header("authorization"));
      authenticated = true;
      auditCaller = caller.subject;
      argumentHash = canonicalRequestHash(req.body ?? null);
      await ledger.recordAuthAudit({ runId: null, callerId: caller.subject, action: "mcp.authenticate", argumentHash, outcome: "allowed", detail: { request_id_hash: sha256(requestId), client_request_id_hash: clientRequestIdHash, ...(probeIdHash ? { probe_id_sha256: probeIdHash } : {}) }, observedAt: new Date() });
      if (!isInitializeRequest(req.body) && req.header("mcp-session-id")) {
        // Stateless mode intentionally ignores protocol session IDs. Run state
        // is Postgres-durable and survives this web process restarting.
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false } as any);
      const server = createVoiceLabMcpServer(service, ledger, caller, oauth ? (scopes, error) => oauth.challenge(scopes, error) : undefined, { requestIdHash: sha256(requestId), clientRequestIdHash });
      await server.connect(transport as any);
      res.on("close", () => { void transport.close(); void server.close(); });
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await ledger.recordAuthAudit({ runId: null, callerId: auditCaller, action: authenticated ? "mcp.request" : "mcp.authenticate", argumentHash, outcome: "denied", detail: { error_class: error instanceof VoiceLabError ? error.detail.code : error instanceof Error ? error.name : "Error", request_id_hash: sha256(requestId), client_request_id_hash: clientRequestIdHash, ...(probeIdHash ? { probe_id_sha256: probeIdHash } : {}) }, observedAt: new Date() }).catch(() => undefined);
      logger.warn({ request_id: requestId, error_class: error instanceof Error ? error.name : "Error" }, "MCP request rejected");
      if (!res.headersSent) {
        if (!authenticated) {
          const challenge = oauth?.challenge(["voice_lab:read", "voice_lab:run", "voice_lab:fault"], "invalid_token") ?? 'Bearer realm="sophia-voice-lab"';
          res.set("WWW-Authenticate", challenge).status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized", data: { _meta: { "mcp/www_authenticate": [challenge] } } }, id: null });
        }
        else if (error instanceof VoiceLabError && error.detail.category === "validation") res.status(400).json({ jsonrpc: "2.0", error: { code: -32602, message: "Voice Lab request arguments were rejected.", data: { error_code: error.detail.code } }, id: null });
        else res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Voice Lab request processing failed." }, id: null });
      }
    }
  });
  app.get("/mcp", (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless transport accepts POST requests." }, id: null }));
  app.delete("/mcp", (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless transport has no protocol session to delete." }, id: null }));
  // express.json() is installed by createMcpExpressApp before our routes. Its
  // parse/size failures therefore arrive here without entering /mcp. Bind the
  // rejection to an authenticated caller, audit only a content-free fallback
  // hash, and return a bounded JSON-RPC error before any tool/provider work.
  app.use(((error, req, res, next) => {
    const attestationPath = req.path === "/internal/voice-lab/attestations" || req.path === "/internal/voice-lab/d02/browser-continuity" || req.path === "/internal/voice-lab/d02/browser-worker-loss-observation" || req.path === "/internal/voice-lab/d02/render-worker-dispatch-claims";
    const principalProvisionPath = req.path === PRINCIPAL_PROVISION_PATH;
    if (req.path !== "/mcp" && !attestationPath && !principalProvisionPath || (error as { type?: string }).type !== "entity.parse.failed" && (error as { type?: string }).type !== "entity.too.large") return next(error);
    void (async () => {
      const argumentHash = sha256("bounded-unparsed-request");
      const probeIdHash = governedProbeIdHash(req.header("x-sophia-voice-lab-probe-id"));
      const requestIdHash = sha256(randomUUID());
      try {
        const caller = principalProvisionPath
          ? await provisionAuthenticator?.authenticate(req.header('authorization'))
          : await authenticator.authenticate(req.header("authorization"));
        if (!caller) throw new Error('provision-authority-unavailable');
        const tooLarge = (error as { type?: string }).type === "entity.too.large";
        const action = principalProvisionPath ? 'principal.provision' : attestationPath ? "external_attestation.body" : "mcp.body";
        await ledger.recordAuthAudit({ runId: null, callerId: caller.subject, action, argumentHash, outcome: "denied", detail: { error_class: tooLarge ? "BODY_TOO_LARGE" : "MALFORMED_JSON", request_id_hash: requestIdHash, ...(probeIdHash ? { probe_id_sha256: probeIdHash } : {}) }, observedAt: new Date() });
        if (principalProvisionPath) res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).status(tooLarge ? 413 : 400).json({ ok: false, error: tooLarge ? 'BODY_TOO_LARGE' : 'MALFORMED_JSON' });
        else if (attestationPath) res.set({ "Cache-Control": "no-store", Pragma: "no-cache" }).status(tooLarge ? 413 : 400).json({ error: { code: tooLarge ? "BODY_TOO_LARGE" : "MALFORMED_JSON", message: "External attestation request body was rejected." } });
        else res.status(tooLarge ? 413 : 400).json({ jsonrpc: "2.0", error: { code: tooLarge ? -32000 : -32700, message: tooLarge ? "MCP request body exceeded the bounded transport limit." : "MCP request body was not valid JSON.", data: { error_code: tooLarge ? "BODY_TOO_LARGE" : "MALFORMED_JSON" } }, id: null });
      } catch {
        const challenge = principalProvisionPath ? 'Bearer realm="sophia-voice-lab-principal-provision"' : attestationPath ? 'Bearer realm="sophia-voice-lab-attestation"' : oauth?.challenge(["voice_lab:read", "voice_lab:run", "voice_lab:fault"], "invalid_token") ?? 'Bearer realm="sophia-voice-lab"';
        const action = principalProvisionPath ? 'principal.provision' : attestationPath ? "external_attestation.authenticate" : "mcp.authenticate";
        await ledger.recordAuthAudit({ runId: null, callerId: "unauthenticated", action, argumentHash, outcome: "denied", detail: { error_class: "UNAUTHORIZED_BODY_REJECTION", request_id_hash: requestIdHash, ...(probeIdHash ? { probe_id_sha256: probeIdHash } : {}) }, observedAt: new Date() }).catch(() => undefined);
        if (principalProvisionPath) res.set({ 'WWW-Authenticate': challenge, 'Cache-Control': 'no-store', Pragma: 'no-cache' }).status(401).json({ ok: false, error: 'UNAUTHORIZED' });
        else if (attestationPath) res.set({ "WWW-Authenticate": challenge, "Cache-Control": "no-store", Pragma: "no-cache" }).status(401).json({ error: { code: "UNAUTHORIZED", message: "Attestation authorization is required." } });
        else res.set("WWW-Authenticate", challenge).status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized", data: { _meta: { "mcp/www_authenticate": [challenge] } } }, id: null });
      }
    })().catch(next);
  }) as ErrorRequestHandler);
  return app;
}

function governedProbeIdHash(value: string | undefined): string | null {
  if (value === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return null;
  return sha256(value.toLowerCase());
}

function governedClientRequestIdHash(value: string | undefined): string | null {
  if (value === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return null;
  return sha256(value.toLowerCase());
}

interface ProductMutationGateProjection {
  valid: boolean;
  health_ready: boolean;
  open: boolean;
  voice_lab_enabled: boolean | null;
  voice_lab_kill_switch_engaged: boolean | null;
  voice_lab_protected_plane_ready?: boolean | null;
  voice_lab_admission_ready?: boolean | null;
  voice_lab_mutation_ready: boolean | null;
}

function productMutationGateProjection(component: "backend" | "voice", payload: Record<string, unknown>): ProductMutationGateProjection {
  const enabled = payload.voice_lab_enabled;
  const killSwitchEngaged = payload.voice_lab_kill_switch_engaged;
  const admissionReady = component === "backend" ? payload.voice_lab_admission_ready : true;
  const mutationReady = payload.voice_lab_mutation_ready;
  const protectedPlaneReady = component === "backend" ? payload.voice_lab_protected_plane_ready : true;
  const booleansValid = typeof enabled === "boolean"
    && typeof killSwitchEngaged === "boolean"
    && typeof admissionReady === "boolean"
    && typeof mutationReady === "boolean"
    && typeof protectedPlaneReady === "boolean";
  if (!booleansValid) {
    return {
      valid: false,
      health_ready: false,
      open: false,
      voice_lab_enabled: typeof enabled === "boolean" ? enabled : null,
      voice_lab_kill_switch_engaged: typeof killSwitchEngaged === "boolean" ? killSwitchEngaged : null,
      ...(component === "backend" ? { voice_lab_protected_plane_ready: typeof protectedPlaneReady === "boolean" ? protectedPlaneReady : null } : {}),
      ...(component === "backend" ? { voice_lab_admission_ready: typeof admissionReady === "boolean" ? admissionReady : null } : {}),
      voice_lab_mutation_ready: typeof mutationReady === "boolean" ? mutationReady : null,
    };
  }
  const derivedMutationReady = enabled && !killSwitchEngaged && protectedPlaneReady;
  const valid = mutationReady === derivedMutationReady && (component !== "backend" || admissionReady === protectedPlaneReady);
  return {
    valid,
    health_ready: valid && (component !== "backend" || admissionReady),
    open: valid && derivedMutationReady,
    voice_lab_enabled: enabled,
    voice_lab_kill_switch_engaged: killSwitchEngaged,
    ...(component === "backend" ? { voice_lab_protected_plane_ready: protectedPlaneReady } : {}),
    ...(component === "backend" ? { voice_lab_admission_ready: admissionReady } : {}),
    voice_lab_mutation_ready: mutationReady,
  };
}

export async function probeTarget(config: VoiceLabConfig): Promise<Record<string, unknown> & { ok: boolean }> {
  const target = config.readinessTarget!;
  const probeId = randomUUID();
  const observedAt = new Date();
  try {
    const specs = [
      ["frontend", target.frontendUrl, "/api/app-version", ["build_id"], null],
      ["backend", target.gatewayUrl, "/version", ["commit_sha", "git_sha", "build_id"], "/ready"],
      ["voice", target.voiceUrl, "/version", ["commit_sha", "git_sha", "build_id"], "/ready"],
      ["langgraph", target.langgraphUrl, "/version", ["commit_sha", "git_sha", "build_id"], "/ok"],
    ] as const;
    const entries = await Promise.all(specs.map(async ([component, base, pathname, fields, readinessPath]) => {
      const origin = validateAllowedOrigin(base, config.allowedOrigins).origin;
      const [response, readiness] = await Promise.all([
        fetch(new URL(pathname, origin), { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } }),
        readinessPath === null ? Promise.resolve(null) : fetch(new URL(readinessPath, origin), { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } }),
      ]);
      const payload = response.ok ? await response.json() as Record<string, unknown> : {};
      const readinessPayload = readiness?.ok ? await readiness.json() as Record<string, unknown> : {};
      const observed = fields.map((field) => payload[field]).find((value) => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)) ?? null;
      const expected = component === "langgraph" ? target.expectedDependencies.langgraph : target.expectedDeployment[component];
      const identityMatches = response.ok && observed === expected;
      const mutationGate = component === "backend" || component === "voice" ? productMutationGateProjection(component, readinessPayload) : null;
      const configReady = readiness === null || readiness.ok && (mutationGate === null || mutationGate.health_ready);
      const configStatus = configReady ? "ready" : mutationGate !== null && readiness?.ok && !mutationGate.valid ? "voice_lab_gate_projection_invalid" : mutationGate !== null && readiness?.ok ? "voice_lab_protected_plane_not_ready" : "not_ready";
      return [component, { ready: identityMatches && configReady, identity_status: identityMatches ? "verified" : response.ok ? "deployment_mismatch" : "version_unavailable", config_status: configStatus, expected, observed, version_http_status: response.status, readiness_http_status: readiness?.status ?? null, ...(mutationGate === null ? {} : { product_mutation_gate: mutationGate }) }] as const;
    }));
    const builds = Object.fromEntries(entries) as Record<string, { ready: boolean; product_mutation_gate?: ProductMutationGateProjection }>;
    const productMutationGatesOpen = builds.backend?.product_mutation_gate?.open === true && builds.voice?.product_mutation_gate?.open === true;
    const ok = Object.values(builds).every((value) => value.ready);
    return { ok, status: ok ? "verified" : "mismatch_or_unavailable", environment: config.environment, target_binding_sha256: targetAdmissionBinding(target), probe_id: probeId, observed_at: observedAt.toISOString(), product_mutation_gates_open: productMutationGatesOpen, builds };
  } catch (error) {
    return { ok: false, status: "unavailable", environment: config.environment, target_binding_sha256: targetAdmissionBinding(target), probe_id: probeId, observed_at: observedAt.toISOString(), product_mutation_gates_open: false, builds: null, reason: error instanceof Error ? error.name : "probe_failed" };
  }
}

export async function probeTestAuth(config: VoiceLabConfig): Promise<Record<string, unknown> & { ok: boolean; status: string }> {
  const target = config.readinessTarget!;
  const testRunId = randomUUID();
  const cleanupObligationId = randomUUID();
  try {
    const endpoint = resolveAllowedOriginPath(target.frontendUrl, config.authReadinessPath, config.allowedOrigins);
    const codec = new CapabilityCodec(config.grantSecret, config.capabilityIssuer, config.capabilityTtlSeconds);
    const providerExpiresAt = new Date(Date.now() + config.maxRunSeconds * 1_000).toISOString();
    const minted = codec.mint({ aud: "sophia-voice-lab-frontend", sub: config.principalId, principal_id: config.principalId, test_run_id: testRunId, cleanup_obligation_id: cleanupObligationId, synthetic: true, environment: config.environment, retention_hours: 24, provider_expires_at: providerExpiresAt, allowed_ops: ["auth:readiness"], expected_deployment: target.expectedDeployment });
    const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "application/json", "X-Sophia-Voice-Lab-Capability": minted.token } });
    const payload = response.ok ? await response.json() as Record<string, unknown> : {};
    const readinessKeys = new Set(['schema', 'ok', 'ready', 'provisioned', 'principal_record_present', 'principal_record_provisioned', 'provider_account_provisioned', 'provider_account_count', 'active_session_count', 'voice_lab_enabled', 'kill_switch_engaged', 'provisioning_enabled', 'auth_ledger_ready', 'auth_ledger_migration_sha256', 'frontend_build', 'test_run_id', 'cleanup_obligation_id', 'environment', 'expected_deployment', 'deployment_identity', 'capability_jti_sha256', 'principal_id_sha256']);
    const exactShape = Object.keys(payload).length === readinessKeys.size && Object.keys(payload).every((key) => readinessKeys.has(key));
    const deploymentIdentity = payload.deployment_identity && typeof payload.deployment_identity === "object" && !Array.isArray(payload.deployment_identity) ? payload.deployment_identity as Record<string, unknown> : {};
    const expectedDeployment = payload.expected_deployment && typeof payload.expected_deployment === 'object' && !Array.isArray(payload.expected_deployment) ? payload.expected_deployment as Record<string, unknown> : {};
    const commonBound = exactShape && payload.schema === 'sophia_voice_lab_auth_readiness_v1' && payload.ok === true
      && payload.auth_ledger_ready === true && typeof payload.auth_ledger_migration_sha256 === 'string' && /^[a-f0-9]{64}$/.test(payload.auth_ledger_migration_sha256)
      && payload.frontend_build === target.expectedDeployment.frontend && payload.principal_id_sha256 === sha256(config.principalId)
      && payload.test_run_id === testRunId && payload.cleanup_obligation_id === cleanupObligationId && payload.environment === config.environment
      && payload.capability_jti_sha256 === sha256(minted.claims.jti)
      && Object.keys(deploymentIdentity).length === 1 && deploymentIdentity.frontend === target.expectedDeployment.frontend
      && Object.keys(expectedDeployment).sort().join(',') === 'backend,frontend,voice'
      && expectedDeployment.frontend === target.expectedDeployment.frontend && expectedDeployment.backend === target.expectedDeployment.backend && expectedDeployment.voice === target.expectedDeployment.voice
      && typeof payload.principal_record_present === 'boolean' && typeof payload.principal_record_provisioned === 'boolean'
      && typeof payload.voice_lab_enabled === 'boolean'
      && typeof payload.kill_switch_engaged === 'boolean' && typeof payload.provisioning_enabled === 'boolean'
      && (config.killSwitch || payload.voice_lab_enabled === true)
      && Number.isInteger(payload.provider_account_count) && Number(payload.provider_account_count) >= 0
      && Number.isInteger(payload.active_session_count) && Number(payload.active_session_count) >= 0;
    const provisioned = commonBound && payload.ready === true && payload.provisioned === true
      && payload.principal_record_present === true && payload.principal_record_provisioned === true
      && payload.provider_account_provisioned === true && payload.provider_account_count === 1 && payload.active_session_count === 0
      && payload.provisioning_enabled === false;
    const unprovisioned = commonBound && payload.ready === false && payload.provisioned === false
      && payload.provider_account_provisioned === false && payload.provider_account_count === 0 && payload.active_session_count === 0
      && payload.principal_record_present === false && payload.principal_record_provisioned === false
      && payload.kill_switch_engaged === true && payload.provisioning_enabled === true;
    const frontendKillSwitchEngaged = response.ok && (provisioned || unprovisioned)
      ? payload.kill_switch_engaged as boolean
      : null;
    const frontendVoiceLabEnabled = response.ok && (provisioned || unprovisioned)
      ? payload.voice_lab_enabled as boolean
      : null;
    const mutationGateOrderSafe = frontendKillSwitchEngaged !== null
      && (config.killSwitch || frontendKillSwitchEngaged === false);
    const status = response.ok && provisioned ? 'verified' : response.ok && unprovisioned ? 'provisioning_required' : 'unverified';
    return {
      ok: response.ok && provisioned,
      status,
      http_status: response.status,
      principal_hash: sha256(config.principalId),
      frontend_voice_lab_enabled: frontendVoiceLabEnabled,
      frontend_kill_switch_engaged: frontendKillSwitchEngaged,
      mcp_web_kill_switch_engaged: config.killSwitch,
      mutation_gate_order_safe: mutationGateOrderSafe,
    };
  } catch (error) {
    return {
      ok: false,
      status: "unavailable",
      reason: error instanceof Error ? error.name : "probe_failed",
      principal_hash: sha256(config.principalId),
      frontend_voice_lab_enabled: null,
      frontend_kill_switch_engaged: null,
      mcp_web_kill_switch_engaged: config.killSwitch,
      mutation_gate_order_safe: false,
    };
  }
}

export function listen(app: ReturnType<typeof createHttpApp>, port: number): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "0.0.0.0", () => resolve(server));
    server.once("error", reject);
  });
}
