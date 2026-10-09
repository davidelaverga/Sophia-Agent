import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { VoiceLabConfig } from "../src/config.js";
import { TERMINAL_RUN_STATES as TERMINAL, VoiceLabError, type LabEnvelope } from "../src/domain.js";
import type { VoiceLabLedger } from "../src/ledger.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256, type AuthenticatedCaller } from "../src/security.js";
import { createVoiceLabMcpServer } from "../src/mcp-server.js";
import { STUDIO_G7_TOOL_NAMES, VoiceLabService, toolNamesForTarget } from "../src/service.js";
import { computeRunBindingSha256 } from "../src/studio-g7/contract.js";
import { STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA } from "../src/studio-g7/lease-release.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig } from "./helpers.js";
import { API_SHA, BRIDGE_SHA, EXCHANGE_UUID, GRANT_UUID, STUDIO_SHA, studioRun, studioTestConfig } from "./studio-g7-helpers.js";
import { ScriptedStudioDriver, newIdempotencyKey } from "./studio-g7-worker-helpers.js";

const caller: AuthenticatedCaller = { subject: "caller-1", scopes: new Set(["voice_lab:read", "voice_lab:run"]) };
const START = { environment: "production", scenario_id: "V-G07", scenario_version: "studio-g7-v1" } as const;

afterEach(() => { vi.useRealTimers(); });

describe("target-kind wiring in the service", () => {
  it("exposes the Studio G7 tools only on the Studio kind; the legacy tool surface is unchanged", async () => {
    expect(toolNamesForTarget(undefined)).toEqual(["get_capabilities", "start_voice_run", "speak", "wait_for_turn", "inspect_voice_run", "barge_in", "force_socket_rotation", "end_voice_run", "export_voice_evidence", "run_regression_suite", "get_suite_run"]);
    expect(toolNamesForTarget("studio-livekit-g7-v1")).toEqual([...toolNamesForTarget(undefined), ...STUDIO_G7_TOOL_NAMES]);
    const legacy = await new VoiceLabService(new MemoryVoiceLabLedger("test"), testConfig(), async () => []).getCapabilities(caller, {});
    expect(legacy.data.tools).toEqual(toolNamesForTarget(undefined));
    expect(legacy.data).not.toHaveProperty("studio_g7");
    const studio = await new VoiceLabService(new MemoryVoiceLabLedger("test"), studioTestConfig(), async () => []).getCapabilities(caller, {});
    expect(studio.data.tools).toEqual(expect.arrayContaining([...STUDIO_G7_TOOL_NAMES]));
    expect(studio.data.studio_g7).toMatchObject({ tools: [...STUDIO_G7_TOOL_NAMES], lab_schema: { version: 7, studio_action_requires_upgrade_from_v6: true }, limitations: expect.arrayContaining(["no_transcript_retained", "no_audio_retained", "fake_studio_loopback_peer_has_no_packet_flow_proof"]) });
    // The published limitations are exactly the evaluator's.
    const { STUDIO_G7_LIMITATIONS } = await import("../src/studio-g7/evaluate.js");
    expect((studio.data.studio_g7 as { limitations: string[] }).limitations).toEqual([...STUDIO_G7_LIMITATIONS]);
  });

  it("registers the Studio tools as MCP tools with strict schemas and an audited, idempotent start", async () => {
    const listTools = async (config: VoiceLabConfig, ledger = new MemoryVoiceLabLedger("test")) => {
      const service = new VoiceLabService(ledger, config, async () => []);
      const server = createVoiceLabMcpServer(service, ledger, caller);
      const client = new Client({ name: "studio-g7-contract-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, server, ledger, listed: await client.request({ method: "tools/list", params: {} }, z.any()) as { tools: Array<Record<string, any>> } };
    };
    const legacy = await listTools(testConfig());
    expect(legacy.listed.tools.map((tool) => tool.name)).toEqual(toolNamesForTarget(undefined));
    await legacy.client.close(); await legacy.server.close();
    const studio = await listTools(studioTestConfig());
    try {
      const byName = Object.fromEntries(studio.listed.tools.map((tool) => [tool.name, tool]));
      expect(Object.keys(byName)).toEqual(expect.arrayContaining([...STUDIO_G7_TOOL_NAMES]));
      expect(byName.studio_g7_action.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
      expect(byName.studio_g7_voice_step.inputSchema.properties.step.enum).toEqual(["create", "steer", "hold", "resume", "stop"]);
      expect(byName.studio_g7_action.inputSchema.properties.action.enum).toEqual(["leave_and_return", "section_revision", "stale_edit", "withdrawal", "observe"]);
      const started = await studio.client.callTool({ name: "start_studio_g7_run", arguments: { ...START, idempotency_key: "mcp-studio-start-01" } }) as unknown as { structuredContent: LabEnvelope; isError?: boolean };
      expect(started.isError).toBeFalsy();
      expect(started.structuredContent.data.run_binding).toMatchObject({ run_binding_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const replay = await studio.client.callTool({ name: "start_studio_g7_run", arguments: { ...START, idempotency_key: "mcp-studio-start-01" } }) as unknown as { structuredContent: LabEnvelope };
      expect(replay.structuredContent.run_id).toBe(started.structuredContent.run_id);
      const refused = await studio.client.callTool({ name: "studio_g7_action", arguments: { run_id: started.structuredContent.run_id, action: "section_revision", idempotency_key: "mcp-studio-missing-instruction" } });
      expect(refused.isError).toBe(true);
      const audits = await studio.ledger.listAuthAudit(started.structuredContent.run_id!);
      expect(audits.some((audit) => audit.action === "tool:start_studio_g7_run" && audit.outcome === "allowed")).toBe(true);
    } finally { await studio.client.close(); await studio.server.close(); }
  });

  it("rejects every legacy start on the Studio kind as unsupported_for_target", async () => {
    const config = studioTestConfig();
    const service = new VoiceLabService(new MemoryVoiceLabLedger("test"), config, async () => []);
    const error = await service.startVoiceRun(caller, { environment: "production", scenario_id: "V-A01", scenario_version: "vt00.scenarios.v1", idempotency_key: "legacy-on-studio-0001" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceLabError);
    expect((error as VoiceLabError).detail).toMatchObject({ code: "SCENARIO_UNSUPPORTED_FOR_TARGET", details: { status: "unsupported_for_target", target_kind: "studio-livekit-g7-v1", scenario_id: "V-A01", reason: "legacy_gemini_browser_scenario_requires_browser_provider_socket" } });
  });

  it("rejects Studio starts and steps on the legacy kind", async () => {
    const service = new VoiceLabService(new MemoryVoiceLabLedger("test"), testConfig(), async () => []);
    await expect(service.startStudioG7Run(caller, { ...START, idempotency_key: "studio-on-legacy-1" })).rejects.toMatchObject({ detail: { code: "SCENARIO_UNSUPPORTED_FOR_TARGET", details: { status: "unsupported_for_target", target_kind: "legacy-gemini-browser-v1" } } });
  });

  it("reserves a Studio run with a pinned target and returns its run binding", async () => {
    const config = studioTestConfig();
    const ledger = new MemoryVoiceLabLedger("test");
    const service = new VoiceLabService(ledger, config, async () => []);
    const started = await service.startStudioG7Run(caller, { ...START, idempotency_key: "studio-start-0001" });
    const run = (await ledger.getRun(started.run_id!))!;
    expect(run).toMatchObject({ scenarioId: "V-G07", scenarioVersion: "studio-g7-v1", capturePolicy: { screenshot: false, rawAudio: false } });
    expect(run.target.expectedDeployment).toEqual({ frontend: STUDIO_SHA, backend: API_SHA, voice: BRIDGE_SHA });
    expect(started.data.run_binding).toMatchObject({ run_binding_sha256: computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: "V-G07", scenarioVersion: "studio-g7-v1" }) });
    expect(JSON.stringify(started)).not.toContain(run.cleanupObligationId);
    const replay = await service.startStudioG7Run(caller, { ...START, idempotency_key: "studio-start-0001" });
    expect(replay.run_id).toBe(started.run_id);
    await expect(service.startStudioG7Run(caller, { ...START, scenario_id: "V-A01", idempotency_key: "studio-start-0002" } as never)).rejects.toThrow();
    const capabilities = await service.getCapabilities(caller, {});
    expect(capabilities.data.studio_g7).toMatchObject({ target_kind: "studio-livekit-g7-v1", legacy_scenarios: "unsupported_for_target" });
    expect(JSON.stringify(capabilities)).not.toContain(config.studioG7!.principalPassword);
  });

  it("validates G7 step inputs at the MCP boundary", async () => {
    const config = studioTestConfig();
    const ledger = new MemoryVoiceLabLedger("test");
    const service = new VoiceLabService(ledger, config, async () => []);
    const started = await service.startStudioG7Run(caller, { ...START, idempotency_key: "studio-start-validate" });
    const runId = started.run_id!;
    for (const input of [
      { run_id: runId, action: "section_revision", idempotency_key: "action-key-0001" },
      { run_id: runId, action: "stale_edit", instruction: "x", idempotency_key: "action-key-0002" },
      { run_id: runId, action: "observe", idempotency_key: "action-key-0003" },
      { run_id: runId, action: "withdrawal", sections: ["intro"], idempotency_key: "action-key-0004" },
      { run_id: runId, action: "leave_and_return", entry_id: randomUUID(), idempotency_key: "action-key-0005" },
      { run_id: runId, action: "section_revision", instruction: "x", sections: ["Not A Section"], idempotency_key: "action-key-0006" },
      { run_id: runId, action: "rotate_socket", idempotency_key: "action-key-0007" },
    ]) await expect(service.studioG7Action(caller, input), JSON.stringify(input)).rejects.toThrow();
    await expect(service.studioG7VoiceStep(caller, { run_id: runId, step: "dance", fixture_id: "a02_short_command", idempotency_key: "voice-key-0001" })).rejects.toThrow();
    await expect(service.studioG7VoiceStep(caller, { run_id: runId, step: "create", idempotency_key: "voice-key-0002" })).rejects.toThrow();
  });
});

interface Harness { config: VoiceLabConfig; ledger: VoiceLabLedger; service: VoiceLabService; driver: ScriptedStudioDriver; worker: VoiceLabWorker; runId: string }

async function harness(workerId = "studio-worker", ledger: VoiceLabLedger = new MemoryVoiceLabLedger("test"), overrides: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const config = studioTestConfig(undefined, overrides);
  const audio = new AudioResolver(config);
  await audio.initialize();
  const service = new VoiceLabService(ledger, config, async () => audio.summaries());
  const started = await service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("studio-start") });
  const run = (await ledger.getRun(started.run_id!))!;
  const driver = new ScriptedStudioDriver(run);
  const worker = new VoiceLabWorker(workerId, ledger, config, audio, driver as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  return { config, ledger, service, driver, worker, runId: run.id };
}

/** Drive one MCP call to completion with the worker executing its operation. */
async function drive(h: Harness, call: Promise<LabEnvelope>): Promise<LabEnvelope> {
  let settled = false;
  const result = call.finally(() => { settled = true; });
  while (!settled) {
    if (!(await h.worker.runOnce())) await delay(10);
  }
  return result;
}

async function voice(h: Harness, step: string): Promise<LabEnvelope> {
  return drive(h, h.service.studioG7VoiceStep(caller, { run_id: h.runId, step, fixture_id: "a02_short_command", idempotency_key: newIdempotencyKey(`voice-${step}`) }));
}

async function action(h: Harness, input: Record<string, unknown>): Promise<LabEnvelope> {
  return drive(h, h.service.studioG7Action(caller, { run_id: h.runId, idempotency_key: newIdempotencyKey(`action-${String(input.action)}`), ...input }));
}

async function episode(h: Harness, skip: string[] = []): Promise<void> {
  await h.worker.runOnce();
  expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "ready" });
  if (!skip.includes("create")) expect((await voice(h, "create")).status).toBe("completed");
  if (!skip.includes("steer")) expect((await voice(h, "steer")).status).toBe("completed");
  if (!skip.includes("leave_and_return")) expect((await action(h, { action: "leave_and_return" })).data).toMatchObject({ performed: true, operation_state: "succeeded" });
  if (!skip.includes("section_revision")) expect((await action(h, { action: "section_revision", instruction: "Shorten the introduction" })).data).toMatchObject({ performed: true, http_status: 202 });
  if (!skip.includes("stale_edit")) expect((await action(h, { action: "stale_edit" })).data).toMatchObject({ performed: true, http_status: 409, code: "stale_revision" });
  for (const step of ["hold", "resume", "stop"]) {
    if (skip.includes(step)) continue;
    expect((await voice(h, step)).status).toBe("completed");
    expect((await action(h, { action: "observe", for_step: step })).data).toMatchObject({ performed: false, status: "observed" });
  }
  if (!skip.includes("withdrawal")) expect((await action(h, { action: "withdrawal" })).data).toMatchObject({ performed: true });
}

async function end(h: Harness): Promise<LabEnvelope> {
  return drive(h, h.service.endVoiceRun(caller, { run_id: h.runId, idempotency_key: newIdempotencyKey("end"), wait_timeout_ms: 5_000 }));
}

describe("target-kind wiring in the worker", () => {
  it("runs every G7 step as an operation and settles a complete run as completed, never pending then failed", async () => {
    const h = await harness();
    await episode(h);
    const operations = await h.ledger.listOperations(h.runId);
    expect(operations.filter((operation) => operation.type === "speak").map((operation) => operation.input._g7_step)).toEqual(["g7.create", "g7.steer", "g7.hold", "g7.resume", "g7.stop"]);
    expect(operations.filter((operation) => operation.type === "studio_action").map((operation) => operation.input.action)).toEqual(["leave_and_return", "section_revision", "stale_edit", "observe", "observe", "observe", "withdrawal"]);
    // Write-ahead events were durable before the driver acted on them.
    expect(h.driver.durable).toEqual(["studio.exchange.speak_requested", "studio.exchange.opened"]);
    await end(h);
    const settled = (await h.ledger.getRun(h.runId))!;
    expect(settled).toMatchObject({ state: "completed", cleanupComplete: true, verdicts: { harness: "pass", product: "inconclusive", provider: "pass", auth: "pass", evidence: "pass" } });
    const evidence = await h.ledger.getEvidence(h.runId);
    const manifestRef = evidence!.artifactRefs.find((ref) => ref.kind === "manifest")!;
    const manifest = JSON.parse(Buffer.from((await h.ledger.getArtifact(manifestRef.resource_id.replace("voice-lab://evidence/", "")))!.bytes).toString("utf8"));
    expect(manifest.studio_g7).toMatchObject({ grant_id: GRANT_UUID, pcm_reconciliation: "envelope_only", retention: { transcript: "not_retained", audio: "not_retained" }, cleanup: { complete: true, ownership: "proven" } });
    expect(manifest.studio_g7.steps.map((step: { step_id: string; executed: string }) => `${step.step_id}:${step.executed}`)).toEqual(["g7.create:pass", "g7.steer:pass", "g7.leave_return:pass", "g7.section_revision:pass", "g7.stale_edit:pass", "g7.hold:pass", "g7.resume:pass", "g7.stop:pass", "g7.withdrawal:pass"]);
    const events = (await h.ledger.listEvents(h.runId, 0, 1_000)).events;
    expect(events.some((event) => event.kind === "cleanup.browser_lease_released" && event.payload.schema === "sophia_voice_lab_studio_g7_lease_release_v1")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(h.config.studioG7!.principalPassword);
    expect(JSON.stringify(events)).not.toContain("Shorten the introduction");
  }, 60_000);

  it("refuses a duplicate step and replays the same operation under the same key", async () => {
    const h = await harness();
    await h.worker.runOnce();
    const key = newIdempotencyKey("voice-create");
    const first = await drive(h, h.service.studioG7VoiceStep(caller, { run_id: h.runId, step: "create", fixture_id: "a02_short_command", idempotency_key: key }));
    const replay = await drive(h, h.service.studioG7VoiceStep(caller, { run_id: h.runId, step: "create", fixture_id: "a02_short_command", idempotency_key: key }));
    expect(replay.operation_id).toBe(first.operation_id);
    expect(replay.data.replay).toBe(true);
    await expect(h.service.studioG7VoiceStep(caller, { run_id: h.runId, step: "create", fixture_id: "a02_short_command", idempotency_key: newIdempotencyKey("voice-create-again") })).rejects.toMatchObject({ detail: { code: "STUDIO_G7_STEP_ALREADY_PERFORMED" } });
    await action(h, { action: "leave_and_return" });
    await expect(h.service.studioG7Action(caller, { run_id: h.runId, action: "leave_and_return", idempotency_key: newIdempotencyKey("leave-again") })).rejects.toMatchObject({ detail: { code: "STUDIO_G7_STEP_ALREADY_PERFORMED" } });
    // observe is not a step: it may be repeated.
    await action(h, { action: "observe", for_step: "create" });
    await action(h, { action: "observe", for_step: "create" });
    expect((await h.ledger.listOperations(h.runId)).filter((operation) => operation.type === "speak")).toHaveLength(1);
  }, 60_000);

  it("fails a run whose episode skipped steps at End instead of leaving it pending external evidence", async () => {
    const h = await harness();
    await episode(h, ["stale_edit", "withdrawal"]);
    await end(h);
    const settled = (await h.ledger.getRun(h.runId))!;
    expect(settled).toMatchObject({ state: "failed_harness", cleanupComplete: true, verdicts: { harness: "fail" } });
  }, 60_000);

  it("completes a run whose last receipts arrive after End through the evidence completion path", async () => {
    const h = await harness();
    h.driver.lateSessionClosed = true;
    await episode(h);
    await end(h);
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true, verdicts: { harness: "unavailable" } });
    await h.worker.maintainSessions();
    expect(h.driver.calls).toContain(`refresh:${EXCHANGE_UUID}`);
    const settled = (await h.ledger.getRun(h.runId))!;
    expect(settled).toMatchObject({ state: "completed", verdicts: { harness: "pass", evidence: "pass" } });
    // Bounded: a second maintenance pass on a settled run reads nothing.
    const refreshes = h.driver.calls.filter((call) => call.startsWith("refresh:")).length;
    await h.worker.maintainSessions();
    expect(h.driver.calls.filter((call) => call.startsWith("refresh:")).length).toBe(refreshes);
  }, 60_000);

  it("terminalizes a run that outlives its TTL mid-episode as expired, aborting through the driver and settling cleanup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const h = await harness();
    await h.worker.runOnce();
    await voice(h, "create");
    const run = (await h.ledger.getRun(h.runId))!;
    vi.setSystemTime(new Date(run.expiresAt.getTime() + 1_000));
    await h.worker.maintainSessions();
    expect(h.driver.calls).toContain("abort:RUN_EXPIRED");
    const settled = (await h.ledger.getRun(h.runId))!;
    expect(settled).toMatchObject({ state: "expired", cleanupComplete: true, terminalError: { code: "RUN_EXPIRED" } });
    // A later step on the expired run is refused, never queued.
    await expect(h.service.studioG7Action(caller, { run_id: h.runId, action: "leave_and_return", idempotency_key: newIdempotencyKey("after-expiry") })).rejects.toMatchObject({ detail: { code: "RUN_TERMINAL" } });
  }, 60_000);

  it("settles a Studio start that failed on a deployment mismatch with typed, network-free cleanup", async () => {
    const config = studioTestConfig();
    const ledger = new MemoryVoiceLabLedger("test");
    const audio = new AudioResolver(config);
    await audio.initialize();
    const run = studioRun(config);
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(randomUUID()), input: {} }, { global: 1, caller: 1 });
    const calls: string[] = [];
    const fetchImpl = async (input: URL | string): Promise<Response> => {
      const url = new URL(String(input));
      calls.push(`${url.origin}${url.pathname}`);
      if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true, commit: "4".repeat(40) }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/") return new Response(`<meta name="sophia-build" content="${STUDIO_SHA}">`, { status: 200, headers: { "content-type": "text/html" } });
      return new Response("{}", { status: 500 });
    };
    const { StudioG7Driver } = await import("../src/studio-g7/studio-driver.js");
    const driver = new StudioG7Driver(config, config.studioG7!, { fetchImpl, readinessDriver: { readiness: async () => ({ ok: true, detail: "fixture", engine: "chromium", version: "fixture" }), close: async () => undefined }, setTimer: () => ({}), clearTimer: () => undefined });
    const worker = new VoiceLabWorker("studio-mismatch-worker", ledger, config, audio, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    await worker.runOnce();
    const settled = (await ledger.getRun(run.id))!;
    expect(settled).toMatchObject({ state: "deployment_mismatch", cleanupComplete: true, terminalError: { code: "DEPLOYMENT_MISMATCH" } });
    // Only the two identity reads happened: no sign-in, no member-API call.
    expect(calls.every((call) => call.endsWith("/health") || call.endsWith("/"))).toBe(true);
    const events = (await ledger.listEvents(run.id, 0, 500)).events;
    expect(events.some((event) => event.kind === "cleanup.browser_context_absent" && event.payload.browser_never_allocated === true)).toBe(true);
    expect(events.some((event) => event.kind === "cleanup.browser_lease_released")).toBe(true);
  });
});

/** Worker B's recovery of worker A's run: the scripted driver reports what a real API-only recovery would. */
function recoveryEvents(runId: string) {
  return [
    { kind: "studio.cleanup.exchange_ended", source: "canonical" as const, payload: { confirmed: true, status: "confirmed", basis: "run_exchange_not_live", exchange_id: EXCHANGE_UUID, join: "durable", ownership: "not_required", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `recovery-ended:${runId}` },
    { kind: "studio.cleanup.signed_out", source: "canonical" as const, payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "fresh_grant" }, dedupeKey: `recovery-signed-out:${runId}` },
    { kind: "studio.cleanup.recovery", source: "canonical" as const, payload: { complete: true, exchange_ended: true, signed_out: true, browser_session_absent: true }, dedupeKey: `recovery:${runId}` },
  ];
}

export async function deadOwnerRecovery(ledger: VoiceLabLedger, advance: (ms: number) => Promise<void>): Promise<{ runId: string; workerB: Harness }> {
  // Worker A starts the run and two steps, then dies mid-run (no end, no heartbeat).
  const workerA = await harness("worker-a-dies", ledger);
  await workerA.worker.runOnce();
  await voice(workerA, "create");
  expect(await ledger.getBrowserLease(workerA.runId)).toMatchObject({ workerId: "worker-a-dies" });
  // Worker B is a fresh process: its driver retains nothing about the run.
  const config = workerA.config;
  const audio = new AudioResolver(config);
  await audio.initialize();
  const run = (await ledger.getRun(workerA.runId))!;
  const driverB = new ScriptedStudioDriver(run);
  driverB.recoverResult = recoveryEvents;
  const workerB: Harness = { ...workerA, driver: driverB, worker: new VoiceLabWorker("worker-b-recovers", ledger, config, audio, driverB as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" })) };
  // Lease expiry: B observes the loss, terminalizes, recovers, signs out, but
  // must not release the lease while A's access JWTs could still be valid.
  await advance(40_000);
  // Pass 1 observes the lease loss and terminalizes the run; pass 2 recovers the terminal run.
  await workerB.worker.maintainSessions();
  await advance(1_000);
  await workerB.worker.maintainSessions();
  expect(await ledger.getRun(workerA.runId)).toMatchObject({ state: "aborted_driver_restart", cleanupComplete: false });
  expect(driverB.adopted).toMatchObject({ exchangeId: EXCHANGE_UUID, grantId: GRANT_UUID, speakRequested: true });
  expect(await ledger.getBrowserLease(workerA.runId)).not.toBeNull();
  const pending = (await ledger.listEvents(workerA.runId, 0, 1_000)).events.filter((event) => event.kind === "cleanup.browser_lease_unconfirmed").map((event) => event.payload.dead_owner_release);
  expect(pending).toEqual(expect.arrayContaining(["access_token_lifetime_pending"]));
  return { runId: workerA.runId, workerB };
}

describe("dead foreign worker: Studio lease recovery", () => {
  it("releases the dead owner's lease only after sign-out, the JWT lifetime, a fresh not-live verification and a stale heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    const { runId, workerB } = await deadOwnerRecovery(ledger, advance);
    // Still inside the access-token lifetime (default 3600 s): nothing released.
    await advance(30 * 60_000);
    await workerB.worker.maintainSessions();
    expect(await ledger.getBrowserLease(runId)).not.toBeNull();
    // After the lifetime, a fresh verification releases it (typed quiesced, never closed).
    await advance(31 * 60_000);
    await workerB.worker.maintainSessions();
    expect(await ledger.getBrowserLease(runId)).toBeNull();
    const events = (await ledger.listEvents(runId, 0, 1_000)).events;
    const released = events.find((event) => event.kind === "cleanup.browser_lease_released");
    expect(released?.payload).toMatchObject({ schema: STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA, dead_owner_quiesced: true, cas_deleted: true, browser_close: "unobservable_owner_dead", room_presence: "unobservable", room_presence_reason: "presence_not_read" });
    expect(events.some((event) => event.kind === "studio.cleanup.dead_owner_verified")).toBe(true);
    await workerB.worker.maintainSessions();
    expect(await ledger.getRun(runId)).toMatchObject({ state: "aborted_driver_restart", cleanupComplete: true });
  }, 60_000);

  it("never releases while the owner still heartbeats, or without a fresh not-live verification", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    const { runId, workerB } = await deadOwnerRecovery(ledger, advance);
    await advance(61 * 60_000);
    // The owner is alive after all (a hung, not dead, worker): no release.
    await ledger.heartbeatWorker({ workerId: "worker-a-dies", serviceVersion: "x", browserReady: true, attestation: null, detail: {}, observedAt: new Date() });
    await workerB.worker.maintainSessions();
    expect(await ledger.getBrowserLease(runId)).not.toBeNull();
    // The exchange cannot be verified not live: no release either (past the
    // heartbeat staleness plus its clock-skew margin, 30 s + 60 s).
    await advance(120_000);
    workerB.driver.recoverResult = (id) => recoveryEvents(id).map((event) => event.kind === "studio.cleanup.exchange_ended" ? { ...event, payload: { ...event.payload, confirmed: false, status: "uncertain", basis: "live_exchange_not_joined_to_run" }, dedupeKey: `uncertain:${id}` } : event);
    await workerB.worker.maintainSessions();
    expect(await ledger.getBrowserLease(runId)).not.toBeNull();
    // The ledger itself refuses a release without a matching verification.
    expect(await ledger.releaseDeadOwnerStudioBrowserLease(runId, { verificationId: randomUUID(), tokenMaxLifetimeMs: 3_600_000, heartbeatStaleMs: 30_000 })).toEqual({ released: false, reason: "fresh_exchange_verification_missing" });
    expect(await ledger.getRun(runId)).toMatchObject({ cleanupComplete: false });
  }, 60_000);
});

/** A fresh worker B process for worker A's run: its driver retains nothing about the run. */
async function workerBFor(ledger: VoiceLabLedger, a: Harness, workerId = "worker-b-recovers"): Promise<Harness> {
  const audio = new AudioResolver(a.config);
  await audio.initialize();
  const driverB = new ScriptedStudioDriver((await ledger.getRun(a.runId))!);
  return { ...a, driver: driverB, worker: new VoiceLabWorker(workerId, ledger, a.config, audio, driverB as unknown as VoiceBrowserDriver, new CapabilityCodec(a.config.capabilitySecret, a.config.capabilityIssuer, a.config.capabilityTtlSeconds), pino({ level: "silent" })) };
}

/** What a real driver persists when its own End/abort completed: exchange ended, global sign-out, browser closed. */
function ownerCleanupEvents(runId: string, bindEpoch: boolean) {
  return [
    { kind: "studio.cleanup.exchange_ended", source: "canonical" as const, payload: { confirmed: true, status: "confirmed", basis: "api_end", exchange_id: EXCHANGE_UUID, join: "retained", ownership: "proven", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `owner-ended:${runId}` },
    { kind: "studio.cleanup.signed_out", source: "canonical" as const, payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "held_session", credentials_excluded: true }, dedupeKey: `owner-signed-out:${runId}` },
    { kind: "cleanup.browser_context_closed", source: "browser" as const, payload: { schema: "sophia_voice_lab_execution_epoch_browser_cleanup_v1", close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true, browser_process_disconnected: true, reason: "normal_end", ...(bindEpoch ? { execution_epoch_sha256: sha256(`epoch:${runId}`) } : {}) }, dedupeKey: `cleanup:${runId}:browser` },
  ];
}

describe("adversarial review: dead owner whose own cleanup completed (P2-1)", () => {
  it("releases the lease of an owner that finished its own cleanup for that lease epoch, then admits the next run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    const a = await harness("worker-a-finished-cleanup", ledger);
    await a.worker.runOnce();
    await voice(a, "create");
    // A's End/abort persisted all of its cleanup, then A died before deleting its lease.
    await ledger.appendEvents(a.runId, ownerCleanupEvents(a.runId, true));
    expect(await ledger.getBrowserLease(a.runId)).toMatchObject({ workerId: "worker-a-finished-cleanup" });
    const b = await workerBFor(ledger, a);
    await advance(40_000);
    for (let pass = 0; pass < 13 && (await ledger.getBrowserLease(a.runId)) !== null; pass += 1) {
      await b.worker.maintainSessions();
      await advance(30 * 60_000);
    }
    expect(await ledger.getBrowserLease(a.runId)).toBeNull();
    const events = (await ledger.listEvents(a.runId, 0, 1_000)).events;
    expect(events.find((event) => event.kind === "cleanup.browser_lease_released")?.payload).toMatchObject({ schema: STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA, cas_deleted: true, dead_owner_cleanup_complete: true, browser_close: "proven_by_owner_epoch" });
    await b.worker.maintainSessions();
    expect(await ledger.getRun(a.runId)).toMatchObject({ cleanupComplete: true });
    const next = await a.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("after-dead-owner") });
    expect(next.status).toBe("accepted");
  }, 60_000);

  it("re-verifies through an API-only recovery when the dead owner's cleanup cannot be bound to its lease epoch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    const a = await harness("worker-a-unbound-cleanup", ledger);
    await a.worker.runOnce();
    await voice(a, "create");
    await ledger.appendEvents(a.runId, ownerCleanupEvents(a.runId, false));
    const b = await workerBFor(ledger, a);
    b.driver.recoverResult = recoveryEvents;
    await advance(40_000);
    await b.worker.maintainSessions();
    await advance(1_000);
    await b.worker.maintainSessions();
    // Not short-circuited by the (unbound) complete proof: B signs in, re-verifies and signs out.
    expect(b.driver.calls).toContain("recover");
    expect(await ledger.getBrowserLease(a.runId)).not.toBeNull();
    await advance(61 * 60_000);
    await b.worker.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).toBeNull();
    const events = (await ledger.listEvents(a.runId, 0, 1_000)).events;
    expect(events.find((event) => event.kind === "cleanup.browser_lease_released")?.payload).toMatchObject({ dead_owner_quiesced: true, browser_close: "unobservable_owner_dead" });
  }, 60_000);
});

describe("adversarial review: G7 step singularity and legacy tools (P3-3, P3-4)", () => {
  it("performs a step at most once when two different keys race for it", async () => {
    const h = await harness();
    await h.worker.runOnce();
    const calls = [1, 2].map((n) => h.service.studioG7Action(caller, { run_id: h.runId, action: "section_revision", instruction: "Shorten the introduction", idempotency_key: newIdempotencyKey(`race-${n}`) }));
    let settled = false;
    const all = Promise.allSettled(calls).finally(() => { settled = true; });
    while (!settled) { if (!(await h.worker.runOnce())) await delay(10); }
    const results = await all;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    expect(rejected?.reason).toMatchObject({ detail: { code: expect.stringMatching(/^STUDIO_G7_STEP_(IN_FLIGHT|ALREADY_PERFORMED)$/) } });
    expect(h.driver.calls.filter((call) => call === "action:section_revision")).toHaveLength(1);
    expect((await h.ledger.listOperations(h.runId)).filter((operation) => operation.type === "studio_action" && operation.input.action === "section_revision")).toHaveLength(1);
  }, 60_000);

  it("answers legacy speak, barge_in and force_socket_rotation on the Studio kind as unsupported_for_target, and the worker refuses a legacy speak", async () => {
    const h = await harness();
    await h.worker.runOnce();
    await voice(h, "create");
    const unsupported = { detail: { code: "SCENARIO_UNSUPPORTED_FOR_TARGET", details: { status: "unsupported_for_target" } } };
    await expect(h.service.speak(caller, { run_id: h.runId, fixture_id: "a02_short_command", idempotency_key: newIdempotencyKey("legacy-speak") })).rejects.toMatchObject(unsupported);
    await expect(h.service.bargeIn(caller, { run_id: h.runId, fixture_id: "a02_short_command", after_output_event_seq: 1, delay_ms: 0, max_lateness_ms: 500, idempotency_key: newIdempotencyKey("legacy-barge") })).rejects.toMatchObject(unsupported);
    const faultCaller: AuthenticatedCaller = { subject: caller.subject, scopes: new Set([...caller.scopes, "voice_lab:fault"]) };
    await expect(h.service.forceSocketRotation(faultCaller, { run_id: h.runId, expected_socket_epoch: 0, idempotency_key: newIdempotencyKey("legacy-rotate") })).rejects.toMatchObject(unsupported);
    expect(h.driver.calls.filter((call) => call.startsWith("schedule:"))).toHaveLength(1);
    // A legacy speak row that reached the ledger anyway (no G7 step) is refused when the worker executes it.
    const legacy = await h.ledger.createOperation({ id: randomUUID(), runId: h.runId, callerId: caller.subject, type: "speak", idempotencyKey: newIdempotencyKey("legacy-row"), requestHash: sha256("legacy-row"), input: { run_id: h.runId, fixture_id: "a02_short_command" } });
    while (await h.worker.runOnce()) { /* drain */ }
    expect(await h.ledger.getOperation(legacy.operation.id)).toMatchObject({ state: "failed", error: { code: "SCENARIO_UNSUPPORTED_FOR_TARGET" } });
    expect(h.driver.calls.filter((call) => call.startsWith("schedule:"))).toHaveLength(1);
  }, 60_000);
});

describe("adversarial review: dead-owner token lifetime clamp (P3-6)", () => {
  it("never shortens the wait below the access-token lifetime the product actually issued", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    const a = await harness("worker-a-long-jwt", ledger);
    // The product issued 2 h JWTs although the Lab is configured for 1 h.
    a.driver.sessionExpiresInS = 7_200;
    await a.worker.runOnce();
    await voice(a, "create");
    const b = await workerBFor(ledger, a);
    b.driver.recoverResult = recoveryEvents;
    await advance(40_000);
    await b.worker.maintainSessions();
    await advance(1_000);
    await b.worker.maintainSessions();
    await advance(61 * 60_000);
    await b.worker.maintainSessions();
    // One configured hour is not enough: the orphan's 2 h JWT could still be valid.
    expect(await ledger.getBrowserLease(a.runId)).not.toBeNull();
    await advance(60 * 60_000);
    await b.worker.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).toBeNull();
  }, 60_000);
});

describe("adversarial re-review: token lifetime bound and unrevoked refresh sessions", () => {
  it("never lets an access-JWT lifetime above the 24 h bound become the dead-owner wait (P3-6)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    const a = await harness("worker-a-unbounded-jwt", ledger);
    a.driver.sessionExpiresInS = 1_000_000_000_000;
    await a.worker.runOnce();
    await voice(a, "create");
    const b = await workerBFor(ledger, a);
    b.driver.recoverResult = recoveryEvents;
    await advance(100_000);
    await b.worker.maintainSessions();
    await advance(1_000);
    await b.worker.maintainSessions();
    // The configured hour bounds the wait: the refused value never does.
    await advance(61 * 60_000);
    await b.worker.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).toBeNull();
  }, 60_000);

  it("an unrevoked evidence-refresh session keeps cleanup incomplete and is signed out globally only once no other run holds admission (P3-5 follow-up)", async () => {
    const h = await harness();
    h.driver.lateSessionClosed = true;
    h.driver.refreshRevokeConfirmed = false;
    await episode(h);
    await end(h);
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
    // A later run is admitted while this one awaits evidence; it holds admission.
    const second = await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("second-run") });
    await h.worker.maintainSessions();
    expect(h.driver.calls).toContain(`refresh:${EXCHANGE_UUID}`);
    // The refresh session could not be revoked: no global sign-out while the other run holds admission.
    expect(h.driver.calls).not.toContain("recover");
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence" });
    const { studioG7CleanupProof } = await import("../src/studio-g7/evaluate.js");
    expect(studioG7CleanupProof((await h.ledger.listEvents(h.runId, 0, 1_000)).events)).toMatchObject({ refreshSessionsRevoked: false, complete: false });
    // The other run finishes (its admission is released).
    const other = (await h.ledger.getRun(second.run_id!))!;
    await h.ledger.updateRun(other.id, other.version, { state: "aborted_driver_restart", cleanupComplete: true });
    h.driver.recoverResult = (id) => recoveryEvents(id);
    await h.worker.maintainSessions();
    expect(h.driver.calls).toContain("recover");
    expect(studioG7CleanupProof((await h.ledger.listEvents(h.runId, 0, 1_000)).events)).toMatchObject({ refreshSessionsRevoked: true, complete: true });
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true });
  }, 60_000);
});

describe("adversarial re-review: forced recoveries are spaced (new P3)", () => {
  it("runs at most one forced recovery per backoff window, even when each one settles the exchange", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    const { runId, workerB } = await deadOwnerRecovery(ledger, advance);
    await advance(61 * 60_000);
    // The exchange is confirmed not live, but the global sign-out keeps failing.
    let attempt = 0;
    workerB.driver.recoverResult = (id) => {
      attempt += 1;
      return recoveryEvents(id).map((event) => event.kind === "studio.cleanup.signed_out" ? { ...event, payload: { ...event.payload, confirmed: false, basis: "unreachable", sign_out_id: `failed-${attempt}` }, dedupeKey: `failed-sign-out:${id}:${attempt}` } : event);
    };
    const before = workerB.driver.calls.filter((call) => call === "recover").length;
    for (let pass = 0; pass < 5; pass += 1) { await workerB.worker.maintainSessions(); await advance(2_000); }
    expect(workerB.driver.calls.filter((call) => call === "recover").length - before).toBe(1);
    expect(await ledger.getBrowserLease(runId)).not.toBeNull();
  }, 60_000);
});

/** Recovery results with a fresh global sign-out per call (as the real driver now records). */
function freshRecovery(): (id: string) => Array<{ kind: string; source: "canonical"; payload: Record<string, unknown>; dedupeKey: string }> {
  let call = 0;
  return (id) => {
    call += 1;
    return [
      { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "run_exchange_not_live", exchange_id: EXCHANGE_UUID, join: "durable", ownership: "not_required", verified_by: "member_snapshot", speak_requested_before_observation: true, call }, dedupeKey: `fresh-ended:${id}:${call}` },
      { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "fresh_grant", sign_out_id: `fresh-${id}-${call}` }, dedupeKey: `fresh-signed-out:${id}:${call}` },
    ];
  };
}

describe("adversarial third review: no admission deadlock, fenced global sign-out", () => {
  it("never deadlocks: a terminal run with a closed browser does not block a live run's recovery (P2)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    // Short runs (120 s TTL) so the deadline is reached while run 2's lease is heartbeated.
    const h = await harness("deadlock-worker", new MemoryVoiceLabLedger("test"), { SOPHIA_VOICE_LAB_MAX_RUN_SECONDS: "120" });
    // 1. Run 1 ends pending external evidence; its refresh session's local revoke fails three times.
    h.driver.lateSessionClosed = true;
    h.driver.refreshRevokeConfirmed = false;
    await episode(h);
    await end(h);
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
    // 2. Run 2 is admitted and starts; run 1's global sign-out is deferred.
    await advance(60_000);
    const second = await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("deadlock-second") });
    const run2Id = second.run_id!;
    await h.worker.runOnce();
    expect(await h.ledger.getRun(run2Id)).toMatchObject({ state: "ready" });
    h.driver.recoverResult = freshRecovery();
    await h.worker.maintainSessions();
    expect(h.driver.calls).not.toContain("recover");
    // 3. Run 1's certification deadline passes while run 2 is live.
    const run1 = (await h.ledger.getRun(h.runId))!;
    const run2 = (await h.ledger.getRun(run2Id))!;
    expect(run1.expiresAt.getTime()).toBeLessThan(run2.expiresAt.getTime());
    while (Date.now() <= run1.expiresAt.getTime()) {
      await advance(Math.min(15_000, run1.expiresAt.getTime() + 1_000 - Date.now()));
      await h.worker.maintainSessions();
    }
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "failed_harness", cleanupComplete: false });
    // 4. Run 2's End cannot prove ownership: it needs an API-only re-verification.
    h.driver.endExchangeConfirmed = false;
    // (Queued without the service's settlement wait, whose deadline would read the frozen test clock.)
    const endKey = newIdempotencyKey("deadlock-end");
    await h.service.queueRunOperation(caller, run2Id, "end", endKey, { run_id: run2Id, idempotency_key: endKey });
    for (let step = 0; step < 5 && await h.worker.runOnce(); step += 1) { /* execute the End */ }
    // 5. Bounded simulated time: both runs settle, then run 3 is admitted.
    for (let pass = 0; pass < 12; pass += 1) {
      const [first, latest] = [await h.ledger.getRun(h.runId), await h.ledger.getRun(run2Id)];
      if (first?.cleanupComplete && latest?.cleanupComplete && TERMINAL.has(latest.state)) break;
      await advance(40_000);
      await h.worker.maintainSessions();
    }
    expect(await h.ledger.getRun(run2Id)).toMatchObject({ cleanupComplete: true });
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "failed_harness", cleanupComplete: true });
    const third = await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("deadlock-third") });
    expect(third.status).toBe("accepted");
  }, 120_000);

  it("refuses an admission that arrives while a global sign-out is in flight, instead of revoking it (P3 residual 2)", async () => {
    const h = await harness("fence-worker");
    h.driver.lateSessionClosed = true;
    h.driver.refreshRevokeConfirmed = false;
    await episode(h);
    await end(h);
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
    // No other run holds a live session: the worker resolves the unrevoked
    // refresh session with a global sign-out. A start arrives meanwhile.
    let admission: unknown = null;
    h.driver.recoverHook = async () => { admission = await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("racing-start") }).catch((error: unknown) => error); };
    h.driver.recoverResult = freshRecovery();
    await h.worker.maintainSessions();
    expect(h.driver.calls).toContain("recover");
    expect(admission).toMatchObject({ detail: { code: "STUDIO_GLOBAL_SIGNOUT_PENDING" } });
    // The sign-out landed, the marker cleared: run 1 completes and admission reopens.
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true });
    const next = await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("after-fence") });
    expect(next.status).toBe("accepted");
  }, 60_000);
});

/** Every evidence manifest published for a run, oldest first. */
async function manifests(ledger: VoiceLabLedger, runId: string): Promise<Array<Record<string, unknown>>> {
  return (await ledger.listArtifacts(runId))
    .filter((artifact) => artifact.kind === "manifest_attachment")
    .map((artifact) => JSON.parse(Buffer.from(artifact.bytes).toString("utf8")) as Record<string, unknown>);
}

describe("adversarial fourth review: an abandoned fenced sign-out on a run awaiting evidence", () => {
  it("never publishes a failure-shaped manifest for a pending_external_evidence run; the Studio evidence path re-finalizes it (P3)", async () => {
    const h = await harness("abandoned-fence-worker");
    h.driver.lateSessionClosed = true;
    h.driver.refreshRevokeConfirmed = false;
    await episode(h);
    await end(h);
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const advance = (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    // The first fenced global sign-out fails (the marker is abandoned); the next one lands.
    const fresh = freshRecovery();
    let calls = 0;
    h.driver.recoverResult = (id) => {
      calls += 1;
      return fresh(id).map((event) => calls === 1 && event.kind === "studio.cleanup.signed_out"
        ? { ...event, payload: { ...event.payload, confirmed: false, http_status: 503, basis: "unreachable" }, dedupeKey: `abandoned-sign-out:${id}` }
        : event);
    };
    await h.worker.maintainSessions();
    expect(calls).toBe(1);
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: false });
    for (let pass = 0; pass < 4; pass += 1) {
      advance(31_000);
      await h.worker.maintainSessions();
      const run = (await h.ledger.getRun(h.runId))!;
      if (run.state === "completed") break;
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    const published = await manifests(h.ledger, h.runId);
    expect(published.length).toBeGreaterThan(0);
    // No manifest ever presents the run as failed while it awaited evidence.
    for (const manifest of published) {
      expect(manifest.terminal_reason).not.toBe("RECOVERY_PENDING");
      expect(manifest.terminal_reason).not.toBe("TERMINAL_CERTIFICATION_REVISION");
      if (manifest.terminal_state === "pending_external_evidence") expect(manifest.terminal_error).toBeNull();
    }
    // The Studio evidence path finalized the run from the durable ledger.
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true, terminalError: null, verdicts: { harness: "pass", evidence: "pass" } });
    expect(published.at(-1)).toMatchObject({ terminal_state: "completed" });
  }, 60_000);
});

describe("adversarial fourth review: the fence marker is cleared on every path after a granted begin", () => {
  it("abandons the marker when a step between the granted begin and the driver's recovery throws", async () => {
    const { STUDIO_GLOBAL_SIGNOUT_CLEARED_KIND, STUDIO_GLOBAL_SIGNOUT_PENDING_KIND, studioGlobalSignOutPending } = await import("../src/studio-g7/sign-out-fence.js");
    const { STUDIO_RECOVERY_ATTEMPT_EVENT } = await import("../src/worker.js");
    const h = await harness("marker-finally-worker");
    h.driver.lateSessionClosed = true;
    h.driver.refreshRevokeConfirmed = false;
    await episode(h);
    await end(h);
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
    // The recovery-attempt append (after the granted begin, before the driver runs) fails.
    const append = h.ledger.appendEvent.bind(h.ledger);
    const spy = vi.spyOn(h.ledger, "appendEvent").mockImplementation(async (runId, kind, ...rest) => {
      if (kind === STUDIO_RECOVERY_ATTEMPT_EVENT) throw new Error("injected ledger write failure");
      return append(runId, kind, ...rest);
    });
    h.driver.recoverResult = freshRecovery();
    await h.worker.maintainSessions();
    spy.mockRestore();
    expect(h.driver.calls).not.toContain("recover");
    const events = (await h.ledger.listEvents(h.runId, 0, 1_000)).events;
    const pending = events.filter((event) => event.kind === STUDIO_GLOBAL_SIGNOUT_PENDING_KIND);
    const cleared = events.filter((event) => event.kind === STUDIO_GLOBAL_SIGNOUT_CLEARED_KIND);
    expect(pending.length).toBeGreaterThan(0);
    // Every granted begin ended as abandoned: no marker is left pending.
    expect(cleared.map((event) => event.payload.marker_id).sort()).toEqual(pending.map((event) => event.payload.marker_id).sort());
    expect(cleared.every((event) => event.payload.outcome === "abandoned")).toBe(true);
    expect(studioGlobalSignOutPending(events)).toBe(false);
    // The next recovery is granted and completes the run.
    await h.worker.maintainSessions();
    expect(h.driver.calls).toContain("recover");
    expect(await h.ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true });
  }, 60_000);
});

/** One live-presence read as the real driver records it (A15): status present / absent / unobservable. */
function presenceEvent(runId: string, status: "present" | "absent" | "unobservable", reason: string | null, n: number) {
  return { kind: "studio.room.live_presence", source: "canonical" as const, payload: { schema: "sophia_voice_lab_studio_room_presence_v1", purpose: "recover", status, reason, http_status: reason === "endpoint_not_served" ? 404 : 200, observation_id: `presence-${n}`, identities_excluded: true, ...(reason === null ? { observed: true, fresh: true, self_present: status === "present" } : {}) }, dedupeKey: `presence:${runId}:${n}` };
}

describe("dead foreign worker: the orphan browser's room presence (A15 live presence)", () => {
  it("keeps the lease while a fresh report places the principal in the room, and records a fresh absence when it releases", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
    const { runId, workerB } = await deadOwnerRecovery(ledger, advance);
    await advance(61 * 60_000);
    workerB.driver.recoverResult = (id) => [...recoveryEvents(id), presenceEvent(id, "present", null, 1)];
    await workerB.worker.maintainSessions();
    expect(await ledger.getBrowserLease(runId)).not.toBeNull();
    let events = (await ledger.listEvents(runId, 0, 1_000)).events;
    expect(events.filter((event) => event.kind === "cleanup.browser_lease_unconfirmed").map((event) => event.payload.dead_owner_release)).toContain("principal_present_in_room");
    expect(events.find((event) => event.kind === "studio.cleanup.dead_owner_verified")?.payload).toMatchObject({ room_presence: "present" });
    // A later fresh report without the principal: released, the absence recorded.
    await advance(31_000);
    workerB.driver.recoverResult = (id) => [...recoveryEvents(id), presenceEvent(id, "absent", null, 2)];
    await workerB.worker.maintainSessions();
    expect(await ledger.getBrowserLease(runId)).toBeNull();
    events = (await ledger.listEvents(runId, 0, 1_000)).events;
    expect(events.find((event) => event.kind === "cleanup.browser_lease_released")?.payload).toMatchObject({ dead_owner_quiesced: true, browser_close: "unobservable_owner_dead", room_presence: "absent", room_presence_reason: null });
  }, 60_000);

  it("never counts a stale or missing report, or an absent route, as gone: the other gates decide and presence stays unobservable", async () => {
    for (const reason of ["report_stale", "not_observed", "endpoint_not_served"]) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date());
      const ledger = new MemoryVoiceLabLedger("test");
      const advance = async (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
      const { runId, workerB } = await deadOwnerRecovery(ledger, advance);
      await advance(61 * 60_000);
      workerB.driver.recoverResult = (id) => [...recoveryEvents(id), presenceEvent(id, "unobservable", reason, 3)];
      await workerB.worker.maintainSessions();
      expect(await ledger.getBrowserLease(runId), reason).toBeNull();
      const released = (await ledger.listEvents(runId, 0, 1_000)).events.find((event) => event.kind === "cleanup.browser_lease_released");
      expect(released?.payload, reason).toMatchObject({ dead_owner_quiesced: true, room_presence: "unobservable", room_presence_reason: reason });
      vi.useRealTimers();
    }
  }, 120_000);
});

describe("a G7 voice step's calls baseline is durable before the step's write-ahead (A15 getExchangeCalls)", () => {
  it("reads the exchange's calls before each voice step acts, persists that baseline first, and keeps the first one", async () => {
    const h = await harness("calls-baseline-worker");
    let recorded = 0;
    h.driver.callsAnswer = () => ({ status: "available", calls: Array.from({ length: recorded }, (_, index) => ({ seq: index + 1, recorded_at: new Date().toISOString(), input_epoch: 1, tool: "project_status", task_id: null, command: null })) });
    await h.worker.runOnce();
    for (const step of ["create", "steer"]) {
      expect((await voice(h, step)).status).toBe("completed");
      recorded += 1;
    }
    const events = (await h.ledger.listEvents(h.runId, 0, 1_000)).events;
    const speaks = (await h.ledger.listOperations(h.runId)).filter((operation) => operation.type === "speak");
    expect(speaks).toHaveLength(2);
    for (const [index, operation] of speaks.entries()) {
      const baseline = events.filter((event) => event.kind === "studio.exchange.calls_read" && event.payload.purpose === "baseline" && event.payload.operation_id === operation.id);
      const resolved = events.find((event) => event.kind === "utterance.resolved" && event.payload.operation_id === operation.id)!;
      expect(baseline).toHaveLength(1);
      expect(baseline[0]!.payload).toMatchObject({ status: "available", max_seq: index, step_id: operation.input._g7_step });
      // Durable before the step's write-ahead, and read before the driver scheduled the step.
      expect(baseline[0]!.seq).toBeLessThan(resolved.seq);
      expect(h.driver.calls.indexOf(`schedule:${operation.id}`)).toBeGreaterThan(-1);
    }
    expect(h.driver.calls.filter((item) => item.startsWith("calls:") || item.startsWith("schedule:")).map((item) => item.split(":")[0])).toEqual(["calls", "schedule", "calls", "schedule"]);
  }, 60_000);

  it("a re-executed voice step keeps its first durable baseline and never reads a later one", async () => {
    const h = await harness("calls-baseline-retry");
    h.driver.callsAnswer = () => ({ status: "available", calls: [{ seq: 1, recorded_at: new Date().toISOString(), input_epoch: 1, tool: "start_research", task_id: null, command: null }] });
    await h.worker.runOnce();
    // The step's operation is queued; a previous execution already made its baseline durable, then crashed.
    const pending = h.service.studioG7VoiceStep(caller, { run_id: h.runId, step: "create", fixture_id: "a02_short_command", idempotency_key: newIdempotencyKey("voice-retry") });
    let queued = null as Awaited<ReturnType<typeof h.ledger.listOperations>>[number] | null;
    while (!(queued = (await h.ledger.listOperations(h.runId)).find((operation) => operation.type === "speak") ?? null)) await delay(5);
    const first = { kind: "studio.exchange.calls_read", source: "canonical" as const, payload: { schema: "sophia_voice_lab_studio_exchange_calls_v1", purpose: "baseline", operation_id: queued.id, step_id: "g7.create", exchange_id: EXCHANGE_UUID, read_id: "first-read", status: "available", reason: null, http_status: 200, max_seq: 0, calls: [] }, dedupeKey: `studio-calls-baseline:${h.runId}:${queued.id}` };
    await h.ledger.appendEvents(h.runId, [first]);
    expect((await drive(h, pending)).status).toBe("completed");
    const baselines = (await h.ledger.listEvents(h.runId, 0, 1_000)).events.filter((event) => event.kind === "studio.exchange.calls_read" && event.payload.purpose === "baseline" && event.payload.operation_id === queued!.id);
    expect(baselines.map((event) => [event.payload.read_id, event.payload.max_seq])).toEqual([["first-read", 0]]);
    expect(h.driver.callsReads.filter((item) => item.operationId === queued!.id)).toEqual([]);
  }, 60_000);
});
