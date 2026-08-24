import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalRequestHash, sha256 } from "../src/security.js";
import {
  A03ControllerInputSchema,
  D02RenderControllerInputSchema,
  P01CollectorInputSchema,
  PublicAuthorityConfigSchema,
  TransportTokensSchema,
  type PublicAuthorityConfig,
} from "../scripts/external-attestations/contracts.js";
import { initializeAuthorityFiles, newUnsignedClaim, signExternalClaim, verifyExternalClaimSignature } from "../scripts/external-attestations/crypto.js";
import { executeA03LostResponse, postAttestationAndVerifyReplay } from "../scripts/external-attestations/http.js";
import { verifyManifestRevision } from "../scripts/external-attestations/manifest.js";
import { redactControllerValue, safeError } from "../scripts/external-attestations/redaction.js";
import { executeD02RenderRestart } from "../scripts/external-attestations/render-controller.js";
import { readSecureJson, writeNewSecureJson } from "../scripts/external-attestations/secure-files.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function initialized() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-lab-attestation-controller-"));
  temporaryDirectories.push(directory);
  const paths = {
    publicConfig: path.join(directory, "public.json"),
    tokens: path.join(directory, "tokens.json"),
    external: path.join(directory, "external.pk8"),
    deployment: path.join(directory, "deployment.pk8"),
    platform: path.join(directory, "platform.pk8"),
  };
  const output = await initializeAuthorityFiles({
    publicConfigPath: paths.publicConfig,
    transportTokensPath: paths.tokens,
    privateKeyPaths: { external_mcp_client: paths.external, deployment_control: paths.deployment, platform_plugin: paths.platform },
    keyIds: { external_mcp_client: "external-client-test-v1", deployment_control: "deployment-control-test-v1", platform_plugin: "platform-plugin-test-v1" },
  });
  return { directory, paths, output };
}

function runBinding(scenario: "V-A03" | "V-D02" | "V-P01", runId = randomUUID()) {
  return {
    run_id: runId,
    test_run_id_sha256: HASH_A,
    cleanup_obligation_id_sha256: HASH_B,
    scenario_id: scenario,
    scenario_version: "vt00.scenarios.v1" as const,
    environment: "production" as const,
    expected_deployment: { frontend: SHA_A, backend: SHA_B, voice: SHA_C },
  };
}

function a03Evidence(operationId = randomUUID(), base = new Date()) {
  return {
    kind: "a03_http_response_loss" as const,
    authority: "external_mcp_client" as const,
    operation_id: operationId,
    replayed_operation_id: operationId,
    request_sha256: HASH_A,
    idempotency_key_sha256: HASH_B,
    initial_client_request_id_sha256: HASH_A,
    retry_client_request_id_sha256: HASH_B,
    retry_response_sha256: HASH_C,
    accepted_at: new Date(base.getTime() - 4_000).toISOString(),
    response_lost_at: new Date(base.getTime() - 3_000).toISOString(),
    retry_at: new Date(base.getTime() - 2_000).toISOString(),
    transport_outcome: "connection_closed_after_durable_acceptance" as const,
    initial_response_observed: false as const,
  };
}

function d02ControllerInput() {
  const run = runBinding("V-D02");
  const serviceId = "srv-0123456789abcdefghij";
  const replay = { run_id: run.run_id, text: "restart safe", idempotency_key: "d02-replay-key" };
  return D02RenderControllerInputSchema.parse({
    schema: "sophia_voice_lab_d02_render_controller_input_v1",
    voice_lab_url: "http://voice-lab.test",
    render_api_origin: "https://api.render.com",
    render_service_id: serviceId,
    run,
    operation: { operation_id: randomUUID(), operation_type: "speak", public_argument_sha256: canonicalRequestHash(replay), request_sha256: HASH_B, idempotency_key_sha256: sha256(replay.idempotency_key), durable_receipt_sha256: HASH_C, replay_arguments: replay },
    browser: { worker_id_sha256: HASH_A, lease_epoch: 3 },
    product: { canonical_session_id_sha256: sha256("canonical-session"), thread_id_sha256: sha256("thread"), provider_session_id_sha256: sha256("provider-session"), provider_connection_epoch: 7 },
    authorization: { service_id_sha256: sha256(serviceId), one_shot: true, provider_mutation_authorized: true, confirmation: "RESTART_EXACT_VOICE_LAB_MCP_SERVICE_ONCE" },
    poll: { timeout_ms: 30_000, interval_ms: 1_000 },
  });
}

function deterministicNow() {
  let tick = 0;
  const base = Date.now();
  return () => new Date(base + ++tick * 1_000);
}

function d02FetchHarness(controller: ReturnType<typeof d02ControllerInput>, options: { providerStatus?: number; continuityPendingCount?: number } = {}) {
  const calls: Array<{ method: string; origin: string; pathname: string; search: string }> = [];
  const attestationInvocations = new Map<string, number>();
  let providerAccepted = false;
  let continuityPending = options.continuityPendingCount ?? 0;
  const base = Date.now();
  const at = (milliseconds: number) => new Date(base + milliseconds).toISOString();
  const beforeVersion = { service: "sophia-voice-lab-mcp", commit_sha: controller.run.expected_deployment.backend, boot_id_sha256: sha256("before-boot"), instance_id_sha256: sha256("before-instance"), version_response_sha256: "" };
  beforeVersion.version_response_sha256 = canonicalRequestHash({ service: beforeVersion.service, commit_sha: beforeVersion.commit_sha, boot_id_sha256: beforeVersion.boot_id_sha256, instance_id_sha256: beforeVersion.instance_id_sha256 });
  const afterVersion = { service: "sophia-voice-lab-mcp", commit_sha: controller.run.expected_deployment.backend, boot_id_sha256: sha256("after-boot"), instance_id_sha256: sha256("after-instance"), version_response_sha256: "" };
  afterVersion.version_response_sha256 = canonicalRequestHash({ service: afterVersion.service, commit_sha: afterVersion.commit_sha, boot_id_sha256: afterVersion.boot_id_sha256, instance_id_sha256: afterVersion.instance_id_sha256 });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = new URL(rawUrl instanceof Request ? rawUrl.url : rawUrl.toString());
    const method = String(init?.method ?? (rawUrl instanceof Request ? rawUrl.method : "GET")).toUpperCase();
    calls.push({ method, origin: url.origin, pathname: url.pathname, search: url.search });
    if (url.origin === "http://voice-lab.test" && url.pathname === "/version") return json(providerAccepted ? afterVersion : beforeVersion);
    if (url.origin === "http://voice-lab.test" && url.pathname === "/internal/voice-lab/attestations") {
      const claim = JSON.parse(String(init?.body)) as Record<string, any>;
      const count = (attestationInvocations.get(claim.attestation_id) ?? 0) + 1;
      attestationInvocations.set(claim.attestation_id, count);
      return json({
        contract_version: "sophia.voice-lab.v1", request_id: randomUUID(), run_id: claim.run_id, test_run_id: randomUUID(), status: "completed", event_cursor: 50,
        deployment_identity: { expected: claim.expected_deployment, observed: claim.expected_deployment },
        data: { attestation_id: claim.attestation_id, attestation_kind: claim.evidence.kind, content_sha256: sha256(`attestation-${claim.evidence.kind}`), event_seq: claim.evidence.kind === "d02_restart_command" ? 30 : 45, immutable: true, ...(count === 2 ? { replay: true } : {}), proof_status: "pending_evaluator_cross_join" },
      });
    }
    if (url.origin === "https://api.render.com") {
      if (method === "POST") {
        providerAccepted = true;
        return json({ accepted: true }, options.providerStatus ?? 200);
      }
      const after = providerAccepted;
      if (url.pathname.endsWith("/deploys")) return json([{ deploy: { id: after ? "dep-abcdefghij0123456789" : "dep-0123456789abcdefghij", status: "live", createdAt: after ? at(2_000) : at(-3_600_000), startedAt: after ? at(2_500) : at(-3_600_000), updatedAt: after ? at(3_500) : at(-1_800_000), finishedAt: after ? at(3_500) : at(-1_800_000) } }]);
      if (url.pathname.endsWith("/instances")) return json([{ instance: { id: after ? "instance-after" : "instance-before", createdAt: after ? at(3_200) : at(-3_600_000) } }]);
      return json({ service: { id: controller.render_service_id } });
    }
    if (url.origin === "http://voice-lab.test" && url.pathname === "/mcp") {
      const envelope = { contract_version: "sophia.voice-lab.v1", request_id: randomUUID(), run_id: controller.run.run_id, test_run_id: randomUUID(), operation_id: controller.operation.operation_id, status: "completed", observed_at: at(4_000), data: { operation_state: "succeeded", replay: true } };
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "replay", result: { structuredContent: envelope } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.origin === "http://voice-lab.test" && url.pathname === "/internal/voice-lab/d02/browser-continuity") {
      if (continuityPending-- > 0) return json({ error: { code: "D02_CONTINUITY_PENDING" } }, 409);
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const core = {
        schema: "sophia_voice_lab_d02_browser_continuity_v1", run_id_sha256: sha256(controller.run.run_id), restart_request_id_sha256: String(request.restart_request_id_sha256), operation_id_sha256: sha256(controller.operation.operation_id), after_boot_id_sha256: afterVersion.boot_id_sha256,
        browser_worker_id_sha256: controller.browser.worker_id_sha256, browser_lease_epoch: controller.browser.lease_epoch, browser_lease_updated_at: at(4_500), browser_lease_expires_at: at(64_500),
        replay_event_seq: 40, replay_observed_at: at(4_000), observed_at: at(5_000), runtime_acquisition_count: 1, loss_or_replacement_count: 0, continuity_proven: true,
      };
      return json({ ...core, proof_sha256: canonicalRequestHash(core) });
    }
    throw new Error(`Unexpected D02 controller request ${method} ${url.toString()}`);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, attestationInvocations };
}

describe("offline external-attestation controllers", () => {
  it("generates three distinct mode-0600 authority keys/tokens and never overwrites", async () => {
    const fixture = await initialized();
    const publicConfig = PublicAuthorityConfigSchema.parse(JSON.parse(await readFile(fixture.paths.publicConfig, "utf8")));
    const tokens = TransportTokensSchema.parse(await readSecureJson(fixture.paths.tokens));
    expect(new Set(Object.values(fixture.output.publicKeyFingerprints)).size).toBe(3);
    expect(new Set(Object.values(tokens)).size).toBe(3);
    for (const target of Object.values(fixture.paths)) expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(publicConfig)).not.toContain(Object.values(tokens)[0]!);
    await expect(initializeAuthorityFiles({
      publicConfigPath: fixture.paths.publicConfig,
      transportTokensPath: fixture.paths.tokens,
      privateKeyPaths: { external_mcp_client: fixture.paths.external, deployment_control: fixture.paths.deployment, platform_plugin: fixture.paths.platform },
      keyIds: { external_mcp_client: "external-client-test-v2", deployment_control: "deployment-control-test-v2", platform_plugin: "platform-plugin-test-v2" },
    })).rejects.toThrow(/overwrite/i);
  });

  it("signs only the exact source authority/run/kind/audience/time binding", async () => {
    const fixture = await initialized();
    const now = new Date();
    const unsigned = newUnsignedClaim({ run: runBinding("V-A03"), authority: "external_mcp_client", publicConfig: fixture.output.publicConfig, evidence: a03Evidence(randomUUID(), now), now });
    const signed = await signExternalClaim(unsigned, fixture.output.publicConfig, fixture.paths.external, now);
    expect(() => verifyExternalClaimSignature(signed, fixture.output.publicConfig)).not.toThrow();
    await expect(signExternalClaim(unsigned, fixture.output.publicConfig, fixture.paths.deployment, now)).rejects.toThrow(/does not match/i);
    await expect(signExternalClaim({ ...unsigned, audience: "wrong-audience" }, fixture.output.publicConfig, fixture.paths.external, now)).rejects.toThrow();
    await expect(signExternalClaim({ ...unsigned, evidence: { ...unsigned.evidence, authority: "deployment_control" } }, fixture.output.publicConfig, fixture.paths.external, now)).rejects.toThrow();
  });

  it("POSTs with the source token and verifies an exact immutable receipt replay without exposing it", async () => {
    const fixture = await initialized();
    const now = new Date();
    const unsigned = newUnsignedClaim({ run: runBinding("V-A03"), authority: "external_mcp_client", publicConfig: fixture.output.publicConfig, evidence: a03Evidence(randomUUID(), now), now });
    const claim = await signExternalClaim(unsigned, fixture.output.publicConfig, fixture.paths.external, now);
    const tokens = TransportTokensSchema.parse(await readSecureJson(fixture.paths.tokens));
    const authorizations: string[] = [];
    let invocation = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      invocation += 1;
      authorizations.push(String(new Headers(init?.headers).get("authorization")));
      const body = {
        contract_version: "sophia.voice-lab.v1", request_id: randomUUID(), run_id: claim.run_id, test_run_id: randomUUID(), status: "completed", event_cursor: 9,
        deployment_identity: { expected: claim.expected_deployment, observed: claim.expected_deployment },
        data: { attestation_id: claim.attestation_id, attestation_kind: claim.evidence.kind, content_sha256: HASH_C, event_seq: 8, immutable: true, ...(invocation === 2 ? { replay: true } : {}), proof_status: "pending_evaluator_cross_join" },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const receipt = await postAttestationAndVerifyReplay({ baseUrl: "http://attestation.test", claim, publicConfig: fixture.output.publicConfig, transportTokens: tokens, fetchImpl: fetchImpl as typeof fetch, allowHttpForTest: true });
    expect(receipt).toMatchObject({ content_sha256: HASH_C, event_seq: 8, exact_replay_verified: true });
    expect(authorizations).toEqual([`Bearer ${tokens.external_mcp_client}`, `Bearer ${tokens.external_mcp_client}`]);
    expect(JSON.stringify(receipt)).not.toContain(tokens.external_mcp_client);
  });

  it("abandons the first real MCP response body and retains only content-free A03 hashes", async () => {
    const run = runBinding("V-A03");
    const controller = A03ControllerInputSchema.parse({ schema: "sophia_voice_lab_a03_controller_input_v1", mcp_url: "http://mcp.test/mcp", run, speak_arguments: { run_id: run.run_id, text: "content that must not enter the record", idempotency_key: "a03-independent-client" } });
    const operationId = randomUUID();
    const requestId = randomUUID();
    const acceptedAt = new Date("2026-08-24T00:00:00.000Z");
    const envelope = {
      contract_version: "sophia.voice-lab.v1", request_id: requestId, run_id: run.run_id, test_run_id: randomUUID(), operation_id: operationId, status: "completed", observed_at: "2026-08-24T00:00:03.000Z",
      data: { replay: true, operation_state: "succeeded", schedule_receipt: { observed_at: acceptedAt.toISOString() } },
    };
    let count = 0;
    const fetchImpl = vi.fn(async () => {
      count += 1;
      if (count === 1) return new Response("discard-me-entirely", { status: 200, headers: { "content-type": "text/event-stream" } });
      const rpc = { jsonrpc: "2.0", id: "retry", result: { structuredContent: envelope } };
      return new Response(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const times = [new Date("2026-08-24T00:00:01.000Z"), new Date("2026-08-24T00:00:02.000Z"), new Date("2026-08-24T00:00:03.000Z")];
    const record = await executeA03LostResponse({ controller, mcpBearer: "mcp-controller-bearer-credential-00000000001", fetchImpl: fetchImpl as typeof fetch, allowHttpForTest: true, now: () => times.shift()!, requestIds: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"] });
    expect(record).toMatchObject({ operation_id: operationId, initial_application_response_observed: false, initial_body_bytes_retained: 0, retry_flag: true, retry_response_sha256: canonicalRequestHash(envelope) });
    expect(JSON.stringify(record)).not.toMatch(/discard-me|content that must not enter|mcp-controller-bearer/i);
  });

  it("verifies that a later immutable manifest revision contains the exact receipt projection", async () => {
    const fixture = await initialized();
    const now = new Date();
    const testRunId = "00000000-0000-4000-8000-000000000003";
    const binding = runBinding("V-A03");
    binding.test_run_id_sha256 = sha256(testRunId);
    const claim = await signExternalClaim(newUnsignedClaim({ run: binding, authority: "external_mcp_client", publicConfig: fixture.output.publicConfig, evidence: a03Evidence(randomUUID(), now), now }), fixture.output.publicConfig, fixture.paths.external, now);
    const receipt = { first_response_sha256: HASH_A, replay_response_sha256: HASH_B, attestation_id: claim.attestation_id, attestation_kind: claim.evidence.kind, content_sha256: HASH_C, event_seq: 20, event_cursor: 21, immutable: true as const, exact_replay_verified: true as const };
    const baseManifest = (revision: number, manifestId: string, external: unknown[]) => ({
      contract_version: "sophia.voice-lab.evidence.v1", schema_version: "sophia.voice-lab.evidence.v1", manifest_id: manifestId, run_id: claim.run_id, test_run_id: testRunId,
      cleanup_obligation: { cleanup_obligation_id_sha256: claim.cleanup_obligation_id_sha256, raw_identifier_excluded: true }, environment: claim.environment,
      scenario: { id: claim.scenario_id, version: claim.scenario_version }, deployment_identity: { expected: claim.expected_deployment, observed: claim.expected_deployment },
      certification: { revision_seq: revision, current_manifest_pointer_advances_append_only: true }, external_attestations: external,
    });
    const prior = Buffer.from(JSON.stringify(baseManifest(18, "00000000-0000-4000-8000-000000000004", [])));
    const current = Buffer.from(JSON.stringify(baseManifest(22, "00000000-0000-4000-8000-000000000005", [{ kind: claim.evidence.kind, event_seq: 20, content_sha256: HASH_C, authority: claim.evidence.authority, issuer: claim.issuer, authority_key_id: claim.authority_key_id, jti_sha256: sha256(claim.jti), request_argument_sha256: canonicalRequestHash(claim) }])));
    const result = verifyManifestRevision({ manifestBytes: current, priorManifestBytes: prior, claim, receipt });
    expect(result).toMatchObject({ revision_seq: 22, prior_revision_seq: 18, attestation_event_seq: 20, append_only_revision_verified: true });
    expect(() => verifyManifestRevision({ manifestBytes: current, priorManifestBytes: prior, claim, receipt: { ...receipt, attestation_id: randomUUID() } })).toThrow(/exact signed attestation/i);
  });

  it("does not accept caller-authored P01 evidence or call observations", () => {
    const immutableIntent = {
      schema: "sophia_voice_lab_p01_official_collector_input_v1",
      campaign: { scenario_id: "V-P01", scenario_version: "vt00.scenarios.v1", environment: "production", expected_deployment: { frontend: SHA_A, backend: SHA_B, voice: SHA_C } },
      codex: { binary_path: "/Applications/ChatGPT.app/Contents/Resources/codex", binary_sha256: HASH_A, version: "codex-cli 0.148.0-alpha.15" },
      plugin: { source_root: "/secure/sophia-voice-lab", selector: "sophia-voice-lab@private", plugin_id: "sophia-voice-lab@private", name: "sophia-voice-lab", marketplace_name: "private", version: "0.1.0+codex.local-20260824-120000", package_sha256: HASH_B, skill_name: "sophia-voice-lab:autonomous-voice-dogfood", skill_relative_path: "skills/autonomous-voice-dogfood/SKILL.md" },
      app: { registered_app_id: "plugin_asdk_app_voice_lab_test", runtime_name: "sophia_voice_lab" },
      execution: { cwd: "/secure", model: "gpt-5.5", request_timeout_ms: 60_000 },
    };
    expect(P01CollectorInputSchema.safeParse(immutableIntent).success).toBe(true);
    expect(P01CollectorInputSchema.safeParse({ ...immutableIntent, plugin: { ...immutableIntent.plugin, version: "1.2.3-beta.1+codex.release-20260824" } }).success).toBe(true);
    for (const version of ["0.1.0", "0.1.0+", "0.1.0+other.local", "0.1.0+codex.", "0.1.0+codex..token", "0.1.0+codex.local.token", "0.1.0+codex.Local", "0.1.0+codex.-local", "0.1.0+codex.local-", "0.1.0+codex.local--token", "0.1.0+codex_bad"]) {
      expect(P01CollectorInputSchema.safeParse({ ...immutableIntent, plugin: { ...immutableIntent.plugin, version } }).success).toBe(false);
    }
    expect(P01CollectorInputSchema.safeParse({ ...immutableIntent, evidence: { passed: true } }).success).toBe(false);
    expect(P01CollectorInputSchema.safeParse({ ...immutableIntent, call_observations: [] }).success).toBe(false);
  });

  it("fails D02 closed before network activity when exact one-shot service authorization is wrong", () => {
    const run = runBinding("V-D02");
    const serviceId = "srv-0123456789abcdefghij";
    const replay = { run_id: run.run_id, text: "restart safe", idempotency_key: "d02-replay-key" };
    const candidate = {
      schema: "sophia_voice_lab_d02_render_controller_input_v1", voice_lab_url: "https://voice-lab.test", render_api_origin: "https://api.render.com", render_service_id: serviceId, run,
      operation: { operation_id: randomUUID(), operation_type: "speak", public_argument_sha256: canonicalRequestHash(replay), request_sha256: HASH_B, idempotency_key_sha256: sha256(replay.idempotency_key), durable_receipt_sha256: HASH_C, replay_arguments: replay },
      browser: { worker_id_sha256: HASH_A, lease_epoch: 1 }, product: { canonical_session_id_sha256: HASH_A, thread_id_sha256: HASH_B, provider_session_id_sha256: HASH_C, provider_connection_epoch: 2 },
      authorization: { service_id_sha256: HASH_A, one_shot: true, provider_mutation_authorized: true, confirmation: "RESTART_EXACT_VOICE_LAB_MCP_SERVICE_ONCE" }, poll: { timeout_ms: 30_000, interval_ms: 1_000 },
    };
    expect(D02RenderControllerInputSchema.safeParse(candidate).success).toBe(false);
  });

  it("executes D02 with one provider POST only after the durable command and binds the server continuity/local receipts", async () => {
    const fixture = await initialized();
    const controller = d02ControllerInput();
    const harness = d02FetchHarness(controller, { continuityPendingCount: 1 });
    const tokens = TransportTokensSchema.parse(await readSecureJson(fixture.paths.tokens));
    const phases: string[] = [];
    const result = await executeD02RenderRestart({
      controller,
      renderBearer: "render-controller-bearer-material-00000000000001",
      mcpBearer: "mcp-controller-bearer-material-00000000000000001",
      publicConfig: fixture.output.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: fixture.paths.deployment,
      fetchImpl: harness.fetchImpl,
      sleep: async () => undefined,
      now: deterministicNow(),
      allowHttpForTest: true,
      checkpoint: async (checkpoint) => { phases.push(checkpoint.phase); },
    });
    const renderPosts = harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST");
    expect(renderPosts).toHaveLength(1);
    const providerPostIndex = harness.calls.findIndex((call) => call.origin === "https://api.render.com" && call.method === "POST");
    const commandPostsBeforeMutation = harness.calls.slice(0, providerPostIndex).filter((call) => call.pathname === "/internal/voice-lab/attestations" && call.method === "POST");
    expect(commandPostsBeforeMutation).toHaveLength(2);
    expect(harness.calls.filter((call, index) => index > providerPostIndex && call.origin === "https://api.render.com").every((call) => call.method === "GET")).toBe(true);
    expect(harness.calls.filter((call) => call.pathname === "/internal/voice-lab/d02/browser-continuity").map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(phases).toEqual(["command_attached", "render_restart_accepted", "render_settled", "final_attached"]);
    expect([...harness.attestationInvocations.values()]).toEqual([2, 2]);
    const command = result.command_claim.evidence;
    const final = result.final_claim.evidence;
    expect(command.kind).toBe("d02_restart_command");
    expect(final.kind).toBe("d02_api_process_restart");
    if (command.kind !== "d02_restart_command" || final.kind !== "d02_api_process_restart") throw new Error("Unexpected D02 claim kinds.");
    expect(final.restart_request_id_sha256).toBe(sha256(command.restart_request_id));
    expect(final.provider_restart_request_sha256).toBe(result.provider_action.request_sha256);
    expect(final.provider_restart_accepted_response_sha256).toBe(result.provider_action.accepted_response_sha256);
    expect(final.local_controller_receipt_sha256).toBe(result.local_controller_receipt_sha256);
    expect(result.local_controller_receipt.browser.continuity_proof).toEqual(final.browser_continuity_proof);
    expect(final.browser_continuity_proof.continuity_proven).toBe(true);

    vi.useFakeTimers();
    try {
      for (const claim of [result.command_claim, result.final_claim]) {
        vi.setSystemTime(new Date(new Date(claim.expires_at).getTime() + 1));
        let ordinal = 0;
        const committedContinuityReplay = vi.fn(async () => {
          ordinal += 1;
          return new Response(JSON.stringify({
            contract_version: "sophia.voice-lab.v1",
            request_id: randomUUID(),
            run_id: claim.run_id,
            test_run_id: randomUUID(),
            status: "completed",
            event_cursor: 51,
            deployment_identity: { expected: claim.expected_deployment, observed: claim.expected_deployment },
            data: {
              attestation_id: claim.attestation_id,
              attestation_kind: claim.evidence.kind,
              content_sha256: sha256(`expired-continuity-${claim.evidence.kind}`),
              event_seq: 50,
              immutable: true,
              ...(ordinal === 1 ? { gateway_continuity_idempotent_replay: true } : { replay: true }),
              proof_status: "pending_evaluator_cross_join",
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        });
        await expect(postAttestationAndVerifyReplay({
          baseUrl: "http://attestation.test",
          claim,
          publicConfig: fixture.output.publicConfig,
          transportTokens: tokens,
          fetchImpl: committedContinuityReplay as typeof fetch,
          allowHttpForTest: true,
        })).resolves.toMatchObject({ attestation_kind: claim.evidence.kind, exact_replay_verified: true });
        expect(committedContinuityReplay).toHaveBeenCalledTimes(2);

        const absentContinuity = vi.fn(async () => new Response(JSON.stringify({
          contract_version: "sophia.voice-lab.v1",
          request_id: randomUUID(),
          run_id: claim.run_id,
          test_run_id: randomUUID(),
          status: "completed",
          event_cursor: 51,
          deployment_identity: { expected: claim.expected_deployment, observed: claim.expected_deployment },
          data: {
            attestation_id: claim.attestation_id,
            attestation_kind: claim.evidence.kind,
            content_sha256: sha256(`expired-continuity-${claim.evidence.kind}`),
            event_seq: 50,
            immutable: true,
            proof_status: "pending_evaluator_cross_join",
          },
        }), { status: 200, headers: { "content-type": "application/json" } }));
        await expect(postAttestationAndVerifyReplay({
          baseUrl: "http://attestation.test",
          claim,
          publicConfig: fixture.output.publicConfig,
          transportTokens: tokens,
          fetchImpl: absentContinuity as typeof fetch,
          allowHttpForTest: true,
        })).rejects.toThrow(/already-committed Gateway continuity replay/i);
        expect(absentContinuity).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails D02 after exactly one rejected provider POST without polling, replay, or final attestation", async () => {
    const fixture = await initialized();
    const controller = d02ControllerInput();
    const harness = d02FetchHarness(controller, { providerStatus: 503 });
    const tokens = TransportTokensSchema.parse(await readSecureJson(fixture.paths.tokens));
    await expect(executeD02RenderRestart({
      controller,
      renderBearer: "render-controller-bearer-material-00000000000001",
      mcpBearer: "mcp-controller-bearer-material-00000000000000001",
      publicConfig: fixture.output.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: fixture.paths.deployment,
      fetchImpl: harness.fetchImpl,
      sleep: async () => undefined,
      now: deterministicNow(),
      allowHttpForTest: true,
    })).rejects.toThrow(/not accepted exactly once/i);
    expect(harness.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
    expect(harness.calls.some((call) => call.pathname === "/mcp" || call.pathname === "/internal/voice-lab/d02/browser-continuity")).toBe(false);
    expect(harness.attestationInvocations.size).toBe(1);
  });

  it("does not cross a failed durable-command checkpoint and never retries after an accepted-restart checkpoint crash", async () => {
    const fixture = await initialized();
    const tokens = TransportTokensSchema.parse(await readSecureJson(fixture.paths.tokens));
    const beforeMutationController = d02ControllerInput();
    const beforeMutation = d02FetchHarness(beforeMutationController);
    await expect(executeD02RenderRestart({
      controller: beforeMutationController,
      renderBearer: "render-controller-bearer-material-00000000000001",
      mcpBearer: "mcp-controller-bearer-material-00000000000000001",
      publicConfig: fixture.output.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: fixture.paths.deployment,
      fetchImpl: beforeMutation.fetchImpl,
      sleep: async () => undefined,
      now: deterministicNow(),
      allowHttpForTest: true,
      checkpoint: async (checkpoint) => { if (checkpoint.phase === "command_attached") throw new Error("checkpoint storage unavailable"); },
    })).rejects.toThrow(/checkpoint storage unavailable/i);
    expect(beforeMutation.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(0);

    const afterMutationController = d02ControllerInput();
    const afterMutation = d02FetchHarness(afterMutationController);
    await expect(executeD02RenderRestart({
      controller: afterMutationController,
      renderBearer: "render-controller-bearer-material-00000000000001",
      mcpBearer: "mcp-controller-bearer-material-00000000000000001",
      publicConfig: fixture.output.publicConfig,
      transportTokens: tokens,
      deploymentPrivateKeyPath: fixture.paths.deployment,
      fetchImpl: afterMutation.fetchImpl,
      sleep: async () => undefined,
      now: deterministicNow(),
      allowHttpForTest: true,
      checkpoint: async (checkpoint) => { if (checkpoint.phase === "render_restart_accepted") throw new Error("controller crashed after accepted checkpoint"); },
    })).rejects.toThrow(/controller crashed/i);
    expect(afterMutation.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "POST")).toHaveLength(1);
    expect(afterMutation.calls.some((call) => call.pathname === "/mcp" || call.pathname === "/internal/voice-lab/d02/browser-continuity")).toBe(false);
    expect(afterMutation.calls.filter((call) => call.origin === "https://api.render.com" && call.method === "GET")).toHaveLength(3);
  });

  it("redacts controller secrets and creates JSON atomically with mode 0600", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "voice-lab-secure-file-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "record.json");
    const secret = "render-api-key-material-000000000000000000001";
    const redacted = redactControllerValue({ authorization: `Bearer ${secret}`, nested: { bearer_token: secret }, safe_hash: HASH_A });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(safeError(new Error(`token=${secret}`)).error).not.toContain(secret);
    await writeNewSecureJson(target, { safe_hash: HASH_A });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    await expect(writeNewSecureJson(target, { changed: true })).rejects.toThrow(/overwrite/i);
  });
});
