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
  /** A `speak` operation through the Studio's own microphone path (MCP `studio_g7_voice_step`). */
  | "speak"
  /** A `studio_action` operation (MCP `studio_g7_action`): a room UI action or a member-API request as the principal. */
  | "studio_action";

export const STUDIO_G7_VOICE_STEPS = ["create", "steer", "hold", "resume", "stop"] as const;
export type StudioG7VoiceStep = typeof STUDIO_G7_VOICE_STEPS[number];
export const STUDIO_G7_ACTIONS = ["leave_and_return", "section_revision", "stale_edit", "withdrawal"] as const;
export type StudioG7Action = typeof STUDIO_G7_ACTIONS[number];

export interface StudioG7Step {
  id: string;
  ordinal: number;
  intent: "create_html_by_voice" | "steer_by_voice" | "leave_and_return" | "section_revision" | "stale_edit" | "hold_by_voice" | "resume_by_voice" | "stop_by_voice" | "withdrawal";
  executor: StudioG7StepExecutor;
  /** The `step` (voice) or `action` value that performs it. */
  label: StudioG7VoiceStep | StudioG7Action;
  /** Typed availability inside this adapter; `unavailable` is never a pass. */
  availability: "supported" | "unavailable";
  unavailable_reason: string | null;
  /**
   * How the step's product outcome joins to this run. `canonical`: the Lab's
   * own member-API request returned the task or receipt id. `exchange_calls`:
   * a voice step, certified only from the exchange's calls (A15
   * getExchangeCalls, with the API's voice qualification on): the one
   * command its own call admitted after its baseline, of its kind and goal
   * (calls-certification.ts); never by actor or time, and unavailable when
   * the product does not serve the calls. `lab_owned`: the Lab's own receipts.
   */
  outcome_join: "canonical" | "exchange_calls" | "lab_owned";
  /** Receipts the step's assertions are drawn from. */
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

const VOICE_EVIDENCE = ["studio.exchange.calls_read", "utterance.resolved", "audio.input.scheduled", "audio.input.started", "audio.input.completed", "page:mic_published", "input_window", "input_turn", "provider", "output_reply", "page:sophia_playback", "studio.outcome.observed"] as const;
const voice = (id: string, ordinal: number, intent: StudioG7Step["intent"], label: StudioG7VoiceStep): StudioG7Step => ({ id, ordinal, intent, executor: "speak", label, availability: "supported", unavailable_reason: null, outcome_join: "exchange_calls", evidence: VOICE_EVIDENCE });

export const STUDIO_G7_CATALOG: readonly StudioG7Scenario[] = Object.freeze([
  {
    id: "V-G07",
    version: STUDIO_G7_SCENARIO_VERSION,
    contract_version: STUDIO_G7_CONTRACT_VERSION,
    target_kind: STUDIO_G7_TARGET_KIND,
    summary: "Pack 03 G7 synthetic in-app episode through the Studio room microphone and the member API",
    required_tools: ["start_studio_g7_run", "studio_g7_voice_step", "studio_g7_action", "inspect_voice_run", "wait_for_turn", "end_voice_run", "export_voice_evidence"],
    steps: [
      voice("g7.create", 1, "create_html_by_voice", "create"),
      voice("g7.steer", 2, "steer_by_voice", "steer"),
      { id: "g7.leave_return", ordinal: 3, intent: "leave_and_return", executor: "studio_action", label: "leave_and_return", availability: "supported", unavailable_reason: null, outcome_join: "lab_owned", evidence: ["studio.room.left", "studio.room.rejoined", "page:mic_unpublished", "page:mic_published", "studio.outcome.observed"] },
      { id: "g7.section_revision", ordinal: 4, intent: "section_revision", executor: "studio_action", label: "section_revision", availability: "supported", unavailable_reason: null, outcome_join: "canonical", evidence: ["studio.action.html_edit", "studio.outcome.observed"] },
      { id: "g7.stale_edit", ordinal: 5, intent: "stale_edit", executor: "studio_action", label: "stale_edit", availability: "supported", unavailable_reason: null, outcome_join: "canonical", evidence: ["studio.action.html_edit"] },
      voice("g7.hold", 6, "hold_by_voice", "hold"),
      voice("g7.resume", 7, "resume_by_voice", "resume"),
      voice("g7.stop", 8, "stop_by_voice", "stop"),
      { id: "g7.withdrawal", ordinal: 9, intent: "withdrawal", executor: "studio_action", label: "withdrawal", availability: "supported", unavailable_reason: null, outcome_join: "canonical", evidence: ["studio.action.withdrawal", "studio.outcome.observed"] },
    ],
  },
] satisfies StudioG7Scenario[]);

/** `g7.<label>` step id for a voice step or action label. */
export function studioG7StepId(label: StudioG7VoiceStep | StudioG7Action): string {
  const step = STUDIO_G7_CATALOG[0]!.steps.find((candidate) => candidate.label === label);
  if (!step) throw new Error("Unknown Studio G7 step label");
  return step.id;
}

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

/** Action steps (`studio_action`) of a scenario, in episode order. */
export function studioG7ActionSteps(scenario: StudioG7Scenario): StudioG7Step[] {
  return scenario.steps.filter((step) => step.executor === "studio_action");
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
