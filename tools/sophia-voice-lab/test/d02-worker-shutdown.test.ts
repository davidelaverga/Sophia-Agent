import { createPrivateKey, randomUUID, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { D02BrowserContextBinding, D02ProductCleanupAcknowledgement, D02ProductCleanupRequest, VoiceBrowserDriver } from "../src/browser-driver.js";
import { D02GatewayClient } from "../src/d02-gateway.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, canonicalRequestHash, sha256, type AuthenticatedCaller } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";

const DEPLOYMENT_CONTROL_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDhkSCJg4Qta3ZaccGJIGUnCLA/WT8IuvVrBV11Vg0Ot";

class ShutdownDriver {
  live = false;
  readonly order: string[] = [];
  productCleanupError: Error | null = null;
  productCleanupMutator: ((ack: D02ProductCleanupAcknowledgement) => D02ProductCleanupAcknowledgement) | null = null;

  hasSession = () => this.live;
  start = async (run: ReturnType<typeof testRun>, _capability: string, binding?: D02BrowserContextBinding) => {
    this.live = true;
    this.order.push("context-open");
    return { observedDeployment: run.target.expectedDeployment, events: [], browserContextBinding: binding };
  };
  readiness = async () => ({ ok: true, detail: "test", engine: "chromium", version: "test" });
  continueSession = async () => { this.order.push("continue"); return []; };
  drain = async () => { this.order.push("drain"); return []; };
  quiesceD02Provider = async (_run: ReturnType<typeof testRun>, request: D02ProductCleanupRequest) => {
    this.order.push("product-cleanup-request");
    if (this.productCleanupError) throw this.productCleanupError;
    const acknowledgement: D02ProductCleanupAcknowledgement = {
      schema: "sophia_voice_lab_d02_product_provider_cleanup_acknowledgement_v1",
      voice_lab_run_id_sha256: request.browserContextBinding.voice_lab_run_id_sha256,
      browser_worker_id_sha256: request.browserContextBinding.browser_worker_id_sha256,
      browser_lease_epoch: request.browserContextBinding.browser_lease_epoch,
      browser_context_id_sha256: request.browserContextBinding.browser_context_id_sha256,
      provider_session_id_sha256: request.providerSessionIdSha256,
      frozen_provider_connection_epochs: [...request.frozenProviderConnectionEpochs],
      browser_provider_close_receipt_count: request.frozenProviderConnectionEpochs.length,
      browser_provider_activation_abort_receipt_count: 0,
      settlement_acknowledgement_sha256: canonicalRequestHash({ accepted_epochs: request.frozenProviderConnectionEpochs }),
      raw_provider_and_receipt_identifiers_excluded: true,
    };
    this.order.push("product-cleanup-ack");
    return this.productCleanupMutator?.(acknowledgement) ?? acknowledgement;
  };
  cancel = async () => { this.order.push("context-close"); this.live = false; };
  abort = async (run: ReturnType<typeof testRun>) => {
    this.order.push("generic-abort");
    this.live = false;
    return { events: [{ kind: "cleanup.browser_context_closed", source: "worker" as const, payload: { closed: true }, dedupeKey: `cleanup:${run.id}:generic-context` }], artifacts: [] };
  };
  recover = async (run: ReturnType<typeof testRun>) => {
    this.order.push("recover");
    return { events: [{ kind: "cleanup.recovery", source: "canonical" as const, payload: { complete: true, live_cleanup_complete: false }, dedupeKey: `recovery:${run.id}:worker-shutdown-test` }], artifacts: [] };
  };
  close = async () => { this.order.push("driver-close"); this.live = false; };
}

interface D02Harness {
  config: ReturnType<typeof testConfig>;
  ledger: MemoryVoiceLabLedger;
  audio: AudioResolver;
  driver: ShutdownDriver;
  worker: VoiceLabWorker;
  service: VoiceLabService;
  caller: AuthenticatedCaller;
  run: ReturnType<typeof testRun>;
  workerId: string;
  leaseEpoch: number;
  browserContextIdSha256: string;
}

async function readyHarness(workerId = "render-worker-before"): Promise<D02Harness> {
  const config = testConfig();
  const ledger = new MemoryVoiceLabLedger("test");
  const audio = new AudioResolver(config);
  await audio.initialize();
  const run = testRun({
    scenarioId: "V-D02",
    capturePolicy: { rawAudio: false, screenshot: false, video: false, retentionHours: 24 },
    expiresAt: new Date(Date.now() + 600_000),
  });
  await ledger.createRunWithOperation(run, {
    id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: `start-${run.id}`, requestHash: sha256(run.id), input: { environment: run.environment },
  }, { global: 1, caller: 1 });
  const driver = new ShutdownDriver();
  const worker = new VoiceLabWorker(workerId, ledger, config, audio, driver as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds));
  expect(await worker.runOnce()).toBe(true);
  const started = await ledger.getRun(run.id);
  const ready = await ledger.updateRun(run.id, started!.version, { providerSessionId: "provider-session-d02-worker-shutdown", providerEpoch: 7 });
  const lease = await ledger.getBrowserLease(run.id);
  const binding = (await ledger.listEvents(run.id, 0, 500)).events.find((event) => event.kind === "harness.browser_context_bound")!;
  const gateway = new D02GatewayClient(config, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ frozen: true, idempotent_replay: false, freeze_request_sha256: canonicalRequestHash(body) }), { status: 202 });
  });
  const service = new VoiceLabService(ledger, config, async () => [], undefined, undefined, gateway);
  const caller: AuthenticatedCaller = {
    subject: config.attestationAuthorities.deployment_control.subject,
    scopes: new Set(["voice_lab:attest", "voice_lab:attest:deployment_control"]),
    authorizationKind: "attestation",
  };
  return {
    config, ledger, audio, driver, worker, service, caller, run: ready, workerId,
    leaseEpoch: lease!.leaseEpoch,
    browserContextIdSha256: String(binding.payload.browser_context_id_sha256),
  };
}

function signEnvelope(unsigned: Record<string, unknown>): Record<string, unknown> {
  const key = createPrivateKey({ key: Buffer.from(DEPLOYMENT_CONTROL_PRIVATE_KEY, "base64"), format: "der", type: "pkcs8" });
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), key).toString("base64url") };
}

async function attachCommand(harness: D02Harness, overrides: Record<string, unknown> = {}) {
  const { config, run, workerId, leaseEpoch, browserContextIdSha256, ledger, service, caller } = harness;
  const authority = config.attestationAuthorities.deployment_control;
  const terminationRequestId = randomUUID();
  const actionRequestSha256 = sha256(`render-action:${terminationRequestId}`);
  const evidence = {
    kind: "d02_browser_worker_termination_command",
    authority: "deployment_control",
    termination_request_id: terminationRequestId,
    run_id_sha256: sha256(run.id),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    worker_service_id_sha256: sha256("srv-voice-lab-worker"),
    provider_session_id_sha256: sha256(run.providerSessionId!),
    provider_admission_id_sha256: sha256("provider-admission-d02-worker-shutdown"),
    provider_connection_epoch: run.providerEpoch!,
    frozen_provider_connection_epochs: [run.providerEpoch!],
    browser_worker_id_sha256: sha256(workerId),
    browser_lease_epoch: leaseEpoch,
    browser_context_id_sha256: browserContextIdSha256,
    before_worker_deploy_id_sha256: sha256("worker-deploy-before"),
    before_worker_instance_set_sha256: sha256("worker-instance-set-before"),
    before_worker_owner_instance_id_sha256: sha256(workerId),
    before_worker_owner_membership_count: 1,
    render_action_request_sha256: actionRequestSha256,
    requested_at: new Date().toISOString(),
    target_service: "sophia-voice-lab-worker",
    termination_mode: "render_service_restart_one_shot",
    worker_mutation_authorized: true,
    product_mutation_authorized: false,
    one_shot: true,
    ...overrides,
  };
  const attestationId = randomUUID();
  const unsigned = {
    schema: "sophia_voice_lab_external_attestation_v1",
    attestation_id: attestationId,
    run_id: run.id,
    test_run_id_sha256: sha256(run.testRunId),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    scenario_id: run.scenarioId,
    scenario_version: run.scenarioVersion,
    environment: run.environment,
    expected_deployment: run.target.expectedDeployment,
    issuer: authority.issuer,
    audience: "sophia-voice-lab-attestation",
    authority_key_id: authority.keyId,
    jti: attestationId,
    nonce: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    signature_algorithm: "ed25519-sha256-canonical-request-v1",
    evidence,
  };
  const signed = signEnvelope(unsigned);
  const attached = await service.attachExternalAttestation(caller, signed, { argumentHash: canonicalRequestHash(signed), requestIdHash: sha256(randomUUID()) });
  const events = (await ledger.listEvents(run.id, 0, 500)).events;
  const command = events.find((event) => event.kind === "external.attestation.d02_browser_worker_termination_command")!;
  const freeze = events.find((event) => event.kind === "product.d02_gateway_browser_worker_termination_frozen")!;
  return { terminationRequestId, actionRequestSha256, evidence, signed, attached, command, freeze };
}

async function claimDispatch(harness: D02Harness, command: Awaited<ReturnType<typeof attachCommand>>) {
  const requestedAt = new Date(command.command.at.getTime() + 1);
  return harness.service.claimD02RenderWorkerDispatch(harness.caller, {
    schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_request_v1",
    run_id: harness.run.id,
    termination_request_id: command.terminationRequestId,
    command_attestation_id: String(command.signed.attestation_id),
    command_content_sha256: String(command.attached.data.content_sha256),
    command_event_seq: Number(command.attached.data.event_seq),
    worker_service_id_sha256: command.evidence.worker_service_id_sha256,
    action_request_sha256: command.actionRequestSha256,
    dispatch_attempt_id: randomUUID(),
    requested_at: requestedAt.toISOString(),
  });
}

describe("V-D02 source-specific worker shutdown", () => {
  it("handles the real SIGTERM close path, closes context before CAS release, and lets a distinct replacement author loss", async () => {
    const harness = await readyHarness();
    const command = await attachCommand(harness);
    const dispatch = await claimDispatch(harness, command);
    const release = harness.ledger.releaseBrowserLease.bind(harness.ledger);
    vi.spyOn(harness.ledger, "releaseBrowserLease").mockImplementation(async (...args) => {
      harness.driver.order.push("lease-release");
      return release(...args);
    });

    harness.worker.stop(); // bin/worker.ts does this synchronously on SIGTERM.
    await harness.worker.close();

    const terminal = await harness.ledger.getRun(harness.run.id);
    const oldEvents = (await harness.ledger.listEvents(harness.run.id, 0, 500)).events;
    const shutdown = oldEvents.filter((event) => event.kind === "durability.browser_worker_shutdown_observed");
    expect(terminal).toMatchObject({ state: "aborted_driver_restart", terminalError: { code: "BROWSER_SESSION_LOST" }, cleanupComplete: false });
    expect(shutdown).toHaveLength(1);
    expect(shutdown[0]).toMatchObject({
      source: "worker",
      payload: {
        termination_request_id_sha256: sha256(command.terminationRequestId),
        lost_browser_worker_id_sha256: sha256(harness.workerId),
        lost_browser_lease_epoch: harness.leaseEpoch,
        browser_context_id_sha256: harness.browserContextIdSha256,
        render_dispatch_claim_sha256: dispatch.dispatch_claim_sha256,
        product_provider_cleanup_acknowledged: true,
        product_provider_cleanup_settlement_sha256: canonicalRequestHash({ accepted_epochs: [harness.run.providerEpoch] }),
        product_provider_close_receipt_count: 1,
        product_provider_activation_abort_receipt_count: 0,
        product_provider_cleanup_epoch_union_matches_freeze: true,
        browser_context_closed: true,
        source: "worker_graceful_d02_restart",
      },
    });
    expect(command.freeze.seq).toBeLessThan(command.command.seq);
    expect(command.command.seq).toBeLessThan(Number(shutdown[0]!.payload.render_dispatch_claim_event_seq));
    expect(Number(shutdown[0]!.payload.render_dispatch_claim_event_seq)).toBeLessThan(shutdown[0]!.seq);
    expect(harness.driver.order.indexOf("product-cleanup-ack")).toBeLessThan(harness.driver.order.indexOf("context-close"));
    expect(harness.driver.order.indexOf("context-close")).toBeLessThan(harness.driver.order.indexOf("lease-release"));
    expect(harness.driver.order).not.toContain("generic-abort");
    expect(await harness.ledger.getBrowserLease(harness.run.id)).toBeNull();
    expect(oldEvents.filter((event) => event.kind === "durability.browser_worker_loss_observed")).toHaveLength(0);
    await harness.worker.close();
    expect((await harness.ledger.listEvents(harness.run.id, 0, 500)).events.filter((event) => event.kind === "durability.browser_worker_shutdown_observed")).toHaveLength(1);

    const replacementDriver = new ShutdownDriver();
    const replacementId = "render-worker-after";
    const replacement = new VoiceLabWorker(replacementId, harness.ledger, harness.config, harness.audio, replacementDriver as unknown as VoiceBrowserDriver, new CapabilityCodec(harness.config.capabilitySecret, harness.config.capabilityIssuer, harness.config.capabilityTtlSeconds));
    await replacement.maintainSessions();
    await replacement.maintainSessions();
    const observation = await harness.service.getD02BrowserWorkerLossObservation(harness.caller, { run_id: harness.run.id, termination_request_id_sha256: sha256(command.terminationRequestId) });
    const observationReplay = await harness.service.getD02BrowserWorkerLossObservation(harness.caller, { run_id: harness.run.id, termination_request_id_sha256: sha256(command.terminationRequestId) });
    expect(observation).toMatchObject({
      lost_browser_worker_id_sha256: sha256(harness.workerId),
      replacement_browser_worker_id_sha256: sha256(replacementId),
      lost_browser_lease_epoch: harness.leaseEpoch,
      browser_lease_absent: true,
    });
    expect(observationReplay).toEqual(expect.objectContaining({ loss_event_seq: observation.loss_event_seq, loss_observed_at: observation.loss_observed_at }));
    const replacementEvents = (await harness.ledger.listEvents(harness.run.id, 0, 500)).events;
    expect(replacementEvents.filter((event) => event.kind === "durability.browser_worker_loss_observed")).toHaveLength(1);
    expect(replacementEvents.filter((event) => event.kind === "durability.browser_worker_replacement_observed")).toHaveLength(1);
  });

  it("pauses continuation in the command-to-global-dispatch gap and quiesces only after the dispatch claim commits", async () => {
    const harness = await readyHarness();
    const command = await attachCommand(harness);
    await harness.worker.maintainSessions();
    expect(harness.driver.order).not.toContain("continue");
    expect(harness.driver.order).not.toContain("context-close");
    expect(await harness.ledger.getRun(harness.run.id)).toMatchObject({ state: "ready", terminalError: null });
    expect(await harness.ledger.getBrowserLease(harness.run.id)).not.toBeNull();

    await claimDispatch(harness, command);
    await harness.worker.maintainSessions();
    expect(harness.driver.order).toContain("context-close");
    expect(await harness.ledger.getRun(harness.run.id)).toMatchObject({ state: "aborted_driver_restart", terminalError: { code: "BROWSER_SESSION_LOST" } });
  });

  it("pauses immediately on the exact local freeze intent before the Gateway freeze commits", async () => {
    const harness = await readyHarness();
    let releaseGateway!: () => void;
    const gatewayGate = new Promise<void>((resolve) => { releaseGateway = resolve; });
    const gateway = new D02GatewayClient(harness.config, async (_input, init) => {
      await gatewayGate;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ frozen: true, idempotent_replay: false, freeze_request_sha256: canonicalRequestHash(body) }), { status: 202 });
    });
    harness.service = new VoiceLabService(harness.ledger, harness.config, async () => [], undefined, undefined, gateway);
    const attaching = attachCommand(harness);
    await vi.waitFor(async () => {
      const events = (await harness.ledger.listEvents(harness.run.id, 0, 500)).events;
      expect(events.filter((event) => event.kind === "product.d02_browser_worker_termination_freeze_pending")).toHaveLength(1);
    });

    await harness.worker.maintainSessions();
    expect(harness.driver.order).not.toContain("continue");
    expect(harness.driver.order).not.toContain("product-cleanup-request");
    expect(harness.driver.order).not.toContain("context-close");
    expect(await harness.ledger.getBrowserLease(harness.run.id)).not.toBeNull();
    expect(await harness.ledger.getRun(harness.run.id)).toMatchObject({ state: "ready", terminalError: null });

    releaseGateway();
    const command = await attaching;
    await claimDispatch(harness, command);
    await harness.worker.maintainSessions();
    expect(harness.driver.order).toContain("product-cleanup-ack");
    expect(await harness.ledger.getRun(harness.run.id)).toMatchObject({ state: "aborted_driver_restart", terminalError: { code: "BROWSER_SESSION_LOST" } });
  });

  it("keeps the exact lease and page alive when SIGTERM intersects the local-intent gap, then quiesces after global dispatch", async () => {
    const harness = await readyHarness();
    let releaseGateway!: () => void;
    const gatewayGate = new Promise<void>((resolve) => { releaseGateway = resolve; });
    const gateway = new D02GatewayClient(harness.config, async (_input, init) => {
      await gatewayGate;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ frozen: true, idempotent_replay: false, freeze_request_sha256: canonicalRequestHash(body) }), { status: 202 });
    });
    harness.service = new VoiceLabService(harness.ledger, harness.config, async () => [], undefined, undefined, gateway);
    const attaching = attachCommand(harness);
    await vi.waitFor(async () => {
      const events = (await harness.ledger.listEvents(harness.run.id, 0, 500)).events;
      expect(events.filter((event) => event.kind === "product.d02_browser_worker_termination_freeze_pending")).toHaveLength(1);
    });

    harness.worker.stop();
    let closeSettled = false;
    const closing = harness.worker.close().finally(() => { closeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closeSettled).toBe(false);
    expect(harness.driver.order).not.toContain("generic-abort");
    expect(harness.driver.order).not.toContain("context-close");
    expect(await harness.ledger.getBrowserLease(harness.run.id)).toMatchObject({ workerId: harness.workerId, leaseEpoch: harness.leaseEpoch });

    releaseGateway();
    const command = await attaching;
    await claimDispatch(harness, command);
    await closing;

    expect(harness.driver.order).toContain("product-cleanup-ack");
    expect(harness.driver.order).not.toContain("generic-abort");
    expect(harness.driver.order).toContain("context-close");
    expect(await harness.ledger.getBrowserLease(harness.run.id)).toBeNull();
    expect(await harness.ledger.getRun(harness.run.id)).toMatchObject({ state: "aborted_driver_restart", terminalError: { code: "BROWSER_SESSION_LOST" } });
    const events = (await harness.ledger.listEvents(harness.run.id, 0, 500)).events;
    expect(events.filter((event) => event.kind === "durability.browser_worker_shutdown_observed")).toHaveLength(1);
  });

  it("fails an intent-only shutdown closed when its exact lease heartbeat is unavailable", async () => {
    const harness = await readyHarness();
    let releaseGateway!: () => void;
    const gatewayGate = new Promise<void>((resolve) => { releaseGateway = resolve; });
    const gateway = new D02GatewayClient(harness.config, async (_input, init) => {
      await gatewayGate;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ frozen: true, idempotent_replay: false, freeze_request_sha256: canonicalRequestHash(body) }), { status: 202 });
    });
    harness.service = new VoiceLabService(harness.ledger, harness.config, async () => [], undefined, undefined, gateway);
    const attaching = attachCommand(harness);
    await vi.waitFor(async () => {
      const events = (await harness.ledger.listEvents(harness.run.id, 0, 500)).events;
      expect(events.filter((event) => event.kind === "product.d02_browser_worker_termination_freeze_pending")).toHaveLength(1);
    });
    const heartbeat = vi.spyOn(harness.ledger, "heartbeatBrowserLease").mockRejectedValueOnce(new Error("ledger heartbeat unavailable"));

    await expect(harness.worker.close()).rejects.toThrow("ledger heartbeat unavailable");
    expect(harness.driver.order).not.toContain("generic-abort");
    expect(harness.driver.order).not.toContain("context-close");
    expect(await harness.ledger.getBrowserLease(harness.run.id)).toMatchObject({ workerId: harness.workerId, leaseEpoch: harness.leaseEpoch });
    expect(await harness.ledger.getRun(harness.run.id)).toMatchObject({ state: "ready", terminalError: null });

    heartbeat.mockRestore();
    releaseGateway();
    await attaching;
  });

  it("keeps generic shutdown behavior unchanged when no exact D02 dispatch is armed", async () => {
    const harness = await readyHarness();
    harness.worker.stop();
    await harness.worker.close();
    expect(await harness.ledger.getRun(harness.run.id)).toMatchObject({ state: "cancelled", terminalError: { code: "WORKER_GRACEFUL_SHUTDOWN" } });
    expect(harness.driver.order).toContain("generic-abort");
    const events = (await harness.ledger.listEvents(harness.run.id, 0, 500)).events;
    expect(events.some((event) => event.kind === "durability.browser_worker_shutdown_observed")).toBe(false);
  });

  it("ignores a stale command after ownership changes and never attributes it to the old worker shutdown source", async () => {
    const harness = await readyHarness();
    const command = await attachCommand(harness);
    await claimDispatch(harness, command);
    expect(await harness.ledger.releaseBrowserLease(harness.run.id, harness.workerId, harness.leaseEpoch)).toBe(true);
    await harness.ledger.upsertBrowserLease(harness.run.id, "foreign-current-owner", 60);
    harness.worker.stop();
    await harness.worker.close();
    const events = (await harness.ledger.listEvents(harness.run.id, 0, 500)).events;
    expect(events.some((event) => event.kind === "durability.browser_worker_shutdown_observed")).toBe(false);
    expect(harness.driver.order).toContain("generic-abort");
  });

  it("keeps the page and lease live across a lost cleanup response, then replays the exact control", async () => {
    const harness = await readyHarness();
    const command = await attachCommand(harness);
    await claimDispatch(harness, command);
    harness.driver.productCleanupError = new Error("canonical 202 response lost");
    harness.worker.stop();
    await expect(harness.worker.close()).rejects.toThrow("canonical 202 response lost");
    expect(harness.driver.live).toBe(true);
    expect(harness.driver.order).not.toContain("context-close");
    expect(harness.driver.order).not.toContain("driver-close");
    expect(await harness.ledger.getBrowserLease(harness.run.id)).not.toBeNull();
    expect(await harness.ledger.getRun(harness.run.id)).toMatchObject({ state: "ready", terminalError: null });
    expect((await harness.ledger.listEvents(harness.run.id, 0, 500)).events.some((event) => event.kind === "durability.browser_worker_shutdown_observed")).toBe(false);

    harness.driver.productCleanupError = null;
    await harness.worker.close();
    expect(harness.driver.order.filter((entry) => entry === "product-cleanup-request")).toHaveLength(2);
    expect(harness.driver.order).toContain("product-cleanup-ack");
    expect(await harness.ledger.getBrowserLease(harness.run.id)).toBeNull();
  });

  it("fails closed when the product cleanup acknowledgement epoch union drifts", async () => {
    const harness = await readyHarness();
    const command = await attachCommand(harness);
    await claimDispatch(harness, command);
    harness.driver.productCleanupMutator = (acknowledgement) => ({
      ...acknowledgement,
      frozen_provider_connection_epochs: [acknowledgement.frozen_provider_connection_epochs[0]! + 1],
    });
    harness.worker.stop();
    await expect(harness.worker.close()).rejects.toMatchObject({ detail: { code: "D02_WORKER_SHUTDOWN_ARM_INVALID" } });
    expect(harness.driver.live).toBe(true);
    expect(harness.driver.order).not.toContain("context-close");
    expect(harness.driver.order).not.toContain("driver-close");
    expect(await harness.ledger.getBrowserLease(harness.run.id)).not.toBeNull();
    expect((await harness.ledger.listEvents(harness.run.id, 0, 500)).events.some((event) => event.kind === "durability.browser_worker_shutdown_observed")).toBe(false);
  });

  it("fails closed on a drifted dispatch checksum without closing, releasing, or continuing the current context", async () => {
    const harness = await readyHarness();
    const command = await attachCommand(harness);
    const requestedAt = new Date(command.command.at.getTime() + 1);
    await harness.ledger.appendEvent(harness.run.id, "product.d02_render_worker_dispatch_claimed", "canonical", {
      schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_v1",
      termination_request_id_sha256: sha256(command.terminationRequestId),
      command_attestation_id_sha256: sha256(String(command.signed.attestation_id)),
      command_content_sha256: command.attached.data.content_sha256,
      command_event_seq: command.attached.data.event_seq,
      worker_service_id_sha256: command.evidence.worker_service_id_sha256,
      action_request_sha256: command.actionRequestSha256,
      dispatch_attempt_id_sha256: sha256(randomUUID()),
      requested_at: requestedAt.toISOString(),
      raw_action_and_attempt_identifiers_excluded: true,
      dispatch_claim_sha256: sha256("drifted-dispatch-checksum"),
    }, `d02-render-dispatch:${sha256(command.terminationRequestId)}`, requestedAt);
    await expect(harness.worker.maintainSessions()).rejects.toMatchObject({ detail: { code: "D02_WORKER_SHUTDOWN_ARM_INVALID" } });
    expect(harness.driver.order).not.toContain("continue");
    expect(harness.driver.order).not.toContain("context-close");
    expect(await harness.ledger.getBrowserLease(harness.run.id)).not.toBeNull();
  });
});
