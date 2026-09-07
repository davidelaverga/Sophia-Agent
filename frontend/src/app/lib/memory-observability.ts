import { z } from 'zod';

const count = z.number().int().nonnegative().safe();
const zeroCounters = z.object({
  memory_policy_escape_total: count,
  memory_cross_owner_admission_total: count,
  memory_post_tombstone_admission_total: count,
  memory_raw_provider_bypass_total: count,
  legacy_identity_loaded_total: count,
  memory_redaction_failure_total: count,
});
const durable = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    pagination_complete: z.literal(true),
    transactionally_consistent: z.literal(false),
    terminal_zero_certified: z.literal(false),
    started_at: z.iso.datetime({ offset: true }),
    observed_at: z.iso.datetime({ offset: true }),
    gauges: z.object({
      candidates: z.object({ pending_review: count, legacy_quarantined: count }),
      canonical: z.object({ active: count, forgotten: count, tombstoned: count }),
      bindings: z.object({ eligible: count, stale: count, purged: count }),
      candidate_versions: z.object({ retained: count, unscrubbed: count }),
      canonical_versions: z.object({ retained: count, unscrubbed: count }),
      active_fault_settings: count,
      purge_backlog: count,
      purge_oldest_age_seconds: z.number().finite().nonnegative(),
    }),
  }),
]);

// Explicit projection at the export boundary: extra fields (including raw
// content accidentally added upstream) are never copied to the recap report.
const snapshot = z.object({
  schema: z.literal('mem00.runtime-metrics.v1'),
  scope: z.literal('serving_process_since_start'),
  process_ref: z.string().regex(/^process:[0-9a-f-]{36}$/),
  started_at: z.iso.datetime({ offset: true }),
  observed_at: z.iso.datetime({ offset: true }),
  deployment_sha: z.string().regex(/^(?:[0-9a-f]{40}|unknown)$/),
  environment: z.enum(['production', 'staging', 'development', 'test', 'unknown']),
  memory_contract_epoch: count,
  event_count: count,
  last_export_status: z.enum(['exported', 'disabled', 'unavailable', 'unknown', 'not_attempted']),
  zero_tolerance_counters: zeroCounters,
  security_status: z.enum(['SECURITY_HOLD', 'no_violation_observed']),
  coverage: z.literal('partial'),
  release_certified: z.literal(false),
  durable,
});

export type MemoryObservation =
  | { available: true; snapshot: z.infer<typeof snapshot> }
  | { available: false; reason: 'unavailable_or_not_authorized' };

export function sanitizeMemoryObservation(value: unknown): MemoryObservation {
  const result = snapshot.safeParse(value);
  if (!result.success) return { available: false, reason: 'unavailable_or_not_authorized' };
  if (Object.values(result.data.zero_tolerance_counters).some((value) => value > 0)) {
    result.data.security_status = 'SECURITY_HOLD';
  }
  return { available: true, snapshot: result.data };
}

export async function readMemoryObservation(): Promise<MemoryObservation> {
  try {
    const response = await fetch('/api/memory/observability', {
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    if (response.ok) return sanitizeMemoryObservation(await response.json());
  } catch { /* Diagnostic failure does not change product memory behavior. */ }
  return { available: false, reason: 'unavailable_or_not_authorized' };
}
