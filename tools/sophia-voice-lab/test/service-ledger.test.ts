import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AudioResolver } from "../src/audio.js";
import { TERMINAL_RUN_STATES, VoiceLabError, initialVerdicts, labError } from "../src/domain.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { SCENARIO_IDS } from "../src/scenarios.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabService, assertFreshProductAdmissionProof, targetAdmissionBinding } from "../src/service.js";
import { assertTransition } from "../src/state-machine.js";
import { VoiceLabWorker, assertResolvedAudioWithinAdmission, augmentOperationTimeoutWithInterruptedDriverError, certificationTerminalDecision, deriveCompletedVerdicts, evaluateScenarioAssertions, exactOutputLifecyclesAtEpoch, leaseHeartbeatIntervalMs, settleInterruptedExecution, suiteCertificationProjection, suiteCertificationState } from "../src/worker.js";
import { caller, SHA, SHA_B, SHA_C, SHA_D, testConfig, testRun } from "./helpers.js";

const target = {
  frontend_url: "http://frontend.test",
  gateway_url: "http://gateway.test",
  voice_url: "http://voice.test",
  langgraph_url: "http://langgraph.test",
  expected_deployment: { frontend: SHA, backend: SHA_B, voice: SHA_C },
  expected_dependencies: { langgraph: SHA_D },
};

describe("service and durable memory-ledger contracts", () => {
  let ledger: MemoryVoiceLabLedger;
  let audio: AudioResolver;
  let service: VoiceLabService;

  beforeEach(async () => {
    ledger = new MemoryVoiceLabLedger("test");
    audio = new AudioResolver(testConfig());
    await audio.initialize();
    service = new VoiceLabService(ledger, testConfig(), async () => audio.summaries());
  });

  it("bounds settlement when an interrupted browser driver never resolves", async () => {
    const interrupted = await settleInterruptedExecution(new Promise(() => undefined), 0);

    expect(interrupted).toBeInstanceOf(VoiceLabError);
    expect((interrupted as VoiceLabError).detail).toMatchObject({
      code: "DRIVER_CANCELLATION_TIMEOUT",
      details: { timeout_ms: 0 },
    });
  });

  it("retains only fixed sanitized interrupted route diagnostics on a global start timeout", () => {
    const timeout = new VoiceLabError(labError("OPERATION_TIMEOUT", "bounded", "harness", true, { operation_type: "start", deadline_seconds: 150 }));
    const interrupted = new VoiceLabError(labError("ORDINARY_UI_ROUTE_FAILED", "route", "harness", false, {
      stage: "voice_startup_readiness",
      cause: {
        error_class: "TimeoutError",
        safe_signature: `sha256:${"a".repeat(64)}`,
        character_length: 321,
        unsafe_cause_text: "must-not-be-projected",
      },
      route_state: {
        location: "expected_session",
        voice_tab: "selected",
        voice_button: "absent",
        dashboard_mic_visible: false,
        dashboard_mic_button: "absent",
        consent_visible: false,
        auth_gate_visible: false,
        auth_checking_visible: true,
        session_store_loading_visible: false,
        voice_fallback_visible: true,
        unsafe_route_text: "must-not-be-projected",
      },
      client_page_error: {
        error_class: "TypeError",
        safe_signature: "undefined_property:destroy",
        next_chunk: "app-session-123.js",
        next_frames: [{ chunk: "app-session-123.js", line: 42, column: 7, unsafe_frame_text: "must-not-be-projected" }],
        digest: "safe_digest_123",
        unsafe_page_text: "must-not-be-projected",
      },
      unsafe_text: "must-not-be-projected",
    }));

    const enriched = augmentOperationTimeoutWithInterruptedDriverError(timeout, interrupted);

    expect(enriched).toBeInstanceOf(VoiceLabError);
    expect((enriched as VoiceLabError).detail).toMatchObject({
      code: "OPERATION_TIMEOUT",
      details: {
        operation_type: "start",
        deadline_seconds: 150,
        interrupted_driver_error: {
          code: "ORDINARY_UI_ROUTE_FAILED",
          stage: "voice_startup_readiness",
          cause: {
            error_class: "TimeoutError",
            safe_signature: `sha256:${"a".repeat(64)}`,
            character_length: 321,
          },
          route_state: {
            location: "expected_session",
            voice_tab: "selected",
            voice_button: "absent",
            dashboard_mic_visible: false,
            dashboard_mic_button: "absent",
            consent_visible: false,
            auth_gate_visible: false,
            auth_checking_visible: true,
            session_store_loading_visible: false,
            voice_fallback_visible: true,
          },
          client_page_error: {
            error_class: "TypeError",
            safe_signature: "undefined_property:destroy",
            next_chunk: "app-session-123.js",
            next_frames: [{ chunk: "app-session-123.js", line: 42, column: 7 }],
            digest: "safe_digest_123",
          },
        },
      },
    });
    expect(JSON.stringify((enriched as VoiceLabError).detail)).not.toContain("must-not-be-projected");
  });

  it("drops malformed interrupted route diagnostics instead of projecting caller-shaped data", () => {
    const timeout = new VoiceLabError(labError("OPERATION_TIMEOUT", "bounded", "harness", true));
    const interrupted = new VoiceLabError(labError("ORDINARY_UI_ROUTE_FAILED", "route", "harness", false, {
      stage: "voice_start_button",
      cause: { error_class: "TimeoutError", safe_signature: "raw product text", character_length: 10 },
      client_page_error: { error_class: "TypeError", safe_signature: "https://private.invalid/path", next_chunk: null, next_frames: [], digest: null },
      route_state: {
        location: "expected_session",
        voice_tab: "selected",
        voice_button: "arbitrary-private-state",
        dashboard_mic_visible: false,
        dashboard_mic_button: "arbitrary-private-state",
        consent_visible: false,
        auth_gate_visible: false,
        auth_checking_visible: false,
        session_store_loading_visible: true,
        voice_fallback_visible: false,
      },
    }));

    const detail = (augmentOperationTimeoutWithInterruptedDriverError(timeout, interrupted) as VoiceLabError).detail;
    expect(detail.details?.interrupted_driver_error).toEqual({
      code: "ORDINARY_UI_ROUTE_FAILED",
      stage: "voice_start_button",
    });
    expect(JSON.stringify(detail)).not.toContain("raw product text");
    expect(JSON.stringify(detail)).not.toContain("arbitrary-private-state");
  });

  it("normalizes U+0000 from harness error detail before jsonb persistence", () => {
    const error = labError(
      "ORDINARY_UI_ROUTE_FAILED",
      "The ordinary deployed Sophia voice route could not be established.",
      "harness",
      false,
      { cause: "locator failed\u0000after navigation", nested: ["safe\u0000detail"] },
    );

    expect(error.details).toEqual({
      cause: "locator failed\uFFFDafter navigation",
      nested: ["safe\uFFFDdetail"],
    });
    expect(JSON.stringify(error)).not.toContain("\\u0000");
  });

  it("rebinds recovery to the current deployment only for a proven allocation-free terminal run", async () => {
    const current = { frontend: "e".repeat(40), backend: "f".repeat(40), voice: "1".repeat(40) };
    const config = testConfig({
      SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL: "http://frontend.test",
      SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL: "http://gateway.test",
      SOPHIA_VOICE_LAB_TARGET_VOICE_URL: "http://voice.test",
      SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL: "http://langgraph.test",
      SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA: current.frontend,
      SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA: current.backend,
      SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA: current.voice,
      SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA: "2".repeat(40),
    });
    const terminalError = labError("ORDINARY_UI_ROUTE_FAILED", "The ordinary deployed Sophia voice route could not be established.", "harness");
    const run = testRun({ state: "failed_harness", cleanupComplete: false, terminalError, verdicts: { ...initialVerdicts(), harness: "fail", evidence: "fail" } });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    await ledger.cancelPendingRunOperations(run.id, null, terminalError);
    let observedExpectedDeployment: unknown = null;
    const driver = {
      hasSession: () => false,
      recover: async (_run: unknown, token: string) => {
        observedExpectedDeployment = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")).expected_deployment;
        return { events: [{ kind: "cleanup.recovery", source: "canonical", payload: { complete: true, live_cleanup_complete: true }, dedupeKey: `allocation-free-recovery:${run.id}` }], artifacts: [] };
      },
      readiness: async () => ({ ok: true, detail: "test-browser", engine: "chromium", version: "test" }),
      close: async () => undefined,
    } as any;
    const worker = new VoiceLabWorker("allocation-free-recovery-worker", ledger, config, audio, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds));

    await worker.maintainSessions();

    expect(observedExpectedDeployment).toEqual(current);
    expect((await ledger.listAuthAudit(run.id)).some((entry) => entry.action === "capability:session:recover" && entry.detail.recovery_runtime_rebound === true)).toBe(true);
  });

  it("terminalizes a nonterminal run whose durable failed operation survived a worker restart", async () => {
    const run = testRun({ state: "authenticating", cleanupComplete: false });
    const operation = startOperation(run);
    await ledger.createRunWithOperation(run, operation, { global: 1, caller: 1 });
    const claimed = await ledger.claimNextOperation("crash-recovery-worker", 30);
    expect(claimed?.operation.id).toBe(operation.id);
    await ledger.markOperationExecuting(operation.id, "crash-recovery-worker", claimed!.operation.leaseEpoch);
    const timeout = labError("OPERATION_TIMEOUT", "The bounded start operation timed out.", "harness", true, { operation_type: "start", deadline_seconds: 150 });
    await ledger.finishOperation(operation.id, "crash-recovery-worker", claimed!.operation.leaseEpoch, "timed_out", null, timeout);

    const driver = {
      hasSession: () => false,
      recover: async () => ({ events: [{ kind: "cleanup.recovery", source: "canonical", payload: { complete: true, live_cleanup_complete: true }, dedupeKey: `restart-recovery:${run.id}` }], artifacts: [] }),
      readiness: async () => ({ ok: true, detail: "test-browser", engine: "chromium", version: "test" }),
      close: async () => undefined,
    } as any;
    const config = testConfig();
    const worker = new VoiceLabWorker("replacement-recovery-worker", ledger, config, audio, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds));

    await worker.maintainSessions();

    const recovered = await ledger.getRun(run.id);
    expect(recovered).toMatchObject({ state: "failed_harness", terminalError: { code: "OPERATION_TIMEOUT" } });
    expect((await ledger.listEvents(run.id, 0, 100)).events).toContainEqual(expect.objectContaining({ kind: "run.failed_harness" }));
  });

  it("advances the evidence revision after an orphan manifest and changed run projection", async () => {
    const terminalError = labError(
      "ORDINARY_UI_ROUTE_FAILED",
      "The ordinary deployed Sophia voice route could not be established.",
      "harness",
      false,
      { browser_diagnostic: "x".repeat(1_000_100) },
    );
    const run = testRun({
      state: "failed_harness",
      cleanupComplete: true,
      terminalError,
      verdicts: { ...initialVerdicts(), harness: "fail", evidence: "fail" },
    });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    await ledger.cancelPendingRunOperations(run.id, null, terminalError);
    for (let index = 0; index < 3; index += 1) {
      await ledger.appendEvent(run.id, "cleanup.recovery", "canonical", { complete: true, diagnostic: `${index}${"r".repeat(700_000)}` }, `large-recovery-${index}`);
    }

    const originalSaveEvidence = ledger.saveEvidence.bind(ledger);
    let injectCrash = true;
    ledger.saveEvidence = async (evidence) => {
      if (injectCrash) {
        injectCrash = false;
        throw new Error("simulated crash after immutable manifest insert");
      }
      return originalSaveEvidence(evidence);
    };
    const config = testConfig();
    const driver = {
      hasSession: () => false,
      readiness: async () => ({ ok: true, detail: "test-browser", engine: "chromium", version: "test" }),
      close: async () => undefined,
    } as any;
    const worker = new VoiceLabWorker(
      "worker-orphan-manifest",
      ledger,
      config,
      audio,
      driver,
      new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds),
    );

    await expect(worker.maintainSessions()).rejects.toThrow("simulated crash");
    expect(await ledger.getEvidence(run.id)).toBeNull();
    expect((await ledger.listArtifacts(run.id)).filter((artifact) => artifact.kind === "manifest_attachment")).toHaveLength(1);

    for (let index = 0; index < 4; index += 1) {
      const bytes = Buffer.alloc(1_600_000, index + 1);
      await ledger.saveArtifact({ id: randomUUID(), runId: run.id, kind: "capture_json", contentType: "application/json", sha256: sha256(bytes), bytes, createdAt: new Date() });
    }

    const stale = await ledger.getRun(run.id);
    await ledger.updateRun(run.id, stale!.version, { observedDeployment: { frontend: SHA } });
    await expect(worker.maintainSessions()).resolves.toBeUndefined();

    const evidence = await ledger.getEvidence(run.id);
    expect(evidence).not.toBeNull();
    expect((await ledger.listArtifacts(run.id)).filter((artifact) => artifact.kind === "manifest_attachment")).toHaveLength(1);
    expect((await ledger.listEvents(run.id, 0, 100)).events.filter((event) => event.kind === "evidence.publication_revision")).toHaveLength(2);
    expect((await ledger.listEvents(run.id, 0, 100)).events.filter((event) => event.kind === "evidence.orphan_artifacts_pruned")).toHaveLength(1);
  });

  it("reports the exact 21-scenario catalog, governed fixture classes, limits, and caller scope", async () => {
    const result = await service.getCapabilities(caller, {});
    expect(result.status).toBe("ok");
    expect(result.data.scenario_versions).toEqual(["vt00.scenarios.v1"]);
    expect((result.data.scenarios as unknown[])).toHaveLength(21);
    expect((result.data.scenarios as Array<{ id: string }>).map((item) => item.id)).toEqual(SCENARIO_IDS);
    expect((result.data.fixtures as Array<{ fixtureClass: string }>).map((fixture) => fixture.fixtureClass).sort()).toEqual(["long_brief", "noisy_command", "short_command", "silence", "trailing_pause"]);
    expect(result.data.restricted_fault_capabilities).toEqual(["force_socket_rotation"]);
    expect(result.data.raw_audio).toBe("unavailable_until_isolated_storage");
    expect(result.data.versions).toEqual({ harness: "0.1.0", mcp: "0.1.0", plugin: "0.1.0+codex.test", evidence_schema: "sophia.voice-lab.evidence.v1", scenario_catalog: "vt00.scenarios.v1" });
    expect(result.data.repository_commits).toEqual({ base: "41a9b127af780bbe9d88acf34566a6aaf443e6b0", candidate: SHA, rollback: "a793100008f7ccb5a25e9e018f896e7ec9dc2a3d" });
    expect(result.data.registered_app).toMatchObject({ technical_id: "plugin_asdk_app_voice_lab_test_0001", platform_install_attestation: "required_for_v_p01_and_not_self_asserted" });
  });

  it("rejects an unknown fixture through the owning public speak surface before run readiness or operation allocation", async () => {
    const started = await service.startVoiceRun(caller, { environment: "production", target, scenario_id: "V-S02", scenario_version: "vt00.scenarios.v1", idempotency_key: "s02-public-fixture-run" });
    const runId = started.run_id!;
    const before = await ledger.getRun(runId);
    const operationsBefore = await ledger.listOperations(runId);
    await expect(service.speak(caller, { run_id: runId, fixture_id: "s02-governed-unknown-fixture", idempotency_key: "s02-public-fixture-probe" })).rejects.toMatchObject({ detail: { code: "FIXTURE_NOT_FOUND" } });
    const after = await ledger.getRun(runId);
    expect(await ledger.listOperations(runId)).toHaveLength(operationsBefore.length);
    expect(after?.latestCursor).toBe(before?.latestCursor);
    expect(after?.canonicalSessionId).toBeNull();
    expect(after?.providerSessionId).toBeNull();
  });

  it("gives a fresh tool-only client the configured target and currently verified deployment identities", async () => {
    const config = testConfig({
      SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL: "http://frontend.test",
      SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL: "http://gateway.test",
      SOPHIA_VOICE_LAB_TARGET_VOICE_URL: "http://voice.test",
      SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL: "http://langgraph.test",
      SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA: SHA,
      SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA: SHA_B,
      SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA: SHA_C,
      SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA: SHA_D,
    });
    const targetService = new VoiceLabService(ledger, config, async () => audio.summaries(), async () => audio.ttsInfo(), async () => ({
      ok: true,
      status: "verified",
      builds: {
        frontend: { ready: true, expected: SHA, observed: SHA },
        backend: { ready: true, expected: SHA_B, observed: SHA_B },
        voice: { ready: true, expected: SHA_C, observed: SHA_C },
        langgraph: { ready: true, expected: SHA_D, observed: SHA_D },
      },
    }));
    const capabilities = await targetService.getCapabilities(caller, {});
    expect(capabilities.data.target_environment).toEqual({
      environment: "production",
      frontend_url: "http://frontend.test",
      gateway_url: "http://gateway.test",
      voice_url: "http://voice.test",
      langgraph_url: "http://langgraph.test",
      expected_deployment: { frontend: SHA, backend: SHA_B, voice: SHA_C },
      expected_dependencies: { langgraph: SHA_D },
      current_identity: expect.objectContaining({ ok: true, status: "verified" }),
    });
  });

  it("requires the LangGraph dependency URL and SHA with the complete readiness target", () => {
    expect(() => testConfig({
      SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL: "http://frontend.test",
      SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL: "http://gateway.test",
      SOPHIA_VOICE_LAB_TARGET_VOICE_URL: "http://voice.test",
      SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA: SHA,
      SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA: SHA_B,
      SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA: SHA_C,
    })).toThrowError(/dependency SHAs must be configured together/i);
    expect(() => testConfig({
      SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL: "http://langgraph.test",
      SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA: SHA_D,
    })).toThrowError(/dependency SHAs must be configured together/i);
  });

  it("hard-fences provider-bearing admission and rechecks immediately before browser allocation", async () => {
    const config = testConfig({
      SOPHIA_VOICE_LAB_TARGET_FRONTEND_URL: "http://frontend.test",
      SOPHIA_VOICE_LAB_TARGET_GATEWAY_URL: "http://gateway.test",
      SOPHIA_VOICE_LAB_TARGET_VOICE_URL: "http://voice.test",
      SOPHIA_VOICE_LAB_TARGET_LANGGRAPH_URL: "http://langgraph.test",
      SOPHIA_VOICE_LAB_EXPECTED_FRONTEND_SHA: SHA,
      SOPHIA_VOICE_LAB_EXPECTED_BACKEND_SHA: SHA_B,
      SOPHIA_VOICE_LAB_EXPECTED_VOICE_SHA: SHA_C,
      SOPHIA_VOICE_LAB_EXPECTED_LANGGRAPH_SHA: SHA_D,
    });
    const fencedLedger = new MemoryVoiceLabLedger("test");
    const fencedAudio = new AudioResolver(config);
    await fencedAudio.initialize();
    const missingDependency = productAdmissionProof(config, true);
    delete (missingDependency.builds as Record<string, unknown>).langgraph;
    expect(() => assertFreshProductAdmissionProof(config, config.readinessTarget!, missingDependency)).toThrowError(
      expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_ADMISSION_NOT_READY" }) }),
    );
    const mismatchedDependency = productAdmissionProof(config, true);
    ((mismatchedDependency.builds as Record<string, unknown>).langgraph as Record<string, unknown>).observed = SHA;
    expect(() => assertFreshProductAdmissionProof(config, config.readinessTarget!, mismatchedDependency)).toThrowError(
      expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_ADMISSION_NOT_READY" }) }),
    );
    const closedProductMutationGates = productAdmissionProof(config, true);
    closedProductMutationGates.product_mutation_gates_open = false;
    expect(() => assertFreshProductAdmissionProof(config, config.readinessTarget!, closedProductMutationGates)).toThrowError(
      expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_ADMISSION_NOT_READY" }) }),
    );
    let admissionReady = false;
    const probe = async () => productAdmissionProof(config, admissionReady);
    const fencedService = new VoiceLabService(fencedLedger, config, async () => fencedAudio.summaries(), async () => fencedAudio.ttsInfo(), probe);
    const request = { environment: "production" as const, target, scenario_id: "V-P01" as const, scenario_version: "vt00.scenarios.v1", idempotency_key: "skip-capabilities-admission" };

    await expect(fencedService.startVoiceRun(caller, request)).rejects.toMatchObject({ detail: { code: "PRODUCT_ADMISSION_NOT_READY" } });
    expect(await fencedLedger.countActiveRuns()).toBe(0);
    await expect(fencedService.runRegressionSuite(caller, { environment: "production", target, scenarios: [{ id: "V-P01" }], max_concurrency: 1, idempotency_key: "suite-admission-not-ready" })).rejects.toMatchObject({ detail: { code: "PRODUCT_ADMISSION_NOT_READY" } });
    expect(await fencedLedger.listRunnableSuites(10)).toHaveLength(0);

    admissionReady = true;
    const accepted = await fencedService.startVoiceRun(caller, { ...request, idempotency_key: "queued-before-readiness-drop" });
    admissionReady = false;
    let browserStarts = 0;
    const driver = {
      hasSession: () => false,
      start: async () => { browserStarts += 1; throw new Error("must not allocate"); },
      recover: async () => ({ events: [
        { kind: "cleanup.browser_context_absent", source: "worker", payload: { browser_never_allocated: true }, dedupeKey: `cleanup:${accepted.run_id}:context-absent` },
        { kind: "cleanup.recovery", source: "canonical", payload: { complete: true, receipt: { complete: true, live_cleanup_complete: true, live_resources_zero: true, components: { builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } } } }, dedupeKey: `cleanup:${accepted.run_id}:recovery` },
      ], artifacts: [] }),
      cancel: async () => undefined,
      readiness: async () => ({ ok: true, detail: "test", engine: "chromium", version: "test" }),
      close: async () => undefined,
    } as any;
    const worker = new VoiceLabWorker("worker-admission-drop", fencedLedger, config, fencedAudio, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), undefined, fetch, probe);
    expect(await worker.runOnce()).toBe(true);
    expect(browserStarts).toBe(0);
    expect(await fencedLedger.getOperation(accepted.operation_id!)).toMatchObject({ state: "failed", error: { code: "PRODUCT_ADMISSION_NOT_READY" } });

    // The pre-resource security scenarios remain explicitly exempt and can
    // diagnose the broken boundary without allocating a browser/provider.
    const preResource = await fencedService.startVoiceRun(caller, { ...request, scenario_id: "V-S01", idempotency_key: "pre-resource-admission-diagnostic" });
    expect(preResource.status).toBe("accepted");
  });

  it("renews operation and browser ownership from the shorter lease", () => {
    expect(leaseHeartbeatIntervalMs(300, 10)).toBe(3_333);
    expect(leaseHeartbeatIntervalMs(10, 120)).toBe(3_333);
    expect(leaseHeartbeatIntervalMs(10, 10)).toBeLessThan(10_000);
  });

  it("keeps mandatory unavailable proof pending and certifies suites from verdicts, not execution labels", async () => {
    expect(certificationTerminalDecision({ harness: "unavailable", product: "unavailable", provider: "pass", auth: "pass", evidence: "unavailable" })).toEqual({ state: "pending_external_evidence", reason: "mandatory_supported_assertions_awaiting_external_evidence" });
    expect(certificationTerminalDecision({ harness: "pass", product: "unavailable", provider: "pass", auth: "pass", evidence: "pass" })).toEqual({ state: "completed", reason: "harness_evidence_certified_product_unavailable_provider_pass" });
    expect(() => assertTransition("pending_external_evidence", "completed")).not.toThrow();
    const abortedButCertified = testRun({ state: "aborted_driver_restart", cleanupComplete: true, verdicts: { harness: "pass", product: "unavailable", provider: "pass", auth: "pass", evidence: "pass" } });
    expect(suiteCertificationState([abortedButCertified])).toBe("completed");
    const pending = testRun({ state: "pending_external_evidence", cleanupComplete: true, expiresAt: new Date(Date.now() - 1), verdicts: { harness: "unavailable", product: "unavailable", provider: "pass", auth: "pass", evidence: "unavailable" } });
    await ledger.createRunWithOperation(pending, startOperation(pending), { global: 1, caller: 1 });
    expect(suiteCertificationState([pending])).toBe("pending");
    expect((await ledger.listRunsCertificationDue(new Date(), 10)).map((run) => run.id)).toEqual([pending.id]);
  });

  it("labels a mixed certified suite without implying that product-unavailable children passed product assertions", async () => {
    const children = [
      testRun({ scenarioId: "V-I01", state: "completed", cleanupComplete: true, verdicts: { harness: "pass", product: "pass", provider: "pass", auth: "pass", evidence: "pass" } }),
      testRun({ scenarioId: "V-I02", state: "completed", cleanupComplete: true, verdicts: { harness: "pass", product: "unavailable", provider: "pass", auth: "pass", evidence: "pass" } }),
    ];
    const projection = suiteCertificationProjection(children);
    expect(projection).toMatchObject({ status: "certified", outcome_label: "harness_evidence_certified_mixed_product_outcomes", product_counts: { pass: 1, unavailable: 1 }, outcome_counts: { harness_evidence_certified_product_pass: 1, harness_evidence_certified_product_unavailable: 1 } });
    const manifest = await buildSuiteCertificationManifest(children);
    expect(manifest.aggregate_certification).toMatchObject(projection);
    expect(manifest.certification_outcome_counts).toMatchObject({ harness_evidence_certified_product_pass: 1, harness_evidence_certified_product_unavailable: 1 });
    expect(manifest.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ scenario_id: "V-I01", certification_outcome: "harness_evidence_certified_product_pass", certification_reason: "harness_evidence_certified_product_pass_provider_pass" }),
      expect.objectContaining({ scenario_id: "V-I02", certification_outcome: "harness_evidence_certified_product_unavailable", certification_reason: "harness_evidence_certified_product_unavailable_provider_pass" }),
    ]));
    expect(manifest.product_nonpass_certifications).toEqual([expect.objectContaining({ scenario_id: "V-I02", certification_outcome: "harness_evidence_certified_product_unavailable" })]);
    expect(manifest.human_summary).toContain("Product outcomes: 1 pass, 1 unavailable");
  });

  it("labels an all-product-unavailable certified suite explicitly", async () => {
    const children = ["V-I02", "V-N01"].map((scenarioId) => testRun({ scenarioId: scenarioId as "V-I02" | "V-N01", state: "completed", cleanupComplete: true, verdicts: { harness: "pass", product: "unavailable", provider: "pass", auth: "pass", evidence: "pass" } }));
    const manifest = await buildSuiteCertificationManifest(children);
    expect(manifest.aggregate_certification).toMatchObject({ status: "certified", outcome_label: "harness_evidence_certified_all_product_unavailable", harness_evidence_certified_count: 2, product_counts: { pass: 0, unavailable: 2 } });
    expect(manifest.certification_outcome_counts).toEqual({ harness_evidence_certified_product_unavailable: 2 });
    expect(manifest.children.every((child: any) => child.certification_outcome === "harness_evidence_certified_product_unavailable")).toBe(true);
    expect(manifest.human_summary).toContain("Aggregate label: harness_evidence_certified_all_product_unavailable");
  });

  it("returns one start operation/run for 20 concurrent same-key calls and conflicts on changed arguments", async () => {
    const request = { environment: "production", target, scenario_id: "V-P01", scenario_version: "vt00.scenarios.v1", idempotency_key: "concurrent-start" };
    const results = await Promise.all(Array.from({ length: 20 }, () => service.startVoiceRun(caller, request)));
    expect(new Set(results.map((result) => result.run_id)).size).toBe(1);
    expect(new Set(results.map((result) => result.operation_id)).size).toBe(1);
    expect(results.filter((result) => result.data.replay === false)).toHaveLength(1);
    expect(results.filter((result) => result.data.submission_outcome === "durably_accepted")).toHaveLength(1);
    expect(results.filter((result) => result.data.submission_outcome === "idempotent_replay")).toHaveLength(19);
    await expect(service.startVoiceRun(caller, { ...request, scenario_id: "V-F01" })).rejects.toMatchObject({ detail: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("enforces idempotent rolling run, suite-child, provider, and audio reservations before allocation", async () => {
    const limitedConfig = testConfig({
      SOPHIA_VOICE_LAB_MAX_ROLLING_RUN_STARTS: "1",
      SOPHIA_VOICE_LAB_MAX_ROLLING_RUN_STARTS_PER_CALLER: "1",
      SOPHIA_VOICE_LAB_MAX_ROLLING_SUITE_CHILDREN: "1",
      SOPHIA_VOICE_LAB_MAX_ROLLING_SUITE_CHILDREN_PER_CALLER: "1",
      SOPHIA_VOICE_LAB_MAX_ROLLING_INJECTED_DURATION_MS: "1000",
      SOPHIA_VOICE_LAB_MAX_ROLLING_INJECTED_DURATION_MS_PER_CALLER: "1000",
    });
    const limitedLedger = new MemoryVoiceLabLedger("test");
    const limitedAudio = new AudioResolver(limitedConfig);
    await limitedAudio.initialize();
    const limited = new VoiceLabService(limitedLedger, limitedConfig, async () => limitedAudio.summaries());
    const first = await limited.startVoiceRun(caller, { environment: "production", target, scenario_id: "V-P01", scenario_version: "vt00.scenarios.v1", idempotency_key: "rolling-first" });
    const replay = await limited.startVoiceRun(caller, { environment: "production", target, scenario_id: "V-P01", scenario_version: "vt00.scenarios.v1", idempotency_key: "rolling-first" });
    expect(replay.run_id).toBe(first.run_id);
    const firstRun = await limitedLedger.getRun(first.run_id!);
    await limitedLedger.updateRun(firstRun!.id, firstRun!.version, { state: "completed", cleanupComplete: true });
    await expect(limited.startVoiceRun(caller, { environment: "production", target, scenario_id: "V-P01", scenario_version: "vt00.scenarios.v1", idempotency_key: "rolling-second" })).rejects.toMatchObject({ detail: { code: "ROLLING_RUN_STARTS_LIMIT" } });
    expect(await limitedLedger.countActiveRuns()).toBe(0);

    const suiteConfig = testConfig({ SOPHIA_VOICE_LAB_MAX_ROLLING_SUITE_CHILDREN: "1", SOPHIA_VOICE_LAB_MAX_ROLLING_SUITE_CHILDREN_PER_CALLER: "1" });
    const suiteLedger = new MemoryVoiceLabLedger("test");
    const suiteService = new VoiceLabService(suiteLedger, suiteConfig, async () => limitedAudio.summaries());
    await expect(suiteService.runRegressionSuite(caller, { environment: "production", target, scenarios: [{ id: "V-A01" }, { id: "V-A02" }], max_concurrency: 1, idempotency_key: "rolling-suite-too-large" })).rejects.toMatchObject({ detail: { code: "ROLLING_SUITE_CHILDREN_LIMIT" } });
    expect(await suiteLedger.listRunnableSuites(10)).toHaveLength(0);

    const ready = testRun({ state: "ready" });
    await limitedLedger.createRunWithOperation(ready, startOperation(ready), { global: 1, caller: 1 });
    await expect(limited.speak(caller, { run_id: ready.id, text: "hello", idempotency_key: "rolling-audio-too-long" })).rejects.toMatchObject({ detail: { code: "ROLLING_AUDIO_DURATION_MS_LIMIT" } });
    expect((await limitedLedger.listOperations(ready.id)).filter((operation) => operation.type === "speak")).toHaveLength(0);
  });

  it("fences resolved fixture/TTS media against the exact durable audio reservation", () => {
    expect(() => assertResolvedAudioWithinAdmission({ duration_ms: 1_000, bytes: 44_144 }, 1_000, 44_144)).not.toThrow();
    expect(() => assertResolvedAudioWithinAdmission({ duration_ms: 1_000, bytes: 44_144 }, 1_001, 44_144)).toThrow(expect.objectContaining({ detail: expect.objectContaining({ code: "AUDIO_ADMISSION_RESERVATION_EXCEEDED" }) }));
    expect(() => assertResolvedAudioWithinAdmission({ duration_ms: 1_000, bytes: 44_144 }, 1_000, 44_145)).toThrow(expect.objectContaining({ detail: expect.objectContaining({ code: "AUDIO_ADMISSION_RESERVATION_EXCEEDED" }) }));
    expect(() => assertResolvedAudioWithinAdmission({}, 1_000, 44_144)).toThrow(expect.objectContaining({ detail: expect.objectContaining({ code: "AUDIO_ADMISSION_RECEIPT_INVALID" }) }));
  });

  it("treats a surviving rolling reservation as a content-free replay tombstone after retention purge", async () => {
    const startRequest = { environment: "production" as const, target, scenario_id: "V-P01", scenario_version: "vt00.scenarios.v1", idempotency_key: "purged-start-replay" };
    const started = await service.startVoiceRun(caller, startRequest);
    const startedRun = await ledger.getRun(started.run_id!);
    await ledger.updateRun(startedRun!.id, startedRun!.version, { state: "completed", cleanupComplete: true, retentionPurgeDueAt: new Date(Date.now() - 1), retentionPurgePending: true });
    await ledger.purgeExpiredRetention(new Date(), 10);
    await expect(service.startVoiceRun(caller, startRequest)).rejects.toMatchObject({ detail: { code: "IDEMPOTENCY_RETENTION_EXPIRED" } });
    expect(await ledger.countActiveRuns()).toBe(0);

    const suiteLedger = new MemoryVoiceLabLedger("test");
    const suiteService = new VoiceLabService(suiteLedger, testConfig(), async () => audio.summaries());
    const suiteRequest = { environment: "production" as const, target, scenarios: [{ id: "V-P01" as const }], max_concurrency: 1 as const, idempotency_key: "purged-suite-replay" };
    const accepted = await suiteService.runRegressionSuite(caller, suiteRequest);
    await suiteLedger.updateSuite(accepted.suite_run_id!, "cancelled", [], 1);
    await suiteLedger.purgeExpiredRetention(new Date(), 10);
    await expect(suiteService.runRegressionSuite(caller, suiteRequest)).rejects.toMatchObject({ detail: { code: "IDEMPOTENCY_RETENTION_EXPIRED" } });
    expect(await suiteLedger.listRunnableSuites(10)).toHaveLength(0);
  });

  it("scopes idempotency to a run and returns one operation for concurrent retry", async () => {
    const first = testRun({ state: "ready" });
    const second = testRun({ state: "ready", cleanupComplete: true });
    await ledger.createRunWithOperation(first, startOperation(first), { global: 2, caller: 2 });
    await ledger.updateRun(first.id, 1, { cleanupComplete: true, state: "completed" });
    await ledger.createRunWithOperation(second, startOperation(second), { global: 2, caller: 2 });
    const base = { callerId: caller.subject, type: "speak" as const, idempotencyKey: "turn-1", requestHash: "1".repeat(64), input: { fixture_id: "a02_short_command" } };
    const firstCreated = await Promise.all(Array.from({ length: 20 }, () => ledger.createOperation({ ...base, id: randomUUID(), runId: first.id })));
    expect(new Set(firstCreated.map((item) => item.operation.id)).size).toBe(1);
    const secondCreated = await ledger.createOperation({ ...base, id: randomUUID(), runId: second.id });
    expect(secondCreated.operation.runId).toBe(second.id);
    expect(secondCreated.operation.id).not.toBe(firstCreated[0]!.operation.id);
  });

  it("binds one cleanup obligation to one durable run while preserving exact start replay", async () => {
    const first = testRun({ state: "ready" });
    const created = await ledger.createRunWithOperation(first, startOperation(first), { global: 2, caller: 2 });
    const replay = await ledger.createRunWithOperation({ ...first, cleanupObligationId: "00000000-0000-4000-8000-000000000003" }, startOperation(first), { global: 2, caller: 2 });
    expect(replay.replay).toBe(true);
    expect(replay.run.cleanupObligationId).toBe(created.run.cleanupObligationId);
    const conflicting = testRun({ state: "ready", cleanupObligationId: first.cleanupObligationId });
    await expect(ledger.createRunWithOperation(conflicting, startOperation(conflicting), { global: 2, caller: 2 })).rejects.toMatchObject({ detail: { code: "CLEANUP_OBLIGATION_CONFLICT" } });
  });

  it("requires every V-A01 follow-up to cite the latest exact app-authored assistant observation", async () => {
    const run = testRun({ scenarioId: "V-A01", state: "ready" });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const start = await ledger.claimNextOperation("adaptive-worker", 30);
    await ledger.markOperationExecuting(start!.operation.id, "adaptive-worker", start!.operation.leaseEpoch);
    await ledger.finishOperation(start!.operation.id, "adaptive-worker", start!.operation.leaseEpoch, "succeeded", {}, null);
    await ledger.upsertBrowserLease(run.id, "adaptive-worker", 60);
    const greeting = await ledger.createOperation({ id: randomUUID(), runId: run.id, callerId: caller.subject, type: "speak", idempotencyKey: "a01-greeting", requestHash: sha256("a01-greeting"), input: { text: "neutral greeting" } });
    const claimedGreeting = await ledger.claimNextOperation("adaptive-worker", 30);
    await ledger.markOperationExecuting(claimedGreeting!.operation.id, "adaptive-worker", claimedGreeting!.operation.leaseEpoch);
    await ledger.finishOperation(claimedGreeting!.operation.id, "adaptive-worker", claimedGreeting!.operation.leaseEpoch, "succeeded", { schedule_receipt: {} }, null);
    expect(claimedGreeting!.operation.id).toBe(greeting.operation.id);
    const binding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    const turn = await ledger.appendEvent(run.id, "product.voice-sse.sophia.turn", "product", { _product_run_binding: binding, data: { phase: "agent_ended", turnId: "turn-a01-1" } });
    const withTurn = await ledger.getRun(run.id);
    await ledger.updateRun(run.id, withTurn!.version, { turnId: "turn-a01-1" });
    await expect(service.speak(caller, { run_id: run.id, text: "predetermined follow-up", idempotency_key: "a01-missing-observation", timing_policy: { schedule_timeout_ms: 100 } })).rejects.toMatchObject({ detail: { code: "ADAPTIVE_OBSERVATION_REQUIRED" } });
    await expect(service.speak(caller, { run_id: run.id, text: "stale follow-up", idempotency_key: "a01-stale-observation", expected_cursor: turn.seq, expected_turn_id: "turn-a01-1", adaptive_observation: { event_seq: turn.seq + 1, turn_id: "turn-a01-1", observation_class: "assistant_turn_complete", followup_intent: "clarify" }, timing_policy: { schedule_timeout_ms: 100 } })).rejects.toMatchObject({ detail: { code: "ADAPTIVE_OBSERVATION_MISMATCH" } });
    const accepted = await service.speak(caller, { run_id: run.id, text: "observation-bound follow-up", idempotency_key: "a01-exact-observation", expected_cursor: turn.seq, expected_turn_id: "turn-a01-1", adaptive_observation: { event_seq: turn.seq, turn_id: "turn-a01-1", observation_class: "assistant_turn_complete", followup_intent: "clarify" }, timing_policy: { schedule_timeout_ms: 100 } });
    expect(accepted.status).toBe("timeout");
    const followup = (await ledger.listOperations(run.id)).find((operation) => operation.id === accepted.operation_id)!;
    expect(accepted.data).toMatchObject({ replay: false, submission_outcome: "durably_accepted", operation_state: followup.state });
    expect(["accepted", "queued", "leased", "executing"]).toContain(accepted.data.operation_state);
    expect(followup.input.adaptive_observation).toMatchObject({ event_seq: turn.seq, turn_id: "turn-a01-1", followup_intent: "clarify" });
  });

  it("mints and verifies one service-authenticated V-P01 observation receipt", async () => {
    const run = testRun({ scenarioId: "V-P01", state: "ready" });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const start = await ledger.claimNextOperation("p01-receipt-worker", 30);
    await ledger.markOperationExecuting(start!.operation.id, "p01-receipt-worker", start!.operation.leaseEpoch);
    await ledger.finishOperation(start!.operation.id, "p01-receipt-worker", start!.operation.leaseEpoch, "succeeded", {}, null);
    await ledger.upsertBrowserLease(run.id, "p01-receipt-worker", 60);
    const first = await ledger.createOperation({ id: randomUUID(), runId: run.id, callerId: caller.subject, type: "speak", idempotencyKey: "p01-first", requestHash: sha256("p01-first"), input: { text: "initial utterance" } });
    const claimedFirst = await ledger.claimNextOperation("p01-receipt-worker", 30);
    await ledger.markOperationExecuting(claimedFirst!.operation.id, "p01-receipt-worker", claimedFirst!.operation.leaseEpoch);
    await ledger.finishOperation(claimedFirst!.operation.id, "p01-receipt-worker", claimedFirst!.operation.leaseEpoch, "succeeded", { schedule_receipt: {} }, null);
    expect(claimedFirst!.operation.id).toBe(first.operation.id);
    const binding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    const turn = await ledger.appendEvent(run.id, "product.voice-sse.sophia.turn", "product", { _product_run_binding: binding, data: { phase: "agent_ended", turnId: "turn-p01-1" } });
    await ledger.appendEvent(run.id, "provider.connection_epoch", "product", { receipt: { providerConnectionEpoch: 7 } });
    const beforeFollowup = await ledger.getRun(run.id);
    await ledger.updateRun(run.id, beforeFollowup!.version, { providerEpoch: 7, turnId: "turn-p01-1" });
    const waited = await service.waitForTurn(caller, { run_id: run.id, after_cursor: 0, condition: "assistant_turn_complete", timeout_ms: 100 });
    const receipts = waited.data.observation_receipts as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ schema: "sophia_voice_lab_observation_receipt_v1", run_id: run.id, test_run_id: run.testRunId, scenario_id: "V-P01", scenario_version: "vt00.scenarios.v1", event_seq: turn.seq, turn_id: "turn-p01-1", observation_class: "assistant_turn_complete" });
    expect(receipts[0]!.deployment_identity_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipts[0]!.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
    const current = await ledger.getRun(run.id);
    await expect(service.speak(caller, { run_id: run.id, text: "tampered follow-up", idempotency_key: "p01-tampered", expected_cursor: current!.latestCursor, expected_provider_epoch: 7, expected_turn_id: "turn-p01-1", adaptive_observation: { receipt: { ...receipts[0], receipt_sha256: "0".repeat(64) }, followup_intent: "clarify" }, timing_policy: { schedule_timeout_ms: 100 } })).rejects.toMatchObject({ detail: { code: "ADAPTIVE_OBSERVATION_INTEGRITY_FAILED" } });
    const followupInput = { run_id: run.id, text: "receipt-bound follow-up", idempotency_key: "p01-receipt-followup", expected_cursor: current!.latestCursor, expected_provider_epoch: 7, expected_turn_id: "turn-p01-1", adaptive_observation: { receipt: receipts[0], followup_intent: "clarify" }, timing_policy: { schedule_timeout_ms: 100 } };
    const accepted = await service.speak(caller, followupInput);
    expect(accepted).toMatchObject({ status: "timeout", data: { replay: false, submission_outcome: "durably_accepted" } });
    const postAccepted = await ledger.getRun(run.id);
    await expect(service.speak(caller, { ...followupInput, idempotency_key: "p01-receipt-reuse", expected_cursor: postAccepted!.latestCursor })).rejects.toMatchObject({ detail: { code: "P01_UTTERANCE_LIMIT" } });
    const replay = await service.speak(caller, followupInput);
    expect(replay).toMatchObject({ operation_id: accepted.operation_id, status: "timeout", data: { replay: true, submission_outcome: "idempotent_replay" } });
  });

  it("bounded-waits in end so the next and final export call deterministically returns evidence", async () => {
    const run = testRun({ state: "active" });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const start = await ledger.claimNextOperation("end-wait-worker", 30);
    await ledger.markOperationExecuting(start!.operation.id, "end-wait-worker", start!.operation.leaseEpoch);
    await ledger.finishOperation(start!.operation.id, "end-wait-worker", start!.operation.leaseEpoch, "succeeded", {}, null);
    await ledger.upsertBrowserLease(run.id, "end-wait-worker", 60);
    const endPromise = service.endVoiceRun(caller, { run_id: run.id, idempotency_key: "bounded-end", wait_timeout_ms: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const claimedEnd = await ledger.claimNextOperation("end-wait-worker", 30);
    expect(claimedEnd?.operation.type).toBe("end");
    await ledger.markOperationExecuting(claimedEnd!.operation.id, "end-wait-worker", claimedEnd!.operation.leaseEpoch);
    await ledger.finishOperation(claimedEnd!.operation.id, "end-wait-worker", claimedEnd!.operation.leaseEpoch, "succeeded", { run_state: "completed" }, null);
    const fresh = await ledger.getRun(run.id);
    await ledger.updateRun(run.id, fresh!.version, { state: "completed", cleanupComplete: true });
    const manifestId = randomUUID();
    await ledger.saveEvidence({ runId: run.id, manifestId, manifestSha256: sha256("bounded-end-manifest"), schemaVersion: "sophia.voice-lab.evidence.v1", revisionSeq: 1, artifactRefs: [], createdAt: new Date() });
    const ended = await endPromise;
    expect(ended).toMatchObject({ status: "completed", operation_id: claimedEnd!.operation.id, data: { replay: false, submission_outcome: "durably_accepted", operation_state: "succeeded", cleanup_complete: true, evidence_state: "available", manifest_id: manifestId } });
    const exported = await service.exportVoiceEvidence(caller, { run_id: run.id });
    expect(exported).toMatchObject({ status: "completed", data: { manifest_id: manifestId } });
  });

  it("revokes an issued OAuth family even when its token response has the wrong resource binding", async () => {
    const config = testConfig({
      SOPHIA_VOICE_LAB_OAUTH_ISSUER: "https://oauth.test",
      SOPHIA_VOICE_LAB_OAUTH_RESOURCE: "https://voice-lab.test/mcp",
      SOPHIA_VOICE_LAB_OAUTH_RESOURCE_METADATA_URL: "https://voice-lab.test/.well-known/oauth-protected-resource/mcp",
      SOPHIA_VOICE_LAB_OAUTH_CLIENT_METADATA_URL: "https://chatgpt.com/oauth/client.json",
      SOPHIA_VOICE_LAB_OAUTH_CLIENT_REDIRECT_URI: "https://chatgpt.com/connector_platform_oauth_redirect",
      SOPHIA_VOICE_LAB_OAUTH_OPERATOR_SUBJECT: "voice-lab-private-operator",
      SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET: "oauth-consent-secret-00000000000000001",
      SOPHIA_VOICE_LAB_OAUTH_TOKEN_PEPPER: "oauth-token-pepper-0000000000000000001",
    });
    const oauthLedger = new MemoryVoiceLabLedger("test");
    const run = testRun({ scenarioId: "V-S01", state: "reserved" });
    await oauthLedger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const response = (status: number, body: BodyInit | null, url: string, headers: HeadersInit = {}) => {
      const value = new Response(body, { status, headers });
      Object.defineProperty(value, "url", { value: url });
      return value;
    };
    let revokeCalls = 0;
    const scenarioFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      const body = String(init?.body ?? "");
      if (url.origin === "http://frontend.test" && url.pathname === config.authGrantPath) return response(401, "{}", url.toString(), { "content-type": "application/json" });
      if (url.origin === "https://voice-lab.test" && url.pathname === "/mcp") return response(401, "{}", url.toString(), { "www-authenticate": "Bearer resource_metadata=\"https://voice-lab.test/.well-known/oauth-protected-resource/mcp\", error_description=\"invalid\"" });
      if (url.origin === "https://oauth.test" && url.pathname === "/authorize" && method === "GET" && url.searchParams.get("resource") !== config.oauth!.resource) {
        return response(303, null, url.toString(), { location: `${config.oauth!.clientRedirectUri}?error=invalid_target&iss=${encodeURIComponent("https://oauth.test")}` });
      }
      if (url.origin === "https://oauth.test" && url.pathname === "/authorize" && method === "GET") {
        return response(200, '<input name="request_id" value="request-12345678"><input name="csrf_token" value="csrf-12345678">', url.toString(), { "set-cookie": "__Host-probe=csrf; Secure; HttpOnly" });
      }
      if (url.origin === "https://oauth.test" && url.pathname === "/authorize" && method === "POST") {
        return response(303, null, url.toString(), { location: `${config.oauth!.clientRedirectUri}?code=issued-code-12345678&iss=${encodeURIComponent("https://oauth.test")}` });
      }
      if (url.origin === "https://oauth.test" && url.pathname === "/token" && body.includes("grant_type=authorization_code")) {
        return response(200, JSON.stringify({ access_token: "issued-access-token-000000000000000001", refresh_token: "issued-refresh-token-00000000000000001", resource: "https://wrong-resource.test/mcp", scope: "voice_lab:read voice_lab:run" }), url.toString(), { "content-type": "application/json" });
      }
      if (url.origin === "https://oauth.test" && url.pathname === "/revoke") {
        revokeCalls += 1;
        const hint = new URLSearchParams(body).get("token_type_hint");
        return response(200, "", url.toString(), hint === "authorization_code" ? { "x-sophia-oauth-revocation-receipt": "authorization_code" } : {});
      }
      if (url.origin === "https://oauth.test" && url.pathname === "/token" && body.includes("grant_type=refresh_token")) return response(400, '{"error":"invalid_grant"}', url.toString(), { "content-type": "application/json" });
      throw new Error(`unexpected OAuth probe request ${method} ${url}`);
    };
    const recoveryReceipt = { complete: true, live_cleanup_complete: true, live_resources_zero: true, components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" }, auth_sessions: { status: "completed" }, builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } } };
    const driver = {
      verifyTarget: async () => ({ observedDeployment: run.target.expectedDeployment, events: [] }),
      hasSession: () => false,
      recover: async () => ({ events: [{ kind: "cleanup.recovery", source: "canonical", payload: { complete: true, receipt: recoveryReceipt }, dedupeKey: `cleanup:${run.id}:oauth-recovery` }], artifacts: [] }),
      readiness: async () => ({ ok: true, detail: "test" }),
      close: async () => undefined,
    } as any;
    const worker = new VoiceLabWorker("oauth-cleanup-worker", oauthLedger, config, audio, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), undefined, scenarioFetch);
    expect(await worker.runOnce()).toBe(true);
    expect(revokeCalls).toBe(3);
    const cleanup = await oauthLedger.findLatestEvent(run.id, ["security.oauth_family_cleanup"]);
    expect(cleanup?.payload).toMatchObject({ complete: true, authorization_code_cleanup_handle_used: true, authorization_code_family_terminalized: true, access_token_issued: true, refresh_token_issued: true, durable_terminal_state_verified: true, raw_tokens_excluded: true });
    expect((await oauthLedger.getRun(run.id))?.state).toBe("authorization_failed");
  });

  it("uses the pre-response authorization-code cleanup handle when a committed token response is lost", async () => {
    const config = testConfig({
      SOPHIA_VOICE_LAB_OAUTH_ISSUER: "https://oauth.test",
      SOPHIA_VOICE_LAB_OAUTH_RESOURCE: "https://voice-lab.test/mcp",
      SOPHIA_VOICE_LAB_OAUTH_RESOURCE_METADATA_URL: "https://voice-lab.test/.well-known/oauth-protected-resource/mcp",
      SOPHIA_VOICE_LAB_OAUTH_CLIENT_METADATA_URL: "https://chatgpt.com/oauth/client.json",
      SOPHIA_VOICE_LAB_OAUTH_CLIENT_REDIRECT_URI: "https://chatgpt.com/connector_platform_oauth_redirect",
      SOPHIA_VOICE_LAB_OAUTH_OPERATOR_SUBJECT: "voice-lab-private-operator",
      SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET: "oauth-consent-secret-00000000000000001",
      SOPHIA_VOICE_LAB_OAUTH_TOKEN_PEPPER: "oauth-token-pepper-0000000000000000001",
    });
    const oauthLedger = new MemoryVoiceLabLedger("test");
    const run = testRun({ scenarioId: "V-S01", state: "reserved" });
    await oauthLedger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const response = (status: number, body: BodyInit | null, url: string, headers: HeadersInit = {}) => {
      const value = new Response(body, { status, headers });
      Object.defineProperty(value, "url", { value: url });
      return value;
    };
    let committedBeforeResponseLoss = false;
    let codeCleanupHandleUsed = false;
    const scenarioFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      const body = String(init?.body ?? "");
      if (url.origin === "http://frontend.test" && url.pathname === config.authGrantPath) return response(401, "{}", url.toString(), { "content-type": "application/json" });
      if (url.origin === "https://voice-lab.test" && url.pathname === "/mcp") return response(401, "{}", url.toString(), { "www-authenticate": "Bearer resource_metadata=\"https://voice-lab.test/.well-known/oauth-protected-resource/mcp\", error_description=\"invalid\"" });
      if (url.origin === "https://oauth.test" && url.pathname === "/authorize" && method === "GET" && url.searchParams.get("resource") !== config.oauth!.resource) return response(303, null, url.toString(), { location: `${config.oauth!.clientRedirectUri}?error=invalid_target&iss=${encodeURIComponent("https://oauth.test")}` });
      if (url.origin === "https://oauth.test" && url.pathname === "/authorize" && method === "GET") return response(200, '<input name="request_id" value="request-12345678"><input name="csrf_token" value="csrf-12345678">', url.toString(), { "set-cookie": "__Host-probe=csrf; Secure; HttpOnly" });
      if (url.origin === "https://oauth.test" && url.pathname === "/authorize" && method === "POST") return response(303, null, url.toString(), { location: `${config.oauth!.clientRedirectUri}?code=lost-response-code-12345678&iss=${encodeURIComponent("https://oauth.test")}` });
      if (url.origin === "https://oauth.test" && url.pathname === "/token" && body.includes("grant_type=authorization_code")) {
        committedBeforeResponseLoss = true;
        throw new Error("simulated response loss after durable token-family commit");
      }
      if (url.origin === "https://oauth.test" && url.pathname === "/revoke") {
        const params = new URLSearchParams(body);
        codeCleanupHandleUsed = params.get("token") === "lost-response-code-12345678" && params.get("token_type_hint") === "authorization_code";
        return response(200, "", url.toString(), { "x-sophia-oauth-revocation-receipt": "authorization_code" });
      }
      throw new Error(`unexpected lost-response OAuth probe request ${method} ${url}`);
    };
    const recoveryReceipt = { complete: true, live_cleanup_complete: true, live_resources_zero: true, components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" }, auth_sessions: { status: "completed" }, builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } } };
    const driver = {
      verifyTarget: async () => ({ observedDeployment: run.target.expectedDeployment, events: [] }), hasSession: () => false,
      recover: async () => ({ events: [{ kind: "cleanup.recovery", source: "canonical", payload: { complete: true, receipt: recoveryReceipt }, dedupeKey: `cleanup:${run.id}:oauth-response-loss-recovery` }], artifacts: [] }),
      readiness: async () => ({ ok: true, detail: "test" }), close: async () => undefined,
    } as any;
    const worker = new VoiceLabWorker("oauth-response-loss-worker", oauthLedger, config, audio, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), undefined, scenarioFetch);
    expect(await worker.runOnce()).toBe(true);
    expect(committedBeforeResponseLoss).toBe(true);
    expect(codeCleanupHandleUsed).toBe(true);
    expect((await oauthLedger.findLatestEvent(run.id, ["security.oauth_family_cleanup"]))?.payload).toMatchObject({ complete: true, authorization_code_cleanup_handle_used: true, authorization_code_family_terminalized: true, access_token_issued: false, refresh_token_issued: false });
    expect((await oauthLedger.getRun(run.id))?.state).toBe("failed_harness");
  });

  it("requires and durably binds an exact app-authored N02 commit target before rotation", async () => {
    const run = testRun({ scenarioId: "V-N02", state: "active", providerEpoch: 1 });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const binding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    const committed = await ledger.appendEvent(run.id, "audio.output.started", "product", { _product_run_binding: binding, _capture_provenance: { generation: 1, seq: 7 }, receipt: { phase: "started", realizationId: "realization-1", providerConnectionEpoch: 1, playbackGeneration: 4, chunkHash: "d".repeat(64), timestamp: new Date().toISOString() } });
    await expect(service.forceSocketRotation(caller, { run_id: run.id, expected_socket_epoch: 1, idempotency_key: "n02-missing" })).rejects.toMatchObject({ detail: { code: "COMMIT_TARGET_REQUIRED" } });
    await expect(service.forceSocketRotation(caller, { run_id: run.id, expected_socket_epoch: 1, commit_target: { event_seq: committed.seq, kind: "output_realization", stable_id: "wrong" }, idempotency_key: "n02-wrong" })).rejects.toMatchObject({ detail: { code: "COMMIT_TARGET_PRECONDITION_FAILED" } });
    const accepted = await service.forceSocketRotation(caller, { run_id: run.id, expected_socket_epoch: 1, commit_target: { event_seq: committed.seq, kind: "output_realization", stable_id: "realization-1" }, idempotency_key: "n02-exact" });
    const operation = (await ledger.listOperations(run.id)).find((candidate) => candidate.id === accepted.operation_id)!;
    expect(operation.input._commit_target).toMatchObject({ event_seq: committed.seq, product_generation: 1, product_seq: 7, kind: "output_realization", stable_id: "realization-1", provider_connection_epoch: 1, playback_generation: 4, chunk_hash: "d".repeat(64), activity_state: "in_flight" });
    await ledger.appendEvent(run.id, "audio.output.completed", "product", { _product_run_binding: binding, _capture_provenance: { generation: 1, seq: 8 }, receipt: { phase: "completed", realizationId: "realization-1", providerConnectionEpoch: 1, playbackGeneration: 4, chunkHash: "d".repeat(64), timestamp: new Date().toISOString() } });
    const reused = await ledger.appendEvent(run.id, "audio.output.started", "product", { _product_run_binding: binding, _capture_provenance: { generation: 1, seq: 9 }, receipt: { phase: "started", realizationId: "realization-1", providerConnectionEpoch: 1, playbackGeneration: 5, chunkHash: "d".repeat(64), timestamp: new Date().toISOString() } });
    await expect(service.forceSocketRotation(caller, { run_id: run.id, expected_socket_epoch: 1, commit_target: { event_seq: reused.seq, kind: "output_realization", stable_id: "realization-1" }, idempotency_key: "n02-reused-history" })).rejects.toMatchObject({ detail: { code: "COMMIT_TARGET_PRECONDITION_FAILED" } });
  });

  it("requires an N02 in-flight tool target to have one exact succeeded synthetic input owner", async () => {
    const run = testRun({ scenarioId: "V-N02", state: "active", providerEpoch: 1 });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const finishNext = async (result: Record<string, unknown>) => {
      const claimed = (await ledger.claimNextOperation("n02-owner-worker", 30))!;
      await ledger.markOperationExecuting(claimed.operation.id, "n02-owner-worker", claimed.operation.leaseEpoch);
      return ledger.finishOperation(claimed.operation.id, "n02-owner-worker", claimed.operation.leaseEpoch, "succeeded", result, null);
    };
    await finishNext({ run_state: "active" });
    await ledger.upsertBrowserLease(run.id, "n02-owner-worker", 30);
    const ownerCreated = await ledger.createOperation({ id: randomUUID(), runId: run.id, callerId: caller.subject, type: "speak", idempotencyKey: "n02-owner-speak", requestHash: sha256("n02-owner-speak"), input: { fixture_id: "a02_short_command" } });
    const owner = await finishNext({ utterance_id: "utterance-n02-owner" });
    expect(owner.id).toBe(ownerCreated.operation.id);
    const binding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    const appendTool = (seq: number, toolCallId: string, effectId: string, operationId: string | null) => ledger.appendEvent(run.id, "product.voice-session.gemini-tool-call-ledger", "product", {
      _product_run_binding: binding, _capture_provenance: { generation: 2, seq }, entry: {
        toolCallId, effectId, providerConnectionEpoch: 1, toolName: "start_builder_task", receivedAt: "2026-08-23T12:00:00.000Z", toolResponseSentAt: null, cancelledAt: null, finalState: "unknown",
        syntheticToolEvidence: operationId === null ? null : { schema: "sophia_synthetic_tool_evidence_v1", test_run_id: run.testRunId, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, operation_id: operationId, utterance_id: "utterance-n02-owner", provider_input_sequence: 8, tool_call_id: toolCallId, effect_id: effectId, provider_connection_epoch: 1, relay_correlation_id: "relay-n02-owner", tool_name: "start_builder_task", received_at: "2026-08-23T12:00:00.000Z" },
      },
    });
    const missing = await appendTool(10, "tool-n02-missing", "effect-n02-missing", null);
    await expect(service.forceSocketRotation(caller, { run_id: run.id, expected_socket_epoch: 1, commit_target: { event_seq: missing.seq, kind: "tool_settlement", stable_id: "tool-n02-missing", effect_id: "effect-n02-missing" }, idempotency_key: "n02-missing-owner" })).rejects.toMatchObject({ detail: { code: "COMMIT_TARGET_PRECONDITION_FAILED" } });
    const foreign = await appendTool(11, "tool-n02-foreign", "effect-n02-foreign", randomUUID());
    await expect(service.forceSocketRotation(caller, { run_id: run.id, expected_socket_epoch: 1, commit_target: { event_seq: foreign.seq, kind: "tool_settlement", stable_id: "tool-n02-foreign", effect_id: "effect-n02-foreign" }, idempotency_key: "n02-foreign-owner" })).rejects.toMatchObject({ detail: { code: "COMMIT_TARGET_PRECONDITION_FAILED" } });
    const exact = await appendTool(12, "tool-n02-exact", "effect-n02-exact", owner.id);
    const accepted = await service.forceSocketRotation(caller, { run_id: run.id, expected_socket_epoch: 1, commit_target: { event_seq: exact.seq, kind: "tool_settlement", stable_id: "tool-n02-exact", effect_id: "effect-n02-exact" }, idempotency_key: "n02-exact-owner" });
    const rotation = await ledger.getOperation(accepted.operation_id!);
    expect(rotation?.input._commit_target).toMatchObject({ product_generation: 2, product_seq: 12, owner_operation_id: owner.id, owner_utterance_id: "utterance-n02-owner", provider_input_sequence: 8 });
  });

  it("fails N02 if a committed realization is replayed under a later epoch or generation", () => {
    const run = testRun({ scenarioId: "V-N02", state: "completed", providerEpoch: 2 });
    const binding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    const event = (seq: number, kind: string, receipt: Record<string, unknown>) => ({ runId: run.id, seq, kind, source: "product" as const, payload: { _product_run_binding: binding, _capture_provenance: { generation: 1, seq }, receipt }, at: new Date(), dedupeKey: null });
    const prior = event(1, "provider.connection_epoch", { timestamp: "2026-08-23T12:00:00.000Z", phase: "bootstrap", previousProviderConnectionEpoch: null, providerConnectionEpoch: 1, continuityState: "active", reason: "initial" });
    const committed = event(2, "audio.output.started", { phase: "started", realizationId: "realization-n02", chunkHash: "e".repeat(64), providerConnectionEpoch: 1, playbackGeneration: 2 });
    const revalidated = { runId: run.id, seq: 3, kind: "fault.active_target_revalidated", source: "canonical" as const, payload: { operation_id: "placeholder", target_event_seq: 2, target_kind: "output_realization", target_identity_sha256: sha256(`realization-n02\u0000${"e".repeat(64)}`), observed_through_seq: 2, active: true }, at: new Date(), dedupeKey: null };
    const fencedAt = "2026-08-23T12:00:00.500Z";
    const fenced = { runId: run.id, seq: 4, kind: "harness.product_active_target_fenced", source: "browser" as const, payload: { schema: "sophia_voice_lab_active_target_fence_v1", operation_id: "placeholder", lab_event_seq: 2, kind: "output_realization", product_generation: 1, product_seq: 2, observed_through_product_seq: 2, stable_id: "realization-n02", effect_or_chunk_id: "e".repeat(64), provider_connection_epoch: 1, active: true, fenced_at: fencedAt }, at: new Date(fencedAt), dedupeKey: null };
    const restoredReceipt = { timestamp: "2026-08-23T12:00:01.000Z", phase: "restored", previousProviderConnectionEpoch: 1, providerConnectionEpoch: 2, continuityState: "active", reason: "provider_continuation_setup_complete" };
    const restored = event(5, "provider.connection_epoch", restoredReceipt);
    const terminal = event(6, "audio.output.completed", { phase: "completed", realizationId: "realization-n02", chunkHash: "e".repeat(64), providerConnectionEpoch: 1, playbackGeneration: 2 });
    const operation = { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "force_socket_rotation", idempotencyKey: "n02-evaluate", requestHash: sha256("n02-evaluate"), input: { expected_socket_epoch: 1, _commit_target: { event_seq: 2, product_generation: 1, product_seq: 2, kind: "output_realization", stable_id: "realization-n02", chunk_hash: "e".repeat(64), provider_connection_epoch: 1, playback_generation: 2, activity_state: "in_flight" } }, state: "succeeded", attemptCount: 1, leaseOwner: null, leaseExpiresAt: null, createdAt: new Date(), updatedAt: new Date(), result: { rotation_receipt: { product: { ...restoredReceipt, _seq: 5 } } }, error: null } as any;
    revalidated.payload.operation_id = operation.id;
    fenced.payload.operation_id = operation.id;
    expect(evaluateScenarioAssertions(run, [prior, committed, revalidated, fenced, restored, terminal] as any, [operation]).harness.every((assertion) => assertion.status === "pass")).toBe(true);
    const stale = event(7, "audio.output.started", { phase: "started", realizationId: "realization-n02", chunkHash: "e".repeat(64), providerConnectionEpoch: 2, playbackGeneration: 3 });
    expect(evaluateScenarioAssertions(run, [prior, committed, revalidated, fenced, restored, terminal, stale] as any, [operation]).harness.some((assertion) => assertion.id === "v-n02.committed_boundary_exactly_once_effect" && assertion.status === "fail")).toBe(true);
    expect(evaluateScenarioAssertions(run, [prior, committed, revalidated, restored, terminal] as any, [operation]).harness).toContainEqual(expect.objectContaining({ id: "v-n02.committed_boundary_exactly_once_effect", status: "fail" }));
    const historicalStarted = event(2, "audio.output.started", { phase: "started", realizationId: "realization-n02", chunkHash: "e".repeat(64), providerConnectionEpoch: 1, playbackGeneration: 1 });
    const historicalTerminal = event(3, "audio.output.completed", { phase: "completed", realizationId: "realization-n02", chunkHash: "e".repeat(64), providerConnectionEpoch: 1, playbackGeneration: 1 });
    const reusedTarget = event(4, "audio.output.started", { phase: "started", realizationId: "realization-n02", chunkHash: "e".repeat(64), providerConnectionEpoch: 1, playbackGeneration: 2 });
    const reusedRevalidated = { ...revalidated, seq: 5, payload: { ...revalidated.payload, target_event_seq: 4, observed_through_seq: 4 } };
    const reusedFence = { ...fenced, seq: 6, payload: { ...fenced.payload, lab_event_seq: 4, product_seq: 4, observed_through_product_seq: 4 } };
    const reusedRestored = event(7, "provider.connection_epoch", restoredReceipt);
    const reusedTerminal = event(8, "audio.output.completed", { phase: "completed", realizationId: "realization-n02", chunkHash: "e".repeat(64), providerConnectionEpoch: 1, playbackGeneration: 2 });
    const reusedOperation = { ...operation, input: { ...operation.input, _commit_target: { ...(operation.input._commit_target as Record<string, unknown>), event_seq: 4, product_seq: 4 } }, result: { rotation_receipt: { product: { ...restoredReceipt, _seq: 7 } } } };
    reusedRevalidated.payload.operation_id = reusedOperation.id;
    reusedFence.payload.operation_id = reusedOperation.id;
    expect(evaluateScenarioAssertions(run, [prior, historicalStarted, historicalTerminal, reusedTarget, reusedRevalidated, reusedFence, reusedRestored, reusedTerminal] as any, [reusedOperation]).harness).toContainEqual(expect.objectContaining({ id: "v-n02.committed_boundary_exactly_once_effect", status: "fail" }));
  });

  it("rejects an N01 stable realization replayed under a new epoch or playback generation", () => {
    const run = testRun({ scenarioId: "V-N01", providerEpoch: 2 });
    const binding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    const event = (seq: number, kind: string, phase: string, epoch: number, generation: number) => ({ runId: run.id, seq, kind, source: "product" as const, payload: { _product_run_binding: binding, receipt: { phase, realizationId: "stable-realization-n01", providerConnectionEpoch: epoch, playbackGeneration: generation } }, at: new Date(), dedupeKey: null });
    const exact = [event(10, "audio.output.scheduled", "scheduled", 2, 7), event(11, "audio.output.started", "started", 2, 7), event(12, "audio.output.completed", "completed", 2, 7)];
    expect(exactOutputLifecyclesAtEpoch(exact as any, 2, 9)).toBe(true);
    const replay = [event(13, "audio.output.scheduled", "scheduled", 3, 8), event(14, "audio.output.started", "started", 3, 8), event(15, "audio.output.completed", "completed", 3, 8)];
    expect(exactOutputLifecyclesAtEpoch([...exact, ...replay] as any, 2, 9)).toBe(false);
  });

  it("rejects N01 tool settlements that reuse one effect identity across distinct calls", () => {
    const run = testRun({ scenarioId: "V-N01", providerEpoch: 2 });
    const binding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    let seq = 0;
    const event = (kind: string, source: "product" | "browser", payload: Record<string, unknown>) => ({ runId: run.id, seq: ++seq, kind, source, payload: source === "product" ? { _product_run_binding: binding, ...payload } : payload, at: new Date(), dedupeKey: null });
    const restoredReceipt = { timestamp: "2026-08-23T12:00:01.000Z", phase: "restored", previousProviderConnectionEpoch: 1, providerConnectionEpoch: 2, continuityState: "active", reason: "provider_continuation_setup_complete" };
    const prior = event("provider.connection_epoch", "product", { receipt: { timestamp: "2026-08-23T12:00:00.000Z", phase: "bootstrap", previousProviderConnectionEpoch: null, providerConnectionEpoch: 1, continuityState: "active", reason: "initial" } });
    const restored = event("provider.connection_epoch", "product", { receipt: restoredReceipt });
    const operationId = randomUUID();
    const utteranceId = "utterance-n01-effect";
    const sourceSha = "a".repeat(64);
    const frameBytes = Buffer.from([1, 2, 3, 4]);
    const frameSha = sha256(frameBytes);
    const frameSeq = Buffer.alloc(4); frameSeq.writeUInt32BE(1);
    const pcmChain = sha256(Buffer.concat([Buffer.alloc(32), Buffer.from(frameSha, "hex"), frameSeq]));
    const input = [
      event("utterance.resolved", "browser", { operation_id: operationId, utterance_id: utteranceId, wav: { sha256: sourceSha } }),
      event("audio.input.scheduled", "browser", { operation_id: operationId }),
      event("audio.input.started", "browser", { operation_id: operationId }),
      event("harness.input_frame_forwarded", "browser", { operation_id: operationId, utterance_id: utteranceId, frame_seq: 1, byte_length: frameBytes.length, nonzero_byte_count: frameBytes.length, sha256: frameSha }),
      event("audio.input.completed", "browser", { operation_id: operationId }),
      event("audio.input.product_leg", "product", { receipt: { schema: "sophia_gemini_input_leg_v1", status: "verified", operation_id: operationId, utterance_id: utteranceId, source_sha256: sourceSha, expected_silence: false, raw_audio_excluded: true, frame_count: 1, sample_count: 2, byte_length: frameBytes.length, pcm_digest_algorithm: "sha-256-chain-v1", pcm_sha256_chain: pcmChain, nonzero_sample_count: 2, pcm_rms: 1, pcm_peak: 1, frame_window_id: "window-n01", provider_connection_epoch: 2 } }),
      event("audio.input.product_turn", "product", { receipt: { schema: "sophia_gemini_input_turn_v1", operation_id: operationId, utterance_id: utteranceId, frame_window_id: "window-n01", expected_silence: false, raw_audio_excluded: true, source: "provider_input_transcription", outcome: "provider_input_transcription_observed" } }),
      event("audio.input.product_turn", "product", { receipt: { schema: "sophia_gemini_input_turn_v1", operation_id: operationId, utterance_id: utteranceId, frame_window_id: "window-n01", expected_silence: false, raw_audio_excluded: true, source: "public_user_turn", outcome: "public_user_turn_accepted" } }),
    ];
    const output = [
      event("audio.output.scheduled", "product", { receipt: { phase: "scheduled", realizationId: "realization-n01-effect", providerConnectionEpoch: 2, playbackGeneration: 1 } }),
      event("audio.output.started", "product", { receipt: { phase: "started", realizationId: "realization-n01-effect", providerConnectionEpoch: 2, playbackGeneration: 1 } }),
      event("audio.output.completed", "product", { receipt: { phase: "completed", realizationId: "realization-n01-effect", providerConnectionEpoch: 2, playbackGeneration: 1 } }),
      event("product.voice-session.gemini-tool-call-ledger", "product", { entry: { toolCallId: "tool-n01-a", effectId: "effect-n01-reused", finalState: "responded", toolResponseSentAt: "2026-08-23T12:00:02.000Z" } }),
      event("product.voice-session.gemini-tool-call-ledger", "product", { entry: { toolCallId: "tool-n01-b", effectId: "effect-n01-reused", finalState: "responded", toolResponseSentAt: "2026-08-23T12:00:03.000Z" } }),
    ];
    const speak = { id: operationId, runId: run.id, callerId: run.callerId, type: "speak", idempotencyKey: "n01-effect-speak", requestHash: sha256("n01-effect-speak"), input: { fixture_id: "a02_short_command" }, state: "succeeded", result: { schedule_receipt: { kind: "audio.input.scheduled" } }, attemptCount: 1 } as any;
    const rotation = { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "force_socket_rotation", idempotencyKey: "n01-effect-rotation", requestHash: sha256("n01-effect-rotation"), input: { expected_socket_epoch: 1 }, state: "succeeded", result: { rotation_receipt: { product: { ...restoredReceipt, _seq: restored.seq } } }, attemptCount: 1 } as any;
    expect(evaluateScenarioAssertions(run, [prior, restored, ...input, ...output] as any, [rotation, speak]).harness).toContainEqual(expect.objectContaining({ id: "v-n01.no_duplicate_speech_or_tool_work", status: "fail" }));
    const distinctEffects = output.map((candidate, index) => index === output.length - 1 ? { ...candidate, payload: { ...candidate.payload, entry: { ...(candidate.payload.entry as Record<string, unknown>), effectId: "effect-n01-b" } } } : candidate);
    expect(evaluateScenarioAssertions(run, [prior, restored, ...input, ...distinctEffects] as any, [rotation, speak]).harness).toContainEqual(expect.objectContaining({ id: "v-n01.no_duplicate_speech_or_tool_work", status: "pass" }));
    const resurrected = event("product.voice-session.gemini-tool-call-ledger", "product", { entry: { toolCallId: "tool-n01-a", effectId: "effect-n01-reused", finalState: "unknown", toolResponseSentAt: null, cancelledAt: null } });
    expect(evaluateScenarioAssertions(run, [prior, restored, ...input, ...distinctEffects, resurrected] as any, [rotation, speak]).harness).toContainEqual(expect.objectContaining({ id: "v-n01.no_duplicate_speech_or_tool_work", status: "fail" }));
  });

  it("rejects near-miss duplicate model, output-leg, stacked-response, and tool-effect evidence", () => {
    const bound = (run: ReturnType<typeof testRun>) => ({ app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() });
    const productEvent = (run: ReturnType<typeof testRun>, seq: number, kind: string, payload: Record<string, unknown>) => ({ runId: run.id, seq, kind, source: "product" as const, payload: { _product_run_binding: bound(run), ...payload }, at: new Date(), dedupeKey: null });

    const a03 = testRun({ scenarioId: "V-A03" });
    const speak = { id: randomUUID(), runId: a03.id, callerId: a03.callerId, type: "speak", idempotencyKey: "a03", requestHash: sha256("a03"), input: {}, state: "succeeded", result: {}, attemptCount: 1 } as any;
    const a03Events = [
      productEvent(a03, 1, "product.voice-sse.sophia.user_transcript", { operation_id: speak.id }),
      productEvent(a03, 2, "product.voice-sse.sophia.turn", { phase: "agent_ended" }),
      productEvent(a03, 3, "product.voice-sse.sophia.turn", { phase: "agent_ended" }),
    ];
    expect(evaluateScenarioAssertions(a03, a03Events as any, [speak]).product).toContainEqual(expect.objectContaining({ id: "a03.exactly_one_product_turn_effect", status: "unavailable", reason: "product_authored_input_operation_to_assistant_turn_response_and_backend_effect_lineage_unavailable" }));

    const o01 = testRun({ scenarioId: "V-O01" });
    const receivedAt = new Date().toISOString();
    const receipt = { realizationId: "realization-o01", responseId: "response-o01", providerEventId: "provider-event-o01", chunkHash: "f".repeat(64), byteLength: 320, chunkIndex: 0, chunksInEvent: 1, providerConnectionEpoch: 1, playbackGeneration: 2, providerReceiveSequence: 7, providerRelaySequence: 6, providerReceivedAt: receivedAt, relayCorrelationId: "relay-o01", durationSeconds: 0.2 };
    const leg = { schema: "sophia_gemini_output_leg_v1", status: "verified", completionPhase: "completed", realizationId: "realization-o01", providerChunkFingerprint: "f".repeat(64), providerConnectionEpoch: 1, playbackGeneration: 2, monitorDigestSha256: "1".repeat(64), monitorFrameCount: 2, monitorNonSilentFrameCount: 1, rawAudioExcluded: true, scheduledAt: new Date().toISOString(), completedAt: new Date().toISOString(), monitorDurationMs: 200 };
    const receivedDiagnostic = { timestamp: receivedAt, providerReceiveSequence: 7, providerRelaySequence: 6, providerConnectionEpoch: 1, providerReceivedAt: receivedAt, relayCorrelationId: "relay-o01", responseId: "response-o01", providerEventId: "provider-event-o01", chunksInEvent: 1, playbackGeneration: 2 };
    const chunkDiagnostic = { ...receivedDiagnostic, responseId: undefined, providerEventId: undefined, chunkIndex: 0, chunkHash: "f".repeat(64), byteLength: 320, scheduled: true, dropReason: null };
    const o01Events = [
      productEvent(o01, 1, "audio.output.received", { diagnostic: receivedDiagnostic }),
      productEvent(o01, 2, "audio.output.provider_chunk", { diagnostic: chunkDiagnostic }),
      productEvent(o01, 3, "audio.output.scheduled", { receipt: { ...receipt, phase: "scheduled" } }),
      productEvent(o01, 4, "audio.output.started", { receipt: { ...receipt, phase: "started" } }),
      productEvent(o01, 5, "audio.output.completed", { receipt: { ...receipt, phase: "completed" } }),
      productEvent(o01, 6, "audio.output.leg_receipt", { receipt: leg }),
      productEvent(o01, 7, "audio.output.leg_receipt", { receipt: leg }),
    ];
    expect(evaluateScenarioAssertions(o01, o01Events as any, []).harness).toContainEqual(expect.objectContaining({ id: "o01.provider_chunk_to_playback_to_output_leg_join", status: "fail" }));
    const oneLeg = o01Events.slice(0, 6);
    expect(evaluateScenarioAssertions(o01, oneLeg as any, []).harness).toContainEqual(expect.objectContaining({ id: "o01.provider_chunk_to_playback_to_output_leg_join", status: "pass" }));
    const missingDiagnosticHash = oneLeg.filter((event) => event.kind !== "audio.output.provider_chunk");
    expect(evaluateScenarioAssertions(o01, missingDiagnosticHash as any, []).harness).toContainEqual(expect.objectContaining({ id: "o01.provider_chunk_to_playback_to_output_leg_join", status: "fail" }));
    const wrongDiagnosticHash = oneLeg.map((event) => event.kind === "audio.output.provider_chunk" ? productEvent(o01, 2, "audio.output.provider_chunk", { diagnostic: { ...chunkDiagnostic, chunkHash: "0".repeat(64) } }) : event);
    expect(evaluateScenarioAssertions(o01, wrongDiagnosticHash as any, []).harness).toContainEqual(expect.objectContaining({ id: "o01.provider_chunk_to_playback_to_output_leg_join", status: "fail" }));
    const orphanReceived = productEvent(o01, 8, "audio.output.received", { diagnostic: { ...receivedDiagnostic, providerReceiveSequence: 8, relayCorrelationId: "relay-orphan", responseId: "response-orphan" } });
    expect(evaluateScenarioAssertions(o01, [...oneLeg, orphanReceived] as any, []).harness).toContainEqual(expect.objectContaining({ id: "o01.provider_chunk_to_playback_to_output_leg_join", status: "fail" }));

    const a01 = testRun({ scenarioId: "V-A01" });
    const a01Events = Array.from({ length: 6 }, (_, index) => productEvent(a01, index + 10, "product.voice-sse.sophia.turn", { phase: "agent_ended" }));
    a01Events.unshift(productEvent(a01, 1, "audio.output.started", { receipt: { phase: "started", realizationId: "r1" } }), productEvent(a01, 2, "audio.output.started", { receipt: { phase: "started", realizationId: "r2" } }), productEvent(a01, 3, "audio.output.completed", { receipt: { phase: "completed", realizationId: "r1" } }), productEvent(a01, 4, "audio.output.completed", { receipt: { phase: "completed", realizationId: "r2" } }));
    expect(evaluateScenarioAssertions(a01, a01Events as any, []).product).toContainEqual(expect.objectContaining({ id: "a01.six_nonstacked_responses", status: "unavailable" }));
    const oneInterval = [productEvent(a01, 1, "audio.output.started", { receipt: { phase: "started", realizationId: "only-one" } }), productEvent(a01, 2, "audio.output.completed", { receipt: { phase: "completed", realizationId: "only-one" } }), ...Array.from({ length: 6 }, (_, index) => productEvent(a01, index + 3, "product.voice-sse.sophia.turn", { phase: "agent_ended" }))];
    expect(evaluateScenarioAssertions(a01, oneInterval as any, []).product).toContainEqual(expect.objectContaining({ id: "a01.six_nonstacked_responses", status: "unavailable" }));

    const adaptiveEvents: any[] = [];
    const adaptiveOperations: any[] = [];
    let adaptiveSeq = 0;
    const observedAt = new Date(Date.now() - 10_000);
    for (let index = 0; index < 6; index += 1) {
      const operationId = randomUUID();
      adaptiveEvents.push({ runId: a01.id, seq: ++adaptiveSeq, kind: "audio.input.started", source: "browser", payload: { operation_id: operationId }, at: observedAt, dedupeKey: null });
      adaptiveEvents.push({ runId: a01.id, seq: ++adaptiveSeq, kind: "audio.input.completed", source: "browser", payload: { operation_id: operationId }, at: observedAt, dedupeKey: null });
      const turnEvent = productEvent(a01, ++adaptiveSeq, "product.voice-sse.sophia.turn", { data: { phase: "agent_ended", turnId: `turn-${index + 1}` } });
      turnEvent.at = observedAt;
      adaptiveEvents.push(turnEvent);
      const priorTurnSeq = adaptiveSeq - 3;
      adaptiveOperations.push({ id: operationId, runId: a01.id, callerId: a01.callerId, type: "speak", state: "succeeded", createdAt: new Date(), updatedAt: new Date(), input: index === 0 ? {} : { expected_cursor: priorTurnSeq, expected_turn_id: `turn-${index}`, adaptive_observation: { event_seq: priorTurnSeq, turn_id: `turn-${index}`, observation_class: "assistant_turn_complete", followup_intent: "clarify" } }, result: {}, error: null, attemptCount: 1 });
    }
    const adaptivePass = evaluateScenarioAssertions(a01, adaptiveEvents as any, adaptiveOperations).harness.find((assertion) => assertion.id === "a01.five_adaptive_turn_boundaries");
    expect(adaptivePass?.status).toBe("pass");
    const repeatedTurnEvents = adaptiveEvents.map((event: any) => event.seq === 6 ? { ...event, payload: { ...event.payload, data: { ...event.payload.data, turnId: "turn-1" } } } : event);
    const repeatedTurnOperations = adaptiveOperations.map((operation: any, index: number) => index === 2 ? { ...operation, input: { ...operation.input, expected_turn_id: "turn-1", adaptive_observation: { ...operation.input.adaptive_observation, turn_id: "turn-1" } } } : operation);
    expect(evaluateScenarioAssertions(a01, repeatedTurnEvents as any, repeatedTurnOperations).harness).toContainEqual(expect.objectContaining({ id: "a01.five_adaptive_turn_boundaries", status: "fail" }));
    const predetermined = adaptiveOperations.map((operation: any) => ({ ...operation, input: {} }));
    expect(evaluateScenarioAssertions(a01, adaptiveEvents as any, predetermined).harness).toContainEqual(expect.objectContaining({ id: "a01.five_adaptive_turn_boundaries", status: "fail" }));

    const i02 = testRun({ scenarioId: "V-I02" });
    const i02Events = [
      productEvent(i02, 1, "product.gemini-tool-call-ledger", { entry: { toolCallId: "tool-i02", receivedAt: new Date().toISOString(), finalState: "received" } }),
      productEvent(i02, 2, "product.gemini-tool-call-ledger", { entry: { toolCallId: "tool-i02", receivedAt: new Date().toISOString(), finalState: "responded", toolResponseSentAt: new Date().toISOString() } }),
      productEvent(i02, 3, "product.voice-sse.sophia.turn", { data: { phase: "agent_ended", content: "Done successfully" } }),
    ];
    expect(evaluateScenarioAssertions(i02, i02Events as any, []).harness).toContainEqual(expect.objectContaining({ id: "v-i02.tool_boundary_total_order_and_at_most_once_settlement", status: "fail" }));
    expect(evaluateScenarioAssertions(i02, i02Events as any, []).product).toContainEqual(expect.objectContaining({ id: "v-i02.retained_input_and_at_most_once_effect", status: "unavailable", reason: "owning_post_barge_promise_to_tool_outcome_receipt_unavailable" }));
  });

  it("requires exact operation-to-input-to-tool-to-Builder-to-post-commit UI joins for B01-B04", () => {
    const timestamp = "2026-08-23T12:00:00.000Z";
    const assertions = (accepted: number, tools: number, overrides: Record<string, unknown> = {}) => ({
      artifact_created: true, artifact_visible_current: true, accepted_turn_count: accepted, tool_dispatch_count: tools, owned_task_count: 1, stable_task_identity: true,
      revision_updated_same_task: false, current_behavior_result: false, cancel_request_count: 0, cancel_terminal_settled: false, no_post_cancel_publication: true, ...overrides,
    });
    for (const scenarioId of ["V-B01", "V-B02", "V-B03", "V-B04"] as const) {
      const run = testRun({ scenarioId });
      const binding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
      const operations = Array.from({ length: scenarioId === "V-B01" ? 1 : scenarioId === "V-B02" ? 3 : 2 }, (_, index) => ({ id: randomUUID(), runId: run.id, callerId: run.callerId, type: "speak", idempotencyKey: `${scenarioId}-${index}`, requestHash: sha256(`${scenarioId}-${index}`), input: {}, state: "succeeded", result: {}, attemptCount: 1 } as any));
      let seq = 0;
      const product = (kind: string, payload: Record<string, unknown>) => ({ runId: run.id, seq: ++seq, kind, source: "product" as const, payload: { _product_run_binding: binding, ...payload }, at: new Date(timestamp), dedupeKey: null });
      const events: any[] = [];
      for (let index = 0; index < operations.length; index += 1) {
        events.push({ runId: run.id, seq: ++seq, kind: "utterance.resolved", source: "browser", payload: { operation_id: operations[index]!.id, utterance_id: `utterance-${index + 1}` }, at: new Date(timestamp), dedupeKey: null });
        events.push(product("audio.input.product_turn", { receipt: { schema: "sophia_gemini_input_turn_v1", synthetic: true, test_run_id: run.testRunId, operation_id: operations[index]!.id, utterance_id: `utterance-${index + 1}`, source: "public_user_turn", outcome: "public_user_turn_accepted", provider_receive_sequence: index + 1, raw_audio_excluded: true } }));
      }
      const taskId = `task-${scenarioId}`;
      const makeBackendJoin = (index: number, toolName: string, cancelCount = 0) => ({
        schema: "sophia_synthetic_builder_join_v1", test_run_id: run.testRunId, scenario_id: scenarioId, scenario_version: run.scenarioVersion,
        operation_id: operations[index]!.id, utterance_id: `utterance-${index + 1}`, provider_input_sequence: index + 1, tool_call_id: `tool-${index + 1}`, effect_id: `effect-${index + 1}`,
        provider_connection_epoch: 1, relay_correlation_id: `relay-${index + 1}`, tool_name: toolName, tool_state: scenarioId === "V-B04" && toolName === "cancel_async_task" ? "terminal_settled" : "responded", builder_operation_id: `builder-operation-${scenarioId}`,
        parent_thread_id: `parent-${scenarioId}`, task_id: taskId, thread_id: taskId, run_id: `builder-run-${scenarioId}`, build_id: `builder-operation-${scenarioId}`,
        artifact_id: null, artifact_path_sha256: null, ui_projection_state: null, cancel_count: cancelCount, no_post_cancel_publication: true,
        source_tool_received_at: timestamp, source_backend_accepted_at: timestamp, source_tool_response_sent_at: timestamp, source_builder_event_id: null, source_builder_event_at: null, source_ui_projected_at: null, scenario_assertions: {},
      });
      const tools: Array<{ index: number; name: string; cancel?: number }> = scenarioId === "V-B01" ? [{ index: 0, name: "start_builder_task" }]
        : scenarioId === "V-B02" ? [{ index: 2, name: "start_builder_task" }]
          : scenarioId === "V-B03" ? [{ index: 0, name: "start_builder_task" }, { index: 1, name: "update_async_task" }]
            : [{ index: 0, name: "start_builder_task" }, { index: 1, name: "cancel_async_task", cancel: 1 }];
      let terminalJoin: Record<string, unknown> | null = null;
      for (const tool of tools) {
        const backendJoin = makeBackendJoin(tool.index, tool.name, tool.cancel ?? 0);
        terminalJoin = backendJoin;
        events.push(product("product.voice-session.gemini-tool-call-ledger", { entry: {
          toolCallId: backendJoin.tool_call_id, effectId: backendJoin.effect_id, providerConnectionEpoch: 1, toolName: tool.name, receivedAt: timestamp, toolResponseSentAt: timestamp, finalState: "responded",
          syntheticToolEvidence: { schema: "sophia_synthetic_tool_evidence_v1", test_run_id: run.testRunId, scenario_id: scenarioId, scenario_version: run.scenarioVersion, operation_id: backendJoin.operation_id, utterance_id: backendJoin.utterance_id, provider_input_sequence: backendJoin.provider_input_sequence, tool_call_id: backendJoin.tool_call_id, effect_id: backendJoin.effect_id, provider_connection_epoch: 1, relay_correlation_id: backendJoin.relay_correlation_id, tool_name: tool.name, received_at: timestamp },
          syntheticBuilderJoin: backendJoin,
        } }));
      }
      const uiAssertions = scenarioId === "V-B01" ? assertions(1, 1)
        : scenarioId === "V-B02" ? assertions(3, 1)
          : scenarioId === "V-B03" ? assertions(2, 2, { revision_updated_same_task: true, current_behavior_result: true })
            : assertions(2, 2, { artifact_created: false, artifact_visible_current: false, cancel_request_count: 1, cancel_terminal_settled: true });
      const uiJoin = { ...terminalJoin!, artifact_id: scenarioId === "V-B04" ? null : `artifact-${scenarioId}`, artifact_path_sha256: scenarioId === "V-B04" ? null : "a".repeat(64), ui_projection_state: scenarioId === "V-B04" ? "canvas_current" : "artifact_visible_current", source_builder_event_id: scenarioId === "V-B04" ? `langgraph-run-terminal:builder-run-${scenarioId}:cancelled` : `event-${scenarioId}`, source_builder_event_at: timestamp, source_ui_projected_at: timestamp, scenario_assertions: uiAssertions, raw_transcript_excluded: true, raw_artifact_content_excluded: true, secrets_excluded: true };
      const uiEvent = product("product.builder-ui.synthetic-builder-join", uiJoin);
      events.push(uiEvent);
      const evaluated = evaluateScenarioAssertions(run, events, operations);
      expect(evaluated.harness).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.exact_builder_ownership_chain`, status: "pass" }));
      expect(evaluated.product).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.owning_builder_semantics`, status: scenarioId === "V-B02" ? "unavailable" : "pass" }));
      const wrongTask = { ...uiEvent, payload: { ...uiEvent.payload, task_id: "foreign-task" } };
      expect(evaluateScenarioAssertions(run, [...events.slice(0, -1), wrongTask], operations).harness).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.exact_builder_ownership_chain`, status: "fail" }));
      const duplicateTerminal = { ...events.find((event) => event.kind.includes("gemini-tool-call-ledger"))!, seq: ++seq };
      expect(evaluateScenarioAssertions(run, [...events, duplicateTerminal], operations).harness).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.exact_builder_ownership_chain`, status: "fail" }));
      const sourceLedger = events.find((event) => event.kind.includes("gemini-tool-call-ledger"))!;
      const sourceEntry = sourceLedger.payload.entry as Record<string, any>;
      const resurrected = product("product.voice-session.gemini-tool-call-ledger", { entry: {
        ...sourceEntry, finalState: "unknown", toolResponseSentAt: null, cancelledAt: null, syntheticBuilderJoin: null,
      } });
      expect(evaluateScenarioAssertions(run, [...events, resurrected], operations).harness).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.exact_builder_ownership_chain`, status: "fail" }));
      const missingJoin = product("product.voice-session.gemini-tool-call-ledger", { entry: {
        ...sourceEntry, toolCallId: "tool-missing-join", effectId: "effect-missing-join", syntheticBuilderJoin: null,
        syntheticToolEvidence: { ...sourceEntry.syntheticToolEvidence, tool_call_id: "tool-missing-join", effect_id: "effect-missing-join" },
      } });
      expect(evaluateScenarioAssertions(run, [...events, missingJoin], operations).harness).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.exact_builder_ownership_chain`, status: "fail" }));
      const inFlightExtra = product("product.voice-session.gemini-tool-call-ledger", { entry: {
        ...sourceEntry, toolCallId: "tool-in-flight-extra", effectId: "effect-in-flight-extra", finalState: "unknown", toolResponseSentAt: null, syntheticBuilderJoin: null,
        syntheticToolEvidence: { ...sourceEntry.syntheticToolEvidence, tool_call_id: "tool-in-flight-extra", effect_id: "effect-in-flight-extra" },
      } });
      expect(evaluateScenarioAssertions(run, [...events, inFlightExtra], operations).harness).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.exact_builder_ownership_chain`, status: "fail" }));
      const missingBothTerminal = product("product.voice-session.gemini-tool-call-ledger", { entry: {
        toolCallId: "tool-missing-both-terminal", effectId: "effect-missing-both-terminal", providerConnectionEpoch: 1, toolName: "start_builder_task",
        receivedAt: timestamp, toolResponseSentAt: timestamp, cancelledAt: null, finalState: "responded",
      } });
      expect(evaluateScenarioAssertions(run, [...events, missingBothTerminal], operations).harness).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.exact_builder_ownership_chain`, status: "fail" }));
      const missingBothInFlight = product("product.voice-session.gemini-tool-call-ledger", { entry: {
        toolCallId: "tool-missing-both-in-flight", effectId: "effect-missing-both-in-flight", providerConnectionEpoch: 1, toolName: "start_builder_task",
        receivedAt: timestamp, toolResponseSentAt: null, cancelledAt: null, finalState: "unknown",
      } });
      expect(evaluateScenarioAssertions(run, [...events, missingBothInFlight], operations).harness).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.exact_builder_ownership_chain`, status: "fail" }));
      if (tools.length === 2) {
        const ledgerIndexes = events.map((event, index) => event.kind.includes("gemini-tool-call-ledger") ? index : -1).filter((index) => index >= 0);
        const firstEffect = events[ledgerIndexes[0]!]!.payload.entry.effectId;
        const secondIndex = ledgerIndexes[1]!;
        const secondEntry = events[secondIndex]!.payload.entry;
        const repeatedEffectEvents = events.map((event, index) => index === secondIndex ? { ...event, payload: { ...event.payload, entry: {
          ...secondEntry, effectId: firstEffect,
          syntheticToolEvidence: { ...secondEntry.syntheticToolEvidence, effect_id: firstEffect },
          syntheticBuilderJoin: { ...secondEntry.syntheticBuilderJoin, effect_id: firstEffect },
        } } } : event.kind === "product.builder-ui.synthetic-builder-join" ? { ...event, payload: { ...event.payload, effect_id: firstEffect } } : event);
        expect(evaluateScenarioAssertions(run, repeatedEffectEvents, operations).harness).toContainEqual(expect.objectContaining({ id: `${scenarioId.toLowerCase()}.exact_builder_ownership_chain`, status: "fail" }));
      }
    }
  });

  it("requires the exact app-authored V-L01 trace-fault lifecycle and governed unavailable reason", () => {
    const run = testRun({ scenarioId: "V-L01" });
    const binding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    const event = (seq: number, kind: string, payload: Record<string, unknown>) => ({ runId: run.id, seq, kind, source: "product" as const, payload: { _product_run_binding: binding, ...payload }, at: new Date(), dedupeKey: null });
    const appliedAt = "2026-08-23T12:00:00.000Z";
    const base = { schema: "sophia_voice_lab_trace_fault_v1", fault: "langsmith_unavailable", principal_id: run.principalId, test_run_id: run.testRunId, scenario_id: "V-L01", scenario_version: run.scenarioVersion, environment: run.environment, expected_deployment: run.target.expectedDeployment, trace_unavailable: true, canonical_behavior_unchanged: true, applied_at: appliedAt };
    const applied = event(1, "trace.fault_receipt", { receipt: { ...base, phase: "applied", restored_at: null } });
    const unavailable = event(2, "provider.connection_observability", { langsmithTraceId: null, langsmithTraceStatus: "trace_unavailable", langsmithTraceUnavailableReason: "governed_synthetic_fault" });
    const restored = event(3, "trace.fault_receipt", { receipt: { ...base, phase: "restored", restored_at: "2026-08-23T12:05:00.000Z" } });
    const exact = evaluateScenarioAssertions(run, [applied, unavailable, restored] as any, []);
    expect(exact.harness).toContainEqual(expect.objectContaining({ id: "l01.governed_supplemental_trace_outage", status: "pass" }));
    expect(evaluateScenarioAssertions(run, [applied, unavailable] as any, []).harness).toContainEqual(expect.objectContaining({ id: "l01.governed_supplemental_trace_outage", status: "fail" }));
    const wrongDeployment = event(3, "trace.fault_receipt", { receipt: { ...base, expected_deployment: { ...run.target.expectedDeployment, voice: "0".repeat(40) }, phase: "restored", restored_at: "2026-08-23T12:05:00.000Z" } });
    expect(evaluateScenarioAssertions(run, [applied, unavailable, wrongDeployment] as any, []).harness).toContainEqual(expect.objectContaining({ id: "l01.governed_supplemental_trace_outage", status: "fail" }));
  });

  it("paginates wait beyond 500 and matches only the requested terminal operation", async () => {
    const run = testRun({ state: "active" });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    for (let index = 0; index < 550; index += 1) await ledger.appendEvent(run.id, "noise", "product", { index });
    const productBinding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    await ledger.appendEvent(run.id, "audio.output.started", "product", { _product_run_binding: productBinding, receipt: { realization: "actual" } });
    const waited = await service.waitForTurn(caller, { run_id: run.id, after_cursor: 0, condition: "assistant_first_audio", timeout_ms: 500 });
    expect(waited.data.condition_satisfied).toBe(true);
    expect(waited.data.scanned_event_count).toBe(551);

    const wanted = randomUUID();
    await ledger.appendEvent(run.id, "operation.succeeded", "worker", { operation_id: randomUUID() });
    await ledger.appendEvent(run.id, "operation.failed", "worker", { operation_id: wanted });
    const exact = await service.waitForTurn(caller, { run_id: run.id, after_cursor: 551, condition: "operation_terminal", operation_id: wanted, timeout_ms: 500 });
    expect((exact.data.matched as Array<any>)[0].payload.operation_id).toBe(wanted);
  });

  it("waits through every nonterminal product tool-ledger state and matches only an exact terminal settlement", async () => {
    const run = testRun({ state: "active" });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const productBinding = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
    let cursor = 0;
    for (const finalState of ["unknown", "pending", "received", "executing"]) {
      const event = await ledger.appendEvent(run.id, "product.gemini-tool-call-ledger", "product", { _product_run_binding: productBinding, entry: { toolCallId: "tool-wait", effectId: "effect-wait", finalState } });
      cursor = event.seq;
    }
    const beforeTerminal = await service.waitForTurn(caller, { run_id: run.id, after_cursor: 0, condition: "tool_settlement", timeout_ms: 100 });
    expect(beforeTerminal).toMatchObject({ status: "timeout", data: { matched: [] } });
    const terminal = await ledger.appendEvent(run.id, "product.gemini-tool-call-ledger", "product", { _product_run_binding: productBinding, entry: { toolCallId: "tool-wait", effectId: "effect-wait", finalState: "responded", toolResponseSentAt: new Date().toISOString() } });
    const settled = await service.waitForTurn(caller, { run_id: run.id, after_cursor: cursor, condition: "tool_settlement", timeout_ms: 100 });
    expect(settled).toMatchObject({ status: "ok", data: { condition_satisfied: true } });
    expect((settled.data.matched as Array<any>)[0].seq).toBe(terminal.seq);
  });

  it("exposes bounded synthetic semantics only with original app-authored exact-run provenance", async () => {
    const run = testRun({ state: "active" });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const binding = { _runner_binding: { run_id: run.id, test_run_id_sha256: sha256(run.testRunId) }, _product_run_binding: { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() } };
    for (const [index, text] of ["build a calm page", "make the title blue", "what is its status"].entries()) await ledger.appendEvent(run.id, "product.voice-sse.sophia.user_transcript", "product", { ...binding, text, synthetic_context: { synthetic: true, test_run_id: run.testRunId }, index });
    const visible = await service.inspectVoiceRun(caller, { run_id: run.id, after_cursor: 0, limit: 10 });
    expect(JSON.stringify(visible.data.events)).toContain("build a calm page");
    await ledger.appendEvent(run.id, "product.voice-sse.sophia.user_transcript", "product", { text: "must remain private" });
    const redacted = await service.inspectVoiceRun(caller, { run_id: run.id, after_cursor: 3, limit: 10 });
    expect(JSON.stringify(redacted.data.events)).not.toContain("must remain private");
  });

  it("rejects unknown/unsupported scenarios and concurrency above the single-principal contract", async () => {
    await expect(service.startVoiceRun(caller, { environment: "production", target, scenario_id: "V-F02", idempotency_key: "unsupported" })).rejects.toMatchObject({ detail: { code: "SCENARIO_OWNING_PRIMITIVE_UNAVAILABLE" } });
    await expect(service.startVoiceRun(caller, { environment: "production", target, scenario_id: "V-Z99", idempotency_key: "unknown" })).rejects.toBeInstanceOf(Error);
    await expect(service.runRegressionSuite(caller, { environment: "production", target, scenarios: [{ id: "V-P01" }], max_concurrency: 2, idempotency_key: "parallel" })).rejects.toBeInstanceOf(Error);
    await expect(service.runRegressionSuite(caller, { environment: "production", target, scenarios: [{ id: "V-P01" }, { id: "V-P01", version: "vt00.scenarios.v1" }], max_concurrency: 1, idempotency_key: "duplicate-scenario" })).rejects.toBeInstanceOf(Error);
  });

  it("cancels durable suite scheduling without allocating a child when kill is engaged", async () => {
    const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
    const suiteId = randomUUID();
    await ledger.createSuite({
      id: suiteId,
      callerId: caller.subject,
      idempotencyKey: "kill-suite",
      requestHash: sha256("kill-suite"),
      state: "accepted",
      scenarioIds: ["V-P01"],
      runIds: [],
      definition: {
        environment: "production",
        target: {
          frontendUrl: "http://frontend.test",
          gatewayUrl: "http://gateway.test",
          voiceUrl: "http://voice.test",
          langgraphUrl: "http://langgraph.test",
          expectedDeployment: { frontend: SHA, backend: SHA_B, voice: SHA_C },
          expectedDependencies: { langgraph: SHA_D },
        },
        scenarios: [{ id: "V-P01", version: "vt00.scenarios.v1" }],
        capturePolicy: { rawAudio: false, screenshot: true, video: false, retentionHours: 24 },
      },
      nextScenarioIndex: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const inertDriver = { reap: undefined, hasSession: () => false, readiness: async () => ({ ok: true, detail: "test" }), close: async () => undefined } as any;
    const worker = new VoiceLabWorker("worker-kill-test", ledger, config, audio, inertDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds));
    await worker.maintainSessions();
    expect(await ledger.getSuite(suiteId)).toMatchObject({ state: "cancelled", runIds: [], nextScenarioIndex: 0 });
  });

  it("runs zero-orphan recovery before terminal evidence publication", async () => {
    const order: string[] = [];
    vi.spyOn(ledger, "listRunsNeedingRecovery").mockImplementation(async () => {
      order.push("recovery");
      return [];
    });
    vi.spyOn(ledger, "listRunsPendingEvidence").mockImplementation(async () => {
      order.push("evidence");
      return [];
    });
    const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
    const inertDriver = { hasSession: () => false, readiness: async () => ({ ok: true, detail: "test" }), close: async () => undefined } as any;
    const worker = new VoiceLabWorker("worker-maintenance-order", ledger, config, audio, inertDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds));

    await worker.maintainSessions();

    expect(order).toEqual(["recovery", "evidence"]);
  });

  it("hard-purges retained content at the signed deadline and gives only the owner a keyed typed result", async () => {
    const old = new Date(Date.now() - 3_600_000);
    const run = testRun({ state: "completed", cleanupComplete: true, capturePolicy: { rawAudio: false, screenshot: true, video: false, retentionHours: 1 }, createdAt: old, updatedAt: old });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    await ledger.appendEvent(run.id, "transcript.input.final", "product", { text: "purge me" });
    await ledger.recordAuthAudit({ runId: run.id, callerId: caller.subject, action: "test", capabilityJtiHash: sha256("jti"), argumentHash: sha256("args"), outcome: "allowed", detail: { principal: "voice-lab-user-1" }, observedAt: old });
    // Durable activity advances updatedAt; retention is measured from the last
    // governed write, not merely the original run creation timestamp.
    const retained = await ledger.getRun(run.id);
    const due = new Date(retained!.updatedAt.getTime() + 3_600_001);
    await ledger.updateRun(run.id, retained!.version, { retentionPurgeDueAt: due, retentionPurgePending: true });
    expect(await ledger.purgeExpiredRetention(new Date(due.getTime() + 1), 10)).toEqual([run.id]);
    expect(await ledger.getRun(run.id)).toBeNull();
    expect(await ledger.getRetentionTombstone(run.id, caller.subject)).toMatchObject({ remotePurgeStatus: "unconfirmed" });
    expect(await ledger.getRetentionTombstone(run.id, "foreign-caller")).toBeNull();
    const result = await service.exportVoiceEvidence(caller, { run_id: run.id });
    expect(result.status).toBe("unavailable");
    expect((result.warnings[0]?.code)).toBe("EVIDENCE_RETENTION_EXPIRED");
    expect(result.data.remote_purge_status).toBe("unconfirmed");
  });

  it("attempts upstream purge but never lets an outage extend the local deadline", async () => {
    const due = new Date(Date.now() - 1_000);
    const run = testRun({ state: "completed", cleanupComplete: true, retentionPurgeDueAt: due, retentionPurgePending: true });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    expect((await ledger.listRunsRetentionDue(new Date(), 10)).map((candidate) => candidate.id)).toEqual([run.id]);
    expect(await ledger.purgeExpiredRetention(new Date(), 10)).toEqual([run.id]);
    expect(await ledger.getRun(run.id)).toBeNull();
    expect(await ledger.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "unconfirmed" });
  });

  it("worker maintenance still hard-purges local evidence when Gateway recovery is unavailable", async () => {
    const config = testConfig();
    const due = new Date(Date.now() - 1_000);
    const run = testRun({ state: "completed", cleanupComplete: true, retentionPurgeDueAt: due, retentionPurgePending: true });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    await ledger.appendEvent(run.id, "transcript.input.final", "product", { text: "must not survive outage" });
    const outageDriver = {
      recover: async () => { throw new Error("gateway unavailable"); },
      hasSession: () => false,
      readiness: async () => ({ ok: true, detail: "test" }),
      close: async () => undefined,
    } as any;
    const worker = new VoiceLabWorker("worker-retention-outage", ledger, config, audio, outageDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds));
    await worker.maintainSessions();
    expect(await ledger.getRun(run.id)).toBeNull();
    expect(await ledger.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "unconfirmed" });
  });

  it("enforces optimistic run CAS and terminal cleanup in the concurrency count", async () => {
    const run = testRun();
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    await ledger.updateRun(run.id, 1, { state: "failed_harness" });
    await expect(ledger.updateRun(run.id, 1, { state: "cancelled" })).rejects.toMatchObject({ detail: { code: "RUN_VERSION_CONFLICT" } });
    expect(await ledger.countActiveRuns()).toBe(1);
    const fresh = await ledger.getRun(run.id);
    await ledger.updateRun(run.id, fresh!.version, { cleanupComplete: true });
    expect(await ledger.countActiveRuns()).toBe(0);
    expect(TERMINAL_RUN_STATES.has((await ledger.getRun(run.id))!.state)).toBe(true);
  });

  it("rejects changed event dedupe meaning and keeps artifacts immutable", async () => {
    const run = testRun();
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const first = await ledger.appendEvent(run.id, "audio.input.scheduled", "browser", { operation_id: "op-1", byte_length: 10 }, "receipt-1");
    const replay = await ledger.appendEvent(run.id, "audio.input.scheduled", "browser", { operation_id: "op-1", byte_length: 10 }, "receipt-1");
    expect(replay.seq).toBe(first.seq);
    await expect(ledger.appendEvent(run.id, "audio.input.completed", "browser", { operation_id: "op-1", byte_length: 11 }, "receipt-1")).rejects.toMatchObject({ detail: { code: "DEDUPE_CONFLICT" } });

    const bytes = Buffer.from("immutable evidence");
    const artifact = { id: randomUUID(), runId: run.id, kind: "manifest_attachment", contentType: "application/json", sha256: sha256(bytes), bytes, createdAt: new Date() };
    expect((await ledger.saveArtifact(artifact)).sha256).toBe(artifact.sha256);
    expect((await ledger.saveArtifact({ ...artifact, createdAt: new Date(Date.now() + 1_000) })).id).toBe(artifact.id);
    await expect(ledger.saveArtifact({ ...artifact, bytes: Buffer.from("changed"), sha256: sha256("changed") })).rejects.toMatchObject({ detail: { code: "ARTIFACT_ID_CONFLICT" } });
    await expect(ledger.saveArtifact({ ...artifact, sha256: sha256("wrong") })).rejects.toMatchObject({ detail: { code: "ARTIFACT_DIGEST_MISMATCH" } });
  });

  it("CAS-releases browser ownership and terminalizes every pending run operation", async () => {
    const run = testRun({ state: "active" });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const queued = await ledger.createOperation({ id: randomUUID(), runId: run.id, callerId: caller.subject, type: "speak", idempotencyKey: "queued", requestHash: sha256("queued"), input: { fixture_id: "a02_short_command" } });
    const leased = await ledger.upsertBrowserLease(run.id, "worker-a", 60);
    expect(await ledger.releaseBrowserLease(run.id, "worker-b", leased.leaseEpoch)).toBe(false);
    expect(await ledger.getBrowserLease(run.id)).not.toBeNull();
    expect(await ledger.releaseBrowserLease(run.id, "worker-a", leased.leaseEpoch)).toBe(true);
    expect(await ledger.getBrowserLease(run.id)).toBeNull();
    const cancelled = await ledger.cancelPendingRunOperations(run.id, null, { code: "RUN_TERMINATED", message: "terminal", category: "harness", retryable: false });
    expect(cancelled.map((operation) => operation.id)).toContain(queued.operation.id);
    expect((await ledger.listOperations(run.id)).every((operation) => !["queued", "leased", "executing"].includes(operation.state))).toBe(true);
    expect(await ledger.claimNextOperation("worker-c", 30)).toBeNull();
  });

  it("keeps evidence revisions append-only and advances only to a newer cursor", async () => {
    const run = testRun({ state: "failed_harness", cleanupComplete: false });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const first = { runId: run.id, manifestId: randomUUID(), manifestSha256: sha256("pending"), schemaVersion: "sophia.voice-lab.evidence.v1", revisionSeq: 10, artifactRefs: [], createdAt: new Date() };
    const complete = { ...first, manifestId: randomUUID(), manifestSha256: sha256("complete"), revisionSeq: 20, createdAt: new Date(Date.now() + 1_000) };
    expect((await ledger.saveEvidence(first)).manifestId).toBe(first.manifestId);
    expect((await ledger.saveEvidence(complete)).manifestId).toBe(complete.manifestId);
    expect((await ledger.saveEvidence(first)).manifestId).toBe(complete.manifestId);
    await expect(ledger.saveEvidence({ ...complete, manifestSha256: sha256("mutated") })).rejects.toMatchObject({ detail: { code: "EVIDENCE_REVISION_CONFLICT" } });
    expect((await ledger.getEvidence(run.id))?.revisionSeq).toBe(20);
  });

  it("publishes the same complete append-only manifest shape for a harness failure and uses canonical saved artifact identities", async () => {
    const run = testRun({ scenarioId: "V-A01", state: "reserved" });
    await ledger.createRunWithOperation(run, startOperation(run), { global: 1, caller: 1 });
    const originalAppendEvents = ledger.appendEvents.bind(ledger);
    let releaseFirstStageWrite = () => undefined;
    const firstStageWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstStageWrite = resolve;
    });
    let firstStageCallbackReleasedBeforePersistence = false;
    ledger.appendEvents = async (...args) => {
      const [, events] = args;
      if (events.some((event) => event.kind === "harness.startup_stage" && event.payload.stage_sequence === 1)) {
        await firstStageWriteBlocked;
      }
      return originalAppendEvents(...args);
    };
    const receiptBytes = Buffer.from('{"safe":"failure-receipt"}');
    const canonicalArtifactId = randomUUID();
    const proposedArtifactId = randomUUID();
    await ledger.saveArtifact({ id: canonicalArtifactId, runId: run.id, kind: "canonical_receipt", contentType: "application/json", sha256: sha256(receiptBytes), bytes: receiptBytes, createdAt: run.createdAt });
    const recoveryReceipt = {
      complete: true,
      live_cleanup_complete: true,
      live_resources_zero: true,
      components: {
        canonical_session: { status: "completed" },
        voice_provider: { status: "completed" },
        auth_sessions: { status: "completed" },
        builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 },
      },
    };
    const driver = {
      hasSession: () => false,
      start: async (_run: unknown, _token: string, _binding: unknown, onStage?: (stage: "session_navigation" | "voice_start_button") => Promise<void>) => {
        await onStage?.("session_navigation");
        firstStageCallbackReleasedBeforePersistence = true;
        releaseFirstStageWrite();
        await onStage?.("voice_start_button");
        throw new VoiceLabError(labError("START_HARNESS_FAILURE", "Synthetic startup failed in the harness test.", "harness"));
      },
      recover: async () => ({
        events: [
          { kind: "cleanup.browser_context_absent", source: "worker", payload: { browser_never_allocated: true }, dedupeKey: `cleanup:${run.id}:context-absent` },
          { kind: "cleanup.recovery", source: "canonical", payload: { complete: true, receipt: recoveryReceipt }, dedupeKey: `cleanup:${run.id}:recovery` },
        ],
        artifacts: [{ id: proposedArtifactId, kind: "canonical_receipt", contentType: "application/json", bytes: receiptBytes }],
      }),
      cancel: async () => undefined,
      readiness: async () => ({ ok: true, detail: "test-browser", engine: "chromium", version: "test" }),
      close: async () => undefined,
    } as any;
    const config = testConfig();
    const worker = new VoiceLabWorker("worker-failure-evidence", ledger, config, audio, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds));
    expect(await worker.runOnce()).toBe(true);
    expect(firstStageCallbackReleasedBeforePersistence).toBe(true);
    const startupStages = (await ledger.listEvents(run.id, 0, 100)).events.filter((event) => event.kind === "harness.startup_stage");
    expect(startupStages.map((event) => event.payload)).toEqual([
      { operation_id: expect.any(String), stage: "session_navigation", stage_sequence: 1 },
      { operation_id: expect.any(String), stage: "voice_start_button", stage_sequence: 2 },
    ]);
    expect(startupStages[0]?.dedupeKey).toMatch(/^startup-stage:[0-9a-f-]+:1$/);
    expect(startupStages[1]?.dedupeKey).toMatch(/^startup-stage:[0-9a-f-]+:2$/);
    const failed = await ledger.getRun(run.id);
    expect(failed).toMatchObject({ state: "failed_harness", cleanupComplete: true });
    const evidence = await ledger.getEvidence(run.id);
    expect(evidence).not.toBeNull();
    const manifestArtifact = await ledger.getArtifact(evidence!.manifestId);
    expect(manifestArtifact?.kind).toBe("manifest_attachment");
    const manifestText = Buffer.from(manifestArtifact!.bytes).toString("utf8");
    expect(manifestText.slice(0, 32)).toContain("contract_version");
    const manifest = JSON.parse(manifestText);
    expect(manifest).toMatchObject({
      contract_version: "sophia.voice-lab.evidence.v1",
      schema_version: "sophia.voice-lab.evidence.v1",
      terminal_state: "failed_harness",
      terminal_reason: "START_HARNESS_FAILURE",
      versions: { harness: config.harnessVersion, mcp: config.mcpVersion, plugin: config.pluginVersion, service_commit: config.serviceVersion, registered_app: { technical_id: config.registeredAppId } },
      repository_commits: { base: config.repositoryBaseSha, candidate: config.repositoryCandidateSha, rollback: config.repositoryRollbackSha },
      scenario: { id: "V-A01", version: "vt00.scenarios.v1" },
      deployment_identity: { expected: { frontend: SHA, backend: SHA_B, voice: SHA_C } },
      deployment_dependencies: { expected: { langgraph: SHA_D }, observations: [] },
      failure: { owner: "harness", classification: "START_HARNESS_FAILURE" },
      raw_audio: { status: "not_captured" },
      video: { status: "unavailable" },
      cleanup_audit: { browser_context_closed: true, browser_lease_released: true, live_execution_resources_zero: true, cleanup_complete: true },
      cleanup_obligation: { cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), raw_identifier_excluded: true },
    });
    for (const key of ["repository_commits", "run_lifecycle", "deployment_identity", "deployment_dependencies", "browser", "joins", "message_revisions", "utterances", "transcripts_and_turns", "media_receipts", "tool_receipts", "builder_receipts", "durable_projections", "ui_assertions", "metrics", "operations", "authorization_audit", "event_stream", "assertions", "human_summary"]) expect(manifest).toHaveProperty(key);
    expect(manifest.artifact_references).toContainEqual(expect.objectContaining({ resource_id: `voice-lab://artifact/${canonicalArtifactId}`, sha256: sha256(receiptBytes) }));
    expect(JSON.stringify(manifest)).not.toContain(proposedArtifactId);
    expect(JSON.stringify(manifest)).not.toContain(run.cleanupObligationId);
    expect((manifest.operations as Array<{ state: string }>).every((operation) => !["accepted", "queued", "leased", "executing"].includes(operation.state))).toBe(true);
  });

  it("never counts unbound product kinds toward readiness, cleanup, or verdicts", () => {
    const run = testRun({ scenarioId: "V-F01", state: "exporting", observedDeployment: { frontend: SHA, backend: SHA_B, voice: SHA_C }, canonicalSessionId: "session-1", threadId: "thread-1", providerSessionId: "provider-1", providerEpoch: 1 });
    let seq = 0;
    const event = (kind: string, source: any, payload: Record<string, unknown> = {}) => ({ runId: run.id, seq: ++seq, kind, source, payload, at: new Date(), dedupeKey: null });
    const events = [
      event("harness.initialized", "browser"), event("harness.media_stream_issued", "browser"),
      event("session.microphone_stream_acquired", "product"), event("provider.connection_epoch", "product"), event("provider.stage", "product", { stage: "closed" }),
      event("deployment.verified", "canonical"), event("deployment.reverified", "canonical"), event("session.finalized", "canonical"),
      event("auth.session_cleanup", "canonical", { session_revoked: true, cookies_cleared: true }), event("cleanup.browser_lease_released", "worker"),
      event("cleanup.recovery", "canonical", { complete: true, receipt: { complete: true, live_cleanup_complete: true, live_resources_zero: true, components: { builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } } } }),
    ];
    const verdicts = deriveCompletedVerdicts(run, events as any, []);
    expect(verdicts.harness).toBe("fail");
    expect(verdicts.provider).toBe("inconclusive");
    expect(verdicts.product).not.toBe("pass");
  });

  it("verifies all generated fixture hashes/metadata and silence policy", async () => {
    for (const fixture of audio.summaries()) {
      const resolved = await audio.resolve({ fixture_id: fixture.id });
      expect(resolved.sha256).toBe(fixture.sha256);
      expect(resolved.durationMs).toBe(fixture.durationMs);
    }
    const silence = audio.summaries().find((fixture) => fixture.fixtureClass === "silence")!;
    expect(silence.assertionPolicy.expect_transcript).toBe(false);
    expect(silence.assertionPolicy.semantic_threshold).toBe("no_fabricated_injected_or_product_turn");
  });
});

async function buildSuiteCertificationManifest(children: ReturnType<typeof testRun>[]): Promise<any> {
  const localLedger = new MemoryVoiceLabLedger("test");
  const config = testConfig();
  const localAudio = new AudioResolver(config);
  await localAudio.initialize();
  for (const child of children) {
    await localLedger.createRunWithOperation(child, startOperation(child), { global: 1, caller: 1 });
    await localLedger.saveEvidence({ runId: child.id, manifestId: randomUUID(), manifestSha256: sha256(`suite-child-${child.id}`), schemaVersion: "sophia.voice-lab.evidence.v1", revisionSeq: 0, artifactRefs: [], createdAt: child.updatedAt });
  }
  const now = new Date();
  const suiteId = randomUUID();
  await localLedger.createSuite({
    id: suiteId, callerId: children[0]!.callerId, idempotencyKey: `suite-certification-${suiteId}`, requestHash: sha256(`suite-certification-${suiteId}`), state: "running",
    scenarioIds: children.map((child) => child.scenarioId!), runIds: children.map((child) => child.id),
    definition: {
      environment: "production", target: children[0]!.target,
      scenarios: children.map((child) => ({ id: child.scenarioId!, version: child.scenarioVersion, support: "supported" as const, unavailableReason: null })),
      capturePolicy: children[0]!.capturePolicy,
    },
    nextScenarioIndex: children.length, createdAt: now, updatedAt: now,
  });
  const driver = { hasSession: () => false, readiness: async () => ({ ok: true, detail: "test" }), close: async () => undefined } as any;
  const worker = new VoiceLabWorker("suite-certification-worker", localLedger, config, localAudio, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds));
  await worker.maintainSessions();
  expect(await localLedger.getSuite(suiteId)).toMatchObject({ state: "completed" });
  const evidence = await localLedger.getSuiteEvidence(suiteId);
  expect(evidence).not.toBeNull();
  return JSON.parse(Buffer.from(evidence!.bytes).toString("utf8"));
}

function startOperation(run: ReturnType<typeof testRun>) {
  return { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start" as const, idempotencyKey: `start-${run.id}`, requestHash: sha256(run.id), input: { environment: run.environment } };
}

function productAdmissionProof(config: ReturnType<typeof testConfig>, ready: boolean): Record<string, unknown> & { ok: boolean } {
  const configured = config.readinessTarget!;
  const component = (expected: string) => ({ ready, config_status: ready ? "ready" : "voice_lab_admission_not_ready", expected, observed: expected });
  return {
    ok: ready,
    status: ready ? "verified" : "mismatch_or_unavailable",
    environment: config.environment,
    target_binding_sha256: targetAdmissionBinding(configured),
    probe_id: randomUUID(),
    observed_at: new Date().toISOString(),
    product_mutation_gates_open: ready,
    builds: {
      frontend: component(configured.expectedDeployment.frontend),
      backend: component(configured.expectedDeployment.backend),
      voice: component(configured.expectedDeployment.voice),
      langgraph: component(configured.expectedDependencies.langgraph),
    },
  };
}
