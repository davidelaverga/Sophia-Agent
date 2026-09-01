import { describe, expect, it } from "vitest";

import { activateVoiceStartWithClientErrorReload, assertPageLocation, captureSessionRecoveryStorageState, classifyBrowserStartCause, classifyClientCdpExceptionFrames, classifyClientCdpPausedFrames, classifyClientConsoleErrorLocation, classifyClientPageError, closeContextWithProof, DASHBOARD_ROUTE_TIMEOUT_MS, drainProductCapture, establishDashboardMicRoute, establishSessionNavigation, extractNextChunkScriptUrls, findPassiveEffectCreateBreakpoint, findPassiveEffectCreateCatchBreakpoint, findPassiveEffectDestroyBreakpoint, isExactFinalizationResponse, isRecoverableEmptySessionVoiceRoute, openFreshExactSessionContext, passiveEffectBreakpointCondition, PlaywrightVoiceDriver, RECOVERABLE_DASHBOARD_LOAD_ERROR, RECOVERABLE_DASHBOARD_RELOAD_BUTTON, requestBoundJson, requestBoundJsonWithOneTransientRetry, selectRecentClientEffectProbe, selectRecentClientPausedFrames, SESSION_NAVIGATION_ROUTE_TIMEOUT_MS, SESSION_NAVIGATION_SETTLE_TIMEOUT_MS, SESSION_RECOVERY_STORAGE_CAPTURE_TIMEOUT_MS, SESSION_ROUTE_RECOVERY_RELOAD_TIMEOUT_MS, SESSION_VOICE_INITIAL_START_TIMEOUT_MS, SESSION_VOICE_INITIAL_TAB_TIMEOUT_MS, SESSION_VOICE_RECOVERY_START_TIMEOUT_MS, SESSION_VOICE_RECOVERY_TAB_TIMEOUT_MS, shouldCaptureSessionVoiceRoute, shouldReleasePassiveEffectBreakpoint, validateAppSyntheticBinding, validateD02BrowserContextBinding, validateD02ProductCleanupEcho, waitForClientPageError, waitOnWorkerClock, withClientDiagnosticFrames, withClientEffectProbe } from "../src/browser-driver.js";
import { sha256 } from "../src/security.js";
import { SHA, SHA_B, SHA_C, SHA_D, testConfig, testRun } from "./helpers.js";

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

  it("accepts an exact session route that commits at the polling deadline", async () => {
    let currentUrl = "https://www.sophia-ei.com/";
    const emptyButtons = {
      count: async () => 0,
      nth: () => { throw new Error("no button expected"); },
    };
    const page = {
      url: () => currentUrl,
      getByRole: () => emptyButtons,
      waitForTimeout: async () => undefined,
      waitForURL: async (predicate: (url: URL) => boolean, options: { timeout: number; waitUntil: string }) => {
        expect(options.timeout).toBe(SESSION_NAVIGATION_SETTLE_TIMEOUT_MS);
        expect(options.waitUntil).toBe("commit");
        currentUrl = "https://www.sophia-ei.com/session";
        expect(predicate(new URL(currentUrl))).toBe(true);
        expect(predicate(new URL("https://evil.invalid/session"))).toBe(false);
        expect(predicate(new URL("https://www.sophia-ei.com/session#stale"))).toBe(false);
      },
    };

    await establishSessionNavigation(page as any, "https://www.sophia-ei.com", "Start fresh", 0);
    expect(SESSION_NAVIGATION_ROUTE_TIMEOUT_MS).toBe(75_000);
    expect(SESSION_NAVIGATION_SETTLE_TIMEOUT_MS).toBe(15_000);
  });

  it("returns immediately when the exact route is already committed at the deadline", async () => {
    let waitForUrlCalled = false;
    const page = {
      url: () => "https://www.sophia-ei.com/session",
      getByRole: () => ({ count: async () => 0 }),
      waitForTimeout: async () => undefined,
      waitForURL: async () => { waitForUrlCalled = true; },
    };

    await establishSessionNavigation(page as any, "https://www.sophia-ei.com", "Start fresh", 0);
    expect(waitForUrlCalled).toBe(false);
  });

  it("can rehydrate an exact session route after a client-error navigation timeout", async () => {
    let currentUrl = "https://www.sophia-ei.com/";
    let attempts = 0;
    let reloads = 0;
    const emptyButtons = { count: async () => 0 };
    const page = {
      url: () => currentUrl,
      getByRole: () => emptyButtons,
      waitForTimeout: async () => undefined,
      waitForURL: async () => {
        attempts += 1;
        currentUrl = "https://www.sophia-ei.com/session";
        throw Object.assign(new Error("hidden browser detail"), { name: "TimeoutError" });
      },
    };

    await expect(activateVoiceStartWithClientErrorReload({
      activate: () => establishSessionNavigation(page as any, "https://www.sophia-ei.com", "Start fresh", 0),
      hasClientPageError: async () => true,
      reload: async () => { reloads += 1; },
    })).resolves.toBe("reloaded_after_client_error");
    expect(attempts).toBe(1);
    expect(reloads).toBe(1);
  });
});

describe("ordinary voice start recovery", () => {
  it("refreshes recovery storage with the session persisted before route commit", async () => {
    const authenticated = { cookies: [{ name: "auth" }], origins: [] };
    const withSession = {
      cookies: [{ name: "auth" }],
      origins: [{ origin: "https://www.sophia-ei.com", localStorage: [{ name: "sophia-session-store", value: "persisted-session" }] }],
    };
    const context = { storageState: async () => withSession };

    await expect(captureSessionRecoveryStorageState(context as any, authenticated, 100))
      .resolves.toEqual(withSession);
    expect(SESSION_RECOVERY_STORAGE_CAPTURE_TIMEOUT_MS).toBe(2_500);
  });

  it("retains authenticated recovery storage when the post-commit snapshot exceeds its worker budget", async () => {
    const authenticated = { cookies: [{ name: "auth" }], origins: [] };
    const context = { storageState: () => new Promise(() => undefined) };

    await expect(captureSessionRecoveryStorageState(context as any, authenticated, 10))
      .resolves.toBe(authenticated);
  });

  it("rehydrates the exact session URL in a fresh isolated context with the same authenticated state", async () => {
    const calls: string[] = [];
    const currentPage = {
      url: () => "https://www.sophia-ei.com/session",
    };
    const replacementPage = {
      url: () => "https://www.sophia-ei.com/session",
      goto: async (url: string, options: unknown) => { calls.push(`goto:${url}:${JSON.stringify(options)}`); },
    };
    const currentContext = {
      close: async () => { calls.push("close-current-context"); },
    };
    const replacementContext = {
      addInitScript: async () => { calls.push("add-init"); },
      newPage: async () => { calls.push("new-page"); return replacementPage; },
      close: async () => { calls.push("close-replacement-context"); },
    };
    const browser = {
      newContext: async (options: unknown) => { calls.push(`new-context:${JSON.stringify(options)}`); return replacementContext; },
    };

    await expect(openFreshExactSessionContext({
      browser: browser as any,
      currentContext: currentContext as any,
      currentPage: currentPage as any,
      storageState: { cookies: [], origins: [] },
      initScriptContent: "sealed-init",
      frontendOrigin: "https://www.sophia-ei.com",
      attachDiagnostics: (page) => { expect(page).toBe(replacementPage); calls.push("attach"); },
    })).resolves.toEqual({ context: replacementContext, page: replacementPage });
    expect(calls).toEqual([
      `new-context:${JSON.stringify({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block" })}`,
      "add-init",
      "new-page",
      "attach",
      `goto:https://www.sophia-ei.com/session:${JSON.stringify({ waitUntil: "domcontentloaded", timeout: SESSION_ROUTE_RECOVERY_RELOAD_TIMEOUT_MS })}`,
      "close-current-context",
    ]);
  });

  it("reserves enough of the operation watchdog for one bounded reload and recovery attempt", () => {
    expect(SESSION_VOICE_INITIAL_TAB_TIMEOUT_MS).toBe(5_000);
    expect(SESSION_VOICE_INITIAL_START_TIMEOUT_MS).toBe(10_000);
    expect(SESSION_ROUTE_RECOVERY_RELOAD_TIMEOUT_MS).toBe(15_000);
    expect(SESSION_VOICE_RECOVERY_TAB_TIMEOUT_MS).toBe(10_000);
    expect(SESSION_VOICE_RECOVERY_START_TIMEOUT_MS).toBe(15_000);
    expect(
      SESSION_VOICE_INITIAL_TAB_TIMEOUT_MS
      + SESSION_VOICE_INITIAL_START_TIMEOUT_MS
      + SESSION_ROUTE_RECOVERY_RELOAD_TIMEOUT_MS
      + SESSION_VOICE_RECOVERY_TAB_TIMEOUT_MS
      + SESSION_VOICE_RECOVERY_START_TIMEOUT_MS,
    ).toBe(55_000);
  });

  it("uses a worker-owned clock that does not depend on a page", async () => {
    const started = Date.now();
    await expect(waitOnWorkerClock(10)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });

  it("settles a causally preceding page error within one bounded diagnostic window", async () => {
    let clock = 0;
    let probes = 0;
    await expect(waitForClientPageError({
      probe: () => ++probes === 3,
      wait: async () => { clock += 25; },
      timeoutMs: 100,
      now: () => clock,
    })).resolves.toBe(true);
    expect(probes).toBe(3);
  });

  it("returns false when the bounded diagnostic window expires", async () => {
    let clock = 0;
    await expect(waitForClientPageError({
      probe: () => false,
      wait: async () => { clock += 25; },
      timeoutMs: 50,
      now: () => clock,
    })).resolves.toBe(false);
    expect(clock).toBe(50);
  });

  it("reloads the exact session route once after a start-button timeout with a captured client error", async () => {
    const calls: string[] = [];
    const timeout = Object.assign(new Error("hidden browser detail"), { name: "TimeoutError" });
    let activation = 0;

    const result = await activateVoiceStartWithClientErrorReload({
      activate: async () => {
        calls.push("activate");
        activation += 1;
        if (activation === 1) throw timeout;
      },
      hasClientPageError: () => true,
      reload: async () => { calls.push("reload"); },
    });

    expect(result).toBe("reloaded_after_client_error");
    expect(calls).toEqual(["activate", "reload", "activate"]);
  });

  it("accepts Playwright timeout-shaped values without relying on a JavaScript realm", async () => {
    const timeout = { name: "TimeoutError" };
    let activation = 0;
    let reloads = 0;
    await expect(activateVoiceStartWithClientErrorReload({
      activate: async () => {
        activation += 1;
        if (activation === 1) throw timeout;
      },
      hasClientPageError: async () => true,
      reload: async () => { reloads += 1; },
    })).resolves.toBe("reloaded_after_client_error");
    expect(reloads).toBe(1);
  });

  it("does not reload a timeout without a captured client page error", async () => {
    const timeout = Object.assign(new Error("hidden browser detail"), { name: "TimeoutError" });
    let reloads = 0;

    await expect(activateVoiceStartWithClientErrorReload({
      activate: async () => { throw timeout; },
      hasClientPageError: () => false,
      reload: async () => { reloads += 1; },
    })).rejects.toBe(timeout);
    expect(reloads).toBe(0);
  });

  it("reloads once for the exact empty session shell after the bounded startup timeout", async () => {
    const timeout = Object.assign(new Error("hidden browser detail"), { name: "TimeoutError" });
    let activation = 0;
    let reloads = 0;
    const route = {
      location: "expected_session",
      voice_tab: "absent",
      voice_button: "absent",
      dashboard_mic_visible: false,
      dashboard_mic_button: "absent",
      consent_visible: false,
      auth_gate_visible: false,
      auth_checking_visible: false,
      session_store_loading_visible: false,
      voice_fallback_visible: false,
    } as const;

    expect(isRecoverableEmptySessionVoiceRoute(route)).toBe(true);
    await expect(activateVoiceStartWithClientErrorReload({
      activate: async () => {
        activation += 1;
        if (activation === 1) throw timeout;
      },
      hasClientPageError: () => false,
      hasRecoverableExactSessionShell: () => isRecoverableEmptySessionVoiceRoute(route),
      reload: async () => { reloads += 1; },
    })).resolves.toBe("reloaded_after_exact_session_shell");
    expect(reloads).toBe(1);
  });

  it("rejects lookalike session states that still expose a loading or auth gate", () => {
    const base = {
      location: "expected_session",
      voice_tab: "absent",
      voice_button: "absent",
      dashboard_mic_visible: false,
      dashboard_mic_button: "absent",
      consent_visible: false,
      auth_gate_visible: false,
      auth_checking_visible: false,
      session_store_loading_visible: false,
      voice_fallback_visible: false,
    } as const;
    expect(isRecoverableEmptySessionVoiceRoute({ ...base, session_store_loading_visible: true })).toBe(false);
    expect(isRecoverableEmptySessionVoiceRoute({ ...base, auth_gate_visible: true })).toBe(false);
    expect(isRecoverableEmptySessionVoiceRoute({ ...base, location: "same_origin_other" })).toBe(false);
  });

  it("never loops when the reloaded route still cannot render the control", async () => {
    const timeout = Object.assign(new Error("hidden browser detail"), { name: "TimeoutError" });
    let reloads = 0;

    await expect(activateVoiceStartWithClientErrorReload({
      activate: async () => { throw timeout; },
      hasClientPageError: () => true,
      reload: async () => { reloads += 1; },
    })).rejects.toBe(timeout);
    expect(reloads).toBe(1);
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

  it("projects up to five same-origin Next frames from Chromium exception details", () => {
    const diagnostic = classifyClientCdpExceptionFrames({
      text: "Uncaught secret detail",
      url: "https://attacker.example/private.js?token=secret",
      lineNumber: 8,
      columnNumber: 9,
      stackTrace: {
        callFrames: [
          { url: "https://attacker.example/private.js?token=secret", lineNumber: 1, columnNumber: 2 },
          { url: "https://www.sophia-ei.com/_next/static/chunks/dashboard.abc123.js?token=secret", lineNumber: 11, columnNumber: 33 },
          { url: "https://www.sophia-ei.com/_next/static/chunks/app.987xyz.js", lineNumber: 21, columnNumber: 43 },
        ],
      },
    }, "https://www.sophia-ei.com");

    expect(diagnostic).toEqual([
      { chunk: "dashboard.abc123.js", line: 12, column: 34 },
      { chunk: "app.987xyz.js", line: 22, column: 44 },
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    expect(classifyClientCdpExceptionFrames({
      stackTrace: { callFrames: [{ url: "https://attacker.example/_next/static/chunks/evil.js", lineNumber: 0, columnNumber: 0 }] },
    }, "https://www.sophia-ei.com")).toEqual([]);
  });

  it("projects only same-origin Next throw-site frames from Chromium debugger pauses", () => {
    const diagnostic = classifyClientCdpPausedFrames({
      reason: "exception",
      data: { description: "secret exception text" },
      callFrames: [
        { url: "https://www.sophia-ei.com/_next/static/chunks/app-page.abc123.js?token=secret", location: { lineNumber: 4, columnNumber: 18 } },
        { url: "https://attacker.example/_next/static/chunks/evil.js", location: { lineNumber: 8, columnNumber: 9 } },
        { url: "https://www.sophia-ei.com/_next/static/chunks/react.987xyz.js", location: { lineNumber: 10, columnNumber: 20 } },
      ],
    }, "https://www.sophia-ei.com");

    expect(diagnostic).toEqual([
      { chunk: "app-page.abc123.js", line: 5, column: 19 },
      { chunk: "react.987xyz.js", line: 11, column: 21 },
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    expect(JSON.stringify(diagnostic)).not.toContain("attacker");
  });

  it("keeps the application throw when a later React rethrow shares the pageerror window", () => {
    expect(selectRecentClientPausedFrames([
      { observedAt: 1_000, frames: [{ chunk: "stale.js", line: 1, column: 1 }] },
      { observedAt: 9_100, frames: [
        { chunk: "app-page.js", line: 1, column: 77 },
        { chunk: "react.js", line: 1, column: 100 },
      ] },
      { observedAt: 9_200, frames: [
        { chunk: "react.js", line: 1, column: 200 },
        { chunk: "react.js", line: 1, column: 220 },
      ] },
    ], 9_250)).toEqual([
      { chunk: "react.js", line: 1, column: 200 },
      { chunk: "app-page.js", line: 1, column: 77 },
      { chunk: "react.js", line: 1, column: 220 },
      { chunk: "react.js", line: 1, column: 100 },
    ]);
  });

  it("prefers correlated paused throw sites over an existing React-only pageerror stack", () => {
    const diagnostic = classifyClientPageError(Object.assign(new TypeError("opaque product failure"), {
      stack: "TypeError: opaque product failure\n    at react (https://www.sophia-ei.com/_next/static/chunks/react.js:1:100)",
    }));
    const enriched = withClientDiagnosticFrames(diagnostic, [
      { chunk: "app-page.js", line: 1, column: 77 },
      { chunk: "react.js", line: 1, column: 200 },
    ], true);

    expect(enriched).toMatchObject({
      next_chunk: "app-page.js",
      next_frames: [
        { chunk: "app-page.js", line: 1, column: 77 },
        { chunk: "react.js", line: 1, column: 200 },
        { chunk: "react.js", line: 1, column: 100 },
      ],
    });
    expect(JSON.stringify(enriched)).not.toContain("opaque product failure");
  });

  it("attaches only the bounded correlated React effect probe", () => {
    const diagnostic = classifyClientPageError(new TypeError("opaque product failure"));
    const probe = {
      create_type: "object" as const,
      effect_tag: 9,
      owner_fiber_tag: 0,
      owner_props: "on_ready" as const,
      owner_frame: { chunk: "app-page.js", line: 1, column: 77 },
    };
    expect(selectRecentClientEffectProbe([
      { observedAt: 1_000, frames: [], effectProbe: probe },
      { observedAt: 9_100, frames: [{ chunk: "react.js", line: 1, column: 100 }] },
      { observedAt: 9_200, frames: [{ chunk: "react.js", line: 1, column: 200 }], effectProbe: probe },
    ], 9_250)).toEqual(probe);
    expect(withClientEffectProbe(diagnostic, probe)).toMatchObject({ effect_probe: probe });
    expect(JSON.stringify(withClientEffectProbe(diagnostic, probe))).not.toContain("opaque product failure");
  });

  it("selects by pause time when asynchronous probe evaluations complete out of order", () => {
    const invalidProbe = {
      create_type: "object" as const,
      effect_tag: 9,
      owner_fiber_tag: 0,
      owner_props: "other" as const,
      owner_frame: { chunk: "app-page.js", line: 1, column: 77 },
    };
    const callableProbe = { ...invalidProbe, create_type: "function" as const };
    expect(selectRecentClientEffectProbe([
      { observedAt: 9_240, frames: [], effectProbe: callableProbe },
      { observedAt: 9_100, frames: [], effectProbe: invalidProbe },
      { observedAt: 9_200, frames: [], effectProbe: callableProbe },
    ], 9_250)).toEqual(callableProbe);
  });

  it("finds a minified React passive-effect create call without a build-specific offset", () => {
    expect(findPassiveEffectCreateBreakpoint([
      "function before(e){return e}",
      "function iv(e,t){try{var n=t.updateQueue,r=null!==n?n.lastEffect:null;if(null!==r){var l=r.next;n=l;do{if((n.tag&e)===e){r=void 0;var a=n.create;n.inst.destroy=r=a()}n=n.next}while(n!==l)}}catch(e){throw e}}",
    ].join("\n"))).toEqual({
      probe_kind: "create",
      line_number: 1,
      column_number: 145,
      create_variable: "a",
      effect_variable: "n",
      owner_variable: "t",
    });
    expect(findPassiveEffectCreateBreakpoint("function nope(e,t){return t.create}")).toBeNull();
  });

  it("finds a minified React passive-effect destroy call and conditions on invalid cleanup values", () => {
    const source = "function iy(e,t,n){try{var r=t.updateQueue,l=null!==r?r.lastEffect:null;if(null!==l){var a=l.next;r=a;do{if((r.tag&e)===e){var o=r.inst,i=o.destroy;if(void 0!==i){o.destroy=void 0,l=t;try{i()}catch(e){sN(l,n,e)}}}r=r.next}while(r!==a)}}catch(e){sN(t,t.return,e)}}";
    const breakpoint = findPassiveEffectDestroyBreakpoint(source);
    expect(breakpoint).toMatchObject({
      probe_kind: "destroy",
      line_number: 0,
      instance_variable: "o",
      destroy_variable: "i",
      effect_variable: "r",
      owner_variable: "t",
    });
    expect(breakpoint?.column_number).toBe(source.indexOf("i()}"));
    expect(breakpoint && passiveEffectBreakpointCondition(breakpoint)).toBe('typeof i !== "undefined" && typeof i !== "function"');
  });

  it("finds the passive-effect create catch without pausing successful effects", () => {
    const source = "function iv(e,t){try{var n=t.updateQueue,r=null!==n?n.lastEffect:null;if(null!==r){var l=r.next;n=l;do{if((n.tag&e)===e){r=void 0;var a=n.create;n.inst.destroy=r=a()}n=n.next}while(n!==l)}}catch(e){sN(t,t.return,e)}}";
    const breakpoint = findPassiveEffectCreateCatchBreakpoint(source);
    expect(breakpoint).toEqual({
      probe_kind: "create_catch",
      line_number: 0,
      column_number: source.indexOf("sN(t,t.return,e)"),
      exception_variable: "e",
      effect_variable: "n",
      owner_variable: "t",
    });
    expect(breakpoint && passiveEffectBreakpointCondition(breakpoint)).toBe("true");
  });

  it("keeps the passive-effect breakpoint armed across callable effects", () => {
    expect(shouldReleasePassiveEffectBreakpoint("function")).toBe(false);
    expect(shouldReleasePassiveEffectBreakpoint("undefined")).toBe(true);
    expect(shouldReleasePassiveEffectBreakpoint("object")).toBe(true);
  });

  it("pauses the passive-effect probe only for non-callable creates", () => {
    expect(passiveEffectBreakpointCondition({
      probe_kind: "create",
      line_number: 1,
      column_number: 145,
      create_variable: "a",
      effect_variable: "n",
      owner_variable: "t",
    })).toBe('typeof a !== "function"');
  });

  it("extracts only bounded same-origin Next chunk URLs for pre-navigation breakpoint arming", () => {
    expect(extractNextChunkScriptUrls([
      '<script src="/_next/static/chunks/react.js?dpl=abc"></script>',
      '<script src="https://www.sophia-ei.com/_next/static/chunks/app-page.js"></script>',
      '<script src="https://other.example/_next/static/chunks/foreign.js"></script>',
      '<script src="/ordinary.js"></script>',
      '<script src="/_next/static/chunks/react.js?dpl=abc"></script>',
    ].join(""), "https://www.sophia-ei.com")).toEqual([
      "https://www.sophia-ei.com/_next/static/chunks/react.js?dpl=abc",
      "https://www.sophia-ei.com/_next/static/chunks/app-page.js",
    ]);
  });

  it("hashes browser start causes instead of projecting request headers", () => {
    const diagnostic = classifyBrowserStartCause(new Error("X-Sophia-Voice-Lab-Capability: signed-secret"));
    expect(diagnostic.error_class).toBe("Error");
    expect(diagnostic.safe_signature).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(diagnostic)).not.toContain("signed-secret");
  });

  it("matches the exact production recoverable error heading", () => {
    expect(RECOVERABLE_DASHBOARD_LOAD_ERROR.test("This page couldn't load.")).toBe(true);
    expect(RECOVERABLE_DASHBOARD_LOAD_ERROR.test("This page couldn’t load.")).toBe(true);
    expect(RECOVERABLE_DASHBOARD_LOAD_ERROR.test("This page couldn’t load")).toBe(true);
    expect(RECOVERABLE_DASHBOARD_LOAD_ERROR.test("This page could not load.")).toBe(false);
    expect(RECOVERABLE_DASHBOARD_LOAD_ERROR.test("Another page couldn’t load.")).toBe(false);
    expect(RECOVERABLE_DASHBOARD_RELOAD_BUTTON).toBe("Reload");
  });

  it("accepts through the visible consent UI before requiring the microphone CTA", async () => {
    let now = 0;
    let consentAccepted = false;
    let waits = 0;
    const result = await establishDashboardMicRoute({
      isMicVisible: async () => consentAccepted && waits > 0,
      isConsentVisible: async () => !consentAccepted,
      isConsentEnabled: async () => waits > 0,
      acceptConsent: async () => { consentAccepted = true; },
      wait: async () => { waits += 1; now += 100; },
      timeoutMs: 1_000,
      now: () => now,
    });
    expect(result).toBe("accepted");
    expect(consentAccepted).toBe(true);
  });

  it("does not touch consent when the microphone CTA is already present", async () => {
    let accepted = false;
    const result = await establishDashboardMicRoute({
      isMicVisible: async () => true,
      isConsentVisible: async () => true,
      isConsentEnabled: async () => true,
      acceptConsent: async () => { accepted = true; },
      wait: async () => undefined,
      timeoutMs: 1_000,
    });
    expect(result).toBe("already_consented");
    expect(accepted).toBe(false);
  });

  it("allows bounded cold auth hydration beyond the former 20-second limit", async () => {
    let now = 0;
    let accepted = false;
    const result = await establishDashboardMicRoute({
      isMicVisible: async () => accepted,
      isConsentVisible: async () => now >= 25_000 && !accepted,
      isConsentEnabled: async () => now >= 25_000,
      acceptConsent: async () => { accepted = true; },
      wait: async () => { now += 100; },
      timeoutMs: DASHBOARD_ROUTE_TIMEOUT_MS,
      now: () => now,
    });
    expect(DASHBOARD_ROUTE_TIMEOUT_MS).toBe(60_000);
    expect(now).toBe(25_000);
    expect(result).toBe("accepted");
  });

  it("reloads the exact recoverable Next.js error shell once before continuing", async () => {
    let now = 0;
    let reloads = 0;
    const result = await establishDashboardMicRoute({
      isMicVisible: async () => reloads === 1,
      isConsentVisible: async () => false,
      isConsentEnabled: async () => false,
      acceptConsent: async () => undefined,
      isRecoverableLoadErrorVisible: async () => reloads === 0,
      reload: async () => { reloads += 1; },
      wait: async () => { now += 100; },
      timeoutMs: 1_000,
      now: () => now,
    });
    expect(result).toBe("already_consented");
    expect(reloads).toBe(1);
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
