export interface PrincipalProvisionConfig {
  readonly mcpOrigin: string;
  readonly operatorBearer: string;
  readonly environment: 'production';
  readonly idempotencyKey: string;
  readonly expectedDeployment: Readonly<{ frontend: string; backend: string; voice: string }>;
  readonly expectedMcpSha: string;
}

export class VoiceLabPrincipalProvisionError extends Error {
  readonly code: string;
}

export function loadPrincipalProvisionConfig(env?: NodeJS.ProcessEnv): PrincipalProvisionConfig;

export function provisionVoiceLabPrincipal(
  config: PrincipalProvisionConfig,
  options?: { fetchImpl?: typeof fetch },
): Promise<Readonly<{
  schema: 'sophia_voice_lab_principal_provision_receipt_v1';
  ok: true;
  provisioned: boolean;
  idempotent_replay: boolean;
  idempotency_key_sha256: string;
  operator_request_sha256: string;
  principal_id_sha256: string;
  capability_sha256: string;
  capability_jti_sha256: string;
  test_run_id_sha256: string;
  cleanup_obligation_id_sha256: string;
  environment: 'production';
  frontend_build: string;
  mcp_build: string;
  expected_deployment: Readonly<{ frontend: string; backend: string; voice: string }>;
  frontend_attempts: number;
  frontend_reconciled: boolean;
  auth_audit_id: string;
  audit_observed_at: string;
  operator_subject_sha256: string;
  receipt_sha256: string;
  operator_attempts: number;
}>>;

export function main(env?: NodeJS.ProcessEnv): Promise<void>;
