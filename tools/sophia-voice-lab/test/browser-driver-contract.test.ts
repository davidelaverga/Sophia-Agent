import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { assertPageLocation, browserProcessOwnershipHashes, classifyBrowserStartCause, classifyClientConsoleErrorLocation, classifyClientPageError, closeContextWithProof, disposableBrowserProcessIsActive, drainProductCapture, isExactFinalizationResponse, PlaywrightVoiceDriver, requestBoundJson, requestBoundJsonWithOneTransientRetry, shouldCaptureSessionVoiceRoute, validateAppSyntheticBinding, validateD02BrowserContextBinding, validateD02ProductCleanupEcho, validateVoiceLabControlAdapterReceipt, waitOnWorkerClock } from "../src/browser-driver.js";
import { sha256 } from "../src/security.js";
import { SHA, SHA_B, SHA_C, SHA_D, testConfig, testRun } from "./helpers.js";

describe("server-authorized Voice Lab control adapter", () => {
  it("contains no superseded UI activation or route-reload fallback", () => {
    const source = readFileSync(new URL("../src/browser-driver.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "resolveDashboardMicButton",
      "activateDashboardMicButton",
      "establishSessionVoiceTab",
      "establishSessionNavigation",
      "establishDashboardMicRoute",
      "activateVoiceStartWithClientErrorReload",
      "waitForClientPageError",
      "RECOVERABLE_DASHBOARD_LOAD_ERROR",
      "isRecoverableEmptySessionVoiceRoute",
      "isRecoverableEmptyDashboardVoiceRoute",
      "newCDPSession",
      "Debugger.",
      "Runtime.",
      "DIRECT_CDP_CLIENT_DIAGNOSTICS_ENABLED",
      "PAUSING_CLIENT_DIAGNOSTICS_ENABLED",
      "findPassiveEffect",
      "effect_probe",
    ]) expect(source).not.toContain(forbidden);
    expect(source).toContain('enterStage("control_adapter_session_start")');
    expect(source).toContain('enterStage("control_adapter_voice_start")');
  });

  it("accepts only an exact, current run/scenario/deployment/cleanup/action epoch", () => {
    const run = testRun({
      testRunId: "run-control-001",
      cleanupObligationId: "123e4567-e89b-42d3-a456-426614174000",
    });
    const receipt = {
      ok: true,
      schema: "sophia_voice_lab_control_adapter_v1",
      action: "session-start",
      test_run_id: run.testRunId,
      scenario_id: run.scenarioId,
      scenario_version: run.scenarioVersion,
      cleanup_obligation_id: run.cleanupObligationId,
      expected_deployment: { ...run.target.expectedDeployment },
      control_epoch_sha256: "e".repeat(64),
      expires_at: 1_800_000_120,
      ordinary_user_access: false,
    };

    expect(validateVoiceLabControlAdapterReceipt(receipt, "session-start", run, 1_800_000_000)).toEqual(receipt);
    expect(validateVoiceLabControlAdapterReceipt({ ...receipt, action: "voice-start" }, "session-start", run, 1_800_000_000)).toBeNull();
    expect(validateVoiceLabControlAdapterReceipt({ ...receipt, test_run_id: "run-other" }, "session-start", run, 1_800_000_000)).toBeNull();
    expect(validateVoiceLabControlAdapterReceipt({ ...receipt, cleanup_obligation_id: "223e4567-e89b-42d3-a456-426614174111" }, "session-start", run, 1_800_000_000)).toBeNull();
    expect(validateVoiceLabControlAdapterReceipt({ ...receipt, expected_deployment: { ...run.target.expectedDeployment, voice: SHA_D } }, "session-start", run, 1_800_000_000)).toBeNull();
    expect(validateVoiceLabControlAdapterReceipt({ ...receipt, expires_at: 1_800_000_000 }, "session-start", run, 1_800_000_000)).toBeNull();
    expect(validateVoiceLabControlAdapterReceipt({ ...receipt, unexpected: true }, "session-start", run, 1_800_000_000)).toBeNull();
  });
});

describe("disposable browser process ownership", () => {
  it("binds a redacted process identity and boot epoch to exactly one run", () => {
    const input = {
      runId: "run-browser-owner-001",
      cleanupObligationId: "123e4567-e89b-42d3-a456-426614174000",
      processId: 4172,
      nonce: "123e4567-e89b-42d3-a456-426614174222",
      startedAt: "2026-09-02T15:00:00.000Z",
    };
    const first = browserProcessOwnershipHashes(input);
    expect(first.processIdSha256).toBe(sha256("4172"));
    expect(first.bootIdSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.executionEpochSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(browserProcessOwnershipHashes(input)).toEqual(first);
    expect(browserProcessOwnershipHashes({ ...input, runId: "run-browser-owner-002" }).executionEpochSha256).not.toBe(first.executionEpochSha256);
    expect(browserProcessOwnershipHashes({ ...input, processId: 4173 }).bootIdSha256).not.toBe(first.bootIdSha256);
    expect(() => browserProcessOwnershipHashes({ ...input, processId: 0 })).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "BROWSER_PROCESS_OWNERSHIP_INVALID" }) }));
  });

  it("treats either a disconnected browser or exited owned child as a fenced epoch", () => {
    const ownership = {
      browser: { isConnected: () => true },
      child: { exitCode: null, signalCode: null },
    } as any;
    expect(disposableBrowserProcessIsActive(ownership)).toBe(true);
    ownership.child.exitCode = 0;
    expect(disposableBrowserProcessIsActive(ownership)).toBe(false);
    ownership.child.exitCode = null;
    ownership.browser.isConnected = () => false;
    expect(disposableBrowserProcessIsActive(ownership)).toBe(false);
  });

  it("rejects a concurrent duplicate before it can launch a second process", async () => {
    const run = testRun();
    const builds: Record<string, string> = {
      "frontend.test": run.target.expectedDeployment.frontend,
      "gateway.test": run.target.expectedDeployment.backend,
      "voice.test": run.target.expectedDeployment.voice,
      "langgraph.test": run.target.expectedDependencies.langgraph,
    };
    let enterLaunch!: () => void;
    let rejectLaunch!: (error: Error) => void;
    const launchEntered = new Promise<void>((resolve) => { enterLaunch = resolve; });
    const launchBlocked = new Promise<never>((_resolve, reject) => { rejectLaunch = reject; });
    const driver = new PlaywrightVoiceDriver(
      testConfig(),
      async (input) => {
        const url = new URL(String(input));
        return new Response(JSON.stringify({ build_id: builds[url.hostname] }), { status: 200, headers: { "content-type": "application/json" } });
      },
      undefined,
      undefined,
      (() => { enterLaunch(); return launchBlocked; }) as any,
    );
    const first = driver.start(run, "capability").catch((error) => error);
    await launchEntered;
    await expect(driver.start(run, "capability")).rejects.toMatchObject({ detail: { code: "BROWSER_ALREADY_STARTED" } });
    rejectLaunch(new Error("expected-launch-stop"));
    await expect(first).resolves.toMatchObject({ message: "expected-launch-stop" });
  });
});

describe("generation-aware capture drain", () => {
  it("pages beyond the 500-event ring without loss or duplicate", async () => {
    const all = Array.from({ length: 750 }, (_, index) => ({ seq: index + 1, generation: 7, recordedAt: new Date(index * 10).toISOString(), category: "voice", name: `event-${index + 1}`, payload: { index: index + 1 } }));
    const result = await drainProductCapture({ generation: 7, seq: 0 }, async (cursor) => {
      const events = all.filter((event) => event.seq > (cursor?.seq ?? 0)).slice(0, 500);
      return { cursor: { generation: 7, seq: events.at(-1)?.seq ?? cursor?.seq ?? 0 }, events, metadata: { gap: false, oldestSeq: 1, latestSeq: 750, gapReason: null } };
    });
    expect(result.events).toHaveLength(750);
    expect(new Set(result.events.map((event) => `${event.generation}:${event.seq}`)).size).toBe(750);
    expect(result.cursor).toEqual({ generation: 7, seq: 750 });
  });

  it("fails closed on metadata gap, missing readAfter, or no cursor progress", async () => {
    await expect(drainProductCapture({ generation: 1, seq: 10 }, async () => ({ cursor: { generation: 2, seq: 1 }, events: [], metadata: { gap: true, oldestSeq: 1, latestSeq: 1, gapReason: "generation_mismatch" } }))).rejects.toMatchObject({ detail: { code: "CAPTURE_CURSOR_GAP" } });
    await expect(drainProductCapture(null, async () => ({ unsupported: true, metadata: null, events: [] }))).rejects.toMatchObject({ detail: { code: "CAPTURE_DRAIN_UNSUPPORTED" } });
    await expect(drainProductCapture({ generation: 1, seq: 10 }, async () => ({ cursor: { generation: 1, seq: 10 }, events: [], metadata: { gap: false, oldestSeq: 1, latestSeq: 20 } }))).rejects.toMatchObject({ detail: { code: "CAPTURE_CURSOR_GAP" } });
  });
});

describe("ordinary session navigation settlement", () => {
  it("captures fixed route state at both voice-control acquisition stages", () => {
    expect(shouldCaptureSessionVoiceRoute("voice_tab_selection")).toBe(true);
    expect(shouldCaptureSessionVoiceRoute("voice_start_button")).toBe(true);
    expect(shouldCaptureSessionVoiceRoute("voice_startup_readiness")).toBe(true);
    expect(shouldCaptureSessionVoiceRoute("dashboard_privacy_consent")).toBe(true);
    expect(shouldCaptureSessionVoiceRoute("dashboard_microphone_cta")).toBe(true);
    expect(shouldCaptureSessionVoiceRoute("session_navigation")).toBe(false);
  });

});

describe("ordinary voice start recovery", () => {
  it("does not expose or honor legacy browser-storage import configuration", () => {
    const config = testConfig({
      SOPHIA_VOICE_LAB_STORAGE_STATE_ENCRYPTED: "legacy-ciphertext-must-be-ignored",
      SOPHIA_VOICE_LAB_STORAGE_STATE_KEY: "legacy-key-must-be-ignored",
    });
    expect("storageStateCiphertext" in config).toBe(false);
    expect("storageStateKey" in config).toBe(false);
  });

  it("uses a worker-owned clock that does not depend on a page", async () => {
    const started = Date.now();
    await expect(waitOnWorkerClock(10)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });

});

describe("product-authored synthetic capture provenance", () => {
  const expected = { testRunId: "run-001", cleanupObligationId: "00000000-0000-4000-8000-000000000002", principalId: "principal-001", scenarioId: "V-A01", scenarioVersion: "vt00.scenarios.v1", environment: "production", retentionHours: 24, providerExpiresAt: "2026-08-23T12:30:00.000Z" };
  const envelope = { synthetic: true, principal_id: "principal-001", test_run_id: "run-001", cleanup_obligation_id: expected.cleanupObligationId, scenario_id: "V-A01", scenario_version: "vt00.scenarios.v1", environment: "production", retention_hours: 24, provider_expires_at: expected.providerExpiresAt };

  it("keeps only hash-safe proof from an exact envelope binding", () => {
    expect(validateAppSyntheticBinding(envelope, expected)).toEqual({
      app_authenticated: true,
      synthetic: true,
      principal_id_sha256: sha256("principal-001"),
      test_run_id_sha256: sha256("run-001"),
      cleanup_obligation_id_sha256: sha256(expected.cleanupObligationId),
      environment: "production",
      scenario_id: "V-A01",
      scenario_version: "vt00.scenarios.v1",
      retention_hours: 24,
      provider_expires_at: expected.providerExpiresAt,
    });
  });

  it("types absent proof unavailable and hard-aborts wrong or malformed proof", () => {
    expect(validateAppSyntheticBinding(undefined, expected)).toBeNull();
    expect(() => validateAppSyntheticBinding({ ...envelope, cleanup_obligation_id: undefined }, expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
    expect(() => validateAppSyntheticBinding({ ...envelope, cleanup_obligation_id: "00000000-0000-4000-8000-000000000003" }, expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
    expect(() => validateAppSyntheticBinding({ ...envelope, test_run_id: "foreign-run" }, expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
    expect(() => validateAppSyntheticBinding({ ...envelope, retention_hours: 1 }, expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
    expect(() => validateAppSyntheticBinding({ ...envelope, provider_expires_at: "2026-08-23T12:30:00Z" }, expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
    expect(() => validateAppSyntheticBinding({ ...envelope, provider_expires_at: "2026-08-23T12:31:00.000Z" }, expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
    expect(() => validateAppSyntheticBinding({ ...envelope, token: "must-not-be-accepted" }, expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
  });

  it("attests the exact V-D02 context binding and rejects partial, foreign, or epoch-zero ownership", () => {
    const run = testRun({ scenarioId: "V-D02" });
    const browserContextBinding = {
      voice_lab_run_id_sha256: sha256(run.id),
      browser_worker_id_sha256: sha256("worker-d02"),
      browser_lease_epoch: 3,
      browser_context_id_sha256: sha256("context-d02"),
    };
    const d02Expected = {
      testRunId: run.testRunId,
      cleanupObligationId: run.cleanupObligationId,
      principalId: run.principalId,
      scenarioId: run.scenarioId,
      scenarioVersion: run.scenarioVersion,
      environment: run.environment,
      retentionHours: run.capturePolicy.retentionHours,
      providerExpiresAt: run.expiresAt.toISOString(),
      browserContextBinding,
    };
    const d02Envelope = {
      synthetic: true,
      principal_id: run.principalId,
      test_run_id: run.testRunId,
      cleanup_obligation_id: run.cleanupObligationId,
      scenario_id: run.scenarioId,
      scenario_version: run.scenarioVersion,
      environment: run.environment,
      retention_hours: run.capturePolicy.retentionHours,
      provider_expires_at: run.expiresAt.toISOString(),
      ...browserContextBinding,
    };

    expect(validateD02BrowserContextBinding(run, browserContextBinding)).toEqual(browserContextBinding);
    expect(validateAppSyntheticBinding(d02Envelope, d02Expected)).toMatchObject(browserContextBinding);
    expect(() => validateD02BrowserContextBinding(run, { ...browserContextBinding, browser_lease_epoch: 0 })).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "BROWSER_CONTEXT_BINDING_MISMATCH" }) }));
    expect(() => validateD02BrowserContextBinding(testRun({ scenarioId: "V-A01" }), browserContextBinding)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "BROWSER_CONTEXT_BINDING_MISMATCH" }) }));
    expect(() => validateAppSyntheticBinding({ ...d02Envelope, browser_context_id_sha256: undefined }, d02Expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
    expect(() => validateAppSyntheticBinding({ ...d02Envelope, browser_context_id_sha256: sha256("foreign-context") }, d02Expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
    expect(() => validateAppSyntheticBinding({ ...d02Envelope, browser_lease_epoch: 0 }, d02Expected)).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "PRODUCT_RUN_BINDING_MISMATCH" }) }));
  });
});

describe("browser context closure proof", () => {
  it("requires both close resolution and absence from the browser registry", async () => {
    const resolved: any = { close: async () => undefined };
    expect(await closeContextWithProof(resolved, () => [])).toEqual({ closed: true, errorClass: null });
    expect(await closeContextWithProof(resolved, () => [resolved])).toEqual({ closed: false, errorClass: "BrowserRegistryStillOwnsContext" });
    const rejected: any = { close: async () => { throw new Error("refused"); } };
    expect(await closeContextWithProof(rejected, () => [])).toEqual({ closed: false, errorClass: "Error" });
  });
});

describe("ordinary dashboard consent route", () => {
  it("projects only a bounded signature from client page errors", () => {
    const error = Object.assign(
      new TypeError("Cannot read properties of undefined (reading 'profile')"),
      { digest: "nextDigest_123" },
    );
    error.stack = "TypeError: hidden input must not escape\n    at https://www.sophia-ei.com/_next/static/chunks/app-page.abc123.js:12:34?token=secret";

    expect(classifyClientPageError(error)).toEqual({
      error_class: "TypeError",
      safe_signature: "undefined_property:profile",
      next_chunk: "app-page.abc123.js",
      next_frames: [{ chunk: "app-page.abc123.js", line: 12, column: 34 }],
      digest: "nextDigest_123",
    });
    expect(JSON.stringify(classifyClientPageError(error))).not.toContain("hidden input");
    expect(JSON.stringify(classifyClientPageError(error))).not.toContain("token");
  });

  it("hashes unclassified client page error text", () => {
    const diagnostic = classifyClientPageError(new Error("user-controlled detail"));
    expect(diagnostic.error_class).toBe("Error");
    expect(diagnostic.safe_signature).toMatch(/^unclassified_sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(diagnostic)).not.toContain("user-controlled detail");
  });

  it("classifies a bounded non-function identifier without exposing other text", () => {
    expect(classifyClientPageError(new TypeError("a is not a function"))).toMatchObject({
      error_class: "TypeError",
      safe_signature: "identifier_not_function:a",
    });
    expect(classifyClientPageError(new TypeError("private value is not a function")).safe_signature)
      .toMatch(/^unclassified_sha256:[a-f0-9]{64}$/);
  });

  it("projects a Next console location without its URL", () => {
    expect(classifyClientConsoleErrorLocation({
      url: "https://www.sophia-ei.com/_next/static/chunks/app-page.abc123.js?token=secret",
      lineNumber: 0,
      columnNumber: 48123,
    }, "https://www.sophia-ei.com")).toEqual({ chunk: "app-page.abc123.js", line: 1, column: 48124 });
    expect(classifyClientConsoleErrorLocation({
      url: "https://example.com/not-a-next-chunk.js",
      lineNumber: 0,
      columnNumber: 1,
    }, "https://www.sophia-ei.com")).toBeNull();
  });
  it("hashes browser start causes instead of projecting request headers", () => {
    const diagnostic = classifyBrowserStartCause(new Error("X-Sophia-Voice-Lab-Capability: signed-secret"));
    expect(diagnostic.error_class).toBe("Error");
    expect(diagnostic.safe_signature).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(diagnostic)).not.toContain("signed-secret");
  });

});

describe("D02 product provider-cleanup acknowledgement", () => {
  const sessionId = "provider-session-d02";
  const close = (epoch: number) => ({
    schema: "sophia_gemini_browser_provider_close_v1",
    receipt_id: `00000000-0000-4000-8000-${String(epoch).padStart(12, "0")}`,
    session_id: sessionId,
    provider_connection_epoch: epoch,
    websocket_close_observed: true,
    websocket_close_code: 1000,
    websocket_closed_at: `2026-08-23T12:30:0${epoch}.000Z`,
  });

  it("accepts only the canonical echo whose close/abort union exactly equals the freeze", () => {
    const echo = {
      browser_provider_close_receipts: [close(1)],
      browser_provider_activation_abort_receipts: [{
        schema: "sophia_gemini_browser_provider_activation_abort_v1",
        receipt_id: "00000000-0000-4000-8000-000000000002",
        session_id: sessionId,
        previous_activated_epoch: 1,
        candidate_epoch: 2,
        websocket_created: false,
        aborted_at: "2026-08-23T12:30:02.000Z",
      }],
    };
    expect(validateD02ProductCleanupEcho(echo, sessionId, [1, 2])).toEqual(echo);
    expect(() => validateD02ProductCleanupEcho(echo, sessionId, [1])).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "D02_PRODUCT_CLEANUP_EPOCH_DRIFT" }) }));
    expect(() => validateD02ProductCleanupEcho({ ...echo, browser_provider_close_receipts: [{ ...close(1), session_id: "foreign" }] }, sessionId, [1, 2])).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "D02_PRODUCT_CLEANUP_ACK_INVALID" }) }));
    expect(() => validateD02ProductCleanupEcho({ ...echo, invented_success: true }, sessionId, [1, 2])).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "D02_PRODUCT_CLEANUP_ACK_INVALID" }) }));
  });
});

describe("privileged browser boundary", () => {
  it("binds pre-resource and final driver verification to the exact LangGraph dependency", async () => {
    let langgraphSha = SHA_D;
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const commitSha = url.pathname === "/api/app-version" ? SHA
        : url.origin === "http://gateway.test" ? SHA_B
          : url.origin === "http://voice.test" ? SHA_C
            : langgraphSha;
      return new Response(JSON.stringify(url.pathname === "/api/app-version" ? { build_id: commitSha } : { commit_sha: commitSha }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const driver = new PlaywrightVoiceDriver(testConfig(), fetchImpl as typeof fetch);
    const run = testRun();

    const verified = await driver.verifyTarget(run);
    expect(verified.observedDeployment).toEqual({ frontend: SHA, backend: SHA_B, voice: SHA_C });
    expect(verified.events).toContainEqual(expect.objectContaining({
      kind: "deployment.verified",
      payload: expect.objectContaining({ langgraph: expect.objectContaining({ commit_sha: SHA_D }) }),
    }));

    langgraphSha = SHA;
    await expect(driver.verifyTarget(run)).rejects.toMatchObject({
      detail: expect.objectContaining({ code: "DEPLOYMENT_MISMATCH", details: expect.objectContaining({ component: "langgraph", expected: SHA_D, observed: SHA }) }),
    });
  });

  it("probes the governed Better Auth session route after the grant cookie jar is established", async () => {
    const config = testConfig();
    expect(config.authSessionPath).toBe("/api/auth/get-session");
    const cookies = new Set<string>();
    const calls: string[] = [];
    const request = {
      post: async (url: string) => {
        calls.push(new URL(url).pathname);
        cookies.add("__Host-sophia-voice-lab-context");
        cookies.add("__Host-sophia-voice-lab-run-binding");
        return { url: () => url, status: () => 200, ok: () => true, headers: () => ({ "content-type": "application/json" }), json: async () => ({ ok: true }) };
      },
      get: async (url: string) => {
        calls.push(new URL(url).pathname);
        if (!cookies.has("__Host-sophia-voice-lab-context") || !cookies.has("__Host-sophia-voice-lab-run-binding")) throw new Error("grant cookies missing");
        return { url: () => url, status: () => 200, ok: () => true, headers: () => ({ "content-type": "application/json" }), json: async () => ({ user: { id: "voice-lab-user-1" } }) };
      },
    } as any;

    await requestBoundJson(request, "POST", "https://www.sophia-ei.com/api/voice-lab/auth/grant", 1_000, "signed-capability");
    const { response, payload } = await requestBoundJson(request, "GET", `https://www.sophia-ei.com${config.authSessionPath}`, 1_000);

    expect(response.ok()).toBe(true);
    expect(payload?.user).toMatchObject({ id: "voice-lab-user-1" });
    expect(calls).toEqual(["/api/voice-lab/auth/grant", "/api/auth/get-session"]);
  });

  it("never follows a capability-bearing redirect and never trusts a changed response path", async () => {
    const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
    const redirecting = {
      post: async (url: string, options: Record<string, unknown>) => {
        calls.push({ url, options });
        return { url: () => url, status: () => 302, ok: () => false, headers: () => ({ location: "https://attacker.invalid/steal" }), json: async () => ({}) };
      },
      get: async () => { throw new Error("unexpected GET"); },
    } as any;
    await expect(requestBoundJson(redirecting, "POST", "https://www.sophia-ei.com/api/voice-lab/auth/grant", 1_000, "signed-capability")).rejects.toMatchObject({ detail: { code: "PRIVILEGED_REDIRECT_REJECTED" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ maxRedirects: 0, headers: { "X-Sophia-Voice-Lab-Capability": "signed-capability" } });

    const wrongPath = {
      post: async () => ({ url: () => "https://www.sophia-ei.com/api/wrong", status: () => 200, ok: () => true, headers: () => ({ "content-type": "application/json" }), json: async () => ({ ok: true }) }),
      get: async () => { throw new Error("unexpected GET"); },
    } as any;
    await expect(requestBoundJson(wrongPath, "POST", "https://www.sophia-ei.com/api/voice-lab/auth/grant", 1_000, "signed-capability")).rejects.toMatchObject({ detail: { code: "PRIVILEGED_RESPONSE_TARGET_MISMATCH" } });
  });

  it("retries one transient grant response with the exact same capability", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const request = {
      post: async (url: string, options: Record<string, unknown>) => {
        calls.push(options);
        const status = calls.length === 1 ? 503 : 200;
        return { url: () => url, status: () => status, ok: () => status === 200, headers: () => ({ "content-type": "application/json" }), json: async () => ({ ok: status === 200 }) };
      },
      get: async () => { throw new Error("unexpected GET"); },
    } as any;
    const { response } = await requestBoundJsonWithOneTransientRetry(request, "POST", "https://www.sophia-ei.com/api/voice-lab/auth/grant", 1_000, "signed-capability", 0);
    expect(response.status()).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ headers: { "X-Sophia-Voice-Lab-Capability": "signed-capability" } });
    expect(calls[1]).toEqual(calls[0]);
  });

  it("binds navigation and product finalization to exact frontend routes", () => {
    expect(() => assertPageLocation("https://www.sophia-ei.com/session", "https://www.sophia-ei.com", (path) => path === "/session", "ROUTE_DRIFT")).not.toThrow();
    expect(() => assertPageLocation("https://evil.invalid/session", "https://www.sophia-ei.com", (path) => path === "/session", "ROUTE_DRIFT")).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: "ROUTE_DRIFT" }) }));
    const response = (url: string, method = "POST") => ({ url: () => url, request: () => ({ method: () => method }) }) as any;
    expect(isExactFinalizationResponse(response("https://www.sophia-ei.com/api/sophia/end-session"), "https://www.sophia-ei.com")).toBe(true);
    expect(isExactFinalizationResponse(response("https://www.sophia-ei.com/api/sessions/end"), "https://www.sophia-ei.com")).toBe(true);
    expect(isExactFinalizationResponse(response("https://evil.invalid/api/sophia/end-session"), "https://www.sophia-ei.com")).toBe(false);
    expect(isExactFinalizationResponse(response("https://www.sophia-ei.com/api/sophia/end-session?redirect=1"), "https://www.sophia-ei.com")).toBe(false);
    expect(isExactFinalizationResponse(response("https://www.sophia-ei.com/api/sophia/end-session", "GET"), "https://www.sophia-ei.com")).toBe(false);
  });

  it("caches a bounded Chromium launch failure instead of probing every heartbeat", async () => {
    let launches = 0;
    const driver = new PlaywrightVoiceDriver({} as any, fetch, async () => { launches += 1; throw new Error("missing-libraries"); }, async () => undefined);
    const first = await driver.readiness();
    const second = await driver.readiness();
    expect(first.ok).toBe(false);
    expect(first.detail).toContain("chromium-readiness-failed");
    expect(second).toEqual(first);
    expect(launches).toBe(1);
  });
});

describe("out-of-band recovery retention contract", () => {
  const builder = { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 2 };
  const base = {
    ok: true,
    complete: true,
    live_cleanup_complete: true,
    live_resources_zero: true,
    recovery_id: "recovery-1",
    attempt_id: "attempt-1",
    recovered_at: "2026-08-23T17:00:00.000Z",
    components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" }, builder, auth_sessions: { status: "completed" } },
    receipt: { storage: "postgres", object_path: "voice-lab/recovery.json", sha256: "a".repeat(64) },
  };

  it("accepts live cleanup while retaining a separately scheduled purge obligation", async () => {
    const run = testRun();
    const payload = { ...base, test_run_id: run.testRunId, cleanup_obligation_id: run.cleanupObligationId, status: "live_cleanup_completed_retention_pending", retention_maintenance_complete: false, retention_purge_pending: true, retention_purged: false, retention_purge_due_at: "2026-08-24T17:00:00.000Z", components: { ...base.components, canonical_evidence: { status: "retention_pending", retention_expires_at: "2026-08-24T17:00:00.000Z" } } };
    const driver = new PlaywrightVoiceDriver(testConfig(), async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await driver.recover(run, "signed-recovery-capability");
    expect(result.events[0]?.payload).toMatchObject({ complete: true, live_cleanup_complete: true, retention_purge_pending: true, retention_purged: false, retention_purge_due_at: "2026-08-24T17:00:00.000Z" });
    expect(JSON.stringify(result.events[0]?.payload)).not.toContain(run.cleanupObligationId);
    expect(result.events[0]?.payload).toMatchObject({ receipt: { cleanup_obligation_id_sha256: sha256(run.cleanupObligationId) } });
  });

  it("accepts allocation-free live cleanup before a retention deadline exists", async () => {
    const run = testRun();
    const payload = {
      ...base,
      test_run_id: run.testRunId,
      cleanup_obligation_id: run.cleanupObligationId,
      status: "live_cleanup_completed_retention_unsettled",
      retention_maintenance_complete: false,
      retention_purge_pending: true,
      retention_purged: false,
      retention_purge_due_at: null,
      components: {
        ...base.components,
        canonical_evidence: { status: "not_found" },
      },
    };
    const driver = new PlaywrightVoiceDriver(testConfig(), async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await driver.recover(run, "signed-recovery-capability");
    expect(result.events[0]).toMatchObject({
      payload: {
        complete: true,
        live_cleanup_complete: true,
        retention_purge_pending: false,
        retention_purged: false,
        retention_purge_due_at: null,
      },
    });
    expect(result.events[0]?.dedupeKey).toMatch(new RegExp(`^recovery:${run.id}:live-complete-retention-unsettled:[a-f0-9]{64}$`));
  });

  it("dedupes exact recovery replays but preserves distinct pending attempt receipts", async () => {
    const run = testRun();
    const pending = (attemptId: string) => ({
      ok: true,
      complete: false,
      live_cleanup_complete: false,
      live_resources_zero: false,
      test_run_id: run.testRunId,
      cleanup_obligation_id: run.cleanupObligationId,
      recovery_id: "recovery-pending",
      attempt_id: attemptId,
      retention_maintenance_complete: false,
      retention_purge_pending: true,
      retention_purged: false,
      components: {
        canonical_session: { status: "pending" },
        voice_provider: { status: "pending" },
        builder: { status: "pending" },
        auth_sessions: { status: "pending" },
      },
      receipt: { storage: "postgres", object_path: `voice-lab/${attemptId}.json`, sha256: sha256(attemptId) },
    });
    let responsePayload = pending("attempt-1");
    const driver = new PlaywrightVoiceDriver(testConfig(), async () => new Response(JSON.stringify(responsePayload), { status: 202, headers: { "content-type": "application/json" } }));

    const first = await driver.recover(run, "signed-recovery-capability");
    const replay = await driver.recover(run, "signed-recovery-capability");
    responsePayload = pending("attempt-2");
    const second = await driver.recover(run, "signed-recovery-capability");

    expect(replay.events[0]?.dedupeKey).toBe(first.events[0]?.dedupeKey);
    expect(second.events[0]?.dedupeKey).not.toBe(first.events[0]?.dedupeKey);
    expect(second.events[0]?.dedupeKey).toMatch(new RegExp(`^recovery:${run.id}:pending:[a-f0-9]{64}$`));
  });

  it("distinguishes final retention purge from live cleanup", async () => {
    const run = testRun();
    const payload = { ...base, test_run_id: run.testRunId, cleanup_obligation_id: run.cleanupObligationId, status: "completed", retention_maintenance_complete: true, retention_purge_pending: false, retention_purged: true, retention_purge_due_at: "2026-08-24T17:00:00.000Z", components: { ...base.components, canonical_evidence: { status: "completed" } } };
    const driver = new PlaywrightVoiceDriver(testConfig(), async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await driver.recover(run, "signed-recovery-capability");
    expect(result.events[0]?.payload).toMatchObject({ complete: true, retention_purge_pending: false, retention_purged: true });
  });

  it("never accepts a missing or cross-run cleanup obligation as recovery proof", async () => {
    const run = testRun();
    for (const cleanupObligationId of [undefined, "00000000-0000-4000-8000-000000000003"]) {
      const payload = { ...base, test_run_id: run.testRunId, ...(cleanupObligationId === undefined ? {} : { cleanup_obligation_id: cleanupObligationId }), status: "completed", retention_maintenance_complete: true, retention_purge_pending: false, retention_purged: true, retention_purge_due_at: "2026-08-24T17:00:00.000Z", components: { ...base.components, canonical_evidence: { status: "completed" } } };
      const driver = new PlaywrightVoiceDriver(testConfig(), async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }));
      const result = await driver.recover(run, "signed-recovery-capability");
      expect(result.events[0]?.payload).toMatchObject({ complete: false, pending: false });
    }
  });
});
