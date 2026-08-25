export interface D02RoleProvisionConfig {
  readonly ownerDsn: string;
  readonly expectedDatabase: string;
  readonly password: string;
  readonly gatewayDsn: string;
  readonly ssl:
    | false
    | { readonly ca?: string; readonly rejectUnauthorized: boolean }
    | undefined;
}

export interface D02RoleProvisionClient {
  query(
    statement: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

export interface D02RoleProvisionPool {
  connect(): Promise<D02RoleProvisionClient>;
  end(): Promise<void>;
}

export class VoiceLabD02RoleProvisionError extends Error {
  readonly code: string;
}

export function loadD02RoleProvisionConfig(
  env?: NodeJS.ProcessEnv,
): D02RoleProvisionConfig;

export function provisionVoiceLabD02Role(
  config: D02RoleProvisionConfig,
  options?: {
    pool?: D02RoleProvisionPool;
    gatewayPoolFactory?: (
      config: D02RoleProvisionConfig,
    ) => D02RoleProvisionPool;
  },
): Promise<Readonly<{
  ok: true;
  role: 'sophia_voice_lab_gateway';
  role_sha256: string;
  database_sha256: string;
  created: boolean;
  credential_action: 'created' | 'preserved';
  application_schema_count: number;
  authority_attested: true;
  login_attested: true;
  membership_contract_version: 'supabase_pg17.directional_membership.v1';
  canonical_inbound_membership_count: 0 | 1;
  membership_attested: true;
  support_required: false;
  support_action: null;
}>>;

export function main(env?: NodeJS.ProcessEnv): Promise<void>;
