import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { VoiceLabConfig } from "../src/config.js";
import { VoiceLabError, type LabEnvelope } from "../src/domain.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import type { AuthenticatedCaller } from "../src/security.js";
import { createVoiceLabMcpServer } from "../src/mcp-server.js";
import { STUDIO_G7_TOOL_NAMES, VoiceLabService, toolNamesForTarget } from "../src/service.js";
import { computeRunBindingSha256 } from "../src/studio-g7/contract.js";
import { testConfig } from "./helpers.js";
import { API_SHA, BRIDGE_SHA, STUDIO_SHA, studioTestConfig } from "./studio-g7-helpers.js";

/**
 * The Studio G7 target kind as the MCP service exposes it: its tools and
 * capabilities, the strict tool schemas, and starts on either target kind.
 * (Moved unchanged from studio-g7-wiring.test.ts, which keeps the worker
 * wiring.)
 */
const caller: AuthenticatedCaller = { subject: "caller-1", scopes: new Set(["voice_lab:read", "voice_lab:run"]) };
const START = { environment: "production", scenario_id: "V-G07", scenario_version: "studio-g7-v1" } as const;

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
      expect(byName.studio_g7_voice_step.inputSchema.properties.step.enum).toEqual(["create", "steer", "hold", "resume", "create_stop_target", "stop"]);
      expect(byName.studio_g7_action.inputSchema.properties.action.enum).toEqual(["record_note", "leave_and_return", "section_revision", "stale_edit", "withdrawal", "observe"]);
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
