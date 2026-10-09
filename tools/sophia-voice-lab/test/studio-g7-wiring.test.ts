import { randomUUID } from "node:crypto";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { DriverEndResult, DriverStartResult, VoiceBrowserDriver } from "../src/browser-driver.js";
import { VoiceLabError, type LabEvent } from "../src/domain.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256, type AuthenticatedCaller } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { computeRunBindingSha256, canonicalJson } from "../src/studio-g7/contract.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig } from "./helpers.js";
import {
  API_SHA, BRIDGE_SHA, EXCHANGE_UUID, GRANT_UUID, LAB_TRACK_ID, STUDIO_SHA,
  evidenceGrant, inputTurn, inputWindow, outputReply, pageReceipt, providerReceipt, sessionClosed, studioRun, studioTestConfig,
} from "./studio-g7-helpers.js";

const caller: AuthenticatedCaller = { subject: "caller-1", scopes: new Set(["voice_lab:read", "voice_lab:run"]) };

describe("target-kind wiring in the service", () => {
  it("rejects every legacy start on the Studio kind as unsupported_for_target", async () => {
    const config = studioTestConfig();
    const service = new VoiceLabService(new MemoryVoiceLabLedger("test"), config, async () => []);
    const error = await service.startVoiceRun(caller, { environment: "production", scenario_id: "V-A01", scenario_version: "vt00.scenarios.v1", idempotency_key: "legacy-on-studio-0001" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceLabError);
    expect((error as VoiceLabError).detail).toMatchObject({ code: "SCENARIO_UNSUPPORTED_FOR_TARGET", details: { status: "unsupported_for_target", target_kind: "studio-livekit-g7-v1", scenario_id: "V-A01", reason: "legacy_gemini_browser_scenario_requires_browser_provider_socket" } });
  });

  it("rejects Studio starts on the legacy kind and leaves legacy capabilities unchanged", async () => {
    const service = new VoiceLabService(new MemoryVoiceLabLedger("test"), testConfig(), async () => []);
    await expect(service.startStudioG7Run(caller, { environment: "production", scenario_id: "V-G07", scenario_version: "studio-g7-v1", idempotency_key: "studio-on-legacy-1" })).rejects.toMatchObject({ detail: { code: "SCENARIO_UNSUPPORTED_FOR_TARGET", details: { status: "unsupported_for_target", target_kind: "legacy-gemini-browser-v1" } } });
    const capabilities = await service.getCapabilities(caller, {});
    expect(capabilities.data).not.toHaveProperty("studio_g7");
  });

  it("reserves a Studio run with a pinned target and returns its run binding", async () => {
    const config = studioTestConfig();
    const ledger = new MemoryVoiceLabLedger("test");
    const service = new VoiceLabService(ledger, config, async () => []);
    const started = await service.startStudioG7Run(caller, { environment: "production", scenario_id: "V-G07", scenario_version: "studio-g7-v1", idempotency_key: "studio-start-0001" });
    const run = (await ledger.getRun(started.run_id!))!;
    expect(run).toMatchObject({ scenarioId: "V-G07", scenarioVersion: "studio-g7-v1", capturePolicy: { screenshot: false, rawAudio: false } });
    expect(run.target.expectedDeployment).toEqual({ frontend: STUDIO_SHA, backend: API_SHA, voice: BRIDGE_SHA });
    expect(started.data.run_binding).toMatchObject({ run_binding_sha256: computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: "V-G07", scenarioVersion: "studio-g7-v1" }) });
    expect(JSON.stringify(started)).not.toContain(run.cleanupObligationId);
    const replay = await service.startStudioG7Run(caller, { environment: "production", scenario_id: "V-G07", scenario_version: "studio-g7-v1", idempotency_key: "studio-start-0001" });
    expect(replay.run_id).toBe(started.run_id);
    await expect(service.startStudioG7Run(caller, { environment: "production", scenario_id: "V-A01", scenario_version: "studio-g7-v1", idempotency_key: "studio-start-0002" })).rejects.toThrow();
    const capabilities = await service.getCapabilities(caller, {});
    expect(capabilities.data.studio_g7).toMatchObject({ target_kind: "studio-livekit-g7-v1", legacy_scenarios: "unsupported_for_target" });
    expect(JSON.stringify(capabilities)).not.toContain(config.studioG7!.principalPassword);
  });
});

describe("target-kind wiring in the worker", () => {
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

  it("drives start → end with the Studio driver contract and settles with Studio verdicts and cleanup", async () => {
    const config = studioTestConfig();
    const ledger = new MemoryVoiceLabLedger("test");
    const audio = new AudioResolver(config);
    await audio.initialize();
    const run = studioRun(config);
    const binding = computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: "V-G07", scenarioVersion: "studio-g7-v1" });
    const operation = (type: "start" | "end") => ({ id: randomUUID(), runId: run.id, callerId: run.callerId, type, idempotencyKey: randomUUID(), requestHash: sha256(randomUUID()), input: {} });
    await ledger.createRunWithOperation(run, operation("start"), { global: 1, caller: 1 });
    type DriverEvent = Omit<LabEvent, "runId" | "seq" | "at">;
    const bridge = (kind: string, receipt: Record<string, unknown>): DriverEvent => {
      const json = canonicalJson(receipt);
      return { kind: "studio.bridge_receipt", source: "canonical", payload: { exchange_id: EXCHANGE_UUID, seq: receipt.seq, kind, received_at: new Date().toISOString(), receipt_json: json, receipt_sha256: sha256(json) }, dedupeKey: `studio-bridge:${EXCHANGE_UUID}:${receipt.seq}:${sha256(json)}` };
    };
    const page = (receipt: Record<string, unknown>, arrival: number): DriverEvent => {
      const json = canonicalJson(receipt);
      return { kind: "studio.page_receipt", source: "product", payload: { event: receipt.event, receipt_json: json, receipt_sha256: sha256(json) }, dedupeKey: `studio-page:${run.id}:${arrival}` };
    };
    let session = false;
    const recovered: string[] = [];
    const executionEpoch = sha256("epoch");
    const driver = {
      hasSession: () => session,
      readiness: async () => ({ ok: true, detail: "fixture", engine: "chromium", version: "fixture" }),
      start: async (_run: unknown, _grant: unknown, _binding: unknown, _stage: unknown, acquired: any): Promise<DriverStartResult> => {
        const acquisition: DriverEvent = { kind: "harness.browser_process_acquired", source: "browser", payload: { schema: "sophia_voice_lab_browser_process_ownership_v1", voice_lab_run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), process_id_sha256: sha256("pid"), browser_boot_id_sha256: sha256("boot"), execution_epoch_sha256: executionEpoch, started_at: new Date().toISOString(), one_process_per_run: true, raw_process_id_excluded: true }, dedupeKey: `browser-process:${executionEpoch}` };
        await acquired(acquisition, { engine: "chromium", version: "fixture" });
        session = true;
        return { observedDeployment: { frontend: STUDIO_SHA, backend: API_SHA } as never, events: [
          acquisition,
          { kind: "studio.deployment.identity", source: "canonical", payload: { phase: "startup", api: { status: "observed", commit: API_SHA }, studio: { status: "observed", commit: STUDIO_SHA } }, dedupeKey: `studio-identity:${run.id}:startup` },
          { kind: "studio.auth.session_established", source: "canonical", payload: { principal_bound: true }, dedupeKey: `studio-auth:${run.id}` },
          { kind: "harness.media_stream_issued", source: "browser", payload: { replacement_active: true, track_id_sha256s: [sha256(LAB_TRACK_ID)] }, dedupeKey: "browser:1" },
          page(pageReceipt(run, "mic_published", Date.now()), 1),
          { kind: "studio.exchange.opened", source: "canonical", payload: { exchange_id: EXCHANGE_UUID }, dedupeKey: `studio-exchange-opened:${run.id}` },
        ] };
      },
      drain: async () => [],
      continueSession: async () => [],
      end: async (): Promise<DriverEndResult> => {
        session = false;
        return { artifacts: [], events: [
          { kind: "studio.bridge_grant", source: "canonical", payload: { exchange_id: EXCHANGE_UUID, grant_json: canonicalJson(evidenceGrant(run)), grant_sha256: sha256(canonicalJson(evidenceGrant(run))) }, dedupeKey: "grant" },
          bridge("provider", providerReceipt(run, 1, "ready")),
          bridge("provider", providerReceipt(run, 2, "closed")),
          bridge("session_closed", sessionClosed(run, 3, { windows: 0, turns: 0, replies: 0 })),
          { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, basis: "ui_end", exchange_id: EXCHANGE_UUID, verified_by: "member_snapshot" }, dedupeKey: "ended" },
          { kind: "studio.deployment.identity", source: "canonical", payload: { phase: "final", api: { status: "observed", commit: API_SHA }, studio: { status: "observed", commit: STUDIO_SHA } }, dedupeKey: `studio-identity:${run.id}:final` },
          { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted" }, dedupeKey: "signed-out" },
          { kind: "cleanup.browser_context_closed", source: "browser", payload: { schema: "sophia_voice_lab_execution_epoch_browser_cleanup_v1", close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true, browser_process_disconnected: true, execution_epoch_sha256: executionEpoch }, dedupeKey: `cleanup:${run.id}:browser` },
        ] };
      },
      abort: async () => { session = false; return { events: [], artifacts: [] }; },
      recover: async (binding: { id: string }) => { recovered.push(binding.id); return { events: [], artifacts: [] }; },
      cancel: async () => { session = false; },
      close: async () => undefined,
    } as unknown as VoiceBrowserDriver;
    const worker = new VoiceLabWorker("studio-worker", ledger, config, audio, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    await worker.runOnce();
    expect(await ledger.getRun(run.id)).toMatchObject({ state: "ready", verdicts: { harness: "pass", auth: "pass" } });
    await ledger.createOperation(operation("end"));
    await worker.runOnce();
    const settled = (await ledger.getRun(run.id))!;
    // Recovery is skipped once the Studio cleanup proof is durable.
    expect(recovered).toEqual([]);
    expect(settled.cleanupComplete).toBe(true);
    // The G7 catalogue's non-voice steps keep the harness pending external evidence.
    expect(settled.state).toBe("pending_external_evidence");
    expect(settled.verdicts).toMatchObject({ harness: "unavailable", auth: "pass", evidence: "unavailable" });
    const evidence = await ledger.getEvidence(run.id);
    const manifestRef = evidence!.artifactRefs.find((ref) => ref.kind === "manifest")!;
    const manifest = JSON.parse(Buffer.from((await ledger.getArtifact(manifestRef.resource_id.replace("voice-lab://evidence/", "")))!.bytes).toString("utf8"));
    expect(manifest.studio_g7).toMatchObject({ schema: "sophia.voice-lab.studio-g7.evaluation.v1", run_binding_sha256: binding, grant_id: GRANT_UUID, pcm_reconciliation: "envelope_only", cleanup: { complete: true } });
    const events = (await ledger.listEvents(run.id, 0, 500)).events;
    expect(events.some((event) => event.kind === "cleanup.browser_lease_released" && event.payload.schema === "sophia_voice_lab_studio_g7_lease_release_v1")).toBe(true);
    // No credential or principal secret reaches the durable ledger.
    expect(JSON.stringify(events)).not.toContain(config.studioG7!.principalPassword);
    // Unused helpers keep the inputs honest.
    expect(inputWindow(run, 9, 1, 1_000).windowSeq).toBe(1);
    expect(inputTurn(run, 9, 1).outcome).toBe("answered");
    expect(outputReply(run, 9, 1, 1).terminal).toBe("played");
  });
});
