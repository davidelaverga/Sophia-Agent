import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalRequestHash, sha256 } from "../src/security.js";
import {
  D02RenderWorkerTerminationInputSchema,
  D02WorkerTerminationControllerReceiptSchema,
  TransportTokensSchema,
} from "../scripts/external-attestations/contracts.js";
import { runCli } from "../scripts/external-attestations/cli.js";
import { initializeAuthorityFiles, verifyD02WorkerTerminationReceipt } from "../scripts/external-attestations/crypto.js";
import { executeD02RenderWorkerTermination } from "../scripts/external-attestations/render-worker-controller.js";
import { readSecureJson, writeNewSecureJson } from "../scripts/external-attestations/secure-files.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function authorityFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-lab-worker-controller-"));
  temporaryDirectories.push(directory);
  const paths = {
    publicConfig: path.join(directory, "public.json"),
    tokens: path.join(directory, "tokens.json"),
    external: path.join(directory, "external.pk8"),
    deployment: path.join(directory, "deployment.pk8"),
    platform: path.join(directory, "platform.pk8"),
  };
  const initialized = await initializeAuthorityFiles({
    publicConfigPath: paths.publicConfig,
    transportTokensPath: paths.tokens,
    privateKeyPaths: { external_mcp_client: paths.external, deployment_control: paths.deployment, platform_plugin: paths.platform },
    keyIds: { external_mcp_client: "external-client-worker-v1", deployment_control: "deployment-worker-control-v1", platform_plugin: "platform-worker-test-v1" },
  });
  return { paths, initialized };
}

async function cliFixture(controller: ReturnType<typeof controllerInput>) {
  const authority = await authorityFixture();
  const directory = path.dirname(authority.paths.publicConfig);
  const bundleDir = path.join(directory, "worker-bundle");
  const inputPath = path.join(directory, "worker-input.json");
  const renderTokenPath = path.join(directory, "render-token.json");
  await mkdir(bundleDir, { mode: 0o700 });
  await writeNewSecureJson(inputPath, controller);
  await writeNewSecureJson(renderTokenPath, { bearer_token: "render-worker-controller-bearer-000000000001" });
  const args = [
    "d02-render-worker-loss",
    "--input", inputPath,
    "--public-config", authority.paths.publicConfig,
    "--transport-tokens", authority.paths.tokens,
    "--deployment-key", authority.paths.deployment,
    "--render-token", renderTokenPath,
    "--bundle-dir", bundleDir,
  ] as const;
  return { authority, bundleDir, inputPath, args };
}

function controllerInput() {
  const serviceId = "srv-0123456789abcdefghij";
  return D02RenderWorkerTerminationInputSchema.parse({
    schema: "sophia_voice_lab_d02_render_worker_termination_input_v1",
    voice_lab_url: "http://voice-lab.test",
    render_api_origin: "https://api.render.com",
    render_worker_service_id: serviceId,
    run: {
      run_id: randomUUID(),
      test_run_id_sha256: HASH_A,
      cleanup_obligation_id_sha256: HASH_B,
      scenario_id: "V-D02",
      scenario_version: "vt00.scenarios.v1",
      environment: "production",
      expected_deployment: { frontend: SHA_A, backend: SHA_B, voice: SHA_C },
    },
    provider: { session_id_sha256: HASH_C, admission_id_sha256: HASH_D, connection_epoch: 7, frozen_connection_epochs: [5, 6, 7] },
    browser: { worker_id_sha256: sha256("worker-instance-before"), lease_epoch: 3, context_id_sha256: sha256("browser-context-before") },
    authorization: { service_id_sha256: sha256(serviceId), one_shot: true, worker_mutation_authorized: true, product_mutation_authorized: false, confirmation: "RESTART_EXACT_VOICE_LAB_BROWSER_WORKER_ONCE" },
    poll: { timeout_ms: 30_000, interval_ms: 1_000 },
  });
}

function deterministicNow(base: number) {
  let tick = 0;
  return () => new Date(base + ++tick * 1_000);
}

function fetchHarness(controller: ReturnType<typeof controllerInput>, options: {
  providerStatus?: number;
  serviceType?: string;
  serviceName?: string;
  beforeInstanceIds?: string[];
  lossDrift?: "admission";
  loseAttestationResponseOnce?: "command" | "final";
  pendingAttestationOnce?: "command" | "final";
  expiredCommandGatewayReplay?: boolean;
  loseRenderResponseOnce?: boolean;
  loseDispatchClaimResponseOnce?: boolean;
  dispatchClaimDrift?: "hash" | "sequence" | "timestamp";
} = {}) {
  const calls: Array<{ method: string; origin: string; pathname: string }> = [];
  const attestationCounts = new Map<string, number>();
  let accepted = false;
  let command: Record<string, unknown> | null = null;
  let dispatchClaimRequest: Record<string, unknown> | null = null;
  const base = Date.now();
  const at = (offset: number) => new Date(base + offset).toISOString();
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = new URL(rawUrl instanceof Request ? rawUrl.url : rawUrl.toString());
    const method = String(init?.method ?? (rawUrl instanceof Request ? rawUrl.method : "GET")).toUpperCase();
    calls.push({ method, origin: url.origin, pathname: url.pathname });
    if (url.origin === "http://voice-lab.test" && url.pathname === "/internal/voice-lab/attestations") {
      const claim = JSON.parse(String(init?.body)) as Record<string, any>;
      if (claim.evidence.kind === "d02_browser_worker_termination_command") command = claim.evidence;
      const count = (attestationCounts.get(claim.attestation_id) ?? 0) + 1;
      attestationCounts.set(claim.attestation_id, count);
      const target = claim.evidence.kind === "d02_browser_worker_termination_command" ? "command" : "final";
      if (options.pendingAttestationOnce === target && count === 1) return json({ error: { code: target === "command" ? "D02_GATEWAY_FREEZE_PENDING" : "D02_GATEWAY_SETTLEMENT_PENDING" } }, 409);
      if (options.loseAttestationResponseOnce === target && count === 1) throw new TypeError(`simulated ${target} attestation response loss after commit`);
      return json({
        contract_version: "sophia.voice-lab.v1", request_id: randomUUID(), run_id: claim.run_id, test_run_id: randomUUID(), status: "completed", event_cursor: 40,
        deployment_identity: { expected: claim.expected_deployment, observed: claim.expected_deployment },
        data: {
          attestation_id: claim.attestation_id,
          attestation_kind: claim.evidence.kind,
          content_sha256: sha256(`worker-attestation-${claim.evidence.kind}`),
          event_seq: claim.evidence.kind === "d02_browser_worker_termination_command" ? 10 : 30,
          immutable: true,
          ...(count >= 2 ? { replay: true } : {}),
          ...(target === "command" && count === 1 && options.expiredCommandGatewayReplay ? { gateway_freeze_idempotent_replay: true } : {}),
          proof_status: "pending_evaluator_cross_join",
        },
      });
    }
    if (url.origin === "http://voice-lab.test" && url.pathname === "/internal/voice-lab/d02/render-worker-dispatch-claims") {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (dispatchClaimRequest !== null && dispatchClaimRequest.dispatch_attempt_id !== request.dispatch_attempt_id) {
        return json({ error: { code: "D02_RENDER_DISPATCH_ALREADY_CLAIMED" } }, 409);
      }
      const replay = dispatchClaimRequest !== null;
      dispatchClaimRequest ??= request;
      if (options.loseDispatchClaimResponseOnce) {
        options.loseDispatchClaimResponseOnce = false;
        throw new TypeError("simulated global dispatch-claim response loss after commit");
      }
      const core = {
        schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_v1",
        termination_request_id_sha256: sha256(String(request.termination_request_id)),
        command_attestation_id_sha256: sha256(String(request.command_attestation_id)),
        command_content_sha256: String(request.command_content_sha256),
        command_event_seq: Number(request.command_event_seq),
        worker_service_id_sha256: String(request.worker_service_id_sha256),
        action_request_sha256: String(request.action_request_sha256),
        dispatch_attempt_id_sha256: sha256(String(request.dispatch_attempt_id)),
        requested_at: String(request.requested_at),
        raw_action_and_attempt_identifiers_excluded: true,
      };
      return json({
        schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_v1",
        claimed: true,
        idempotent_replay: replay,
        termination_request_id_sha256: core.termination_request_id_sha256,
        dispatch_attempt_id_sha256: core.dispatch_attempt_id_sha256,
        action_request_sha256: core.action_request_sha256,
        dispatch_claim_sha256: options.dispatchClaimDrift === "hash" ? HASH_A : canonicalRequestHash(core),
        event_seq: options.dispatchClaimDrift === "sequence" ? Number(request.command_event_seq) : Number(request.command_event_seq) + 1,
        claimed_at: options.dispatchClaimDrift === "timestamp" ? at(8_000) : String(request.requested_at),
      }, replay ? 200 : 201);
    }
    if (url.origin === "https://api.render.com") {
      if (method === "POST") {
        accepted = true;
        if (options.loseRenderResponseOnce) {
          options.loseRenderResponseOnce = false;
          throw new TypeError("simulated Render response loss after provider acceptance");
        }
        return json({ accepted: true, action: "restart" }, options.providerStatus ?? 200);
      }
      if (url.pathname.endsWith("/deploys")) return json([{ deploy: { id: "dep-0123456789abcdefghij", status: "live", createdAt: at(-3_600_000), startedAt: at(-3_600_000), updatedAt: accepted ? at(3_500) : at(-1_800_000), finishedAt: accepted ? at(3_500) : at(-1_800_000) } }]);
      if (url.pathname.endsWith("/instances")) {
        const instanceIds = accepted ? ["worker-instance-after"] : options.beforeInstanceIds ?? ["worker-instance-before"];
        return json(instanceIds.map((id) => ({ instance: { id, createdAt: accepted ? at(3_000) : at(-3_600_000) } })));
      }
      return json({ service: { id: controller.render_worker_service_id, type: options.serviceType ?? "background_worker", name: options.serviceName ?? "sophia-voice-lab-worker" } });
    }
    if (url.origin === "http://voice-lab.test" && url.pathname === "/internal/voice-lab/d02/browser-worker-loss-observation") {
      if (!command) throw new Error("Loss observation was requested before the durable command.");
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const core = {
        schema: "sophia_voice_lab_d02_browser_worker_loss_observation_v1",
        run_id_sha256: sha256(controller.run.run_id),
        test_run_id_sha256: controller.run.test_run_id_sha256,
        cleanup_obligation_id_sha256: controller.run.cleanup_obligation_id_sha256,
        termination_request_id_sha256: request.termination_request_id_sha256,
        provider_session_id_sha256: controller.provider.session_id_sha256,
        provider_admission_id_sha256: options.lossDrift === "admission" ? HASH_A : controller.provider.admission_id_sha256,
        provider_connection_epoch: controller.provider.connection_epoch,
        frozen_provider_connection_epochs: controller.provider.frozen_connection_epochs,
        product_provider_cleanup_settlement_sha256: sha256("provider-settlement"),
        browser_context_id_sha256: controller.browser.context_id_sha256,
        lost_browser_worker_id_sha256: controller.browser.worker_id_sha256,
        replacement_browser_worker_id_sha256: sha256("worker-instance-after"),
        lost_browser_lease_epoch: controller.browser.lease_epoch,
        loss_event_seq: 20,
        loss_observed_at: at(5_000),
        observed_at: at(6_000),
        terminal_state: "aborted_driver_restart",
        terminal_error_code: "BROWSER_SESSION_LOST",
        browser_lease_absent: true,
        owning_gateway_settlement_included: false,
      };
      return json({ ...core, proof_sha256: canonicalRequestHash(core) });
    }
    throw new Error(`Unexpected worker-controller request: ${method} ${url.toString()}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, attestationCounts };
}

describe("source-specific D02 Render browser-worker termination controller", () => {
  it("removes the generic caller-evidence signing path", async () => {
    const output: string[] = [];
    expect(await runCli(["help"], (line) => output.push(line))).toBe(0);
    const help = JSON.parse(output[0]!) as { usage: Record<string, string> };
    expect(help.usage.sign).toBeUndefined();
    expect(help.usage["d02-render-worker-loss"]).toMatch(/exactly one Render background-worker/i);
    const rejected: string[] = [];
    expect(await runCli(["sign"], (line) => rejected.push(line))).toBe(1);
    expect(JSON.parse(rejected[0]!).error).toMatch(/unknown command/i);
  });

  it("persists the command before one restart, proves disjoint replacement instances, and never self-certifies Gateway settlement", async () => {
    const authority = await authorityFixture();
    const controller = controllerInput();
    const harness = fetchHarness(controller);
    const tokens = TransportTokensSchema.parse(await readSecureJson(authority.paths.tokens));
    const phases: string[] = [];
    const result = await executeD02RenderWorkerTermination({
      controller,
      renderBearer: "render-worker-controller-bearer-000000000001",
      publicConfig: authority.initialized.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: authority.paths.deployment,
      fetchImpl: harness.fetchImpl,
      sleep: async () => undefined,
      now: deterministicNow(Date.now()),
      allowHttpForTest: true,
      checkpoint: async (checkpoint) => { phases.push(checkpoint.phase); },
    });
    const renderPosts = harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST");
    expect(renderPosts).toHaveLength(1);
    const mutationIndex = harness.calls.findIndex((call) => call.origin === "https://api.render.com" && call.method === "POST");
    expect(harness.calls.slice(0, mutationIndex).filter((call) => call.pathname === "/internal/voice-lab/attestations")).toHaveLength(2);
    expect(harness.calls.filter((call, index) => index > mutationIndex && call.origin === "https://api.render.com").every((call) => call.method === "GET")).toBe(true);
    expect(phases).toEqual([
      "preflight_prepared", "command_prepared", "command_attestation_response", "command_attestation_response", "command_attached",
      "render_worker_dispatch_intent", "render_worker_restart_accepted", "render_worker_replacement_settled",
      "final_prepared", "final_attestation_response", "final_attestation_response", "final_attached",
    ]);
    expect([...harness.attestationCounts.values()]).toEqual([2, 2]);
    expect(() => verifyD02WorkerTerminationReceipt(result.local_controller_receipt, authority.initialized.publicConfig)).not.toThrow();
    expect(D02WorkerTerminationControllerReceiptSchema.parse(result.local_controller_receipt).gateway).toEqual({ settlement_schema_status: "not_yet_included", settlement_receipt_included: false });
    const command = result.command_claim.evidence;
    const final = result.final_claim.evidence;
    expect(command.kind).toBe("d02_browser_worker_termination_command");
    expect(final.kind).toBe("d02_browser_worker_loss");
    if (command.kind !== "d02_browser_worker_termination_command" || final.kind !== "d02_browser_worker_loss") throw new Error("Unexpected worker controller claim kind.");
    expect(final.termination_request_id_sha256).toBe(sha256(command.termination_request_id));
    expect(command.before_worker_owner_instance_id_sha256).toBe(controller.browser.worker_id_sha256);
    expect(command.before_worker_owner_membership_count).toBe(1);
    expect(result.local_controller_receipt.render).toMatchObject({ before_worker_owner_instance_id_sha256: controller.browser.worker_id_sha256, before_worker_owner_membership_count: 1, lost_worker_present_before_restart: true, lost_worker_absent_after_restart: true });
    expect(final).toMatchObject({ lost_worker_owner_instance_id_sha256: controller.browser.worker_id_sha256, lost_worker_present_before_restart: true, lost_worker_absent_after_restart: true, render_dispatch_claim_sha256: result.local_controller_receipt.render.dispatch_claim_sha256 });
    expect(final.render_action_request_sha256).toBe(command.render_action_request_sha256);
    expect(final.after_deploy_id_sha256).toBe(final.before_deploy_id_sha256);
    expect(final.local_controller_receipt_sha256).toBe(result.local_controller_receipt_sha256);
    expect(final.gateway_settlement_receipt_included).toBe(false);
    expect(JSON.stringify(final)).not.toMatch(/provider_session_absent|browser_context_absent|builder_tasks_zero|all_operations_terminal/);
  });

  it("rejects a non-worker service before command attachment or provider mutation", async () => {
    const authority = await authorityFixture();
    const controller = controllerInput();
    const harness = fetchHarness(controller, { serviceType: "web_service" });
    const tokens = TransportTokensSchema.parse(await readSecureJson(authority.paths.tokens));
    await expect(executeD02RenderWorkerTermination({
      controller,
      renderBearer: "render-worker-controller-bearer-000000000001",
      publicConfig: authority.initialized.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: authority.paths.deployment,
      fetchImpl: harness.fetchImpl,
      allowHttpForTest: true,
      checkpoint: async () => undefined,
    })).rejects.toThrow(/background-worker/i);
    expect(harness.calls.some((call) => call.method === "POST")).toBe(false);

    const wrongName = fetchHarness(controller, { serviceName: "ordinary-background-worker" });
    await expect(executeD02RenderWorkerTermination({
      controller,
      renderBearer: "render-worker-controller-bearer-000000000001",
      publicConfig: authority.initialized.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: authority.paths.deployment,
      fetchImpl: wrongName.fetchImpl,
      allowHttpForTest: true,
      checkpoint: async () => undefined,
    })).rejects.toThrow(/Sophia Voice Lab background-worker/i);
    expect(wrongName.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects missing, duplicated, or multi-instance Render ownership before command attachment", async () => {
    const authority = await authorityFixture();
    const controller = controllerInput();
    const tokens = TransportTokensSchema.parse(await readSecureJson(authority.paths.tokens));
    for (const beforeInstanceIds of [
      ["foreign-worker-instance"],
      ["worker-instance-before", "worker-instance-before"],
      ["worker-instance-before", "second-worker-instance"],
    ]) {
      const harness = fetchHarness(controller, { beforeInstanceIds });
      await expect(executeD02RenderWorkerTermination({
        controller,
        renderBearer: "render-worker-controller-bearer-000000000001",
        publicConfig: authority.initialized.publicConfig,
        transportTokens: tokens,
        deploymentPrivateKeyPath: authority.paths.deployment,
        fetchImpl: harness.fetchImpl,
        allowHttpForTest: true,
        checkpoint: async () => undefined,
      })).rejects.toThrow(/singleton instance owned|instance set is empty or duplicated/i);
      expect(harness.calls.some((call) => call.method === "POST")).toBe(false);
    }
  });

  it("submits no second mutation after rejection or an accepted-action checkpoint failure", async () => {
    const authority = await authorityFixture();
    const tokens = TransportTokensSchema.parse(await readSecureJson(authority.paths.tokens));
    const rejectedController = controllerInput();
    const rejected = fetchHarness(rejectedController, { providerStatus: 503 });
    await expect(executeD02RenderWorkerTermination({
      controller: rejectedController,
      renderBearer: "render-worker-controller-bearer-000000000001",
      publicConfig: authority.initialized.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: authority.paths.deployment,
      fetchImpl: rejected.fetchImpl,
      now: deterministicNow(Date.now()),
      allowHttpForTest: true,
      checkpoint: async () => undefined,
    })).rejects.toThrow(/sole Render restart returned HTTP 503/i);
    expect(rejected.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
    expect(rejected.calls.some((call) => call.pathname === "/internal/voice-lab/d02/browser-worker-loss-observation")).toBe(false);

    const acceptedController = controllerInput();
    const accepted = fetchHarness(acceptedController);
    await expect(executeD02RenderWorkerTermination({
      controller: acceptedController,
      renderBearer: "render-worker-controller-bearer-000000000001",
      publicConfig: authority.initialized.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: authority.paths.deployment,
      fetchImpl: accepted.fetchImpl,
      now: deterministicNow(Date.now()),
      allowHttpForTest: true,
      checkpoint: async (checkpoint) => { if (checkpoint.phase === "render_worker_restart_accepted") throw new Error("accepted checkpoint storage failed"); },
    })).rejects.toThrow(/checkpoint storage failed/i);
    expect(accepted.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
    expect(accepted.calls.some((call) => call.pathname === "/internal/voice-lab/d02/browser-worker-loss-observation")).toBe(false);
  });

  it("refuses to sign or attach the final claim when the Voice Lab observation drifts one provider admission", async () => {
    const authority = await authorityFixture();
    const controller = controllerInput();
    const harness = fetchHarness(controller, { lossDrift: "admission" });
    const tokens = TransportTokensSchema.parse(await readSecureJson(authority.paths.tokens));
    await expect(executeD02RenderWorkerTermination({
      controller,
      renderBearer: "render-worker-controller-bearer-000000000001",
      publicConfig: authority.initialized.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: authority.paths.deployment,
      fetchImpl: harness.fetchImpl,
      sleep: async () => undefined,
      now: deterministicNow(Date.now()),
      allowHttpForTest: true,
      checkpoint: async () => undefined,
    })).rejects.toThrow(/did not bind the exact governed run\/provider\/admission\/browser\/lease\/epoch command/i);
    expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
    expect(harness.attestationCounts.size).toBe(1);
    expect([...harness.attestationCounts.values()]).toEqual([2]);
  });

  it("resumes an exact persisted command after its first attach response is lost across two CLI invocations", async () => {
    const controller = controllerInput();
    const fixture = await cliFixture(controller);
    const harness = fetchHarness(controller, { loseAttestationResponseOnce: "command" });
    const now = deterministicNow(Date.now());
    const firstOutput: string[] = [];
    expect(await runCli(fixture.args, (line) => firstOutput.push(line), {
      workerTermination: {
        fetchImpl: harness.fetchImpl,
        sleep: async () => { throw new Error("simulated process exit after ambiguous command response"); },
        now,
        allowHttpForTest: true,
      },
    })).toBe(1);
    expect(JSON.parse(firstOutput.at(-1)!).error).toMatch(/simulated process exit/i);
    const commandPath = path.join(fixture.bundleDir, "02-worker-command-claim.json");
    const commandBytesBeforeResume = await readFile(commandPath);
    const commandEntry = JSON.parse(commandBytesBeforeResume.toString("utf8")) as { payload: { claim: { attestation_id: string; evidence: { termination_request_id: string } } } };

    const secondOutput: string[] = [];
    expect(await runCli([...fixture.args, "--resume", "true"], (line) => secondOutput.push(line), {
      workerTermination: { fetchImpl: harness.fetchImpl, sleep: async () => undefined, now, allowHttpForTest: true },
    })).toBe(0);
    expect(await readFile(commandPath)).toEqual(commandBytesBeforeResume);
    const completed = JSON.parse(secondOutput.at(-1)!) as Record<string, unknown>;
    expect(completed).toMatchObject({ ok: true, resumed: true, gateway_settlement_status: "product_authenticated_settlement_committed", certification_status: "pending_evaluator_cross_join" });
    expect(commandEntry.payload.claim.attestation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(commandEntry.payload.claim.evidence.termination_request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
    expect([...harness.attestationCounts.values()].sort((left, right) => left - right)).toEqual([2, 3]);
    const terminalResumeNetwork = vi.fn<typeof fetch>(async () => { throw new Error("completed resume must not use network"); });
    expect(await runCli([...fixture.args, "--resume", "true"], () => undefined, {
      workerTermination: { fetchImpl: terminalResumeNetwork, allowHttpForTest: true },
    })).toBe(0);
    expect(terminalResumeNetwork).not.toHaveBeenCalled();
  });

  it("resumes the exact final claim after response loss without revisiting Render", async () => {
    const controller = controllerInput();
    const fixture = await cliFixture(controller);
    const harness = fetchHarness(controller, { loseAttestationResponseOnce: "final" });
    const now = deterministicNow(Date.now());
    expect(await runCli(fixture.args, () => undefined, {
      workerTermination: {
        fetchImpl: harness.fetchImpl,
        sleep: async () => { throw new Error("simulated process exit after ambiguous final response"); },
        now,
        allowHttpForTest: true,
      },
    })).toBe(1);
    const finalClaimPath = path.join(fixture.bundleDir, "09-worker-loss-claim.json");
    const finalClaimBytes = await readFile(finalClaimPath);
    expect(await runCli([...fixture.args, "--resume", "true"], () => undefined, {
      workerTermination: { fetchImpl: harness.fetchImpl, sleep: async () => undefined, now, allowHttpForTest: true },
    })).toBe(0);
    expect(await readFile(finalClaimPath)).toEqual(finalClaimBytes);
    expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
    expect([...harness.attestationCounts.values()].sort((left, right) => left - right)).toEqual([2, 3]);
  });

  it("classifies explicit Gateway pending responses and retries only the exact persisted signed claim", async () => {
    for (const target of ["command", "final"] as const) {
      const authority = await authorityFixture();
      const controller = controllerInput();
      const harness = fetchHarness(controller, { pendingAttestationOnce: target });
      const tokens = TransportTokensSchema.parse(await readSecureJson(authority.paths.tokens));
      const checkpoints: unknown[] = [];
      const result = await executeD02RenderWorkerTermination({
        controller,
        renderBearer: "render-worker-controller-bearer-000000000001",
        publicConfig: authority.initialized.publicConfig,
        transportTokens: tokens,
        deploymentPrivateKeyPath: authority.paths.deployment,
        fetchImpl: harness.fetchImpl,
        sleep: async () => undefined,
        now: deterministicNow(Date.now()),
        allowHttpForTest: true,
        checkpoint: async (checkpoint) => { checkpoints.push(checkpoint); },
      });
      expect(result.command_claim.attestation_id).toBe((checkpoints.find((value: any) => value.phase === "command_prepared") as any).claim.attestation_id);
      expect(result.final_claim.attestation_id).toBe((checkpoints.find((value: any) => value.phase === "final_prepared") as any).claim.attestation_id);
      expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
      expect([...harness.attestationCounts.values()].sort((left, right) => left - right)).toEqual([2, 3]);
    }
  });

  it("accepts an expired first command insertion only with exact Gateway-freeze replay evidence", async () => {
    vi.useFakeTimers();
    try {
      for (const gatewayReplay of [false, true]) {
        const issuedAt = new Date(`2026-08-24T0${gatewayReplay ? 2 : 1}:00:00.000Z`);
        vi.setSystemTime(issuedAt);
        const controller = controllerInput();
        const fixture = await cliFixture(controller);
        const harness = fetchHarness(controller, { expiredCommandGatewayReplay: gatewayReplay });
        expect(await runCli(fixture.args, () => undefined, {
          workerTermination: {
            fetchImpl: harness.fetchImpl,
            allowHttpForTest: true,
            afterCheckpoint: async (checkpoint) => { if (checkpoint.phase === "command_prepared") throw new Error("stop before first command attach"); },
          },
        })).toBe(1);
        vi.setSystemTime(new Date(issuedAt.getTime() + 301_000));
        const output: string[] = [];
        expect(await runCli([...fixture.args, "--resume", "true"], (line) => output.push(line), {
          workerTermination: {
            fetchImpl: harness.fetchImpl,
            allowHttpForTest: true,
            afterCheckpoint: async (checkpoint) => { if (checkpoint.phase === "command_attached") throw new Error("stop after recovered command"); },
          },
        })).toBe(1);
        if (gatewayReplay) {
          expect(JSON.parse(output.at(-1)!).error).toMatch(/stop after recovered command/i);
          expect([...harness.attestationCounts.values()]).toEqual([2]);
        } else {
          expect(JSON.parse(output.at(-1)!).error).toMatch(/did not prove an exact attestation replay or an already-committed Gateway freeze replay/i);
          expect([...harness.attestationCounts.values()]).toEqual([1]);
        }
        expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reissues Render POST after an ambiguous accepted response and uses GET-only resume reconciliation", async () => {
    const controller = controllerInput();
    const fixture = await cliFixture(controller);
    const harness = fetchHarness(controller, { loseRenderResponseOnce: true });
    const now = deterministicNow(Date.now());
    expect(await runCli(fixture.args, () => undefined, {
      workerTermination: { fetchImpl: harness.fetchImpl, sleep: async () => undefined, now, allowHttpForTest: true },
    })).toBe(1);
    const resumeOutput: string[] = [];
    expect(await runCli([...fixture.args, "--resume", "true"], (line) => resumeOutput.push(line), {
      workerTermination: { fetchImpl: harness.fetchImpl, sleep: async () => undefined, now, allowHttpForTest: true },
    })).toBe(1);
    expect(JSON.parse(resumeOutput.at(-1)!).error).toMatch(/manual_required|never issue a second Render POST/i);
    expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
    const resumeRenderCalls = harness.calls.filter((call) => call.origin === "https://api.render.com");
    expect(resumeRenderCalls.slice(resumeRenderCalls.findIndex((call) => call.method === "POST") + 1).every((call) => call.method === "GET")).toBe(true);
  });

  it("globally consumes one dispatch across copied pre-dispatch journals", async () => {
    const controller = controllerInput();
    const fixture = await cliFixture(controller);
    const harness = fetchHarness(controller);
    expect(await runCli(fixture.args, () => undefined, {
      workerTermination: {
        fetchImpl: harness.fetchImpl,
        allowHttpForTest: true,
        afterCheckpoint: async (checkpoint) => { if (checkpoint.phase === "command_attached") throw new Error("copy the authenticated pre-dispatch prefix"); },
      },
    })).toBe(1);
    const copiedBundle = `${fixture.bundleDir}-copy`;
    temporaryDirectories.push(copiedBundle);
    await cp(fixture.bundleDir, copiedBundle, { recursive: true });
    const copiedArgs = fixture.args.map((value, index, values) => values[index - 1] === "--bundle-dir" ? copiedBundle : value);

    expect(await runCli([...fixture.args, "--resume", "true"], () => undefined, {
      workerTermination: { fetchImpl: harness.fetchImpl, sleep: async () => undefined, allowHttpForTest: true },
    })).toBe(0);
    const rejected: string[] = [];
    expect(await runCli([...copiedArgs, "--resume", "true"], (line) => rejected.push(line), {
      workerTermination: { fetchImpl: harness.fetchImpl, sleep: async () => undefined, allowHttpForTest: true },
    })).toBe(1);
    expect(JSON.parse(rejected.at(-1)!).error).toMatch(/global one-shot Render dispatch claim|already claimed/i);
    expect(harness.calls.filter((call) => call.pathname === "/internal/voice-lab/d02/render-worker-dispatch-claims")).toHaveLength(2);
    expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
  });

  it("never mutates after an ambiguous committed global dispatch claim", async () => {
    const controller = controllerInput();
    const fixture = await cliFixture(controller);
    const harness = fetchHarness(controller, { loseDispatchClaimResponseOnce: true });
    const first: string[] = [];
    expect(await runCli(fixture.args, (line) => first.push(line), {
      workerTermination: { fetchImpl: harness.fetchImpl, sleep: async () => undefined, allowHttpForTest: true },
    })).toBe(1);
    expect(JSON.parse(first.at(-1)!).error).toMatch(/global one-shot Render dispatch claim was rejected or ambiguous/i);
    const resumed: string[] = [];
    expect(await runCli([...fixture.args, "--resume", "true"], (line) => resumed.push(line), {
      workerTermination: { fetchImpl: harness.fetchImpl, sleep: async () => undefined, allowHttpForTest: true },
    })).toBe(1);
    expect(JSON.parse(resumed.at(-1)!).error).toMatch(/manual_required|never issue a second Render POST/i);
    expect(harness.calls.filter((call) => call.pathname === "/internal/voice-lab/d02/render-worker-dispatch-claims")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(0);
  });

  it("rejects a malformed global dispatch claim hash, ordering, or timestamp before Render mutation", async () => {
    for (const dispatchClaimDrift of ["hash", "sequence", "timestamp"] as const) {
      const authority = await authorityFixture();
      const controller = controllerInput();
      const harness = fetchHarness(controller, { dispatchClaimDrift });
      const tokens = TransportTokensSchema.parse(await readSecureJson(authority.paths.tokens));
      await expect(executeD02RenderWorkerTermination({
        controller,
        renderBearer: "render-worker-controller-bearer-000000000001",
        publicConfig: authority.initialized.publicConfig,
        transportTokens: tokens,
        deploymentPrivateKeyPath: authority.paths.deployment,
        fetchImpl: harness.fetchImpl,
        sleep: async () => undefined,
        now: deterministicNow(Date.now()),
        allowHttpForTest: true,
        checkpoint: async () => undefined,
      })).rejects.toThrow(/global one-shot Render dispatch claim was rejected|manual_required/i);
      expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(0);
    }
  });

  it("rejects tampered, gapped, and input-changed resume journals before network activity", async () => {
    const cases = ["tampered", "gapped", "input-changed"] as const;
    for (const fault of cases) {
      const controller = controllerInput();
      const fixture = await cliFixture(controller);
      const harness = fetchHarness(controller);
      expect(await runCli(fixture.args, () => undefined, {
        workerTermination: {
          fetchImpl: harness.fetchImpl,
          allowHttpForTest: true,
          afterCheckpoint: async (checkpoint) => { if (checkpoint.phase === "command_prepared") throw new Error("stop after durable command"); },
        },
      })).toBe(1);
      if (fault === "tampered") {
        const target = path.join(fixture.bundleDir, "02-worker-command-claim.json");
        const entry = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
        entry.payload.claim.attestation_id = randomUUID();
        const core = {
          schema: entry.schema,
          index: entry.index,
          phase: entry.phase,
          controller_input_sha256: entry.controller_input_sha256,
          previous_entry_sha256: entry.previous_entry_sha256,
          payload: entry.payload,
        };
        // Recomputing the public hash is insufficient: the deployment-key HMAC
        // must still reject the modified phase before any controller network.
        entry.entry_sha256 = canonicalRequestHash(core);
        await writeFile(target, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
      } else if (fault === "gapped") {
        await unlink(path.join(fixture.bundleDir, "01-render-worker-preflight.json"));
      } else {
        const changed = { ...controller, browser: { ...controller.browser, context_id_sha256: HASH_A } };
        await writeFile(fixture.inputPath, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
      }
      const network = vi.fn<typeof fetch>(async () => { throw new Error("network must not be reached"); });
      const output: string[] = [];
      expect(await runCli([...fixture.args, "--resume", "true"], (line) => output.push(line), {
        workerTermination: { fetchImpl: network, allowHttpForTest: true },
      })).toBe(1);
      expect(network).not.toHaveBeenCalled();
      expect(JSON.parse(output.at(-1)!).error).toMatch(/tampered|gapped|different controller input/i);
    }
  });

  it("holds an exclusive bundle lock so a concurrent resume fails before network", async () => {
    const controller = controllerInput();
    const fixture = await cliFixture(controller);
    const harness = fetchHarness(controller);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let blocked = false;
    const firstFetch = vi.fn<typeof fetch>(async (rawUrl, init) => {
      const url = new URL(rawUrl instanceof Request ? rawUrl.url : rawUrl.toString());
      if (!blocked && url.origin === "https://api.render.com" && String(init?.method ?? "GET") === "GET") {
        blocked = true;
        await gate;
      }
      return harness.fetchImpl(rawUrl, init);
    });
    const first = runCli(fixture.args, () => undefined, {
      workerTermination: { fetchImpl: firstFetch, sleep: async () => undefined, now: deterministicNow(Date.now()), allowHttpForTest: true },
    });
    while (!blocked) await new Promise<void>((resolve) => setImmediate(resolve));
    const secondNetwork = vi.fn<typeof fetch>(async () => { throw new Error("concurrent network must not be reached"); });
    const secondOutput: string[] = [];
    expect(await runCli([...fixture.args, "--resume", "true"], (line) => secondOutput.push(line), {
      workerTermination: { fetchImpl: secondNetwork, allowHttpForTest: true },
    })).toBe(1);
    expect(secondNetwork).not.toHaveBeenCalled();
    expect(JSON.parse(secondOutput.at(-1)!).error).toMatch(/already locked/i);
    releaseGate();
    expect(await first).toBe(0);
  });

  it("requires an exact sorted frozen epoch set and every provider/admission/context binding", () => {
    const valid = controllerInput();
    expect(D02RenderWorkerTerminationInputSchema.safeParse({ ...valid, provider: { ...valid.provider, frozen_connection_epochs: [7, 6, 7] } }).success).toBe(false);
    expect(D02RenderWorkerTerminationInputSchema.safeParse({ ...valid, provider: { ...valid.provider, frozen_connection_epochs: [5, 6] } }).success).toBe(false);
    expect(D02RenderWorkerTerminationInputSchema.safeParse({ ...valid, provider: { ...valid.provider, connection_epoch: 0, frozen_connection_epochs: [0] } }).success).toBe(false);
    expect(D02RenderWorkerTerminationInputSchema.safeParse({ ...valid, browser: { worker_id_sha256: valid.browser.worker_id_sha256, lease_epoch: valid.browser.lease_epoch } }).success).toBe(false);
    expect(D02RenderWorkerTerminationInputSchema.safeParse({ ...valid, provider: { session_id_sha256: valid.provider.session_id_sha256, connection_epoch: valid.provider.connection_epoch, frozen_connection_epochs: valid.provider.frozen_connection_epochs } }).success).toBe(false);
  });
});
