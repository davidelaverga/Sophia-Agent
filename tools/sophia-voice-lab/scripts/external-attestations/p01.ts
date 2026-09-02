import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { canonicalRequestHash, sha256 } from "../../src/security.js";
import { toolInputSchemas } from "../../src/service.js";
import {
  P01CollectorInputSchema,
  type P01CollectorInput,
  type PublicAuthorityConfig,
  type SignedExternalAttestation,
} from "./contracts.js";
import { newUnsignedClaim, signExternalClaim } from "./crypto.js";

const EXPECTED_TOOLS = [
  "get_capabilities",
  "start_voice_run",
  "wait_for_turn",
  "speak",
  "wait_for_turn",
  "speak",
  "wait_for_turn",
  "inspect_voice_run",
  "end_voice_run",
  "export_voice_evidence",
] as const;
const EXPECTED_STATUSES = ["ok", "accepted", "ok", "completed", "ok", "completed", "ok", "running", "completed", "completed"] as const;
const ALLOWED_ITEM_TYPES = new Set(["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction", "mcpToolCall"]);
const PACKAGE_HASH_ALGORITHM = "sophia-plugin-tree-sha256-v1";
const MAX_COMMAND_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

type P01Evidence = Extract<SignedExternalAttestation["evidence"], { kind: "p01_platform_plugin_task" }>;

export interface CommandCapture {
  argv: readonly string[];
  exit_code: number;
  signal: string | null;
  stdout_base64: string;
  stdout_sha256: string;
  stdout_bytes: number;
  stderr_base64: string;
  stderr_sha256: string;
  stderr_bytes: number;
}

export interface VerifiedCodexBinary {
  real_path_sha256: string;
  binary_sha256: string;
  version: string;
  version_capture: CommandCapture;
  signature_verify_capture: CommandCapture;
  signature_detail_capture: CommandCapture;
  signature_identifier: "codex";
  signature_team_identifier: "2DC432GLL2";
  signature_authority: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)";
}

export interface PluginPackageHash {
  algorithm: typeof PACKAGE_HASH_ALGORITHM;
  sha256: string;
  file_count: number;
  byte_count: number;
}

export interface RawJsonlFrame {
  sequence: number;
  direction: "controller_to_app_server" | "app_server_to_controller";
  raw_base64: string;
  raw_sha256: string;
  byte_length: number;
}

export interface P01CaptureBundle {
  schema: "sophia_voice_lab_p01_official_capture_v1";
  install: {
    installed_at: string;
    codex: VerifiedCodexBinary;
    source_package: PluginPackageHash;
    installed_package: PluginPackageHash;
    listed_source_package: PluginPackageHash;
    add: CommandCapture;
    list: CommandCapture;
    add_result_sha256: string;
    list_entry_sha256: string;
  };
  app_server: {
    frames: readonly RawJsonlFrame[];
    frame_chain_sha256: string;
    stderr_base64: string;
    stderr_sha256: string;
    stderr_bytes: number;
    exit_code: number;
    initialize_response_sha256: string;
    thread_start_response_sha256: string;
    app_installed_response_sha256: string;
    skills_list_response_sha256: string;
    turn_start_response_sha256: string;
    turn_completed_notification_sha256: string;
    evidence_resource_response_sha256: string;
    thread_read_response_sha256: string;
  };
  derived: {
    run_id_sha256: string;
    test_run_id_sha256: string;
    cleanup_obligation_id_sha256: string;
    platform_thread_id_sha256: string;
    platform_task_id_sha256: string;
    manifest_sha256: string;
    call_count: 10;
    mcp_item_replay_verified: true;
    source_receipt_sha256: string;
  };
}

export interface P01CollectionResult {
  claim: SignedExternalAttestation;
  capture: P01CaptureBundle;
}

export interface P01CollectorDependencies {
  now?: () => Date;
  verifyCodexBinary?: (input: P01CollectorInput, runCommand: CommandRunner) => Promise<VerifiedCodexBinary>;
  runCommand?: CommandRunner;
}

export type CommandRunner = (executable: string, args: readonly string[], options: { cwd: string; timeoutMs: number; maximumBytes?: number }) => Promise<CommandCapture>;

interface CapturedMessage {
  frame: RawJsonlFrame;
  value: Record<string, unknown>;
}

interface RequestResult {
  frame: RawJsonlFrame;
  value: unknown;
}

interface CollectedPlatformFacts {
  run: {
    run_id: string;
    test_run_id_sha256: string;
    cleanup_obligation_id_sha256: string;
    scenario_id: "V-P01";
    scenario_version: "vt00.scenarios.v1";
    environment: "production" | "staging";
    expected_deployment: { frontend: string; backend: string; voice: string };
  };
  evidenceWithoutInstallReceipt: Omit<P01Evidence, "install_receipt_sha256">;
  appServer: P01CaptureBundle["app_server"];
  manifestSha256: string;
}

const PluginAddOutputSchema = z.object({
  pluginId: z.string(), name: z.string(), marketplaceName: z.string(), version: z.string(), installedPath: z.string(), authPolicy: z.string(),
}).strict();

const PluginListEntrySchema = z.object({
  pluginId: z.string(), name: z.string(), marketplaceName: z.string(), version: z.string(), installed: z.boolean(), enabled: z.boolean(),
  source: z.object({ source: z.literal("local"), path: z.string() }).strict(),
  marketplaceSource: z.object({ sourceType: z.literal("local"), source: z.string() }).strict(),
  installPolicy: z.enum(["AVAILABLE", "INSTALLED_BY_DEFAULT"]), authPolicy: z.string(),
}).strict();

const PluginListOutputSchema = z.object({ installed: z.array(PluginListEntrySchema), available: z.array(z.unknown()) }).strict();

const AppContextSchema = z.object({
  connectorId: z.string(), linkId: z.string().min(1).nullable(), resourceUri: z.string().nullable(), appName: z.string().nullable(), actionName: z.string().nullable(),
}).strict();

const McpToolItemSchema = z.object({
  type: z.literal("mcpToolCall"), id: z.string().min(1), server: z.string().min(1), tool: z.string().min(1),
  status: z.enum(["inProgress", "completed", "failed"]), arguments: z.unknown(), appContext: AppContextSchema.nullable(),
  mcpAppResourceUri: z.string().optional(), pluginId: z.string().nullable(), readOnlyHint: z.boolean().nullable(),
  result: z.object({ content: z.array(z.unknown()), structuredContent: z.unknown().nullable(), _meta: z.unknown().nullable() }).strict().nullable(),
  error: z.object({ message: z.string() }).strict().nullable(), durationMs: z.number().nonnegative().nullable(),
}).strict();

const EvidenceReferenceSchema = z.object({
  kind: z.string(), resource_id: z.string(), sha256: z.string().regex(SHA256), content_type: z.string().optional(),
  byte_length: z.number().int().nonnegative().optional(), expires_at: z.string().optional(),
}).strict();

const VoiceLabEnvelopeSchema = z.object({
  contract_version: z.literal("sophia.voice-lab.v1"), request_id: z.string().uuid(), test_run_id: z.string().uuid().nullable(),
  run_id: z.string().uuid().nullable(), operation_id: z.string().uuid().nullable(), status: z.string(),
  deployment_identity: z.object({ expected: z.record(z.string(), z.unknown()), observed: z.record(z.string(), z.unknown()) }).strict(),
  evidence_references: z.array(EvidenceReferenceSchema), data: z.record(z.string(), z.unknown()),
}).passthrough();

const ProductManifestSchema = z.object({
  contract_version: z.literal("sophia.voice-lab.evidence.v1"), schema_version: z.literal("sophia.voice-lab.evidence.v1"),
  manifest_id: z.string().uuid(), run_id: z.string().uuid(), test_run_id: z.string().uuid(),
  cleanup_obligation: z.object({ cleanup_obligation_id_sha256: z.string().regex(SHA256), raw_identifier_excluded: z.literal(true) }).passthrough(),
  environment: z.enum(["production", "staging"]),
  scenario: z.object({ id: z.literal("V-P01"), version: z.literal("vt00.scenarios.v1") }).passthrough(),
  deployment_identity: z.object({
    expected: z.object({ frontend: z.string(), backend: z.string(), voice: z.string() }).strict(),
    observed: z.object({ frontend: z.string(), backend: z.string(), voice: z.string() }).strict(),
  }).passthrough(),
  run_lifecycle: z.object({ started_at: z.string().datetime({ offset: true }), ended_at: z.string().datetime({ offset: true }) }).passthrough(),
  versions: z.object({
    plugin: z.string(),
    registered_app: z.object({ technical_id: z.string(), plugin_package_sha256: z.string().regex(SHA256) }).passthrough(),
  }).passthrough(),
}).passthrough();

/**
 * Execute the owning source workflow and sign only facts derived from exact
 * process bytes. `controllerInput` cannot carry evidence or call outcomes.
 * The raw capture is durably persisted before the private signing key is read.
 */
export async function collectAndSignP01Claim(input: {
  controllerInput: unknown;
  publicConfig: PublicAuthorityConfig;
  platformPrivateKeyPath: string;
  persistCapture: (capture: P01CaptureBundle) => Promise<void>;
  dependencies?: P01CollectorDependencies;
}): Promise<P01CollectionResult> {
  const controller = P01CollectorInputSchema.parse(input.controllerInput);
  await assertAbsoluteDirectory(controller.execution.cwd, "P01 working directory");
  await assertAbsoluteDirectory(controller.plugin.source_root, "P01 plugin source root");
  const runCommand = input.dependencies?.runCommand ?? captureCommand;
  const now = input.dependencies?.now ?? (() => new Date());
  const verifyBinary = input.dependencies?.verifyCodexBinary ?? verifySignedCodexBinary;

  // Verify every immutable input before the first state-changing CLI command.
  const codex = await verifyBinary(controller, runCommand);
  const sourcePackage = await hashPluginPackage(controller.plugin.source_root);
  if (sourcePackage.sha256 !== controller.plugin.package_sha256) throw new Error("P01 source plugin package SHA-256 does not match the pinned campaign identity.");
  await validateRegisteredAppPackage(controller.plugin.source_root, controller);

  const add = await runCommand(controller.codex.binary_path, ["plugin", "add", controller.plugin.selector, "--json"], {
    cwd: controller.execution.cwd, timeoutMs: controller.execution.request_timeout_ms,
  });
  requireSuccessfulCommand(add, "codex plugin add --json");
  const addResult = PluginAddOutputSchema.parse(parseSingleJson(add.stdout_base64, "plugin add stdout"));
  assertPluginAddResult(addResult, controller);
  const installedAt = floorToSecond(now()).toISOString();
  const installedRoot = await assertAbsoluteDirectory(addResult.installedPath, "installed plugin root");
  const installedPackage = await hashPluginPackage(installedRoot);
  if (installedPackage.sha256 !== controller.plugin.package_sha256) throw new Error("Installed plugin bytes do not match the pinned package SHA-256.");
  await validateRegisteredAppPackage(installedRoot, controller);

  const list = await runCommand(controller.codex.binary_path, ["plugin", "list", "--json"], {
    cwd: controller.execution.cwd, timeoutMs: controller.execution.request_timeout_ms,
  });
  requireSuccessfulCommand(list, "codex plugin list --json");
  const listOutput = PluginListOutputSchema.parse(parseSingleJson(list.stdout_base64, "plugin list stdout"));
  const selectedRows = listOutput.installed.filter((entry) => entry.pluginId === controller.plugin.plugin_id);
  if (selectedRows.length !== 1) throw new Error("P01 plugin list must contain exactly one installed row for the selected plugin.");
  const listEntry = selectedRows[0]!;
  assertPluginListEntry(listEntry, controller);
  const listedSourceRoot = await assertAbsoluteDirectory(listEntry.source.path, "listed plugin source root");
  const listedSourcePackage = await hashPluginPackage(listedSourceRoot);
  if (listedSourcePackage.sha256 !== controller.plugin.package_sha256) throw new Error("Listed plugin source bytes do not match the pinned package SHA-256.");
  await validateRegisteredAppPackage(listedSourceRoot, controller);

  const platform = await collectAppServerFacts(controller, installedAt, installedRoot);
  const sourceReceipt = {
    schema: "sophia_voice_lab_p01_official_source_receipt_v1", installed_at: installedAt,
    codex: {
      binary_sha256: codex.binary_sha256, real_path_sha256: codex.real_path_sha256, version: codex.version,
      version_stdout_sha256: codex.version_capture.stdout_sha256,
      signature_verify_stdout_sha256: codex.signature_verify_capture.stdout_sha256,
      signature_verify_stderr_sha256: codex.signature_verify_capture.stderr_sha256,
      signature_detail_stdout_sha256: codex.signature_detail_capture.stdout_sha256,
      signature_detail_stderr_sha256: codex.signature_detail_capture.stderr_sha256,
      signature_identifier: codex.signature_identifier, signature_team_identifier: codex.signature_team_identifier,
      signature_authority: codex.signature_authority,
    },
    plugin: {
      plugin_id: controller.plugin.plugin_id, version: controller.plugin.version, package_sha256: controller.plugin.package_sha256,
      add_stdout_sha256: add.stdout_sha256, add_stderr_sha256: add.stderr_sha256, add_exit_code: add.exit_code,
      list_stdout_sha256: list.stdout_sha256, list_stderr_sha256: list.stderr_sha256, list_exit_code: list.exit_code,
      add_result_sha256: canonicalRequestHash(addResult), list_entry_sha256: canonicalRequestHash(listEntry),
    },
    app_server: {
      frame_chain_sha256: platform.appServer.frame_chain_sha256, stderr_sha256: platform.appServer.stderr_sha256,
      exit_code: platform.appServer.exit_code, initialize_response_sha256: platform.appServer.initialize_response_sha256,
      thread_start_response_sha256: platform.appServer.thread_start_response_sha256,
      app_installed_response_sha256: platform.appServer.app_installed_response_sha256,
      skills_list_response_sha256: platform.appServer.skills_list_response_sha256,
      turn_start_response_sha256: platform.appServer.turn_start_response_sha256,
      turn_completed_notification_sha256: platform.appServer.turn_completed_notification_sha256,
      evidence_resource_response_sha256: platform.appServer.evidence_resource_response_sha256,
      thread_read_response_sha256: platform.appServer.thread_read_response_sha256,
    },
  };
  const sourceReceiptSha256 = canonicalRequestHash(sourceReceipt);
  const evidence: P01Evidence = { ...platform.evidenceWithoutInstallReceipt, install_receipt_sha256: sourceReceiptSha256 };
  const capture: P01CaptureBundle = {
    schema: "sophia_voice_lab_p01_official_capture_v1",
    install: {
      installed_at: installedAt, codex, source_package: sourcePackage, installed_package: installedPackage,
      listed_source_package: listedSourcePackage, add, list, add_result_sha256: canonicalRequestHash(addResult),
      list_entry_sha256: canonicalRequestHash(listEntry),
    },
    app_server: platform.appServer,
    derived: {
      run_id_sha256: sha256(platform.run.run_id), test_run_id_sha256: platform.run.test_run_id_sha256,
      cleanup_obligation_id_sha256: platform.run.cleanup_obligation_id_sha256,
      platform_thread_id_sha256: evidence.platform_thread_id_sha256, platform_task_id_sha256: evidence.platform_task_id_sha256,
      manifest_sha256: platform.manifestSha256, call_count: 10, mcp_item_replay_verified: true, source_receipt_sha256: sourceReceiptSha256,
    },
  };

  await input.persistCapture(capture);
  const signingNow = now();
  const unsigned = newUnsignedClaim({ run: platform.run, authority: "platform_plugin", publicConfig: input.publicConfig, evidence, now: signingNow });
  const claim = await signExternalClaim(unsigned, input.publicConfig, input.platformPrivateKeyPath, signingNow);
  return { claim, capture };
}

async function collectAppServerFacts(controller: P01CollectorInput, installedAt: string, installedRoot: string): Promise<CollectedPlatformFacts> {
  const client = new JsonlAppServerClient(controller.codex.binary_path, ["app-server", "--stdio"], {
    cwd: controller.execution.cwd, requestTimeoutMs: controller.execution.request_timeout_ms,
    shutdownTimeoutMs: controller.execution.shutdown_timeout_ms, maximumFrameBytes: controller.execution.maximum_frame_bytes,
    maximumCaptureBytes: controller.execution.maximum_capture_bytes,
  });
  try {
    const initialize = await client.request("initialize", {
      clientInfo: { name: "sophia-voice-lab-p01-collector", title: "Sophia Voice Lab P01 Collector", version: "1.0.0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    const initializeValue = expectRecord(initialize.value, "initialize response");
    if (typeof initializeValue.userAgent !== "string" || !initializeValue.userAgent.toLowerCase().includes("codex")) throw new Error("App Server initialize did not identify the Codex server.");
    client.notify("initialized");

    const threadStart = await client.request("thread/start", {
      model: controller.execution.model, cwd: controller.execution.cwd, approvalPolicy: "never", sandbox: "read-only",
      ephemeral: false, historyMode: "legacy",
      developerInstructions: "Use only the selected Sophia Voice Lab skill and registered app. Do not use shell, filesystem mutation, web search, raw JavaScript, local runners, dynamic tools, collaboration, or manual takeover. Make exactly the ten requested MCP tool calls and then stop.",
    });
    const thread = expectRecord(expectRecord(threadStart.value, "thread/start response").thread, "thread/start thread");
    const threadId = expectString(thread.id, "fresh thread id");
    if (thread.parentThreadId !== null || thread.forkedFromId !== null || thread.ephemeral !== false || !Array.isArray(thread.turns) || thread.turns.length !== 0 || thread.source !== "appServer") {
      throw new Error("P01 requires one fresh persisted root App Server thread, not a fork, subagent, resumed thread, or ephemeral task.");
    }

    const appInstalled = await client.request("app/installed", { threadId, forceRefresh: true });
    const apps = expectArray(expectRecord(appInstalled.value, "app/installed response").apps, "installed apps");
    const matchingApps = apps.filter((entry) => isRecord(entry) && entry.id === controller.app.registered_app_id);
    if (matchingApps.length !== 1) throw new Error("app/installed(forceRefresh) did not return exactly one expected registered app.");
    const installedApp = expectRecord(matchingApps[0], "installed app");
    if (installedApp.runtimeName !== controller.app.runtime_name || installedApp.enabled !== true || installedApp.callable !== true) throw new Error("The registered app is not exactly enabled and callable under its expected runtime name.");

    const skillsList = await client.request("skills/list", { cwds: [controller.execution.cwd], forceReload: true });
    const skillEntries = expectArray(expectRecord(skillsList.value, "skills/list response").data, "skills/list data");
    if (skillEntries.length !== 1) throw new Error("skills/list must return exactly the requested working-directory entry.");
    const skillEntry = expectRecord(skillEntries[0], "skills/list cwd entry");
    if (skillEntry.cwd !== controller.execution.cwd || !Array.isArray(skillEntry.errors) || skillEntry.errors.length !== 0) throw new Error("skills/list returned a wrong cwd or discovery errors.");
    const skillPath = path.join(installedRoot, controller.plugin.skill_relative_path);
    const skills = expectArray(skillEntry.skills, "skills/list skills");
    const matchingSkills = skills.filter((entry) => isRecord(entry) && entry.name === controller.plugin.skill_name);
    if (matchingSkills.length !== 1) throw new Error("skills/list did not return exactly one expected installed plugin skill.");
    const skill = expectRecord(matchingSkills[0], "installed plugin skill");
    if (skill.enabled !== true || await realpath(expectString(skill.path, "skill path")) !== await realpath(skillPath)) throw new Error("The selected skill is disabled or not loaded from the exact installed plugin package.");

    const turnStart = await client.request("turn/start", {
      threadId,
      input: [
        { type: "text", text: buildFixedP01Prompt(controller), text_elements: [] },
        { type: "skill", name: controller.plugin.skill_name, path: skillPath },
        { type: "mention", name: controller.app.runtime_name, path: `app://${controller.app.registered_app_id}` },
      ],
    });
    const startedTurn = expectRecord(expectRecord(turnStart.value, "turn/start response").turn, "turn/start turn");
    const turnId = expectString(startedTurn.id, "fresh task id");
    if (startedTurn.status !== "inProgress") throw new Error("turn/start did not create one in-progress fresh task.");

    const turnCompleted = await client.waitForNotification("turn/completed", (message) => {
      const params = isRecord(message.value.params) ? message.value.params : null;
      const candidate = params && isRecord(params.turn) ? params.turn : null;
      return params?.threadId === threadId && candidate?.id === turnId;
    });
    const completedTurn = expectRecord(expectRecord(turnCompleted.value.params, "turn/completed params").turn, "turn/completed turn");
    if (completedTurn.status !== "completed" || completedTurn.error !== null) throw new Error("P01 fresh task did not complete successfully.");
    const taskStartedAt = epochSecondsToIso(completedTurn.startedAt, "turn startedAt");
    const taskCompletedAt = epochSecondsToIso(completedTurn.completedAt, "turn completedAt");
    if (Date.parse(installedAt) > Date.parse(taskStartedAt) || Date.parse(taskStartedAt) > Date.parse(taskCompletedAt)) throw new Error("P01 install/task timestamps are not monotonic.");

    const completedItems = collectCompletedMcpItems(client.messages, threadId, turnId, turnCompleted.frame.sequence);
    const startedItems = collectStartedMcpItems(client.messages, threadId, turnId, turnCompleted.frame.sequence);
    validateMcpItemLifecycles(startedItems, completedItems, controller);
    const derivedCalls = validateAndDeriveCalls(completedItems, controller);
    const exportEnvelope = derivedCalls.envelopes[9]!;
    const manifestRef = exactManifestReference(exportEnvelope);
    const resourceRead = await client.request("mcpServer/resource/read", { threadId, server: completedItems[9]!.server, uri: manifestRef.resource_id });
    const manifestBytes = exactManifestBytes(resourceRead.value, manifestRef);
    const manifest = ProductManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    validateProductManifest(manifest, controller, derivedCalls, taskStartedAt, taskCompletedAt, manifestRef, manifestBytes);

    const threadRead = await client.request("thread/read", { threadId, includeTurns: true });
    validateThreadReadReplay(threadRead.value, threadId, turnId, completedTurn, completedItems);
    validateNoPostTerminalItems(client.messages, threadId, turnId, turnCompleted.frame.sequence);
    const closed = await client.close();

    const run = {
      run_id: manifest.run_id, test_run_id_sha256: sha256(manifest.test_run_id),
      cleanup_obligation_id_sha256: manifest.cleanup_obligation.cleanup_obligation_id_sha256,
      scenario_id: "V-P01" as const, scenario_version: "vt00.scenarios.v1" as const,
      environment: manifest.environment, expected_deployment: controller.campaign.expected_deployment,
    };
    const evidenceWithoutInstallReceipt: Omit<P01Evidence, "install_receipt_sha256"> = {
      kind: "p01_platform_plugin_task", authority: "platform_plugin", registered_app_id: controller.app.registered_app_id,
      plugin_version: controller.plugin.version, platform_task_id_sha256: sha256(turnId), platform_thread_id_sha256: sha256(threadId),
      plugin_package_sha256: controller.plugin.package_sha256, installed_at: installedAt, fresh_task_started_at: taskStartedAt,
      fresh_task_completed_at: taskCompletedAt, high_level_call_count: 10, calls: derivedCalls.calls,
      polling_call_count: 0, polling_calls: [], operation_ids: derivedCalls.operationIds,
      adaptive_observation_call_ordinal: 5, adaptive_followup_call_ordinal: 6,
      prohibited_tool_audit_passed: true, raw_javascript_used: false, local_runner_used: false, manual_takeover_used: false,
      exact_deployment_discovered: true, adaptive_followup_completed: true,
    };
    return {
      run, evidenceWithoutInstallReceipt, manifestSha256: manifestRef.sha256,
      appServer: {
        frames: client.frames, frame_chain_sha256: hashFrameChain(client.frames),
        stderr_base64: closed.stderr.toString("base64"), stderr_sha256: sha256(closed.stderr), stderr_bytes: closed.stderr.byteLength,
        exit_code: closed.exitCode, initialize_response_sha256: initialize.frame.raw_sha256,
        thread_start_response_sha256: threadStart.frame.raw_sha256, app_installed_response_sha256: appInstalled.frame.raw_sha256,
        skills_list_response_sha256: skillsList.frame.raw_sha256, turn_start_response_sha256: turnStart.frame.raw_sha256,
        turn_completed_notification_sha256: turnCompleted.frame.raw_sha256, evidence_resource_response_sha256: resourceRead.frame.raw_sha256,
        thread_read_response_sha256: threadRead.frame.raw_sha256,
      },
    };
  } catch (error) {
    await client.abort();
    throw error;
  }
}

function validateAndDeriveCalls(items: readonly z.infer<typeof McpToolItemSchema>[], controller: P01CollectorInput): {
  calls: P01Evidence["calls"];
  envelopes: Array<z.infer<typeof VoiceLabEnvelopeSchema>>;
  operationIds: string[];
} {
  const envelopes: Array<z.infer<typeof VoiceLabEnvelopeSchema>> = [];
  const calls: P01Evidence["calls"] = [];
  const operationIds: string[] = [];
  let runId: string | null = null;
  let testRunId: string | null = null;
  for (let index = 0; index < EXPECTED_TOOLS.length; index += 1) {
    const item = items[index]!;
    const tool = EXPECTED_TOOLS[index]!;
    if (item.tool !== tool) throw new Error(`P01 MCP tool order drifted at ordinal ${index + 1}.`);
    const parser = toolInputSchemas[tool];
    const parsedArguments = parser.parse(item.arguments);
    if (canonicalRequestHash(parsedArguments) !== canonicalRequestHash(item.arguments)) throw new Error(`P01 call ${index + 1} relied on implicit argument defaults; public and durable argument hashes would diverge.`);
    const envelope = VoiceLabEnvelopeSchema.parse(item.result?.structuredContent);
    envelopes.push(envelope);
    if (envelope.status !== EXPECTED_STATUSES[index]) throw new Error(`P01 call ${index + 1} returned a noncanonical status.`);
    if (index === 0) {
      if (envelope.run_id !== null || envelope.test_run_id !== null || envelope.operation_id !== null) throw new Error("get_capabilities unexpectedly carried a run or operation identity.");
    } else {
      if (!envelope.run_id || !envelope.test_run_id) throw new Error(`P01 call ${index + 1} omitted its run/test identity.`);
      runId ??= envelope.run_id;
      testRunId ??= envelope.test_run_id;
      if (envelope.run_id !== runId || envelope.test_run_id !== testRunId) throw new Error("P01 calls crossed run or test-run identities.");
    }
    const operationExpected = [1, 3, 5, 8].includes(index);
    if (operationExpected !== (envelope.operation_id !== null)) throw new Error(`P01 call ${index + 1} operation cardinality is invalid.`);
    if (envelope.operation_id) operationIds.push(envelope.operation_id);
    const data = envelope.data;
    if ([1, 3, 5, 8].includes(index) && (data.submission_outcome !== "durably_accepted" || data.replay !== false)) throw new Error(`P01 mutating call ${index + 1} did not distinguish one fresh durable submission from its operation state.`);
    if ([2, 4, 6].includes(index) && data.condition_satisfied !== true) throw new Error(`P01 wait call ${index + 1} did not satisfy its exact condition.`);
    if (index === 1 && data.operation_state !== "accepted") throw new Error("P01 start operation was not accepted.");
    if ([3, 5, 8].includes(index) && data.operation_state !== "succeeded") throw new Error(`P01 mutating call ${index + 1} did not settle exactly once as succeeded.`);
    if (index === 7 && !["active", "ready", "running"].includes(String(data.run_state ?? envelope.status))) throw new Error("P01 inspect did not observe the live run before cleanup.");
    if (index >= 8 && (data.cleanup_complete !== true || data.evidence_state !== "available" || typeof data.manifest_id !== "string" || typeof data.manifest_sha256 !== "string")) throw new Error("P01 end/export did not prove cleanup and durable evidence.");
    calls.push({
      ordinal: index + 1, observed_order: index + 1, tool_name: tool,
      argument_sha256: canonicalRequestHash(item.arguments), response_sha256: canonicalRequestHash(envelope),
      result_request_id_sha256: sha256(envelope.request_id), run_id_sha256: envelope.run_id ? sha256(envelope.run_id) : null,
      operation_id_sha256: envelope.operation_id ? sha256(envelope.operation_id) : null,
    });
  }
  if (!runId || !testRunId || new Set(operationIds).size !== 4 || operationIds.length !== 4) throw new Error("P01 did not produce exactly four distinct start/speak/speak/end operations.");
  const start = toolInputSchemas.start_voice_run.parse(items[1]!.arguments);
  if (start.environment !== controller.campaign.environment || start.scenario_id !== "V-P01" || start.scenario_version !== "vt00.scenarios.v1"
    || canonicalRequestHash(start.target.expected_deployment) !== canonicalRequestHash(controller.campaign.expected_deployment)) throw new Error("P01 start arguments did not select the exact campaign and deployment.");
  for (const ordinal of [3, 4, 5, 6, 7, 8, 9, 10]) {
    const argumentsValue = expectRecord(items[ordinal - 1]!.arguments, `P01 call ${ordinal} arguments`);
    if (argumentsValue.run_id !== runId) throw new Error(`P01 call ${ordinal} did not target the fresh run.`);
  }
  const firstSpeak = toolInputSchemas.speak.parse(items[3]!.arguments);
  const adaptiveSpeak = toolInputSchemas.speak.parse(items[5]!.arguments);
  if (firstSpeak.adaptive_observation !== undefined || adaptiveSpeak.adaptive_observation === undefined || !("receipt" in adaptiveSpeak.adaptive_observation)) throw new Error("P01 adaptive follow-up was not derived from one typed service receipt after the first observation.");
  const observationEnvelope = envelopes[4]!;
  const matchedEvents = Array.isArray(observationEnvelope.data.matched) ? observationEnvelope.data.matched : [];
  const returnedReceipts = Array.isArray(observationEnvelope.data.observation_receipts) ? observationEnvelope.data.observation_receipts : [];
  const receipt = adaptiveSpeak.adaptive_observation.receipt;
  const exactObservation = matchedEvents.some((entry) => isRecord(entry) && entry.seq === receipt.event_seq
    && (entry.turn_id === receipt.turn_id || isRecord(entry.payload) && (entry.payload.turn_id === receipt.turn_id || isRecord(entry.payload.data) && entry.payload.data.turnId === receipt.turn_id)));
  if (returnedReceipts.length !== 1 || canonicalRequestHash(returnedReceipts[0]) !== canonicalRequestHash(receipt) || !exactObservation
    || receipt.run_id !== runId || receipt.test_run_id !== testRunId || receipt.scenario_id !== "V-P01" || receipt.scenario_version !== "vt00.scenarios.v1"
    || adaptiveSpeak.expected_cursor === undefined || adaptiveSpeak.expected_cursor < receipt.event_seq
    || adaptiveSpeak.expected_provider_epoch === undefined || adaptiveSpeak.expected_provider_epoch !== observationEnvelope.provider_connection_epoch
    || adaptiveSpeak.expected_turn_id !== receipt.turn_id) throw new Error("P01 adaptive speak did not bind the exact authenticated event/turn receipt and current execution preconditions returned by call five.");
  const endManifest = exactManifestReference(envelopes[8]!);
  const exportManifest = exactManifestReference(envelopes[9]!);
  if (canonicalRequestHash(endManifest) !== canonicalRequestHash(exportManifest)) throw new Error("P01 end and export did not return the identical immutable manifest.");
  return { calls, envelopes, operationIds };
}

function exactManifestReference(envelope: z.infer<typeof VoiceLabEnvelopeSchema>): z.infer<typeof EvidenceReferenceSchema> {
  const manifestId = envelope.data.manifest_id;
  const manifestSha = envelope.data.manifest_sha256;
  if (typeof manifestId !== "string" || !UUID.test(manifestId) || typeof manifestSha !== "string" || !SHA256.test(manifestSha)) throw new Error("P01 terminal response lacks an exact manifest identity.");
  const matches = envelope.evidence_references.filter((reference) => reference.kind === "manifest" && reference.resource_id === `voice-lab://evidence/${manifestId}` && reference.sha256 === manifestSha);
  if (matches.length !== 1) throw new Error("P01 terminal response does not contain exactly one matching manifest resource.");
  return matches[0]!;
}

function exactManifestBytes(raw: unknown, reference: z.infer<typeof EvidenceReferenceSchema>): Buffer {
  const contents = expectArray(expectRecord(raw, "mcpServer/resource/read response").contents, "resource contents");
  if (contents.length !== 1) throw new Error("P01 evidence resource read returned an ambiguous content set.");
  const content = expectRecord(contents[0], "evidence resource content");
  if (content.uri !== reference.resource_id || content.mimeType !== "application/json" || typeof content.text !== "string" || "blob" in content) throw new Error("P01 evidence resource did not return the exact JSON text resource.");
  const bytes = Buffer.from(content.text, "utf8");
  if (sha256(bytes) !== reference.sha256 || reference.byte_length !== undefined && reference.byte_length !== bytes.byteLength) throw new Error("P01 evidence resource bytes do not match the exported immutable reference.");
  return bytes;
}

function validateProductManifest(
  manifest: z.infer<typeof ProductManifestSchema>, controller: P01CollectorInput,
  calls: ReturnType<typeof validateAndDeriveCalls>, taskStartedAt: string, taskCompletedAt: string,
  reference: z.infer<typeof EvidenceReferenceSchema>, manifestBytes: Buffer,
): void {
  const runId = calls.envelopes[1]!.run_id;
  const testRunId = calls.envelopes[1]!.test_run_id;
  if (manifest.manifest_id !== calls.envelopes[9]!.data.manifest_id || sha256(manifestBytes) !== reference.sha256 || manifest.run_id !== runId || manifest.test_run_id !== testRunId) throw new Error("P01 product manifest does not bind the exact fresh task results.");
  if (manifest.environment !== controller.campaign.environment || manifest.scenario.id !== "V-P01" || manifest.scenario.version !== controller.campaign.scenario_version
    || canonicalRequestHash(manifest.deployment_identity.expected) !== canonicalRequestHash(controller.campaign.expected_deployment)
    || canonicalRequestHash(manifest.deployment_identity.observed) !== canonicalRequestHash(controller.campaign.expected_deployment)) throw new Error("P01 product manifest did not prove the exact campaign deployment.");
  if (manifest.versions.plugin !== controller.plugin.version || manifest.versions.registered_app.technical_id !== controller.app.registered_app_id
    || manifest.versions.registered_app.plugin_package_sha256 !== controller.plugin.package_sha256) throw new Error("P01 product manifest registered-app/package projection drifted.");
  const runStarted = Date.parse(manifest.run_lifecycle.started_at);
  const runEnded = Date.parse(manifest.run_lifecycle.ended_at);
  if (runStarted < Date.parse(taskStartedAt) || runEnded < runStarted || runEnded > Date.parse(taskCompletedAt)) throw new Error("P01 product run did not occur wholly inside the fresh App Server task.");
}

function collectCompletedMcpItems(messages: readonly CapturedMessage[], threadId: string, turnId: string, terminalSequence: number): Array<z.infer<typeof McpToolItemSchema>> {
  const completed: Array<z.infer<typeof McpToolItemSchema>> = [];
  for (const message of messages) {
    if (message.frame.sequence >= terminalSequence || message.value.method !== "item/completed") continue;
    const params = isRecord(message.value.params) ? message.value.params : null;
    if (!params || params.threadId !== threadId || params.turnId !== turnId || !isRecord(params.item)) continue;
    const type = String(params.item.type ?? "");
    if (!ALLOWED_ITEM_TYPES.has(type)) throw new Error(`P01 used prohibited App Server item type ${type || "unknown"}.`);
    if (type === "mcpToolCall") completed.push(McpToolItemSchema.parse(params.item));
  }
  if (completed.length !== 10) throw new Error("P01 fresh task must contain exactly ten completed MCP tool-call items.");
  return completed;
}

function collectStartedMcpItems(messages: readonly CapturedMessage[], threadId: string, turnId: string, terminalSequence: number): Array<z.infer<typeof McpToolItemSchema>> {
  const started: Array<z.infer<typeof McpToolItemSchema>> = [];
  for (const message of messages) {
    if (message.frame.sequence >= terminalSequence || message.value.method !== "item/started") continue;
    const params = isRecord(message.value.params) ? message.value.params : null;
    if (params?.threadId !== threadId || params.turnId !== turnId || !isRecord(params.item)) continue;
    const type = String(params.item.type ?? "");
    if (!ALLOWED_ITEM_TYPES.has(type)) throw new Error(`P01 used prohibited App Server item type ${type || "unknown"}.`);
    if (type === "mcpToolCall") started.push(McpToolItemSchema.parse(params.item));
  }
  return started;
}

function validateMcpItemLifecycles(started: readonly z.infer<typeof McpToolItemSchema>[], completed: readonly z.infer<typeof McpToolItemSchema>[], controller: P01CollectorInput): void {
  if (started.length !== 10 || new Set(started.map((item) => item.id)).size !== 10 || new Set(completed.map((item) => item.id)).size !== 10) throw new Error("P01 MCP item lifecycle cardinality is invalid.");
  let linkId: string | null = null;
  let server: string | null = null;
  for (let index = 0; index < 10; index += 1) {
    const start = started[index]!;
    const done = completed[index]!;
    if (start.status !== "inProgress" || start.result !== null || start.error !== null || done.status !== "completed" || done.result === null || done.error !== null
      || start.id !== done.id || start.tool !== done.tool || start.server !== done.server || canonicalRequestHash(start.arguments) !== canonicalRequestHash(done.arguments)) throw new Error(`P01 MCP item ${index + 1} did not have one exact in-progress to completed lifecycle.`);
    if (done.pluginId !== controller.plugin.plugin_id || done.appContext === null || done.appContext.connectorId !== controller.app.registered_app_id
      || done.appContext.appName !== controller.app.runtime_name || done.appContext.actionName !== done.tool || done.appContext.linkId === null) throw new Error(`P01 MCP item ${index + 1} lacks the exact plugin/app/connector/OAuth-link join.`);
    if (start.pluginId !== done.pluginId || canonicalRequestHash(start.appContext) !== canonicalRequestHash(done.appContext)) throw new Error(`P01 MCP item ${index + 1} changed source provenance during execution.`);
    linkId ??= done.appContext.linkId;
    server ??= done.server;
    if (done.appContext.linkId !== linkId || done.server !== server) throw new Error("P01 MCP calls crossed connector links or server runtimes.");
  }
}

function validateThreadReadReplay(raw: unknown, threadId: string, turnId: string, completedTurn: Record<string, unknown>, completedItems: readonly z.infer<typeof McpToolItemSchema>[]): void {
  const thread = expectRecord(expectRecord(raw, "thread/read response").thread, "thread/read thread");
  if (thread.id !== threadId || thread.parentThreadId !== null || thread.forkedFromId !== null || thread.ephemeral !== false || !Array.isArray(thread.turns) || thread.turns.length !== 1) throw new Error("thread/read did not replay the exact fresh root thread.");
  const turn = expectRecord(thread.turns[0], "thread/read turn");
  if (turn.id !== turnId || turn.status !== "completed" || turn.startedAt !== completedTurn.startedAt || turn.completedAt !== completedTurn.completedAt || !Array.isArray(turn.items)) throw new Error("thread/read did not replay the exact completed task envelope.");
  const replayItems = turn.items.filter((item) => isRecord(item) && item.type === "mcpToolCall").map((item) => McpToolItemSchema.parse(item));
  if (replayItems.length !== 10) throw new Error("thread/read did not replay exactly ten MCP items.");
  for (const item of turn.items) if (isRecord(item) && !ALLOWED_ITEM_TYPES.has(String(item.type ?? ""))) throw new Error("thread/read exposed a prohibited tool/item in the fresh task.");
  for (let index = 0; index < 10; index += 1) if (canonicalRequestHash(replayItems[index]) !== canonicalRequestHash(completedItems[index])) throw new Error(`thread/read MCP replay drifted at ordinal ${index + 1}.`);
}

function validateNoPostTerminalItems(messages: readonly CapturedMessage[], threadId: string, turnId: string, terminalSequence: number): void {
  for (const message of messages) {
    if (message.frame.sequence <= terminalSequence || !["item/started", "item/completed"].includes(String(message.value.method ?? ""))) continue;
    const params = isRecord(message.value.params) ? message.value.params : null;
    if (params?.threadId === threadId && params.turnId === turnId) throw new Error("P01 observed a tool/item lifecycle after the terminal task notification.");
  }
}

function buildFixedP01Prompt(controller: P01CollectorInput): string {
  const deployment = controller.campaign.expected_deployment;
  return [
    `$${controller.plugin.skill_name} Use only $sophia-voice-lab through the attached registered app to execute one fresh governed V-P01 smoke in ${controller.campaign.environment}.`,
    `Discover and require this exact deployment: frontend=${deployment.frontend}, backend=${deployment.backend}, voice=${deployment.voice}.`,
    "Make exactly these ten MCP tool calls, in order, with no retries or polling calls: get_capabilities; start_voice_run; wait_for_turn; speak; wait_for_turn; speak; wait_for_turn; inspect_voice_run; end_voice_run; export_voice_evidence.",
    "The second speak must be an adaptive follow-up explicitly bound to the event sequence and turn ID returned by call five. Every wait must return condition_satisfied=true.",
    "Use scenario V-P01 at vt00.scenarios.v1, explicit arguments (including defaults), fresh stable idempotency keys, and the exact deployment. End and export even if product evidence is unavailable; do not call any other tool or take over manually.",
  ].join("\n");
}

export async function verifySignedCodexBinary(input: P01CollectorInput, runCommand: CommandRunner = captureCommand): Promise<VerifiedCodexBinary> {
  const binary = await assertAbsoluteRegularFile(input.codex.binary_path, "Codex CLI binary");
  const binarySha256 = sha256(await readFile(binary));
  if (binarySha256 !== input.codex.binary_sha256) throw new Error("Codex CLI binary SHA-256 does not match the pinned collector input.");
  const versionCapture = await runCommand(binary, ["--version"], { cwd: input.execution.cwd, timeoutMs: 30_000, maximumBytes: 64 * 1024 });
  requireSuccessfulCommand(versionCapture, "codex --version");
  const version = Buffer.from(versionCapture.stdout_base64, "base64").toString("utf8").trim();
  if (version !== input.codex.version) throw new Error("Codex CLI version output does not match the pinned collector input.");
  if (process.platform !== "darwin") throw new Error("P01 production collection requires the signed macOS Codex binary and fails closed on unsupported signature platforms.");
  const signatureVerify = await runCommand("/usr/bin/codesign", ["--verify", "--strict", binary], { cwd: input.execution.cwd, timeoutMs: 30_000, maximumBytes: 256 * 1024 });
  requireSuccessfulCommand(signatureVerify, "codesign --verify --strict");
  const signatureDetail = await runCommand("/usr/bin/codesign", ["-dv", "--verbose=4", binary], { cwd: input.execution.cwd, timeoutMs: 30_000, maximumBytes: 512 * 1024 });
  requireSuccessfulCommand(signatureDetail, "codesign -dv --verbose=4");
  const detail = `${Buffer.from(signatureDetail.stdout_base64, "base64").toString("utf8")}\n${Buffer.from(signatureDetail.stderr_base64, "base64").toString("utf8")}`;
  if (!/^Identifier=codex$/m.test(detail) || !/^TeamIdentifier=2DC432GLL2$/m.test(detail) || !/^Authority=Developer ID Application: OpenAI OpCo, LLC \(2DC432GLL2\)$/m.test(detail)) throw new Error("Codex CLI code signature is not the exact OpenAI Developer ID identity.");
  return {
    real_path_sha256: sha256(binary), binary_sha256: binarySha256, version, version_capture: versionCapture,
    signature_verify_capture: signatureVerify, signature_detail_capture: signatureDetail, signature_identifier: "codex",
    signature_team_identifier: "2DC432GLL2", signature_authority: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
  };
}

export async function hashPluginPackage(pluginRoot: string): Promise<PluginPackageHash> {
  const root = await assertAbsoluteDirectory(pluginRoot, "plugin package root");
  const manifest = path.join(root, ".codex-plugin", "plugin.json");
  const manifestStat = await lstat(manifest).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) throw new Error("Plugin root is missing a regular .codex-plugin/plugin.json manifest.");
  const files = await packageFiles(root);
  const digest = createHash("sha256");
  digest.update(Buffer.from(`${PACKAGE_HASH_ALGORITHM}\0`, "ascii"));
  let byteCount = 0;
  for (const relative of files) {
    const content = await readFile(path.join(root, relative));
    rejectSecretContent(relative, content);
    const pathBytes = Buffer.from(relative, "utf8");
    digest.update(uint64(pathBytes.byteLength)); digest.update(pathBytes); digest.update(uint64(content.byteLength));
    digest.update(createHash("sha256").update(content).digest());
    byteCount += content.byteLength;
  }
  return { algorithm: PACKAGE_HASH_ALGORITHM, sha256: digest.digest("hex"), file_count: files.length, byte_count: byteCount };
}

async function validateRegisteredAppPackage(root: string, controller: P01CollectorInput): Promise<void> {
  const pluginManifest = expectRecord(JSON.parse((await readFile(path.join(root, ".codex-plugin", "plugin.json"))).toString("utf8")) as unknown, "plugin manifest");
  if (pluginManifest.name !== controller.plugin.name || pluginManifest.version !== controller.plugin.version || pluginManifest.apps !== "./.app.json") throw new Error("Installed plugin manifest does not bind the exact version and .app.json compatibility mapping.");
  const appManifest = expectRecord(JSON.parse((await readFile(path.join(root, ".app.json"))).toString("utf8")) as unknown, ".app.json");
  const entries = Object.entries(expectRecord(appManifest.apps, ".app.json apps"));
  if (entries.length !== 1 || entries[0]![0] !== controller.plugin.name) throw new Error(".app.json must contain exactly one Sophia Voice Lab app mapping.");
  if (expectRecord(entries[0]![1], ".app.json app mapping").id !== controller.app.registered_app_id) throw new Error(".app.json does not contain the exact registered technical app ID.");
}

async function packageFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    rejectUnsafePackagePath(child);
    const childStat = await lstat(path.join(root, child));
    if (childStat.isSymbolicLink()) throw new Error(`Plugin package symbolic links are forbidden: ${child}`);
    if (childStat.isDirectory()) files.push(...await packageFiles(root, child));
    else if (childStat.isFile()) files.push(child);
    else throw new Error(`Plugin package contains a non-regular entry: ${child}`);
  }
  return files;
}

function rejectUnsafePackagePath(relative: string): void {
  const parts = relative.split("/");
  const name = parts.at(-1)!.toLowerCase();
  const suffix = path.extname(name);
  if (parts.some((part) => [".pytest_cache", "__pycache__"].includes(part.toLowerCase())) || name === ".ds_store" || name.endsWith("~") || [".pyc", ".pyo", ".swp", ".tmp"].includes(suffix)) throw new Error(`Transient plugin path is forbidden: ${relative}`);
  if ([".env", ".netrc", "cookies.json", "credentials.json", "id_ed25519", "id_rsa", "secrets.json", "storage-state.json"].includes(name) || name.startsWith(".env.") || [".der", ".jks", ".key", ".keystore", ".p12", ".pfx", ".pem"].includes(suffix)) throw new Error(`Credential-bearing plugin path is forbidden: ${relative}`);
}

function rejectSecretContent(relative: string, bytes: Buffer): void {
  const content = bytes.toString("latin1");
  const patterns = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, /\bAKIA[0-9A-Z]{16}\b/,
    /"(?:access_token|refresh_token|client_secret|password|cookie|authorization)"\s*:\s*"(?!(?:<[^>]+>|\$\{[^}]+\}|REDACTED|CHANGEME)")[^"]{8,}"/i,
  ];
  if (patterns.some((pattern) => pattern.test(content))) throw new Error(`Refusing to hash plugin file containing secret-like material: ${relative}`);
}

function uint64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

export const captureCommand: CommandRunner = async (executable, args, options) => {
  const maximumBytes = options.maximumBytes ?? MAX_COMMAND_BYTES;
  const child = spawn(executable, [...args], { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow: Error | null = null;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > maximumBytes) { overflow = new Error("External command output exceeded its bounded capture size."); child.kill("SIGKILL"); return; }
    stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > maximumBytes) { overflow = new Error("External command output exceeded its bounded capture size."); child.kill("SIGKILL"); return; }
    stderr.push(Buffer.from(chunk));
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("External command timed out.")); }, options.timeoutMs);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  if (overflow) throw overflow;
  if (result.code === null) throw new Error(`External command terminated by signal ${result.signal ?? "unknown"}.`);
  const stdoutBuffer = Buffer.concat(stdout);
  const stderrBuffer = Buffer.concat(stderr);
  return {
    argv: args, exit_code: result.code, signal: result.signal,
    stdout_base64: stdoutBuffer.toString("base64"), stdout_sha256: sha256(stdoutBuffer), stdout_bytes: stdoutBuffer.byteLength,
    stderr_base64: stderrBuffer.toString("base64"), stderr_sha256: sha256(stderrBuffer), stderr_bytes: stderrBuffer.byteLength,
  };
};

class JsonlAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: { requestTimeoutMs: number; shutdownTimeoutMs: number; maximumFrameBytes: number; maximumCaptureBytes: number };
  readonly #pending = new Map<number, { resolve: (message: CapturedMessage) => void; reject: (error: Error) => void }>();
  readonly #messages: CapturedMessage[] = [];
  readonly #frames: RawJsonlFrame[] = [];
  readonly #stderr: Buffer[] = [];
  readonly #changeWaiters = new Set<() => void>();
  #stdoutBuffer = Buffer.alloc(0);
  #stderrBytes = 0;
  #captureBytes = 0;
  #nextId = 1;
  #sequence = 0;
  #fatal: Error | null = null;
  #closing = false;
  #closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(executable: string, args: readonly string[], options: { cwd: string; requestTimeoutMs: number; shutdownTimeoutMs: number; maximumFrameBytes: number; maximumCaptureBytes: number }) {
    this.#options = options;
    this.#child = spawn(executable, [...args], { cwd: options.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.#closed = new Promise((resolve) => {
      this.#child.once("close", (code, signal) => {
        if (!this.#closing && this.#fatal === null) this.#fail(new Error(`Codex App Server exited before collection completed (${code ?? signal ?? "unknown"}).`));
        resolve({ code, signal });
      });
    });
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.stdout.on("data", (chunk: Buffer) => this.#acceptStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#captureBytes + this.#stderrBytes > this.#options.maximumCaptureBytes) this.#fail(new Error("Codex App Server capture exceeded its byte bound."));
      else this.#stderr.push(Buffer.from(chunk));
    });
  }

  get frames(): readonly RawJsonlFrame[] { return this.#frames; }
  get messages(): readonly CapturedMessage[] { return this.#messages; }

  async request(method: string, params: unknown): Promise<RequestResult> {
    this.#throwIfFatal();
    const id = this.#nextId++;
    const response = new Promise<CapturedMessage>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#send({ method, id, params });
    const message = await withTimeout(response, this.#options.requestTimeoutMs, `App Server ${method} request timed out.`);
    if ("error" in message.value) throw new Error(`App Server ${method} returned a JSON-RPC error.`);
    if (!("result" in message.value)) throw new Error(`App Server ${method} response omitted result.`);
    return { frame: message.frame, value: message.value.result };
  }

  notify(method: string): void { this.#throwIfFatal(); this.#send({ method }); }

  async waitForNotification(method: string, predicate: (message: CapturedMessage) => boolean): Promise<CapturedMessage> {
    const deadline = Date.now() + this.#options.requestTimeoutMs;
    while (Date.now() < deadline) {
      this.#throwIfFatal();
      const match = this.#messages.find((message) => message.value.method === method && predicate(message));
      if (match) return match;
      await this.#waitForChange(Math.max(1, deadline - Date.now()));
    }
    throw new Error(`App Server ${method} notification timed out.`);
  }

  async close(): Promise<{ exitCode: number; stderr: Buffer }> {
    this.#throwIfFatal();
    this.#closing = true;
    this.#child.stdin.end();
    const closed = await withTimeout(this.#closed, this.#options.shutdownTimeoutMs, "Codex App Server did not exit after stdio EOF.");
    if (closed.code !== 0 || closed.signal !== null || this.#stdoutBuffer.length !== 0) throw new Error("Codex App Server did not terminate cleanly on the JSONL frame boundary.");
    this.#throwIfFatal();
    return { exitCode: closed.code, stderr: Buffer.concat(this.#stderr) };
  }

  async abort(): Promise<void> {
    this.#closing = true;
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM");
    await Promise.race([this.#closed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }

  #send(value: Record<string, unknown>): void {
    const raw = Buffer.from(JSON.stringify(value), "utf8");
    if (raw.byteLength === 0 || raw.byteLength > this.#options.maximumFrameBytes) throw new Error("P01 controller request exceeded its JSONL frame bound.");
    this.#captureFrame("controller_to_app_server", raw);
    this.#child.stdin.write(raw); this.#child.stdin.write("\n");
  }

  #acceptStdout(chunk: Buffer): void {
    if (this.#fatal) return;
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.#options.maximumFrameBytes) { this.#fail(new Error("Codex App Server emitted an over-size JSONL frame.")); return; }
      const raw = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (raw.byteLength === 0 || raw.byteLength > this.#options.maximumFrameBytes) { this.#fail(new Error("Codex App Server emitted an invalid JSONL frame size.")); return; }
      try {
        const value = expectRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown, "App Server JSONL frame");
        if ("jsonrpc" in value) throw new Error("App Server v2 frame unexpectedly carried a jsonrpc field.");
        const frame = this.#captureFrame("app_server_to_controller", Buffer.from(raw));
        const message = { frame, value };
        this.#messages.push(message);
        if ("id" in value) {
          if ("method" in value) throw new Error("P01 cannot auto-answer App Server requests or approvals; operator/manual takeover is forbidden.");
          const id = value.id;
          if (!Number.isSafeInteger(id)) throw new Error("App Server response ID is invalid.");
          const pending = this.#pending.get(id as number);
          if (!pending) throw new Error("App Server emitted an unknown or duplicate response ID.");
          this.#pending.delete(id as number); pending.resolve(message);
        }
        this.#signalChange();
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error("Invalid App Server JSONL frame.")); return;
      }
    }
    if (this.#stdoutBuffer.byteLength > this.#options.maximumFrameBytes) this.#fail(new Error("Codex App Server emitted an over-size or unterminated JSONL frame."));
  }

  #captureFrame(direction: RawJsonlFrame["direction"], raw: Buffer): RawJsonlFrame {
    this.#captureBytes += raw.byteLength;
    if (this.#captureBytes + this.#stderrBytes > this.#options.maximumCaptureBytes) throw new Error("Codex App Server capture exceeded its byte bound.");
    const frame: RawJsonlFrame = { sequence: ++this.#sequence, direction, raw_base64: raw.toString("base64"), raw_sha256: sha256(raw), byte_length: raw.byteLength };
    this.#frames.push(frame);
    return frame;
  }

  #waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timeout); this.#changeWaiters.delete(done); resolve(); };
      const timeout = setTimeout(() => { this.#changeWaiters.delete(done); reject(new Error("App Server notification wait timed out.")); }, timeoutMs);
      this.#changeWaiters.add(done);
    });
  }
  #signalChange(): void { for (const waiter of [...this.#changeWaiters]) waiter(); }
  #throwIfFatal(): void { if (this.#fatal) throw this.#fatal; }
  #fail(error: Error): void {
    if (this.#fatal) return;
    this.#fatal = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear(); this.#signalChange();
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM");
  }
}

function hashFrameChain(frames: readonly RawJsonlFrame[]): string {
  const digest = createHash("sha256");
  digest.update("sophia-p01-app-server-jsonl-chain-v1\0", "ascii");
  for (const frame of frames) {
    digest.update(frame.direction === "controller_to_app_server" ? Buffer.from([0]) : Buffer.from([1]));
    const raw = Buffer.from(frame.raw_base64, "base64");
    digest.update(uint64(raw.byteLength)); digest.update(raw);
  }
  return digest.digest("hex");
}

function assertPluginAddResult(result: z.infer<typeof PluginAddOutputSchema>, input: P01CollectorInput): void {
  if (result.pluginId !== input.plugin.plugin_id || result.name !== input.plugin.name || result.marketplaceName !== input.plugin.marketplace_name
    || result.version !== input.plugin.version || result.authPolicy !== "ON_INSTALL") throw new Error("codex plugin add --json returned a drifted plugin identity or auth policy.");
}
function assertPluginListEntry(result: z.infer<typeof PluginListEntrySchema>, input: P01CollectorInput): void {
  if (result.name !== input.plugin.name || result.marketplaceName !== input.plugin.marketplace_name || result.version !== input.plugin.version
    || result.installed !== true || result.enabled !== true || result.authPolicy !== "ON_INSTALL") throw new Error("codex plugin list --json did not prove the exact installed and enabled plugin.");
}
function requireSuccessfulCommand(capture: CommandCapture, label: string): void {
  if (capture.exit_code !== 0 || capture.signal !== null) throw new Error(`${label} did not exit successfully.`);
}
function parseSingleJson(base64: string, label: string): unknown {
  const bytes = Buffer.from(base64, "base64");
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!isRecord(value)) throw new Error(`${label} must be one JSON object.`);
    return value;
  } catch (error) {
    throw error instanceof Error && error.message.includes(label) ? error : new Error(`${label} is not one valid UTF-8 JSON object.`);
  }
}
async function assertAbsoluteRegularFile(target: string, label: string): Promise<string> {
  assertNormalizedAbsolute(target, label);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error(`${label} must be one regular, non-symlink, real-path file.`);
  return target;
}
async function assertAbsoluteDirectory(target: string, label: string): Promise<string> {
  assertNormalizedAbsolute(target, label);
  const info = await stat(target);
  if (!info.isDirectory() || await realpath(target) !== target) throw new Error(`${label} must be one real-path directory.`);
  return target;
}
function assertNormalizedAbsolute(target: string, label: string): void {
  if (!path.isAbsolute(target) || path.normalize(target) !== target) throw new Error(`${label} must be absolute and normalized.`);
}
function epochSecondsToIso(value: unknown, label: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} is invalid.`);
  return new Date(value * 1_000).toISOString();
}
function floorToSecond(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("Collector clock returned an invalid time.");
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}
function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be one JSON object.`);
  return value;
}
function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be one JSON array.`);
  return value;
}
function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be one nonempty string.`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { if (timeout) clearTimeout(timeout); }
}
