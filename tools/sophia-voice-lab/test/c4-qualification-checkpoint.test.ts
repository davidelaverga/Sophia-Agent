import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { P01_LIMITS } from "../src/p01-contract.js";

it("pins the shared P01 policy to the approved fixed limits", () => {
  expect(P01_LIMITS).toEqual({ semanticCalls: 10, pollsPerOperation: 10, pollsTotal: 20, pollTimeoutMs: 10_000 });
  expect(Object.isFrozen(P01_LIMITS)).toBe(true);
});

it("keeps complete built-product journeys separate from audio trials, canaries and P01", async () => {
  const checkpoint = parse(await readFile(new URL("../../../docs/campaigns/vt00-voice-lab/deployment-gates.yaml", import.meta.url), "utf8"));
  const gates = checkpoint.quantitative_gates;
  const journeys = gates.find((gate: { id: string }) => gate.id === "c4_complete_built_sophia_journeys");
  expect(journeys).toMatchObject({ required_count: 20, same_exact_candidate_required: true,
    protocol: "complete-built-journeys.md", collection_scenario: "V-F01", maximum_run_starts_per_window: 20,
    required_completed_voice_turns_per_journey: 2, precedes: "fresh_session_smoke",
    distinct_process_identity_per_journey: true, control_plane: "installed_sophia_voice_lab_tools",
    satisfies_five_deployed_canaries: false, satisfies_fresh_installed_root_p01: false });
  expect(journeys.forbidden_substitutes).toContain("twenty_audio_operations_in_one_process");
  expect(journeys.required_evidence).toEqual(expect.arrayContaining([
    "ordinary_authenticated_product_controller", "current_owner_startup_and_provider_readiness",
    "input_pcm_transcription_and_product_acceptance", "output_and_realized_playback",
    "complete_session_finalization", "authoritative_owned_resource_settlement", "durable_export_and_evidence_integrity",
  ]));
  expect(checkpoint.promotion.c4_complete_built_sophia_journeys_required).toBe(true);
  expect(checkpoint.promotion.documentation_alone_can_promote).toBe(false);
  expect(gates.find((gate: { id: string }) => gate.id === "fresh_session_smoke").maximum_run_starts).toBe(5);
  expect(gates.find((gate: { id: string }) => gate.id === "fresh_session_smoke").requires).toBe("c4_complete_built_sophia_journeys");
});

it("records the bounded asynchronous P01 contract instead of excluding arbitrary polling", async () => {
  const checkpoint = parse(await readFile(new URL("../../../docs/campaigns/vt00-voice-lab/deployment-gates.yaml", import.meta.url), "utf8"));
  const p01 = checkpoint.quantitative_gates.find((gate: { id: string }) => gate.id === "plugin_cold_flow");
  expect(p01).toMatchObject({ contract: "p01-erratum-v2.md", semantic_spine_calls: P01_LIMITS.semanticCalls,
    max_polls_per_operation: P01_LIMITS.pollsPerOperation, max_polls_total: P01_LIMITS.pollsTotal, max_poll_timeout_ms: P01_LIMITS.pollTimeoutMs,
    finalization_requires: "operation_success_terminal_run_cleanup_complete_and_durable_evidence" });
});
