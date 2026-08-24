import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ExternalAttestationEvidenceSchema } from "../src/service.js";
import { testConfig } from "./helpers.js";

const SHA256 = "a".repeat(64);
const NOW = "2026-08-24T12:00:00.000Z";

function p01Evidence(pluginVersion: string): Record<string, unknown> {
  const tools = [
    "get_capabilities",
    "start_voice_run",
    "wait_for_turn",
    "speak",
    "wait_for_turn",
    "speak",
    "wait_for_turn",
    "inspect_voice_run",
    "end_voice_run",
    "export_voice_evidence",
  ] as const;
  return {
    kind: "p01_platform_plugin_task",
    authority: "platform_plugin",
    registered_app_id: "plugin_asdk_app_voice_lab_test",
    plugin_version: pluginVersion,
    platform_task_id_sha256: SHA256,
    platform_thread_id_sha256: SHA256,
    install_receipt_sha256: SHA256,
    plugin_package_sha256: SHA256,
    installed_at: NOW,
    fresh_task_started_at: NOW,
    fresh_task_completed_at: NOW,
    high_level_call_count: 10,
    calls: tools.map((tool_name, index) => ({
      ordinal: index + 1,
      observed_order: index + 1,
      tool_name,
      argument_sha256: SHA256,
      response_sha256: SHA256,
      result_request_id_sha256: SHA256,
      run_id_sha256: index === 0 ? null : SHA256,
      operation_id_sha256: [1, 3, 5, 8].includes(index) ? SHA256 : null,
    })),
    polling_call_count: 0,
    polling_calls: [],
    operation_ids: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    adaptive_observation_call_ordinal: 5,
    adaptive_followup_call_ordinal: 6,
    prohibited_tool_audit_passed: true,
    raw_javascript_used: false,
    local_runner_used: false,
    manual_takeover_used: false,
    exact_deployment_discovered: true,
    adaptive_followup_completed: true,
  };
}

describe("plugin version identity", () => {
  const finalVersions = [
    "0.1.0+codex.20260824120000",
    "0.1.0+codex.local-20260824-120000",
    "1.2.3-beta.1+codex.release-20260824",
  ];
  const invalidSemver = [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-alpha..1",
    "1.2.3+",
    "1.2.3+codex.",
    "1.2.3+codex..token",
    "1.2.3+codex_bad",
    "v1.2.3+codex.local",
  ];
  const helperImpossibleFinalVersions = [
    "0.1.0+other.local",
    "0.1.0+codex.local.token",
    "0.1.0+codex.Local",
    "0.1.0+codex.-local",
    "0.1.0+codex.local-",
    "0.1.0+codex.local--token",
  ];

  it.each(finalVersions)("accepts exact final plugin-creator version %s", (version) => {
    expect(testConfig({ SOPHIA_VOICE_LAB_PLUGIN_VERSION: version }).pluginVersion).toBe(version);
    expect(ExternalAttestationEvidenceSchema.safeParse(p01Evidence(version)).success).toBe(true);
  });

  it("allows the bare version only on the unregistered candidate-A runtime", () => {
    expect(testConfig({ SOPHIA_VOICE_LAB_REGISTERED_APP_ID: "", SOPHIA_VOICE_LAB_PLUGIN_VERSION: "0.1.0" }).pluginVersion).toBe("0.1.0");
    expect(() => testConfig({ SOPHIA_VOICE_LAB_PLUGIN_VERSION: "0.1.0" })).toThrow(/plugin-creator SemVer cachebuster/i);
    expect(ExternalAttestationEvidenceSchema.safeParse(p01Evidence("0.1.0")).success).toBe(false);
  });

  it.each(invalidSemver)("rejects malformed SemVer %s at every boundary", (version) => {
    expect(() => testConfig({ SOPHIA_VOICE_LAB_REGISTERED_APP_ID: "", SOPHIA_VOICE_LAB_PLUGIN_VERSION: version })).toThrow(/SemVer 2\.0\.0/i);
    expect(ExternalAttestationEvidenceSchema.safeParse(p01Evidence(version)).success).toBe(false);
  });

  it.each(helperImpossibleFinalVersions)("rejects helper-impossible final version %s", (version) => {
    expect(testConfig({ SOPHIA_VOICE_LAB_REGISTERED_APP_ID: "", SOPHIA_VOICE_LAB_PLUGIN_VERSION: version }).pluginVersion).toBe(version);
    expect(() => testConfig({ SOPHIA_VOICE_LAB_PLUGIN_VERSION: version })).toThrow(/plugin-creator SemVer cachebuster/i);
    expect(ExternalAttestationEvidenceSchema.safeParse(p01Evidence(version)).success).toBe(false);
  });
});
