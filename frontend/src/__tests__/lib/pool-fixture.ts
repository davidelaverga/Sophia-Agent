import type { JournalEntry } from '../../app/lib/journal';
import type { MemoryPool } from '../../app/lib/memory-pool-envelope';

import { inventoryRecord } from './inventory-fixture';

export function poolFixture(entries?: JournalEntry[], owner = 'user-123', view: 'active' | 'forgotten' = 'active'): MemoryPool {
  const record = inventoryRecord();
  const rows = entries ?? [{ id: record.id, content: record.content, category: record.category,
    created_at: record.created_at, metadata: { authority: 'sophia_canonical', lifecycle: view,
      tier: 'none', scope: 'global', projection_state: 'unavailable', content_revision: 2, memory_governance_revision: 3 } }];
  return { schema: 'mem00.pool.v1', authority: 'sophia_canonical', owner_id: owner, memory_contract_epoch: 1,
    view, status: 'available', snapshot_id: 'a'.repeat(32), snapshot_count: rows.length,
    entries: rows.map(item => ({ ...item, metadata: { ...item.metadata } })) as MemoryPool['entries'], count: rows.length, filters: { category: null, search: null },
    enumeration_complete: true, next_cursor: null, projection_status: 'unavailable', provider_state_queried: false };
}
