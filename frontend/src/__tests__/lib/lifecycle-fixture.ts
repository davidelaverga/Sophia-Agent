import { inventoryRecord } from './inventory-fixture';

export function lifecycleResult(action: 'forget' | 'restore' | 'delete', key: string, state = 'active') {
  const record = inventoryRecord();
  const available = ['active', 'forgotten', 'tombstoned'].includes(state);
  const deleted = action === 'delete';
  return {
    schema: 'mem00.command-result.v1', owner_id: 'user-123', command_key: key,
    status: 'committed', historical_result_only: true,
    receipt: { event_id: '20000000-0000-4000-8000-000000000001', operation_id: 'original-' + action + '-operation',
      event_type: { forget: 'memory_forgotten', restore: 'memory_restored', delete: 'memory_tombstoned' }[action],
      resulting_lifecycle: deleted ? 'tombstoned' : action === 'forget' ? 'forgotten' : 'active',
      memory_id: record.id, content_revision: 2, memory_governance_revision: 4,
      user_catalog_generation: 4, user_revocation_epoch: 0, idempotent_replay: true,
      ...(deleted ? { status: 'accepted_and_fenced', provider_purge: 'purge_pending', tombstone_id: '30000000-0000-4000-8000-000000000001' } : {}),
    },
    current_view: { schema: 'mem00.current-memory.v1', owner_id: 'user-123', memory_id: record.id,
      status: available ? 'available' : state, lifecycle: available ? state : null,
      content_revision: available ? 4 : null, memory_governance_revision: available ? 6 : null,
      memory: ['active', 'forgotten'].includes(state) ? { ...record, state, content: 'LATER_CANONICAL_TEXT', revision: 4, memory_governance_revision: 6 } : null,
      provider_state_queried: false, current_view_only: true,
    },
    privacy_disposition: deleted ? {
      scope: 'canonical_memory_only', canonical_fence: 'committed_in_original_receipt',
      canonical_plaintext_erasure: 'not_verified_in_this_response', provider_cleanup: 'not_verified_in_this_response',
      derived_invalidation: 'not_verified_in_this_response', managed_browser_erasure: 'not_verified_in_this_response',
      source_transcript: 'not_deleted_by_this_command', other_account_data: 'not_covered_by_mem00',
      verification_as_of: null, provider_state_queried: false,
    } : null,
  };
}
