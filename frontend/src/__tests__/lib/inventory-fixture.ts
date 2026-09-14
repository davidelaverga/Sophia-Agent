import type { MemoryInventory } from '../../app/lib/memory-inventory-envelope';

export function inventoryRecord(n = 1): MemoryInventory['records'][number] {
  return { kind: 'memory', id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    revision: 2, state: 'active', reviewable: false, session_id: null, extraction_run_id: null,
    source_manifest_ref: null, content: 'CURRENT_SYNTHETIC_TEXT', category: 'fact', memory_governance_revision: 3,
    user_tier: 'none', scope: 'global', created_at: '2026-09-09T00:00:00Z', updated_at: null,
    content_disposition: 'current_canonical_text' };
}

export function inventoryPage(total = 1, start = 0, size = 200): MemoryInventory {
  const records = Array.from({ length: Math.min(size, total - start) }, (_, i) => inventoryRecord(start + i + 1));
  const complete = start + records.length === total;
  return { schema: 'mem00.inventory.v1', memory_contract_epoch: 1, owner_id: 'user-123',
    scope: 'current_saved_and_candidate_state', view: 'all', status: 'available', snapshot_id: 'a'.repeat(32),
    after_key: start ? `memory:${inventoryRecord(start).id}` : null,
    summary: { canonical_records: total, candidate_records: 0, reviewable_pending: 0, withheld_candidates: 0,
      unavailable_review_sources: 0, unfinished_extraction_runs: 0 }, total_count: total, records,
    next_after_key: complete ? null : `memory:${records.at(-1).id}`, enumeration_complete: complete,
    next_cursor: complete ? null : `synthetic-cursor-${start + records.length}`,
    historical_versions_included: false, source_transcripts_included: false, provider_state_queried: false,
    extraction_complete: false };
}
