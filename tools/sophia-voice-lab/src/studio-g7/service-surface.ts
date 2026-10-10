import { z } from "zod";

import type { VoiceLabConfig } from "../config.js";
import { CapturePolicySchema, IdempotencyKeySchema, RunIdSchema, VoiceLabError, labError, type RunRecord, type TargetSpec } from "../domain.js";
import { STUDIO_G7_CONTRACT_VERSION, STUDIO_G7_RECEIPT_COVERAGE, STUDIO_G7_TARGET_KIND, STUDIO_RUN_BINDING_SCHEMA, computeRunBindingSha256 } from "./contract.js";
import { projectStudioG7Config, type StudioG7Config } from "./config.js";
import { STUDIO_G7_ACTIONS, STUDIO_G7_CATALOG, STUDIO_G7_SCENARIO_IDS, STUDIO_G7_SCENARIO_VERSION, STUDIO_G7_VOICE_STEPS, isStudioG7ScenarioVersion, scenarioSupportForTarget, studioG7StepId } from "./scenarios.js";

/**
 * The Studio G7 surface of the MCP service (service.ts): its tool input
 * schemas, its capability block, the run binding it hands out at start, and
 * the target checks its legacy tools make. The service reaches every Studio
 * G7 definition it uses through this one module.
 */

export { studioG7StepId };

/** Studio G7 start: the target is pinned by configuration, never by the caller. */
export const StudioG7StartSchema = z.object({
  environment: z.enum(["production", "staging"]),
  scenario_id: z.enum(STUDIO_G7_SCENARIO_IDS),
  scenario_version: z.literal(STUDIO_G7_SCENARIO_VERSION),
  capture_policy: CapturePolicySchema.optional(),
  idempotency_key: IdempotencyKeySchema,
}).strict();

const StudioTimingPolicySchema = z.object({
  delay_ms: z.number().int().min(0).max(10_000).default(0),
  schedule_timeout_ms: z.number().int().min(100).max(30_000).default(10_000),
}).strict();

/** One G7 voice step: a `speak` operation labelled with its step. */
export const StudioG7VoiceStepSchema = z.object({
  run_id: RunIdSchema,
  step: z.enum(STUDIO_G7_VOICE_STEPS),
  text: z.string().min(1).optional(),
  fixture_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  idempotency_key: IdempotencyKeySchema,
  timing_policy: StudioTimingPolicySchema.optional(),
}).strict().refine((value) => Number(value.text !== undefined) + Number(value.fixture_id !== undefined) === 1, "Exactly one of text or fixture_id is required.");

/** `observe` is not a step: it reads the outcome a voice step should have had. */
export const STUDIO_G7_OBSERVE_ACTION = "observe" as const;

/** One G7 non-voice step (or an outcome observation): a `studio_action` operation. */
export const StudioG7ActionSchema = z.object({
  run_id: RunIdSchema,
  action: z.enum([...STUDIO_G7_ACTIONS, STUDIO_G7_OBSERVE_ACTION]),
  idempotency_key: IdempotencyKeySchema,
  sections: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).min(1).max(16).optional(),
  instruction: z.string().min(1).max(2_000).optional(),
  entry_id: z.string().uuid().optional(),
  for_step: z.enum(STUDIO_G7_VOICE_STEPS).optional(),
  wait_ms: z.number().int().min(0).max(30_000).optional(),
  timeout_ms: z.number().int().min(0).max(300_000).optional(),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if ((value.action === "section_revision") !== (value.instruction !== undefined)) issue("instruction is required for section_revision and accepted only there.");
  if (value.sections !== undefined && value.action !== "section_revision" && value.action !== "stale_edit") issue("sections apply only to section_revision or stale_edit.");
  if (value.entry_id !== undefined && value.action !== "withdrawal") issue("entry_id applies only to withdrawal.");
  if ((value.action === STUDIO_G7_OBSERVE_ACTION) !== (value.for_step !== undefined)) issue("for_step is required for observe and accepted only there.");
  if (value.wait_ms !== undefined && value.action !== STUDIO_G7_OBSERVE_ACTION) issue("wait_ms applies only to observe.");
});

export const STUDIO_G7_TOOL_NAMES = ["start_studio_g7_run", "studio_g7_voice_step", "studio_g7_action"] as const;

/** Whether a deployment's target kind is the Studio LiveKit G7 target. */
export function isStudioTargetKind(targetKind: string | undefined): boolean {
  return targetKind === STUDIO_G7_TARGET_KIND;
}

/** The deployment's Studio configuration, when it targets the Studio. */
export function studioConfigOf(config: Pick<VoiceLabConfig, "targetKind" | "studioG7">): StudioG7Config | null {
  return config.targetKind === STUDIO_G7_TARGET_KIND ? config.studioG7 ?? null : null;
}

/** A Studio G7 step may run: the deployment targets the Studio and the run is a Studio G7 run. */
export function isStudioRunOnStudioTarget(targetKind: string | undefined, run: Pick<RunRecord, "scenarioVersion">): boolean {
  return targetKind === STUDIO_G7_TARGET_KIND && isStudioG7ScenarioVersion(run.scenarioVersion);
}

/** A legacy input tool is refused: the deployment targets the Studio, or the run is a Studio G7 run. */
export function refusesLegacyInputTool(targetKind: string | undefined, run?: Pick<RunRecord, "scenarioVersion">): boolean {
  return targetKind === STUDIO_G7_TARGET_KIND || (run !== undefined && isStudioG7ScenarioVersion(run.scenarioVersion));
}

/**
 * Legacy Gemini-browser scenarios (V-A01 … V-P01) need a browser provider
 * socket the Studio does not have; they are never remapped: start_voice_run
 * on a Studio deployment is refused with this error.
 */
export function studioLegacyStartRefusal(raw: unknown): VoiceLabError {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const scenarioId = typeof record.scenario_id === "string" ? record.scenario_id : null;
  const scenarioVersion = typeof record.scenario_version === "string" ? record.scenario_version : null;
  const support = scenarioSupportForTarget(STUDIO_G7_TARGET_KIND, scenarioId, scenarioVersion);
  return new VoiceLabError(labError("SCENARIO_UNSUPPORTED_FOR_TARGET", "start_voice_run drives the legacy Gemini-browser target; this deployment targets the Studio LiveKit G7 product.", "validation", false, { status: "unsupported_for_target", target_kind: STUDIO_G7_TARGET_KIND, scenario_id: scenarioId, scenario_version: scenarioVersion, reason: support.status === "unsupported_for_target" ? support.reason : "use_start_studio_g7_run" }));
}

/** The Studio G7 block of get_capabilities, on a Studio deployment only. */
export function studioG7Capabilities(config: Pick<VoiceLabConfig, "targetKind" | "studioG7">): { studio_g7?: Record<string, unknown> } {
  if (config.targetKind !== STUDIO_G7_TARGET_KIND || !config.studioG7) return {};
  return { studio_g7: {
    target_kind: STUDIO_G7_TARGET_KIND,
    contract_version: STUDIO_G7_CONTRACT_VERSION,
    target: projectStudioG7Config(config.studioG7),
    scenario_versions: [STUDIO_G7_SCENARIO_VERSION],
    scenarios: STUDIO_G7_CATALOG,
    legacy_scenarios: "unsupported_for_target",
    receipt_coverage: STUDIO_G7_RECEIPT_COVERAGE,
    run_binding: { schema: STUDIO_RUN_BINDING_SCHEMA, algorithm: "sha256(utf8(canonical_json({cleanup_obligation_id,scenario_id,scenario_version,schema,test_run_id})))" },
    tools: [...STUDIO_G7_TOOL_NAMES],
    operation_types: { voice_steps: "speak (studio_g7_voice_step)", non_voice_steps: "studio_action (studio_g7_action)" },
    lab_schema: { version: 7, studio_action_requires_upgrade_from_v6: true },
    limitations: ["no_transcript_retained", "no_audio_retained", "pcm_reconciliation_envelope_only", "fake_studio_loopback_peer_has_no_packet_flow_proof", "voice_steps_certified_only_from_exchange_calls_requires_voice_qualification", "steer_effect_beyond_admitted_command_not_exposed", "goal_status_is_the_created_task_phase", "orphan_browser_room_presence_only_from_fresh_bridge_report", "orphan_browser_process_close_unobservable"],
  } };
}

/**
 * get_capabilities' `target_environment` on a Studio G7 deployment: its safe
 * origins and pinned commits only (never the publishable key, the project or
 * the principal's credentials), and `current_identity` as the Studio probe
 * reports it (the probe /readyz runs: an unpublished identity stays
 * `unavailable`, a proven mismatch `deployment_mismatch`).
 */
export function studioTargetEnvironment(environment: string, studio: StudioG7Config, currentIdentity: Record<string, unknown>): Record<string, unknown> {
  return {
    environment,
    target_kind: STUDIO_G7_TARGET_KIND,
    studio_origin: studio.studioOrigin,
    api_origin: studio.apiOrigin,
    supabase_origin: studio.supabaseUrl,
    expected_deployment: { studio: studio.expected.studio, api: studio.expected.api, bridge: studio.expected.bridge },
    current_identity: currentIdentity,
  };
}

/** The identity a Studio G7 run is accepted under: the target, the contract, and its non-secret run binding. */
export function studioRunIdentity(run: Pick<RunRecord, "testRunId" | "cleanupObligationId" | "scenarioId" | "scenarioVersion">): { targetKind: typeof STUDIO_G7_TARGET_KIND; contractVersion: typeof STUDIO_G7_CONTRACT_VERSION; runBindingSchema: typeof STUDIO_RUN_BINDING_SCHEMA; runBindingSha256: string } {
  return {
    targetKind: STUDIO_G7_TARGET_KIND,
    contractVersion: STUDIO_G7_CONTRACT_VERSION,
    runBindingSchema: STUDIO_RUN_BINDING_SCHEMA,
    runBindingSha256: computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: run.scenarioId!, scenarioVersion: run.scenarioVersion! }),
  };
}

/**
 * Studio runs reuse the TargetSpec container: frontend = Studio origin and
 * commit, gateway/backend = API origin and commit, voice = the media bridge
 * commit (the bridge has no public origin; its identity comes only from
 * provider receipts). The LangGraph slots have no Studio counterpart and hold
 * the API origin/commit; they are never probed or verified for studio runs.
 */
export function studioTargetSpec(studio: StudioG7Config): TargetSpec {
  return {
    frontendUrl: studio.studioOrigin,
    gatewayUrl: studio.apiOrigin,
    voiceUrl: studio.apiOrigin,
    langgraphUrl: studio.apiOrigin,
    expectedDeployment: { frontend: studio.expected.studio, backend: studio.expected.api, voice: studio.expected.bridge },
    expectedDependencies: { langgraph: studio.expected.api },
  };
}
