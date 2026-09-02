import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { LabEnvelope } from "../src/domain.js";
import type { VoiceLabLedger } from "../src/ledger.js";
import { createVoiceLabMcpServer } from "../src/mcp-server.js";
import { canonicalRequestHash, sha256, type AuthenticatedCaller } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { initializeAuthorityFiles, verifyExternalClaimSignature } from "../scripts/external-attestations/crypto.js";
import {
  collectAndSignP01Claim,
  hashPluginPackage,
  type CommandCapture,
  type VerifiedCodexBinary,
} from "../scripts/external-attestations/p01.js";
import { SHA, SHA_B, SHA_C, SHA_D, testConfig } from "./helpers.js";

const PLUGIN_ID = "sophia-voice-lab@private";
const APP_ID = "plugin_asdk_app_voice_lab_integration";
const APP_RUNTIME = "sophia_voice_lab";
const VERSION = "0.1.0+codex.p01-integration";
const CODEX_VERSION = "codex-cli 0.148.0-alpha.15";

const target = {
  frontend_url: "http://frontend.test",
  gateway_url: "http://gateway.test",
  voice_url: "http://voice.test",
  langgraph_url: "http://langgraph.test",
  expected_deployment: { frontend: SHA, backend: SHA_B, voice: SHA_C },
  expected_dependencies: { langgraph: SHA_D },
};

type CompletedItem = {
  type: "mcpToolCall";
  id: string;
  server: string;
  tool: string;
  status: "completed";
  arguments: Record<string, unknown>;
  appContext: { connectorId: string; linkId: string; resourceUri: null; appName: string; actionName: string };
  pluginId: string;
  readOnlyHint: boolean;
  result: { content: unknown[]; structuredContent: LabEnvelope; _meta: unknown };
  error: null;
  durationMs: number;
};

/**
 * Executes the collector against envelopes and audit receipts emitted by the
 * real MCP/service boundary. The App Server fixture only replays those exact
 * bytes; it never invents a service response or authorization audit row.
 */
export async function proveP01LiveBoundary(ledger: VoiceLabLedger): Promise<{ runId: string; pollingCallCount: number }> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "voice-lab-p01-live-")));
  const mcpServers: Array<{ close: () => Promise<void> }> = [];
  const mcpClients: Array<{ close: () => Promise<void> }> = [];
  try {
    const pluginRoot = path.join(directory, "plugin");
    const skillPath = path.join(pluginRoot, "skills", "autonomous-voice-dogfood", "SKILL.md");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), `${JSON.stringify({
      name: "sophia-voice-lab",
      version: VERSION,
      description: "Governed Sophia Voice Lab production dogfood",
      skills: "./skills",
      apps: "./.app.json",
    }, null, 2)}\n`);
    await writeFile(path.join(pluginRoot, ".app.json"), `${JSON.stringify({ apps: { "sophia-voice-lab": { id: APP_ID, category: "Developer Tools" } } }, null, 2)}\n`);
    await writeFile(skillPath, "# Autonomous voice dogfood\n\nUse only the registered Sophia Voice Lab app.\n");
    const packageHash = await hashPluginPackage(pluginRoot);

    const keys = {
      publicConfig: path.join(directory, "public.json"),
      tokens: path.join(directory, "tokens.json"),
      external: path.join(directory, "external.pk8"),
      deployment: path.join(directory, "deployment.pk8"),
      platform: path.join(directory, "platform.pk8"),
    };
    const initialized = await initializeAuthorityFiles({
      publicConfigPath: keys.publicConfig,
      transportTokensPath: keys.tokens,
      privateKeyPaths: { external_mcp_client: keys.external, deployment_control: keys.deployment, platform_plugin: keys.platform },
      keyIds: { external_mcp_client: "external-live-p01", deployment_control: "deployment-live-p01", platform_plugin: "platform-live-p01" },
    });
    const config = testConfig({
      SOPHIA_VOICE_LAB_REGISTERED_APP_ID: APP_ID,
      SOPHIA_VOICE_LAB_PLUGIN_VERSION: VERSION,
      SOPHIA_VOICE_LAB_PLUGIN_PACKAGE_SHA256: packageHash.sha256,
      SOPHIA_VOICE_LAB_ATTESTATION_PUBLIC_KEYS_JSON: JSON.stringify(initialized.publicConfig),
      SOPHIA_VOICE_LAB_OAUTH_ISSUER: "https://oauth.test",
      SOPHIA_VOICE_LAB_OAUTH_RESOURCE: "https://voice-lab.test/mcp",
      SOPHIA_VOICE_LAB_OAUTH_RESOURCE_METADATA_URL: "https://voice-lab.test/.well-known/oauth-protected-resource/mcp",
      SOPHIA_VOICE_LAB_OAUTH_CLIENT_METADATA_URL: "https://chatgpt.com/oauth/client.json",
      SOPHIA_VOICE_LAB_OAUTH_CLIENT_REDIRECT_URI: "https://chatgpt.com/connector_platform_oauth_redirect",
      SOPHIA_VOICE_LAB_OAUTH_OPERATOR_SUBJECT: "voice-lab-private-operator",
      SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET: "oauth-consent-secret-00000000000000001",
      SOPHIA_VOICE_LAB_OAUTH_TOKEN_PEPPER: "oauth-token-pepper-0000000000000000001",
      SOPHIA_VOICE_LAB_MAX_WAIT_MS: "10000",
    });
    const service = new VoiceLabService(ledger, config, async () => []);
    const oauthCaller: AuthenticatedCaller = {
      subject: `p01-live-${randomUUID()}`,
      scopes: new Set(["voice_lab:read", "voice_lab:run", "voice_lab:fault"]),
      authorizationKind: "oauth",
      clientId: config.oauth!.clientMetadataUrl,
      tokenId: `p01-oauth-family-${randomUUID()}`,
    };
    const server = createVoiceLabMcpServer(service, ledger, oauthCaller);
    const client = new Client({ name: "p01-live-boundary", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    mcpServers.push(server);
    mcpClients.push(client);

    const taskFloor = new Date(Date.now() - 2_000);
    const completedItems: CompletedItem[] = [];
    const invoke = async (tool: string, args: Record<string, unknown>, readOnlyHint: boolean): Promise<LabEnvelope> => {
      const before = Date.now();
      const result = await client.callTool({ name: tool, arguments: args }) as any;
      const envelope = result.structuredContent as LabEnvelope;
      assert.equal(result.isError, false, `${tool} unexpectedly returned ${envelope?.error_class}: ${envelope?.error?.message}; ${JSON.stringify(result)}`);
      assert.equal(envelope.contract_version, "sophia.voice-lab.v1");
      completedItems.push({
        type: "mcpToolCall",
        id: `mcp-live-${completedItems.length + 1}`,
        server: APP_RUNTIME,
        tool,
        status: "completed",
        arguments: structuredClone(args),
        appContext: { connectorId: APP_ID, linkId: "oauth-link-p01-live", resourceUri: null, appName: APP_RUNTIME, actionName: tool },
        pluginId: PLUGIN_ID,
        readOnlyHint,
        result: { content: result.content ?? [], structuredContent: envelope, _meta: result._meta ?? null },
        error: null,
        durationMs: Math.max(1, Date.now() - before),
      });
      return envelope;
    };
    const settle = async (operationId: string): Promise<void> => {
      const claimed = await ledger.claimNextOperation("p01-live-worker", 30);
      assert.ok(claimed, "expected one queued operation");
      assert.equal(claimed.operation.id, operationId, "collector operation order drifted");
      await ledger.markOperationExecuting(operationId, "p01-live-worker", claimed.operation.leaseEpoch);
      await ledger.finishOperation(operationId, "p01-live-worker", claimed.operation.leaseEpoch, "succeeded", { integration_boundary: "settled" }, null);
      await ledger.appendEvent(claimed.run.id, "operation.succeeded", "worker", { operation_id: operationId, operation_type: claimed.operation.type }, `operation:${operationId}:succeeded`);
    };
    const appendAssistantTurn = async (runId: string, turnId: string): Promise<number> => {
      const run = await ledger.getRun(runId);
      assert.ok(run);
      const binding = {
        app_authenticated: true,
        synthetic: true,
        test_run_id_sha256: sha256(run.testRunId),
        cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
        principal_id_sha256: sha256(run.principalId),
        environment: run.environment,
        scenario_id: run.scenarioId,
        scenario_version: run.scenarioVersion,
        retention_hours: run.capturePolicy.retentionHours,
        provider_expires_at: run.expiresAt.toISOString(),
      };
      if (!(await ledger.findLatestEvent(run.id, ["provider.connection_epoch"]))) {
        await ledger.appendEvent(run.id, "provider.connection_epoch", "product", {
          _product_run_binding: binding,
          receipt: { providerConnectionEpoch: 1, phase: "bootstrap" },
        }, `p01-live-provider-epoch:${run.id}:1`);
      }
      const event = await ledger.appendEvent(run.id, "product.voice-sse.sophia.turn", "product", { _product_run_binding: binding, data: { phase: "agent_ended", turnId } }, `p01-live-turn:${turnId}`);
      const fresh = await ledger.getRun(run.id);
      assert.ok(fresh);
      await ledger.updateRun(run.id, fresh.version, { turnId, providerEpoch: 1 });
      return event.seq;
    };

    await invoke("get_capabilities", {}, true);
    const start = await invoke("start_voice_run", {
      environment: "production",
      target,
      scenario_id: "V-P01",
      scenario_version: "vt00.scenarios.v1",
      capture_policy: { raw_audio: false, screenshot: true, video: false, retention_hours: 24 },
      idempotency_key: `p01-live-start-${randomUUID()}`,
    }, false);
    assert.equal(start.status, "accepted");
    assert.ok(start.run_id && start.operation_id);
    await settle(start.operation_id);
    let run = await ledger.getRun(start.run_id);
    assert.ok(run);
    run = await ledger.updateRun(run.id, run.version, {
      state: "ready",
      observedDeployment: run.target.expectedDeployment,
      canonicalSessionId: `canonical-${run.id}`,
      threadId: `thread-${run.id}`,
      providerSessionId: `provider-${run.id}`,
      providerEpoch: 1,
    });
    await ledger.upsertBrowserLease(run.id, "p01-live-worker", 60);
    const startWait = await invoke("wait_for_turn", { run_id: run.id, after_cursor: 0, condition: "operation_terminal", operation_id: start.operation_id, timeout_ms: 100 }, true);
    assert.equal(startWait.status, "ok");

    const speakOne = await invoke("speak", { run_id: run.id, text: "Give one concise greeting.", idempotency_key: `p01-live-speak-one-${randomUUID()}`, timing_policy: { delay_ms: 0, schedule_timeout_ms: 100 } }, false);
    assert.equal(speakOne.status, "timeout");
    assert.ok(speakOne.operation_id);
    const firstTimeoutPoll = await invoke("wait_for_turn", { run_id: run.id, after_cursor: run.latestCursor, condition: "operation_terminal", operation_id: speakOne.operation_id, timeout_ms: 100 }, true);
    assert.equal(firstTimeoutPoll.status, "timeout");
    await settle(speakOne.operation_id);
    const firstTerminalPoll = await invoke("wait_for_turn", { run_id: run.id, after_cursor: 0, condition: "operation_terminal", operation_id: speakOne.operation_id, timeout_ms: 100 }, true);
    assert.equal(firstTerminalPoll.status, "ok");
    const firstTurnSeq = await appendAssistantTurn(run.id, `turn-one-${randomUUID()}`);
    const firstAssistant = await invoke("wait_for_turn", { run_id: run.id, after_cursor: 0, condition: "assistant_turn_complete", timeout_ms: 100 }, true);
    assert.equal(firstAssistant.status, "ok");
    const observationReceipt = (firstAssistant.data.observation_receipts as Array<Record<string, unknown>>)[0];
    assert.ok(observationReceipt, "service did not mint the adaptive observation receipt");

    run = (await ledger.getRun(run.id))!;
    const speakTwo = await invoke("speak", {
      run_id: run.id,
      text: "Clarify that result in one sentence.",
      idempotency_key: `p01-live-speak-two-${randomUUID()}`,
      expected_cursor: run.latestCursor,
      expected_provider_epoch: 1,
      expected_turn_id: run.turnId,
      adaptive_observation: { receipt: observationReceipt, followup_intent: "clarify" },
      timing_policy: { delay_ms: 0, schedule_timeout_ms: 100 },
    }, false);
    assert.equal(speakTwo.status, "timeout");
    assert.ok(speakTwo.operation_id);
    await settle(speakTwo.operation_id);
    const secondTerminalPoll = await invoke("wait_for_turn", { run_id: run.id, after_cursor: firstTurnSeq, condition: "operation_terminal", operation_id: speakTwo.operation_id, timeout_ms: 100 }, true);
    assert.equal(secondTerminalPoll.status, "ok");
    await appendAssistantTurn(run.id, `turn-two-${randomUUID()}`);
    const secondAssistant = await invoke("wait_for_turn", { run_id: run.id, after_cursor: firstTurnSeq, condition: "assistant_turn_complete", timeout_ms: 100 }, true);
    assert.equal(secondAssistant.status, "ok");
    await invoke("inspect_voice_run", { run_id: run.id, after_cursor: 0, limit: 100 }, true);

    const end = await invoke("end_voice_run", { run_id: run.id, idempotency_key: `p01-live-end-${randomUUID()}`, wait_timeout_ms: 100 }, false);
    assert.equal(end.status, "timeout");
    assert.ok(end.operation_id);
    await settle(end.operation_id);
    run = (await ledger.getRun(run.id))!;
    run = await ledger.updateRun(run.id, run.version, { state: "pending_external_evidence", cleanupComplete: true, terminalError: null });
    const manifestId = randomUUID();
    const manifest = {
      contract_version: "sophia.voice-lab.evidence.v1",
      schema_version: "sophia.voice-lab.evidence.v1",
      manifest_id: manifestId,
      run_id: run.id,
      test_run_id: run.testRunId,
      cleanup_obligation: { cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), raw_identifier_excluded: true },
      environment: run.environment,
      scenario: { id: run.scenarioId, version: run.scenarioVersion },
      deployment_identity: { expected: run.target.expectedDeployment, observed: run.observedDeployment },
      run_lifecycle: { started_at: run.createdAt.toISOString(), ended_at: run.updatedAt.toISOString() },
      versions: { plugin: VERSION, registered_app: { technical_id: APP_ID, plugin_package_sha256: packageHash.sha256 } },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const manifestSha256 = sha256(manifestBytes);
    await ledger.saveArtifact({ id: manifestId, runId: run.id, kind: "manifest_attachment", contentType: "application/json", sha256: manifestSha256, bytes: manifestBytes, createdAt: run.updatedAt });
    const manifestRef = { kind: "manifest", resource_id: `voice-lab://evidence/${manifestId}`, sha256: manifestSha256, content_type: "application/json", byte_length: manifestBytes.byteLength };
    await ledger.saveEvidence({ runId: run.id, manifestId, manifestSha256, schemaVersion: "sophia.voice-lab.evidence.v1", revisionSeq: run.latestCursor, artifactRefs: [manifestRef], createdAt: run.updatedAt });
    const endTerminalPoll = await invoke("wait_for_turn", { run_id: run.id, after_cursor: 0, condition: "operation_terminal", operation_id: end.operation_id, timeout_ms: 100 }, true);
    assert.equal(endTerminalPoll.status, "completed");
    const exported = await invoke("export_voice_evidence", { run_id: run.id }, true);
    assert.equal(exported.status, "completed");

    const taskCeiling = new Date(Date.now() + 2_000);
    const startedItems = completedItems.map((item) => ({ ...item, status: "inProgress", result: null, durationMs: null }));
    const appServerFixture = {
      cwd: directory,
      skillPath,
      threadId: `thread-p01-live-${randomUUID()}`,
      turnId: `turn-p01-live-${randomUUID()}`,
      startedAt: taskFloor.getTime() / 1_000,
      completedAt: taskCeiling.getTime() / 1_000,
      startedItems,
      completedItems,
      replayItems: structuredClone(completedItems),
      manifestUri: manifestRef.resource_id,
      manifestText: manifestBytes.toString("utf8"),
    };
    const binaryPath = path.join(directory, "fake-codex");
    await writeFile(binaryPath, fakeAppServerScript(appServerFixture));
    await chmod(binaryPath, 0o700);
    const binarySha256 = sha256(await readFile(binaryPath));
    const runCommand = async (_executable: string, args: readonly string[]): Promise<CommandCapture> => {
      if (args.join("\0") === ["plugin", "add", PLUGIN_ID, "--json"].join("\0")) return commandCapture(args, { pluginId: PLUGIN_ID, name: "sophia-voice-lab", marketplaceName: "private", version: VERSION, installedPath: pluginRoot, authPolicy: "ON_INSTALL" });
      if (args.join("\0") === ["plugin", "list", "--json"].join("\0")) return commandCapture(args, { installed: [{ pluginId: PLUGIN_ID, name: "sophia-voice-lab", marketplaceName: "private", version: VERSION, installed: true, enabled: true, source: { source: "local", path: pluginRoot }, marketplaceSource: { sourceType: "local", source: pluginRoot }, installPolicy: "AVAILABLE", authPolicy: "ON_INSTALL" }], available: [] });
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };
    const emptyCapture = commandCapture([], "", true);
    const verified: VerifiedCodexBinary = {
      real_path_sha256: sha256(binaryPath),
      binary_sha256: binarySha256,
      version: CODEX_VERSION,
      version_capture: commandCapture(["--version"], CODEX_VERSION, true),
      signature_verify_capture: emptyCapture,
      signature_detail_capture: emptyCapture,
      signature_identifier: "codex",
      signature_team_identifier: "2DC432GLL2",
      signature_authority: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
    };
    let nowCall = 0;
    const collection = await collectAndSignP01Claim({
      controllerInput: {
        schema: "sophia_voice_lab_p01_official_collector_input_v1",
        campaign: { scenario_id: "V-P01", scenario_version: "vt00.scenarios.v1", environment: "production", expected_deployment: target.expected_deployment },
        codex: { binary_path: binaryPath, binary_sha256: binarySha256, version: CODEX_VERSION },
        plugin: { source_root: pluginRoot, selector: PLUGIN_ID, plugin_id: PLUGIN_ID, name: "sophia-voice-lab", marketplace_name: "private", version: VERSION, package_sha256: packageHash.sha256, skill_name: "sophia-voice-lab:autonomous-voice-dogfood", skill_relative_path: "skills/autonomous-voice-dogfood/SKILL.md" },
        app: { registered_app_id: APP_ID, runtime_name: APP_RUNTIME },
        execution: { cwd: directory, model: "gpt-5.5", request_timeout_ms: 10_000, shutdown_timeout_ms: 1_000, maximum_frame_bytes: 1_048_576, maximum_capture_bytes: 8_388_608 },
      },
      publicConfig: initialized.publicConfig,
      platformPrivateKeyPath: keys.platform,
      persistCapture: async () => undefined,
      dependencies: { now: () => nowCall++ === 0 ? taskFloor : new Date(), runCommand, verifyCodexBinary: async () => verified },
    });
    verifyExternalClaimSignature(collection.claim, initialized.publicConfig);
    assert.equal(collection.claim.run_id, run.id);
    assert.equal(collection.claim.evidence.kind, "p01_platform_plugin_task");
    assert.equal(collection.claim.evidence.polling_call_count, 4);

    const authority = config.attestationAuthorities.platform_plugin;
    const attestationCaller: AuthenticatedCaller = { subject: authority.subject, scopes: new Set(["voice_lab:attest", "voice_lab:attest:platform_plugin"]), authorizationKind: "attestation" };
    const attached = await service.attachExternalAttestation(attestationCaller, collection.claim, { argumentHash: canonicalRequestHash(collection.claim), requestIdHash: sha256(randomUUID()) });
    assert.equal(attached.status, "completed");
    const storedRun = await ledger.getRun(run.id);
    assert.ok(storedRun);
    const events = await ledger.listEvents(run.id, 0, 500);
    assert.ok(events.events.some((event) => event.kind === "external.attestation.p01_platform_plugin_task" && event.payload.binding_validated === true));
    const audits = await ledger.listAuthAudit(run.id);
    assert.equal(audits.filter((audit) => audit.action === "mcp.tool_response").length, completedItems.length - 1);
    assert.ok(audits.some((audit) => audit.action === "external_attestation.authenticate"));
    return { runId: run.id, pollingCallCount: collection.claim.evidence.polling_call_count };
  } finally {
    await Promise.allSettled(mcpClients.map((client) => client.close()));
    await Promise.allSettled(mcpServers.map((server) => server.close()));
    await rm(directory, { recursive: true, force: true });
  }
}

function commandCapture(argv: readonly string[], value: unknown, rawText = false): CommandCapture {
  const stdout = Buffer.from(rawText ? String(value) : JSON.stringify(value), "utf8");
  const stderr = Buffer.alloc(0);
  return { argv: [...argv], exit_code: 0, signal: null, stdout_base64: stdout.toString("base64"), stdout_sha256: sha256(stdout), stdout_bytes: stdout.byteLength, stderr_base64: "", stderr_sha256: sha256(stderr), stderr_bytes: 0 };
}

function fakeAppServerScript(fixture: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(fixture), "utf8").toString("base64");
  return `#!/usr/bin/env node
import readline from "node:readline";
const fixture = JSON.parse(Buffer.from(${JSON.stringify(encoded)}, "base64").toString("utf8"));
if (process.argv[2] !== "app-server" || process.argv[3] !== "--stdio") process.exit(64);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "codex-cli test app-server" } });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: fixture.threadId, parentThreadId: null, forkedFromId: null, ephemeral: false, turns: [], source: "appServer" } } });
  if (message.method === "app/installed") return send({ id: message.id, result: { apps: [{ id: ${JSON.stringify(APP_ID)}, runtimeName: ${JSON.stringify(APP_RUNTIME)}, enabled: true, callable: true }] } });
  if (message.method === "skills/list") return send({ id: message.id, result: { data: [{ cwd: fixture.cwd, errors: [], skills: [{ name: "sophia-voice-lab:autonomous-voice-dogfood", path: fixture.skillPath, enabled: true }] }] } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: fixture.turnId, status: "inProgress" } } });
    for (let index = 0; index < fixture.startedItems.length; index += 1) {
      send({ method: "item/started", params: { threadId: fixture.threadId, turnId: fixture.turnId, item: fixture.startedItems[index] } });
      send({ method: "item/completed", params: { threadId: fixture.threadId, turnId: fixture.turnId, item: fixture.completedItems[index] } });
    }
    return send({ method: "turn/completed", params: { threadId: fixture.threadId, turn: { id: fixture.turnId, status: "completed", error: null, startedAt: fixture.startedAt, completedAt: fixture.completedAt } } });
  }
  if (message.method === "mcpServer/resource/read") return send({ id: message.id, result: { contents: [{ uri: fixture.manifestUri, mimeType: "application/json", text: fixture.manifestText }] } });
  if (message.method === "thread/read") return send({ id: message.id, result: { thread: { id: fixture.threadId, parentThreadId: null, forkedFromId: null, ephemeral: false, turns: [{ id: fixture.turnId, status: "completed", startedAt: fixture.startedAt, completedAt: fixture.completedAt, items: fixture.replayItems }] } } });
  send({ id: message.id, error: { code: -32601, message: "unknown method" } });
});
`;
}
