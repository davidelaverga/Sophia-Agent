import { afterEach, describe, expect, it, vi } from 'vitest';

import { readMemoryObservation, sanitizeMemoryObservation } from '../../app/lib/memory-observability';
import { buildRecapTelemetryReport, createInitialRecapTelemetryState } from '../../app/lib/recap-telemetry-report';

export function metricsFixture() {
  return {
    schema: 'mem00.runtime-metrics.v1', scope: 'serving_process_since_start',
    process_ref: 'process:00000000-0000-0000-0000-000000000001',
    started_at: '2026-09-07T10:00:00+00:00', observed_at: '2026-09-07T10:01:00+00:00',
    deployment_sha: 'a'.repeat(40), environment: 'production', memory_contract_epoch: 1,
    event_count: 5, last_export_status: 'exported', coverage: 'partial', release_certified: false,
    security_status: 'no_violation_observed',
    zero_tolerance_counters: {
      memory_policy_escape_total: 0, memory_cross_owner_admission_total: 0,
      memory_post_tombstone_admission_total: 0, memory_raw_provider_bypass_total: 0,
      legacy_identity_loaded_total: 0, memory_redaction_failure_total: 0,
    },
    durable: { available: false },
  };
}

describe('memory observations', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exports only validated structure through the existing recap report', () => {
    const observation = sanitizeMemoryObservation({ ...metricsFixture(), canonical_content: 'private-sentinel', owner_ref: 'private-owner-sentinel' });
    const report = buildRecapTelemetryReport({
      sessionId: 'synthetic', route: '/recap/synthetic', pageStatus: 'ready',
      telemetry: createInitialRecapTelemetryState({ sessionId: 'synthetic' }),
      artifacts: null, decisions: [], memoryCommitStatus: 'ready', memoryObservation: observation,
      sessionTelemetrySnapshot: null,
    });
    expect(report.memoryGovernance.available).toBe(true);
    expect(JSON.stringify(report)).not.toContain('sentinel');
    expect(JSON.stringify(report.memoryGovernance)).toContain('"release_certified":false');
  });

  it.each([null, {}, { ...metricsFixture(), event_count: -1 }, { ...metricsFixture(), release_certified: true }])('rejects malformed or falsely certifying snapshots', (value) => {
    expect(sanitizeMemoryObservation(value)).toEqual({ available: false, reason: 'unavailable_or_not_authorized' });
  });

  it('a nonzero counter dominates a misleading no-violation label', () => {
    const fixture = metricsFixture();
    fixture.zero_tolerance_counters.memory_policy_escape_total = 1;
    const result = sanitizeMemoryObservation(fixture);
    expect(result.available && result.snapshot.security_status).toBe('SECURITY_HOLD');
  });

  it.each([403, 503])('does not mistake HTTP %s for zero counters', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private-error-sentinel', { status })));
    expect(await readMemoryObservation()).toEqual({ available: false, reason: 'unavailable_or_not_authorized' });
  });

  it('transport outage remains unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-error-sentinel')));
    expect((await readMemoryObservation()).available).toBe(false);
  });
});
