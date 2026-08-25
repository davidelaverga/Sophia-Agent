const TLS_QUERY_KEYS = Object.freeze([
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
]);

const SUPPORTED_MODES = new Set([
  'auto',
  'disable',
  'require',
  'verify-full',
  'no-verify',
]);

function isSupabaseHost(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized.endsWith('.supabase.co')
    || normalized.endsWith('.supabase.com');
}

function normalizeCaPem(caPemRaw) {
  if (caPemRaw === undefined || caPemRaw === null || caPemRaw === '') {
    return undefined;
  }
  if (typeof caPemRaw !== 'string' || caPemRaw.includes('\0')) {
    throw new Error('database_tls_ca_invalid');
  }
  const expanded = caPemRaw.includes('\n')
    ? caPemRaw
    : caPemRaw.replaceAll('\\n', '\n');
  const pem = expanded.trim();
  if (
    Buffer.byteLength(pem, 'utf8') > 64 * 1024
    || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(pem)
  ) {
    throw new Error('database_tls_ca_invalid');
  }
  return `${pem}\n`;
}

export function normalizeDatabaseUrlForExplicitTls(databaseUrl) {
  const normalized = new URL(databaseUrl);
  for (const key of TLS_QUERY_KEYS) normalized.searchParams.delete(key);
  return normalized.toString();
}

export function resolveDatabaseTls({
  databaseUrl,
  modeRaw,
  caPemRaw,
  environmentRaw,
}) {
  const parsed = new URL(databaseUrl);
  const mode = modeRaw?.trim().toLowerCase() || 'auto';
  if (!SUPPORTED_MODES.has(mode)) throw new Error('database_tls_mode_invalid');

  const production = environmentRaw === 'production';
  const supabase = isSupabaseHost(parsed.hostname);
  const queryMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
  const explicitSsl = parsed.searchParams.get('ssl')?.trim().toLowerCase();
  const ca = normalizeCaPem(caPemRaw);

  if (mode === 'disable') {
    if (production) throw new Error('database_tls_insecure_mode_forbidden');
    return Object.freeze({
      mode,
      connectionString: normalizeDatabaseUrlForExplicitTls(databaseUrl),
      ssl: false,
    });
  }
  if (mode === 'no-verify') {
    if (production) throw new Error('database_tls_insecure_mode_forbidden');
    return Object.freeze({
      mode,
      connectionString: normalizeDatabaseUrlForExplicitTls(databaseUrl),
      ssl: Object.freeze({ rejectUnauthorized: false }),
    });
  }

  if (
    production
    && (queryMode === 'disable' || explicitSsl === 'false')
  ) throw new Error('database_tls_insecure_url_forbidden');

  const tlsRequested = mode === 'require'
    || mode === 'verify-full'
    || queryMode === 'require'
    || queryMode === 'verify-ca'
    || queryMode === 'verify-full'
    || explicitSsl === 'true'
    || supabase;
  if (!tlsRequested) {
    return Object.freeze({ mode, connectionString: databaseUrl, ssl: undefined });
  }
  if (supabase && !ca) throw new Error('database_tls_ca_required');

  return Object.freeze({
    mode: mode === 'auto' ? 'verify-full' : mode,
    connectionString: normalizeDatabaseUrlForExplicitTls(databaseUrl),
    ssl: Object.freeze({
      ...(ca ? { ca } : {}),
      rejectUnauthorized: true,
    }),
  });
}
