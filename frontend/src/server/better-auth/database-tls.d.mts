export type DatabaseTlsMode =
  | 'auto'
  | 'disable'
  | 'require'
  | 'verify-full'
  | 'no-verify';

export interface DatabaseTlsResolution {
  readonly mode: DatabaseTlsMode;
  readonly connectionString: string;
  readonly ssl:
    | false
    | Readonly<{ readonly ca?: string; readonly rejectUnauthorized: boolean }>
    | undefined;
}

export function normalizeDatabaseUrlForExplicitTls(databaseUrl: string): string;

export function resolveDatabaseTls(input: {
  readonly databaseUrl: string;
  readonly modeRaw?: string;
  readonly caPemRaw?: string;
  readonly environmentRaw?: string;
}): DatabaseTlsResolution;
