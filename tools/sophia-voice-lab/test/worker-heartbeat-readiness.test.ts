import { describe, expect, it } from "vitest";

import { assessWorkerReadiness, createWebBootIdentity } from "../src/http-server.js";
import { sha256 } from "../src/security.js";
import { WORKER_HEARTBEAT_ATTESTATION_SCHEMA, workerDeploymentIdentitySha256 } from "../src/worker-heartbeat.js";
import { SHA, testConfig, testWorkerHeartbeat } from "./helpers.js";

const WEB_BOOTED_AT = new Date("2026-08-24T12:00:00.000Z");
const WORKER_BOOTED_AT = new Date("2026-08-24T12:00:01.000Z");
const OBSERVED_AT = new Date("2026-08-24T12:00:02.000Z");

function webBoot(config: ReturnType<typeof testConfig>) {
  return createWebBootIdentity(config, "heartbeat-test-web-boot", "heartbeat-test-web-instance", WEB_BOOTED_AT);
}

describe("worker heartbeat deployment and kill-switch attestation", () => {
  it("accepts one post-web-boot worker with the exact same-SHA open deployment identity", () => {
    const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "false" });
    const heartbeat = testWorkerHeartbeat(config, {
      workerId: "worker-open-instance",
      bootToken: "worker-open-boot",
      bootedAt: WORKER_BOOTED_AT,
      observedAt: OBSERVED_AT,
      heartbeatSequence: 7,
      effectiveKillSwitchEngaged: false,
    });
    const assessment = assessWorkerReadiness(config, [heartbeat], webBoot(config));

    expect(assessment).toMatchObject({ runtimeReady: true, gateSettled: true, safeForWeb: true });
    expect(assessment.component).toMatchObject({
      ready: true,
      execution_gate_settled: true,
      expected_kill_switch_engaged: false,
      observed_kill_switch_engaged: false,
      expected_deployment_identity_sha256: workerDeploymentIdentitySha256(config, false),
      heartbeat_attestation: {
        schema: WORKER_HEARTBEAT_ATTESTATION_SCHEMA,
        service: "sophia-voice-lab-worker",
        service_version: SHA,
        repository_candidate_sha: SHA,
        deployment_identity_sha256: workerDeploymentIdentitySha256(config, false),
        worker_boot_id_sha256: sha256("worker-open-boot"),
        worker_instance_id_sha256: sha256("worker-open-instance"),
        booted_at: WORKER_BOOTED_AT.toISOString(),
        heartbeat_sequence: 7,
        effective_kill_switch_engaged: false,
        observed_at: OBSERVED_AT.toISOString(),
      },
    });
  });

  it("rejects legacy, pre-web-boot, multiple-boot, and stale same-SHA configuration rows", () => {
    const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "false" });
    const exact = testWorkerHeartbeat(config, { workerId: "worker-current", bootToken: "current-boot", bootedAt: WORKER_BOOTED_AT, observedAt: OBSERVED_AT });

    expect(assessWorkerReadiness(config, [{ ...exact, attestation: null }], webBoot(config)).component)
      .toMatchObject({ ready: false, detail: { reason: "heartbeat_attestation_missing" } });
    expect(assessWorkerReadiness(config, [testWorkerHeartbeat(config, {
      workerId: "worker-before-web",
      bootedAt: new Date(WEB_BOOTED_AT.getTime() - 2_000),
      observedAt: new Date(WEB_BOOTED_AT.getTime() - 1),
    })], webBoot(config)).component).toMatchObject({ ready: false, detail: { reason: "heartbeat_not_observed_after_web_boot" } });
    expect(assessWorkerReadiness(config, [exact, testWorkerHeartbeat(config, {
      workerId: "worker-prior-boot",
      bootToken: "prior-boot",
      bootedAt: WORKER_BOOTED_AT,
      observedAt: OBSERVED_AT,
    })], webBoot(config)).component).toMatchObject({ ready: false, live_workers: 2, detail: { reason: "live_worker_cardinality_invalid" } });

    const staleConfig = testConfig({
      SOPHIA_VOICE_LAB_KILL_SWITCH: "false",
      SOPHIA_VOICE_LAB_PLUGIN_PACKAGE_SHA256: "e".repeat(64),
    });
    const staleSameSha = testWorkerHeartbeat(staleConfig, { workerId: "worker-stale-config", bootedAt: WORKER_BOOTED_AT, observedAt: OBSERVED_AT });
    expect(staleSameSha.serviceVersion).toBe(config.serviceVersion);
    expect(assessWorkerReadiness(config, [staleSameSha], webBoot(config)).component)
      .toMatchObject({ ready: false, detail: { reason: "heartbeat_deployment_identity_mismatch" } });
  });

  it("keeps web-close health safe while exposing the unsettled worker gate, then proves the new closed boot", () => {
    const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
    const stillOpen = testWorkerHeartbeat(config, {
      workerId: "worker-open-before-close",
      bootToken: "worker-open-before-close-boot",
      bootedAt: WORKER_BOOTED_AT,
      observedAt: OBSERVED_AT,
      effectiveKillSwitchEngaged: false,
    });
    const transition = assessWorkerReadiness(config, [stillOpen], webBoot(config));
    expect(transition).toMatchObject({ runtimeReady: true, gateSettled: false, safeForWeb: true });
    expect(transition.component).toMatchObject({ ready: true, execution_gate_settled: false, expected_kill_switch_engaged: true, observed_kill_switch_engaged: false });

    const closed = testWorkerHeartbeat(config, {
      workerId: "worker-closed-after-redeploy",
      bootToken: "worker-closed-after-redeploy-boot",
      bootedAt: new Date(WORKER_BOOTED_AT.getTime() + 1_000),
      observedAt: new Date(OBSERVED_AT.getTime() + 1_000),
      effectiveKillSwitchEngaged: true,
    });
    const settled = assessWorkerReadiness(config, [closed], webBoot(config));
    expect(settled).toMatchObject({ runtimeReady: true, gateSettled: true, safeForWeb: true });
    expect(settled.component).toMatchObject({ ready: true, execution_gate_settled: true, expected_kill_switch_engaged: true, observed_kill_switch_engaged: true });
    expect(closed.attestation?.worker_boot_id_sha256).not.toBe(stillOpen.attestation?.worker_boot_id_sha256);
    expect(closed.attestation?.deployment_identity_sha256).toBe(workerDeploymentIdentitySha256(config, true));
  });
});
