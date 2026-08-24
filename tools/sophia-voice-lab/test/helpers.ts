import { randomUUID } from "node:crypto";

import { loadConfig, type VoiceLabConfig } from "../src/config.js";
import { initialVerdicts, type RunRecord } from "../src/domain.js";
import type { WorkerHeartbeat } from "../src/ledger.js";
import { createWorkerBootIdentity, createWorkerHeartbeatAttestation } from "../src/worker-heartbeat.js";

export const SHA = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);
export const SHA_D = "d".repeat(40);

export function testConfig(overrides: NodeJS.ProcessEnv = {}, processRole: "web" | "worker" = "web"): VoiceLabConfig {
  return loadConfig({
    NODE_ENV: "test",
    RENDER_GIT_COMMIT: SHA,
    SOPHIA_VOICE_LAB_REPOSITORY_CANDIDATE_SHA: SHA,
    SOPHIA_VOICE_LAB_REGISTERED_APP_ID: "plugin_asdk_app_voice_lab_test_0001",
    SOPHIA_VOICE_LAB_PLUGIN_VERSION: "0.1.0+codex.test",
    SOPHIA_VOICE_LAB_ENVIRONMENT: "production",
    SOPHIA_VOICE_LAB_BEARER_TOKEN: "base-bearer-credential-0000000000000001",
    SOPHIA_VOICE_LAB_FAULT_BEARER_TOKEN: "fault-bearer-credential-000000000000001",
    SOPHIA_VOICE_LAB_ATTESTATION_TRANSPORT_TOKENS_JSON: JSON.stringify({
      external_mcp_client: "external-client-attestation-transport-000001",
      deployment_control: "deployment-control-attestation-transport-01",
      platform_plugin: "platform-plugin-attestation-transport-00001",
    }),
    SOPHIA_VOICE_LAB_PRINCIPAL_ID: "voice-lab-user-1",
    SOPHIA_VOICE_LAB_GRANT_SECRET: "frontend-grant-secret-000000000000000001",
    SOPHIA_VOICE_LAB_CAPABILITY_SECRET: "capability-chain-secret-0000000000000001",
    SOPHIA_VOICE_LAB_RECOVERY_INTERNAL_SECRET: "recovery-internal-secret-000000000000001",
    SOPHIA_VOICE_LAB_ALLOWED_ORIGINS: "http://frontend.test,http://gateway.test,http://voice.test,http://langgraph.test",
    SOPHIA_VOICE_LAB_KILL_SWITCH: "false",
    SOPHIA_VOICE_LAB_MIN_UTTERANCE_INTERVAL_MS: "0",
    ...overrides,
  }, processRole);
}

export function testRun(patch: Partial<RunRecord> = {}): RunRecord {
  const now = new Date();
  return {
    id: randomUUID(), callerId: "caller-1", principalId: "voice-lab-user-1", testRunId: randomUUID(), cleanupObligationId: randomUUID(), environment: "production",
    scenarioId: "V-P01", scenarioVersion: "vt00.scenarios.v1", state: "reserved", version: 1,
    target: {
      frontendUrl: "http://frontend.test",
      gatewayUrl: "http://gateway.test",
      voiceUrl: "http://voice.test",
      langgraphUrl: "http://langgraph.test",
      expectedDeployment: { frontend: SHA, backend: SHA_B, voice: SHA_C },
      expectedDependencies: { langgraph: SHA_D },
    },
    observedDeployment: {}, capturePolicy: { rawAudio: false, screenshot: true, video: false, retentionHours: 24 }, verdicts: initialVerdicts(),
    canonicalSessionId: null, threadId: null, providerSessionId: null, traceId: null, providerEpoch: null, turnId: null,
    latestCursor: 0, expiresAt: new Date(now.getTime() + 60_000), createdAt: now, updatedAt: now, cleanupComplete: false,
    retentionPurgeDueAt: null, retentionPurgePending: false, retentionPurgeVerifiedAt: null, evidencePurgedAt: null, terminalError: null,
    ...patch,
  };
}

export function testWorkerHeartbeat(
  config: VoiceLabConfig,
  options: {
    workerId?: string;
    effectiveKillSwitchEngaged?: boolean;
    bootToken?: string;
    bootedAt?: Date;
    observedAt?: Date;
    heartbeatSequence?: number;
    browserReady?: boolean;
    fixturesReady?: boolean;
  } = {},
): WorkerHeartbeat {
  const workerId = options.workerId ?? "worker-1";
  const observedAt = options.observedAt ?? new Date();
  const bootedAt = options.bootedAt ?? new Date(observedAt.getTime() - 1_000);
  const identity = createWorkerBootIdentity(workerId, options.bootToken ?? `test-boot:${workerId}:${bootedAt.toISOString()}`, bootedAt);
  const effectiveKillSwitchEngaged = options.effectiveKillSwitchEngaged ?? config.killSwitch;
  return {
    workerId,
    serviceVersion: config.serviceVersion,
    browserReady: options.browserReady ?? true,
    observedAt,
    attestation: createWorkerHeartbeatAttestation(config, identity, effectiveKillSwitchEngaged, options.heartbeatSequence ?? 1),
    detail: { fixtures_ready: options.fixturesReady ?? true },
  };
}

export const caller = { subject: "caller-1", scopes: new Set(["voice_lab:read", "voice_lab:run", "voice_lab:fault"]) };
