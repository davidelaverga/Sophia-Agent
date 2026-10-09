import { createHash } from "node:crypto";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { buildVoiceLabInitScript } from "../src/browser-init.js";
import { VoiceLabError } from "../src/domain.js";
import { SCENARIO_IDS } from "../src/scenarios.js";
import {
  COVERAGE_STATUSES,
  STUDIO_G7_CONTRACT_DIFFERENCES,
  STUDIO_G7_RECEIPT_COVERAGE,
  StudioContractViolation,
  canonicalRunBindingJson,
  computeRunBindingSha256,
  parseBridgeReceipt,
  parsePageReceipt,
  parseQualificationEvidence,
} from "../src/studio-g7/contract.js";
import { projectStudioG7Config } from "../src/studio-g7/config.js";
import { STUDIO_G7_CATALOG, scenarioSupportForTarget } from "../src/studio-g7/scenarios.js";
import { buildStudioSessionSeedScript, globalSignOut, passwordGrant, supabaseStorageKey } from "../src/studio-g7/supabase-session.js";
import { parseStudioBuildMeta, projectRoomSnapshot } from "../src/studio-g7/studio-api.js";
import {
  EXCHANGE_UUID, FAKE_ACCESS_TOKEN, FAKE_EMAIL, FAKE_PASSWORD, FAKE_PUBLISHABLE_KEY, FAKE_REFRESH_TOKEN, PRINCIPAL_UUID,
  GRANT_UUID, evidenceEnvelope, evidenceGrant, guardReceipt, inputTurn, inputWindow, pageReceipt, providerReceipt, studioRun, studioTestConfig,
} from "./studio-g7-helpers.js";
import { testConfig } from "./helpers.js";

const config = studioTestConfig();
const run = studioRun(config);

describe("Studio G7 contract strictness", () => {
  it("accepts exact page receipts and rejects unknown keys and free text", () => {
    expect(parsePageReceipt(pageReceipt(run, "mic_published", 1_000)).event).toBe("mic_published");
    expect(() => parsePageReceipt({ ...pageReceipt(run, "mic_published", 1_000), note: "x" })).toThrow(StudioContractViolation);
    // A transcript or caption in any field is free text and is rejected.
    expect(() => parsePageReceipt(pageReceipt(run, "mic_published", 1_000, { trackId: "hello sophia please build" }))).toThrow(StudioContractViolation);
    expect(() => parsePageReceipt(pageReceipt(run, "sophia_playback", 1_000, { phase: "speaking loudly" }))).toThrow(StudioContractViolation);
    expect(() => parsePageReceipt({ ...pageReceipt(run, "mic_unpublished", 1_000), schema: "other" })).toThrow(StudioContractViolation);
  });

  it("parses bridge receipts strictly (0046 bodies), rejecting free text, unknown keys and kind/seq disagreement", () => {
    const window = inputWindow(run, 2, 1, 1_000);
    expect(parseBridgeReceipt("input_window", 2, window)).toMatchObject({ windowSeq: 1, sampleRate: 16_000, kind: "input_window" });
    expect(() => parseBridgeReceipt("input_window", 2, { ...window, transcript: "build me a page" })).toThrow(StudioContractViolation);
    expect(() => parseBridgeReceipt("input_window", 3, window)).toThrow(/bridge_envelope_seq_mismatch/);
    expect(() => parseBridgeReceipt("input_window", 2, { ...window, rawAudioExcluded: false })).toThrow(StudioContractViolation);
    expect(() => parseBridgeReceipt("input_window", 2, { ...window, sampleRate: 48_000 })).toThrow(StudioContractViolation);
    // The body's own kind is required and must equal the row's (0046 refuses otherwise).
    const { kind: _kind, ...kindless } = window;
    expect(() => parseBridgeReceipt("input_window", 2, kindless)).toThrow(StudioContractViolation);
    expect(() => parseBridgeReceipt("provider", 1, providerReceipt(run, 1, "ready", { kind: "input_window" }))).toThrow(StudioContractViolation);
    expect(() => parseBridgeReceipt("provider", 1, providerReceipt(run, 1, "ready", { schema: "sophia.bridge.input_window.v1" }))).toThrow(StudioContractViolation);
    expect(() => parseBridgeReceipt("provider", 1, providerReceipt(run, 1, "ready", { model: "a free text model description" }))).toThrow(StudioContractViolation);
    // Body seq is optional (the migration keys rows by seq; its tests omit it).
    const { seq: _seq, ...seqless } = providerReceipt(run, 7, "usage");
    expect(parseBridgeReceipt("provider", 7, seqless)).toMatchObject({ phase: "usage" });
    // 0046 provider counters are accepted, as counts only.
    expect(parseBridgeReceipt("provider", 1, providerReceipt(run, 1, "usage", { connectionsOpened: 2, turns: 3, lastPromptTokens: 9_000 }))).toMatchObject({ turns: 3 });
    expect(() => parseBridgeReceipt("provider", 1, providerReceipt(run, 1, "usage", { turns: "three" }))).toThrow(StudioContractViolation);
    expect((parseBridgeReceipt("input_window", 0, inputWindow(run, 0, 1, 1_000)) as { seq?: number }).seq).toBe(0);
    expect(() => parseBridgeReceipt("input_window", 100_000, inputWindow(run, 100_000, 1, 1_000))).toThrow(StudioContractViolation);
    // A count is allowed; text is not.
    expect(() => parseBridgeReceipt("input_turn", 1, { ...inputTurn(run, 1, 1), transcriptChars: "hello" })).toThrow(StudioContractViolation);
  });

  it("parses the guard's own receipt: service source, seq 0, six reasons, no body seq", () => {
    const guard = guardReceipt(run, "turns");
    expect(parseBridgeReceipt("guard", 0, guard, "service")).toMatchObject({ reason: "turns", schema: "sophia.service.guard.v1" });
    for (const reason of ["deadline", "expired", "revoked", "connections", "turns", "usage"]) expect(parseBridgeReceipt("guard", 0, guardReceipt(run, reason), "service")).toMatchObject({ reason });
    expect(() => parseBridgeReceipt("guard", 0, guardReceipt(run, "because the operator wanted"), "service")).toThrow(StudioContractViolation);
    expect(() => parseBridgeReceipt("guard", 1, guard, "service")).toThrow(/guard_receipt_seq_not_zero/);
    expect(() => parseBridgeReceipt("guard", 0, guard, "bridge")).toThrow(/evidence_source_kind_mismatch/);
    expect(() => parseBridgeReceipt("guard", 0, { ...guard, seq: 0 }, "service")).toThrow(StudioContractViolation);
    expect(() => parseBridgeReceipt("guard", 0, { ...guard, schema: "sophia.bridge.guard.v1" }, "service")).toThrow(StudioContractViolation);
    expect(() => parseBridgeReceipt("provider", 1, providerReceipt(run, 1, "ready"), "service")).toThrow(/evidence_source_kind_mismatch/);
  });

  it("parses the 0046 evidence answer and rejects the whole answer when any entry is malformed", () => {
    const answer = evidenceEnvelope(run, [["provider", providerReceipt(run, 0, "ready")], ["input_window", inputWindow(run, 1, 1, 1_000)], ["guard", guardReceipt(run, "deadline")]], { state: "ended" });
    const parsed = parseQualificationEvidence(answer);
    expect(parsed).toMatchObject({ exchangeId: EXCHANGE_UUID, state: "ended", grant: { grantId: GRANT_UUID, maxTurns: 20 } });
    expect(parsed.receipts.map((receipt) => [receipt.source, receipt.seq, receipt.kind])).toEqual([["bridge", 0, "provider"], ["bridge", 1, "input_window"], ["service", 0, "guard"]]);
    expect(() => parseQualificationEvidence({ ...answer, extra: true })).toThrow(StudioContractViolation);
    // The plan's `grants` array is not the migration's shape.
    const { grant, ...rest } = answer as { grant: Record<string, unknown> };
    expect(() => parseQualificationEvidence({ ...rest, grants: [grant] })).toThrow(StudioContractViolation);
    expect(() => parseQualificationEvidence({ ...answer, grant: { ...grant, approvalRef: "owner said yes" } })).toThrow(StudioContractViolation);
    expect(() => parseQualificationEvidence({ ...answer, grant: { ...grant, maxUsageTokens: 5_000_001 } })).toThrow(StudioContractViolation);
    expect(parseQualificationEvidence({ ...answer, grant: { ...grant, maxUsageTokens: 5_000_000, endedReason: "turns" } }).grant.endedReason).toBe("turns");
    expect(() => parseQualificationEvidence({ ...answer, state: "closed" })).toThrow(StudioContractViolation);
    const rows = (answer as { receipts: Array<Record<string, unknown>> }).receipts;
    // A duplicate (source, seq), a receipt bound to another grant or run, or a guard from the bridge rejects everything.
    expect(() => parseQualificationEvidence({ ...answer, receipts: [...rows, rows[0]] })).toThrow(/evidence_duplicate_source_seq/);
    expect(() => parseQualificationEvidence({ ...answer, receipts: [...rows, { ...rows[0], seq: 9, receipt: { ...providerReceipt(run, 9, "usage"), grantId: "11111111-2222-4333-8444-555555555555" } }] })).toThrow(/evidence_receipt_grant_mismatch/);
    expect(() => parseQualificationEvidence({ ...answer, receipts: [...rows, { ...rows[0], seq: 9, receipt: { ...providerReceipt(run, 9, "usage"), runBindingSha256: "e".repeat(64) } }] })).toThrow(/evidence_receipt_grant_mismatch/);
    expect(() => parseQualificationEvidence({ ...answer, receipts: rows.map((row) => row.kind === "guard" ? { ...row, source: "bridge" } : row) })).toThrow(StudioContractViolation);
  });

  it("derives the documented run binding from canonical JSON", () => {
    const input = { testRunId: "11111111-2222-4333-8444-555555555555", cleanupObligationId: "66666666-7777-4888-9999-aaaaaaaaaaaa", scenarioId: "V-G07", scenarioVersion: "studio-g7-v1" };
    const json = canonicalRunBindingJson(input);
    expect(json).toBe('{"cleanup_obligation_id":"66666666-7777-4888-9999-aaaaaaaaaaaa","scenario_id":"V-G07","scenario_version":"studio-g7-v1","schema":"sophia.voice-lab.studio-g7.run-binding.v1","test_run_id":"11111111-2222-4333-8444-555555555555"}');
    expect(computeRunBindingSha256(input)).toBe(createHash("sha256").update(json, "utf8").digest("hex"));
    expect(computeRunBindingSha256({ ...input, testRunId: input.testRunId.toUpperCase() })).toBe(computeRunBindingSha256(input));
    expect(computeRunBindingSha256({ ...input, scenarioVersion: "studio-g7-v2" })).not.toBe(computeRunBindingSha256(input));
    expect(() => canonicalRunBindingJson({ ...input, scenarioId: "G7 E01 with spaces" })).toThrow();
  });

  it("types every mandatory channel, and never claims Gemini-only evidence", () => {
    const channels = STUDIO_G7_RECEIPT_COVERAGE.map((entry) => entry.channel);
    expect(new Set(channels).size).toBe(channels.length);
    for (const entry of STUDIO_G7_RECEIPT_COVERAGE) expect(COVERAGE_STATUSES).toContain(entry.status);
    const byChannel = Object.fromEntries(STUDIO_G7_RECEIPT_COVERAGE.map((entry) => [entry.channel, entry]));
    expect(byChannel.downstream_pcm_frames_browser_to_provider!.status).toBe("unsupported");
    expect(byChannel.lab_vs_product_pcm_chain_equality!.status).toBe("unsupported");
    expect(byChannel.canonical_transcript_with_content!.status).toBe("not_supported_by_product_privacy_model");
    expect(byChannel.provider_output_transcription_fragments!.status).toBe("not_supported_by_product_privacy_model");
    expect(byChannel.output_leg_audio_artifact!.status).toBe("not_supported_by_product_privacy_model");
    expect(byChannel.webrtc_sender_stats!.status).toBe("corroboration_only");
    expect(byChannel.downstream_pcm_window_envelope!.sources).toEqual(["input_window"]);
    // Voice steps are certified from the exchange's calls (A15), room presence is a fresh report only, and the loopback limitation is explicit.
    expect(byChannel.builder_task_and_artifact_join).toMatchObject({ status: "product_receipt", reason: "certified_only_from_exchange_calls_requires_voice_qualification" });
    expect(byChannel.builder_task_and_artifact_join!.sources).toEqual(expect.arrayContaining(["GET /api/v1/exchanges/{e}/calls (A15)", "NativeTask.exchangeId (A15)"]));
    expect(byChannel.voice_step_command).toMatchObject({ status: "product_receipt", reason: "exactly_one_new_command_of_the_step_kind_on_the_created_goal" });
    expect(byChannel.orphan_browser_room_presence).toMatchObject({ status: "product_receipt", reason: "fresh_report_only_else_unobservable" });
    expect(byChannel.webrtc_packet_flow_on_loopback_peer).toMatchObject({ status: "unsupported", reason: "fake_studio_loopback_peer_has_no_livekit_sfu" });
    // Each plan-vs-migration difference is data, and the adapter follows the migration.
    expect(STUDIO_G7_CONTRACT_DIFFERENCES.map((entry) => entry.field)).toEqual(expect.arrayContaining(["evidence.grant", "evidence.receipts[].source", "guard.reason", "grant.max_usage_tokens", "receipt.kind"]));
    // Not found: the product answers 422 `not_found` (A15); a 404 means the route is absent.
    const notFound = STUDIO_G7_CONTRACT_DIFFERENCES.find((entry) => entry.field === "not found answer")!;
    expect(notFound.migration_0046).toContain("422 {code: 'not_found'}");
    expect(notFound.migration_0046).toContain("404 only when the route is absent");
    expect(notFound.adapter).toContain("422 not_found: not_answered_to_principal");
    expect(notFound.adapter).toContain("404: endpoint_not_served");
  });

  it("types scenario support per target kind", () => {
    for (const id of SCENARIO_IDS) {
      expect(scenarioSupportForTarget("studio-livekit-g7-v1", id, "vt00.scenarios.v1")).toMatchObject({ status: "unsupported_for_target", reason: "legacy_gemini_browser_scenario_requires_browser_provider_socket" });
      expect(scenarioSupportForTarget("legacy-gemini-browser-v1", id, "vt00.scenarios.v1").status).toBe("supported");
    }
    expect(scenarioSupportForTarget("studio-livekit-g7-v1", "V-G07", "studio-g7-v1").status).toBe("supported");
    expect(scenarioSupportForTarget("legacy-gemini-browser-v1", "V-G07", "studio-g7-v1")).toMatchObject({ status: "unsupported_for_target" });
    const steps = STUDIO_G7_CATALOG[0]!.steps;
    // Every G7 step (pack L3 order) is an operation: speak or studio_action, none only a driver method.
    expect(steps.every((step) => step.availability === "supported" && (step.executor === "speak" || step.executor === "studio_action"))).toBe(true);
    expect(steps.map((step) => step.intent)).toEqual(["create_html_by_voice", "steer_by_voice", "leave_and_return", "section_revision", "stale_edit", "hold_by_voice", "resume_by_voice", "stop_by_voice", "withdrawal"]);
    expect(steps.filter((step) => step.executor === "speak").map((step) => step.outcome_join)).toEqual(["exchange_calls", "exchange_calls", "exchange_calls", "exchange_calls", "exchange_calls"]);
    expect(STUDIO_G7_CATALOG[0]!.required_tools).toEqual(expect.arrayContaining(["start_studio_g7_run", "studio_g7_voice_step", "studio_g7_action"]));
  });

  it("reads deployed identities without guessing", () => {
    expect(parseStudioBuildMeta(`<html><head><meta charset="utf-8"><meta name="sophia-build" content="${"A".repeat(40)}"></head>`)).toEqual({ status: "observed", commit: "a".repeat(40) });
    expect(parseStudioBuildMeta("<html><head><meta charset=utf-8></head>")).toMatchObject({ status: "unavailable", reason: "identity_not_published" });
    expect(parseStudioBuildMeta('<meta content="dev" name="sophia-build">')).toMatchObject({ status: "unavailable", reason: "identity_malformed" });
    expect(projectRoomSnapshot({ room: { id: "room-1", sophia: { exchangeId: EXCHANGE_UUID.toUpperCase(), exchange: "open", inputEpoch: 3, inputActorId: PRINCIPAL_UUID } }, work: [{ text: "ignored" }] })).toEqual({ roomIdPresent: true, roomId: "room-1", exchangeId: EXCHANGE_UUID, exchangeState: "open", inputEpoch: 3, inputActorId: PRINCIPAL_UUID, work: [] });
    // A room without Sophia's presence, or with a malformed state or id, is unknown, never "no exchange".
    expect(() => projectRoomSnapshot({ room: { id: "room-1", sophia: null } })).toThrow(StudioContractViolation);
    expect(() => projectRoomSnapshot({ room: { id: "room-1", sophia: { exchangeId: null } } })).toThrow(StudioContractViolation);
    expect(() => projectRoomSnapshot({ room: { id: "room-1", sophia: { exchange: "open", exchangeId: null } } })).toThrow(StudioContractViolation);
    expect(() => projectRoomSnapshot({})).toThrow(StudioContractViolation);
    // `exchange: none` is no live exchange, whatever id is echoed.
    expect(projectRoomSnapshot({ room: { id: "room-1", sophia: { exchangeId: EXCHANGE_UUID, exchange: "none" } } }).exchangeId).toBeNull();
  });
});

describe("Studio G7 configuration", () => {
  it("defaults to the legacy kind and leaves the legacy config object unchanged", () => {
    const legacy = testConfig();
    expect("targetKind" in legacy).toBe(false);
    expect("studioG7" in legacy).toBe(false);
  });

  it("loads the studio target, keeps origins allowlisted, and never projects the password", () => {
    expect(config.targetKind).toBe("studio-livekit-g7-v1");
    expect(config.studioG7).toMatchObject({ projectId: expect.any(String), grantWaitMs: 10_000, expected: { studio: "1".repeat(40) } });
    const projected = JSON.stringify(projectStudioG7Config(config.studioG7!));
    expect(projected).not.toContain(FAKE_PASSWORD);
    expect(projected).not.toContain(FAKE_EMAIL);
    expect(() => studioTestConfig({ studio: "http://not-allowlisted.test", api: "http://api.test", supabase: "http://abc.supabase.test" }, { SOPHIA_VOICE_LAB_ALLOWED_ORIGINS: "http://api.test,http://abc.supabase.test" })).toThrow(/ALLOWED_ORIGINS/);
    let message = "";
    try { studioTestConfig(undefined, { SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_PASSWORD: "short" }); } catch (error) { message = JSON.stringify(error instanceof VoiceLabError ? error.detail : String(error)); }
    expect(message).toContain("CONFIG_INVALID");
    expect(message).not.toContain("short\"");
    expect(() => studioTestConfig(undefined, { SOPHIA_VOICE_LAB_STUDIO_EXPECTED_BRIDGE_SHA: "main" })).toThrow(/40-character/);
    expect(() => studioTestConfig(undefined, { SOPHIA_VOICE_LAB_TARGET_KIND: "studio" })).toThrow(/TARGET_KIND/);
  });
});

describe("Supabase session handling", () => {
  const target = { supabaseUrl: "http://abc.supabase.test", publishableKey: FAKE_PUBLISHABLE_KEY };
  const session = { access_token: FAKE_ACCESS_TOKEN, refresh_token: FAKE_REFRESH_TOKEN, token_type: "bearer", expires_in: 3_600, expires_at: Math.floor(Date.now() / 1_000) + 3_600, user: { id: PRINCIPAL_UUID } };

  it("uses the supabase-js storage key", () => {
    expect(supabaseStorageKey("https://abc.supabase.co")).toBe("sb-abc-auth-token");
    expect(supabaseStorageKey("http://127.0.0.1:5555")).toBe("sb-127-auth-token");
  });

  it("performs the password grant with the publishable key and binds the principal", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: URL | string, init?: RequestInit) => { requests.push({ url: String(input), init: init ?? {} }); return new Response(JSON.stringify(session), { status: 200, headers: { "content-type": "application/json" } }); };
    const result = await passwordGrant(target, { email: FAKE_EMAIL, password: FAKE_PASSWORD }, { fetchImpl, expectedUserId: PRINCIPAL_UUID });
    expect(result).toMatchObject({ accessToken: FAKE_ACCESS_TOKEN, userId: PRINCIPAL_UUID, tokenType: "bearer" });
    expect(requests[0]!.url).toBe("http://abc.supabase.test/auth/v1/token?grant_type=password");
    expect((requests[0]!.init.headers as Record<string, string>).apikey).toBe(FAKE_PUBLISHABLE_KEY);
    await expect(passwordGrant(target, { email: FAKE_EMAIL, password: FAKE_PASSWORD }, { fetchImpl, expectedUserId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ detail: { code: "STUDIO_AUTH_PRINCIPAL_MISMATCH" } });
  });

  it("types a bad password as an authorization failure without leaking any secret", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: `Invalid login credentials for ${FAKE_EMAIL} with ${FAKE_PASSWORD}` }), { status: 400, headers: { "content-type": "application/json" } });
    const error = await passwordGrant(target, { email: FAKE_EMAIL, password: FAKE_PASSWORD }, { fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceLabError);
    const detail = (error as VoiceLabError).detail;
    expect(detail).toMatchObject({ code: "STUDIO_AUTH_REJECTED", category: "authorization", retryable: false, details: { http_status: 400, supabase_error_code: "invalid_grant" } });
    const serialized = JSON.stringify({ detail, message: (error as Error).message, stack: (error as Error).stack });
    for (const secret of [FAKE_PASSWORD, FAKE_EMAIL, FAKE_PUBLISHABLE_KEY]) expect(serialized).not.toContain(secret);
    const unreachable = await passwordGrant(target, { email: FAKE_EMAIL, password: FAKE_PASSWORD }, { fetchImpl: async () => { throw new Error(`socket closed ${FAKE_PASSWORD}`); } }).catch((caught: unknown) => caught);
    expect(JSON.stringify((unreachable as VoiceLabError).detail)).not.toContain(FAKE_PASSWORD);
    expect((unreachable as VoiceLabError).detail.code).toBe("STUDIO_AUTH_UNAVAILABLE");
  });

  it("signs out globally and only confirms on 204/200", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const ok = await globalSignOut(target, FAKE_ACCESS_TOKEN, { fetchImpl: async (input, init) => { calls.push({ url: String(input), auth: (init?.headers as Record<string, string>).authorization! }); return new Response(null, { status: 204 }); } });
    expect(ok).toMatchObject({ confirmed: true, scope: "global", http_status: 204 });
    expect(calls[0]).toEqual({ url: "http://abc.supabase.test/auth/v1/logout?scope=global", auth: `Bearer ${FAKE_ACCESS_TOKEN}` });
    expect(JSON.stringify(ok)).not.toContain(FAKE_ACCESS_TOKEN);
    expect(await globalSignOut(target, FAKE_ACCESS_TOKEN, { fetchImpl: async () => new Response("{}", { status: 401 }) })).toMatchObject({ confirmed: false, basis: "session_already_revoked" });
    expect(await globalSignOut(target, FAKE_ACCESS_TOKEN, { fetchImpl: async () => { throw new Error("down"); } })).toMatchObject({ confirmed: false, basis: "unreachable" });
  });

  it("seeds the session and mic preference once, only on the exact Studio top document", () => {
    const run = (origin: string, top: boolean, existing: Record<string, string> = {}, seeded = false) => {
      const local = new Map(Object.entries(existing));
      const sessionStore = new Map<string, string>(seeded ? [["sophia.voice-lab.session-seeded.v1", "1"]] : []);
      const sandbox: Record<string, unknown> = {
        location: { origin },
        localStorage: { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value) },
        sessionStorage: { getItem: (key: string) => sessionStore.get(key) ?? null, setItem: (key: string, value: string) => sessionStore.set(key, value) },
      };
      sandbox.window = sandbox;
      sandbox.top = top ? sandbox : {};
      const script = buildStudioSessionSeedScript({ studioOrigin: "http://studio.test", storageKey: "sb-abc-auth-token", session: { accessToken: FAKE_ACCESS_TOKEN, refreshToken: FAKE_REFRESH_TOKEN, tokenType: "bearer", expiresIn: 3_600, expiresAt: session.expires_at, userId: PRINCIPAL_UUID, storageValue: session } });
      vm.runInNewContext(script, sandbox);
      return local;
    };
    const seeded = run("http://studio.test", true);
    expect(JSON.parse(seeded.get("sb-abc-auth-token")!)).toMatchObject({ access_token: FAKE_ACCESS_TOKEN, user: { id: PRINCIPAL_UUID } });
    expect(seeded.get("sophia.mic.v1")).toBe("on");
    expect(run("http://evil.test", true).size).toBe(0);
    expect(run("http://studio.test", false).size).toBe(0);
    // The Studio's rotated session is never overwritten by the stale seed.
    expect(run("http://studio.test", true, { "sb-abc-auth-token": "rotated" }).get("sb-abc-auth-token")).toBe("rotated");
    expect(run("http://studio.test", true, {}, true).size).toBe(0);
  });
});

describe("shared init script profiles", () => {
  const base = { pageOrigin: "https://frontend.test", websocketOrigins: ["wss://provider.test"], maxAudioBytes: 1024, testRunId: "00000000-0000-4000-8000-000000000001", cleanupObligationId: "00000000-0000-4000-8000-000000000002" };
  it("keeps the legacy script byte-identical and varies only the studio profile", () => {
    const legacy = buildVoiceLabInitScript(base);
    expect(createHash("sha256").update(legacy).digest("hex")).toBe("ebf374c0070a8c73ced7a2cfbbb383eceef0a3febdfb6860a76f133c59d3f738");
    expect(buildVoiceLabInitScript({ ...base, profile: "legacy-gemini-browser-v1" })).toBe(legacy);
    const studio = buildVoiceLabInitScript({ ...base, profile: "studio-livekit-g7-v1" });
    expect(studio).not.toContain("sophia-onboarding-v2");
    expect(studio).toContain("fresh_clone_per_request");
    expect(studio).not.toContain('"profile"');
  });
});
