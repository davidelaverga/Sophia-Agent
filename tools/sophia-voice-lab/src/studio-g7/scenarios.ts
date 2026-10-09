import { SCENARIO_CATALOG_VERSION } from "../domain.js";
import { ScenarioIdSet } from "../scenarios.js";
import { LEGACY_TARGET_KIND, STUDIO_G7_CONTRACT_VERSION, STUDIO_G7_TARGET_KIND, type TargetKind } from "./contract.js";

/** Versioned Studio G7 catalogue. Separate from `vt00.scenarios.v1`. */
export const STUDIO_G7_SCENARIO_VERSION = "studio-g7-v1" as const;
// `V-G07` fits the shared recovery-control scenario grammar (V-[A-Z][0-9]{2})
// and collides with no legacy id; the catalogue version keeps it separate.
export const STUDIO_G7_SCENARIO_IDS = ["V-G07"] as const;
export type StudioG7ScenarioId = typeof STUDIO_G7_SCENARIO_IDS[number];

export type StudioG7StepExecutor =
  /** An ordinary `speak` operation through the Studio's own microphone path. */
  | "speak"
  /** A Studio room UI action the studio driver implements (no MCP operation in this change). */
  | "studio_driver_action"
  /** Needs a controller other than this voice driver (non-voice product steps). */
  | "separate_controller";

export interface StudioG7Step {
  id: string;
  ordinal: number;
  intent: "create_html_by_voice" | "steer_by_voice" | "leave_and_return" | "hold_by_voice" | "resume_by_voice" | "stop_by_voice" | "stale_edit" | "withdrawal";
  executor: StudioG7StepExecutor;
  /** Typed availability inside this adapter; `unavailable` is never a pass. */
  availability: "supported" | "unavailable";
  unavailable_reason: string | null;
  /** Receipts the step's harness assertions are drawn from. */
  evidence: readonly string[];
}

export interface StudioG7Scenario {
  id: StudioG7ScenarioId;
  version: typeof STUDIO_G7_SCENARIO_VERSION;
  contract_version: typeof STUDIO_G7_CONTRACT_VERSION;
  target_kind: typeof STUDIO_G7_TARGET_KIND;
  summary: string;
  required_tools: readonly string[];
  steps: readonly StudioG7Step[];
}

const VOICE_EVIDENCE = ["utterance.resolved", "audio.input.scheduled", "audio.input.started", "audio.input.completed", "page:mic_published", "input_window", "input_turn", "provider", "output_reply", "page:sophia_playback"] as const;

export const STUDIO_G7_CATALOG: readonly StudioG7Scenario[] = Object.freeze([
  {
    id: "V-G07",
    version: STUDIO_G7_SCENARIO_VERSION,
    contract_version: STUDIO_G7_CONTRACT_VERSION,
    target_kind: STUDIO_G7_TARGET_KIND,
    summary: "Pack 03 G7 synthetic in-app voice episode through the Studio room microphone",
    // Start is the typed service method `VoiceLabService.startStudioG7Run`;
    // it is not registered as an MCP tool in this change.
    required_tools: ["VoiceLabService.startStudioG7Run", "speak", "inspect_voice_run", "end_voice_run", "export_voice_evidence"],
    steps: [
      { id: "g7.create", ordinal: 1, intent: "create_html_by_voice", executor: "speak", availability: "supported", unavailable_reason: null, evidence: VOICE_EVIDENCE },
      { id: "g7.steer", ordinal: 2, intent: "steer_by_voice", executor: "speak", availability: "supported", unavailable_reason: null, evidence: VOICE_EVIDENCE },
      { id: "g7.leave_return", ordinal: 3, intent: "leave_and_return", executor: "studio_driver_action", availability: "unavailable", unavailable_reason: "driver_action_not_exposed_as_mcp_operation", evidence: ["studio.room.left", "studio.room.rejoined", "page:mic_unpublished", "page:mic_published"] },
      { id: "g7.hold", ordinal: 4, intent: "hold_by_voice", executor: "speak", availability: "supported", unavailable_reason: null, evidence: VOICE_EVIDENCE },
      { id: "g7.resume", ordinal: 5, intent: "resume_by_voice", executor: "speak", availability: "supported", unavailable_reason: null, evidence: VOICE_EVIDENCE },
      { id: "g7.stop", ordinal: 6, intent: "stop_by_voice", executor: "speak", availability: "supported", unavailable_reason: null, evidence: VOICE_EVIDENCE },
      { id: "g7.stale_edit", ordinal: 7, intent: "stale_edit", executor: "separate_controller", availability: "unavailable", unavailable_reason: "requires_separate_non_voice_controller", evidence: [] },
      { id: "g7.withdrawal", ordinal: 8, intent: "withdrawal", executor: "separate_controller", availability: "unavailable", unavailable_reason: "requires_separate_non_voice_controller", evidence: [] },
    ],
  },
] satisfies StudioG7Scenario[]);

export const STUDIO_G7_SCENARIO_ID_SET: ReadonlySet<string> = new Set(STUDIO_G7_SCENARIO_IDS);

export function isStudioG7ScenarioVersion(version: string | null | undefined): boolean {
  return version === STUDIO_G7_SCENARIO_VERSION;
}

export function studioG7Scenario(id: string | null | undefined): StudioG7Scenario | null {
  return STUDIO_G7_CATALOG.find((scenario) => scenario.id === id) ?? null;
}

/** Voice steps (`speak`) of a scenario, in episode order. */
export function studioG7VoiceSteps(scenario: StudioG7Scenario): StudioG7Step[] {
  return scenario.steps.filter((step) => step.executor === "speak");
}

export type ScenarioTargetSupport =
  | { status: "supported"; target_kind: TargetKind; scenario_id: string; scenario_version: string }
  | { status: "unsupported_for_target"; target_kind: TargetKind; scenario_id: string | null; scenario_version: string | null; reason: string };

/**
 * Which catalogue a target kind accepts. Legacy Gemini-browser scenarios
 * (V-A01 … V-P01) are typed `unsupported_for_target` on the Studio target,
 * and Studio G7 scenarios are typed `unsupported_for_target` on the legacy
 * target. Neither is ever silently mapped onto the other.
 */
export function scenarioSupportForTarget(kind: TargetKind, scenarioId: string | null | undefined, scenarioVersion: string | null | undefined): ScenarioTargetSupport {
  const id = scenarioId ?? null;
  const version = scenarioVersion ?? null;
  if (kind === STUDIO_G7_TARGET_KIND) {
    if (id !== null && STUDIO_G7_SCENARIO_ID_SET.has(id) && (version === null || version === STUDIO_G7_SCENARIO_VERSION)) {
      return { status: "supported", target_kind: kind, scenario_id: id, scenario_version: STUDIO_G7_SCENARIO_VERSION };
    }
    return { status: "unsupported_for_target", target_kind: kind, scenario_id: id, scenario_version: version, reason: id !== null && ScenarioIdSet.has(id) ? "legacy_gemini_browser_scenario_requires_browser_provider_socket" : "scenario_not_in_studio_g7_catalog" };
  }
  if (id !== null && STUDIO_G7_SCENARIO_ID_SET.has(id)) {
    return { status: "unsupported_for_target", target_kind: kind, scenario_id: id, scenario_version: version, reason: "studio_g7_scenario_requires_studio_livekit_target" };
  }
  return { status: "supported", target_kind: LEGACY_TARGET_KIND, scenario_id: id ?? "", scenario_version: version ?? SCENARIO_CATALOG_VERSION };
}
