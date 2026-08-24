import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../src/security.js";
import { initializeAuthorityFiles, verifyExternalClaimSignature } from "../scripts/external-attestations/crypto.js";
import {
  collectAndSignP01Claim,
  hashPluginPackage,
  type CommandCapture,
  type P01CaptureBundle,
  type VerifiedCodexBinary,
} from "../scripts/external-attestations/p01.js";

const FRONTEND_SHA = "a".repeat(40);
const BACKEND_SHA = "b".repeat(40);
const VOICE_SHA = "c".repeat(40);
const LANGGRAPH_SHA = "d".repeat(40);
const PLUGIN_ID = "sophia-voice-lab@private";
const APP_ID = "plugin_asdk_app_voice_lab_test";
const APP_RUNTIME = "sophia_voice_lab";
const VERSION = "0.1.0+codex.20260824120000";
const CODEX_VERSION = "codex-cli 0.148.0-alpha.15";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type Drift = "none" | "missing_app_join" | "thread_replay";

interface Fixture {
  controllerInput: Record<string, unknown>;
  publicConfig: Awaited<ReturnType<typeof initializeAuthorityFiles>>["publicConfig"];
  platformKeyPath: string;
  commandCalls: string[][];
  dependencies: {
    now: () => Date;
    runCommand: (executable: string, args: readonly string[]) => Promise<CommandCapture>;
    verifyCodexBinary: () => Promise<VerifiedCodexBinary>;
  };
}

describe("P01 official-source collector", () => {
  it("derives and signs only the exact CLI/App Server install and fresh-task transcript", async () => {
    const fixture = await createFixture("none");
    let persisted: P01CaptureBundle | null = null;
    const result = await collectAndSignP01Claim({
      controllerInput: fixture.controllerInput,
      publicConfig: fixture.publicConfig,
      platformPrivateKeyPath: fixture.platformKeyPath,
      persistCapture: async (capture) => { persisted = capture; },
      dependencies: fixture.dependencies,
    });

    verifyExternalClaimSignature(result.claim, fixture.publicConfig);
    expect(fixture.commandCalls).toEqual([
      ["plugin", "add", PLUGIN_ID, "--json"],
      ["plugin", "list", "--json"],
    ]);
    expect(result.claim.evidence).toMatchObject({
      kind: "p01_platform_plugin_task",
      authority: "platform_plugin",
      registered_app_id: APP_ID,
      plugin_version: VERSION,
      high_level_call_count: 10,
      operation_ids: expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String), expect.any(String)]),
      prohibited_tool_audit_passed: true,
      raw_javascript_used: false,
      local_runner_used: false,
      manual_takeover_used: false,
    });
    expect(new Set(result.claim.evidence.kind === "p01_platform_plugin_task" ? result.claim.evidence.operation_ids : [])).toHaveLength(4);
    expect(persisted).toBe(result.capture);
    expect(result.capture).toMatchObject({
      schema: "sophia_voice_lab_p01_official_capture_v1",
      derived: { call_count: 10, mcp_item_replay_verified: true, source_receipt_sha256: result.claim.evidence.kind === "p01_platform_plugin_task" ? result.claim.evidence.install_receipt_sha256 : "" },
      app_server: { exit_code: 0 },
    });
    expect(result.capture.app_server.frames.length).toBeGreaterThan(30);
    expect(result.capture.app_server.frames.every((frame) => frame.raw_base64.length > 0 && frame.raw_sha256 === sha256(Buffer.from(frame.raw_base64, "base64")))).toBe(true);
  });

  it("rejects a missing app/plugin/connector join before persisting or signing", async () => {
    const fixture = await createFixture("missing_app_join");
    let persisted = false;
    await expect(collectAndSignP01Claim({
      controllerInput: fixture.controllerInput,
      publicConfig: fixture.publicConfig,
      platformPrivateKeyPath: fixture.platformKeyPath,
      persistCapture: async () => { persisted = true; },
      dependencies: fixture.dependencies,
    })).rejects.toThrow(/plugin\/app\/connector|source provenance/i);
    expect(persisted).toBe(false);
  });

  it("rejects a thread/read replay drift before persisting or signing", async () => {
    const fixture = await createFixture("thread_replay");
    let persisted = false;
    await expect(collectAndSignP01Claim({
      controllerInput: fixture.controllerInput,
      publicConfig: fixture.publicConfig,
      platformPrivateKeyPath: fixture.platformKeyPath,
      persistCapture: async () => { persisted = true; },
      dependencies: fixture.dependencies,
    })).rejects.toThrow(/thread\/read MCP replay drifted/i);
    expect(persisted).toBe(false);
  });

  it("rejects package drift before invoking the state-changing plugin command", async () => {
    const fixture = await createFixture("none");
    const drifted = structuredClone(fixture.controllerInput);
    (drifted.plugin as Record<string, unknown>).package_sha256 = "f".repeat(64);
    await expect(collectAndSignP01Claim({
      controllerInput: drifted,
      publicConfig: fixture.publicConfig,
      platformPrivateKeyPath: fixture.platformKeyPath,
      persistCapture: async () => { throw new Error("must not persist"); },
      dependencies: fixture.dependencies,
    })).rejects.toThrow(/source plugin package SHA-256/i);
    expect(fixture.commandCalls).toEqual([]);
  });
});

async function createFixture(drift: Drift): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "voice-lab-p01-collector-")));
  temporaryDirectories.push(directory);
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

  const keyPaths = {
    publicConfig: path.join(directory, "public.json"),
    tokens: path.join(directory, "tokens.json"),
    external: path.join(directory, "external.pk8"),
    deployment: path.join(directory, "deployment.pk8"),
    platform: path.join(directory, "platform.pk8"),
  };
  const initialized = await initializeAuthorityFiles({
    publicConfigPath: keyPaths.publicConfig,
    transportTokensPath: keyPaths.tokens,
    privateKeyPaths: { external_mcp_client: keyPaths.external, deployment_control: keyPaths.deployment, platform_plugin: keyPaths.platform },
    keyIds: { external_mcp_client: "external-client-p01-test", deployment_control: "deployment-p01-test", platform_plugin: "platform-plugin-p01-test" },
  });

  const base = new Date(Math.floor((Date.now() + 2_000) / 1_000) * 1_000);
  const threadStartedAt = base.getTime() / 1_000 + 1;
  const threadCompletedAt = base.getTime() / 1_000 + 6;
  const runId = randomUUID();
  const testRunId = randomUUID();
  const cleanupObligationId = randomUUID();
  const manifestId = randomUUID();
  const threadId = "thread-p01-official-source-test";
  const turnId = "turn-p01-official-source-test";
  const expectedDeployment = { frontend: FRONTEND_SHA, backend: BACKEND_SHA, voice: VOICE_SHA };
  const manifest = {
    contract_version: "sophia.voice-lab.evidence.v1",
    schema_version: "sophia.voice-lab.evidence.v1",
    manifest_id: manifestId,
    run_id: runId,
    test_run_id: testRunId,
    cleanup_obligation: { cleanup_obligation_id_sha256: sha256(cleanupObligationId), raw_identifier_excluded: true },
    environment: "production",
    scenario: { id: "V-P01", version: "vt00.scenarios.v1" },
    deployment_identity: { expected: expectedDeployment, observed: expectedDeployment },
    run_lifecycle: { started_at: new Date(base.getTime() + 2_000).toISOString(), ended_at: new Date(base.getTime() + 5_000).toISOString() },
    versions: { plugin: VERSION, registered_app: { technical_id: APP_ID, plugin_package_sha256: packageHash.sha256 } },
  };
  const manifestText = JSON.stringify(manifest);
  const manifestBytes = Buffer.from(manifestText, "utf8");
  const manifestSha256 = sha256(manifestBytes);
  const manifestReference = {
    kind: "manifest",
    resource_id: `voice-lab://evidence/${manifestId}`,
    sha256: manifestSha256,
    content_type: "application/json",
    byte_length: manifestBytes.byteLength,
  };

  const tools = ["get_capabilities", "start_voice_run", "wait_for_turn", "speak", "wait_for_turn", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run", "export_voice_evidence"];
  const argumentsList: Record<string, unknown>[] = [
    {},
    {
      environment: "production",
      target: {
        frontend_url: "https://frontend.test",
        gateway_url: "https://gateway.test",
        voice_url: "https://voice.test",
        langgraph_url: "https://langgraph.test",
        expected_deployment: expectedDeployment,
        expected_dependencies: { langgraph: LANGGRAPH_SHA },
      },
      scenario_id: "V-P01",
      scenario_version: "vt00.scenarios.v1",
      capture_policy: { raw_audio: false, screenshot: true, video: false, retention_hours: 24 },
      idempotency_key: "p01-start-operation",
    },
    { run_id: runId, after_cursor: 0, condition: "assistant_turn_complete", timeout_ms: 10_000 },
    { run_id: runId, text: "Give one concise greeting.", idempotency_key: "p01-first-speak", timing_policy: { delay_ms: 0, schedule_timeout_ms: 10_000 } },
    { run_id: runId, after_cursor: 20, condition: "assistant_turn_complete", timeout_ms: 10_000 },
    {
      run_id: runId,
      text: "Clarify that result in one sentence.",
      idempotency_key: "p01-adaptive-speak",
      adaptive_observation: { event_seq: 55, turn_id: "turn-product-1", observation_class: "assistant_result", followup_intent: "clarify" },
      timing_policy: { delay_ms: 0, schedule_timeout_ms: 10_000 },
    },
    { run_id: runId, after_cursor: 55, condition: "assistant_turn_complete", timeout_ms: 10_000 },
    { run_id: runId, after_cursor: 0, limit: 100 },
    { run_id: runId, idempotency_key: "p01-end-operation" },
    { run_id: runId },
  ];
  const statuses = ["ok", "accepted", "ok", "completed", "ok", "completed", "ok", "running", "completed", "completed"];
  const operations = new Map<number, string>([[1, randomUUID()], [3, randomUUID()], [5, randomUUID()], [8, randomUUID()]]);
  const data: Record<string, unknown>[] = [
    { deployment_discovered: true },
    { operation_state: "accepted" },
    { condition_satisfied: true },
    { operation_state: "succeeded" },
    { condition_satisfied: true, matched: [{ seq: 55, turn_id: "turn-product-1" }] },
    { operation_state: "succeeded" },
    { condition_satisfied: true },
    { run_state: "active" },
    { operation_state: "succeeded", cleanup_complete: true, evidence_state: "available", manifest_id: manifestId, manifest_sha256: manifestSha256 },
    { cleanup_complete: true, evidence_state: "available", manifest_id: manifestId, manifest_sha256: manifestSha256 },
  ];
  const completedItems = tools.map((tool, index) => {
    const appContext = {
      connectorId: drift === "missing_app_join" && index === 5 ? "plugin_asdk_app_wrong" : APP_ID,
      linkId: "oauth-link-p01",
      resourceUri: null,
      appName: APP_RUNTIME,
      actionName: tool,
    };
    const envelope = {
      contract_version: "sophia.voice-lab.v1",
      request_id: randomUUID(),
      test_run_id: index === 0 ? null : testRunId,
      run_id: index === 0 ? null : runId,
      operation_id: operations.get(index) ?? null,
      status: statuses[index],
      deployment_identity: { expected: expectedDeployment, observed: expectedDeployment },
      evidence_references: index >= 8 ? [manifestReference] : [],
      data: data[index],
    };
    return {
      type: "mcpToolCall",
      id: `mcp-call-${index + 1}`,
      server: APP_RUNTIME,
      tool,
      status: "completed",
      arguments: argumentsList[index],
      appContext,
      pluginId: PLUGIN_ID,
      readOnlyHint: [0, 2, 4, 6, 7, 9].includes(index),
      result: { content: [], structuredContent: envelope, _meta: null },
      error: null,
      durationMs: index + 1,
    };
  });
  const startedItems = completedItems.map((item) => ({ ...item, status: "inProgress", result: null, durationMs: null }));
  const replayItems = structuredClone(completedItems);
  if (drift === "thread_replay") replayItems[9]!.arguments = { run_id: randomUUID() };

  const appServerFixture = {
    cwd: directory,
    pluginRoot,
    skillPath,
    threadId,
    turnId,
    startedAt: threadStartedAt,
    completedAt: threadCompletedAt,
    startedItems,
    completedItems,
    replayItems,
    manifestUri: manifestReference.resource_id,
    manifestText,
  };
  const binaryPath = path.join(directory, "fake-codex");
  await writeFile(binaryPath, fakeAppServerScript(appServerFixture));
  await chmod(binaryPath, 0o700);
  const binarySha256 = sha256(await readFile(binaryPath));
  const commandCalls: string[][] = [];
  const runCommand = async (_executable: string, args: readonly string[]): Promise<CommandCapture> => {
    commandCalls.push([...args]);
    if (args.join("\0") === ["plugin", "add", PLUGIN_ID, "--json"].join("\0")) {
      return commandCapture(args, { pluginId: PLUGIN_ID, name: "sophia-voice-lab", marketplaceName: "private", version: VERSION, installedPath: pluginRoot, authPolicy: "ON_INSTALL" });
    }
    if (args.join("\0") === ["plugin", "list", "--json"].join("\0")) {
      return commandCapture(args, {
        installed: [{
          pluginId: PLUGIN_ID,
          name: "sophia-voice-lab",
          marketplaceName: "private",
          version: VERSION,
          installed: true,
          enabled: true,
          source: { source: "local", path: pluginRoot },
          marketplaceSource: { sourceType: "local", source: pluginRoot },
          installPolicy: "AVAILABLE",
          authPolicy: "ON_INSTALL",
        }],
        available: [],
      });
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  const versionCapture = commandCapture(["--version"], CODEX_VERSION, true);
  const emptyCapture = commandCapture([], "", true);
  const verified: VerifiedCodexBinary = {
    real_path_sha256: sha256(binaryPath),
    binary_sha256: binarySha256,
    version: CODEX_VERSION,
    version_capture: versionCapture,
    signature_verify_capture: emptyCapture,
    signature_detail_capture: emptyCapture,
    signature_identifier: "codex",
    signature_team_identifier: "2DC432GLL2",
    signature_authority: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
  };
  let nowCall = 0;
  return {
    controllerInput: {
      schema: "sophia_voice_lab_p01_official_collector_input_v1",
      campaign: { scenario_id: "V-P01", scenario_version: "vt00.scenarios.v1", environment: "production", expected_deployment: expectedDeployment },
      codex: { binary_path: binaryPath, binary_sha256: binarySha256, version: CODEX_VERSION },
      plugin: {
        source_root: pluginRoot,
        selector: PLUGIN_ID,
        plugin_id: PLUGIN_ID,
        name: "sophia-voice-lab",
        marketplace_name: "private",
        version: VERSION,
        package_sha256: packageHash.sha256,
        skill_name: "sophia-voice-lab:autonomous-voice-dogfood",
        skill_relative_path: "skills/autonomous-voice-dogfood/SKILL.md",
      },
      app: { registered_app_id: APP_ID, runtime_name: APP_RUNTIME },
      execution: { cwd: directory, model: "gpt-5.5", request_timeout_ms: 10_000, shutdown_timeout_ms: 1_000, maximum_frame_bytes: 1_048_576, maximum_capture_bytes: 8_388_608 },
    },
    publicConfig: initialized.publicConfig,
    platformKeyPath: keyPaths.platform,
    commandCalls,
    dependencies: {
      now: () => new Date(base.getTime() + (nowCall++ === 0 ? 0 : 7_000)),
      runCommand,
      verifyCodexBinary: async () => verified,
    },
  };
}

function commandCapture(argv: readonly string[], value: unknown, rawText = false): CommandCapture {
  const stdout = Buffer.from(rawText ? String(value) : JSON.stringify(value), "utf8");
  const stderr = Buffer.alloc(0);
  return {
    argv: [...argv],
    exit_code: 0,
    signal: null,
    stdout_base64: stdout.toString("base64"),
    stdout_sha256: sha256(stdout),
    stdout_bytes: stdout.byteLength,
    stderr_base64: "",
    stderr_sha256: sha256(stderr),
    stderr_bytes: 0,
  };
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
