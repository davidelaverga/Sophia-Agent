import { z } from 'zod';

const count = z.number().int().safe().nonnegative();
const record = z.object({
  kind: z.enum(['candidate', 'memory']), id: z.string().uuid(), revision: count.positive(),
  state: z.enum(['pending_review', 'approved', 'rejected', 'expired', 'legacy_quarantined', 'active', 'forgotten', 'tombstoned']),
  reviewable: z.boolean(), session_id: z.string().nullable(), extraction_run_id: z.string().uuid().nullable(),
  source_manifest_ref: z.string().nullable(), content: z.string().nullable(), category: z.string().nullable(),
  memory_governance_revision: count.positive().nullable(), user_tier: z.enum(['conscious', 'subconscious', 'none']).nullable(),
  scope: z.string().nullable(), created_at: z.string(), updated_at: z.string().nullable(),
  content_disposition: z.enum(['current_review_text', 'current_canonical_text', 'withheld_not_reviewable', 'withheld_tombstoned']),
}).superRefine((value, context) => {
  const candidate = value.kind === 'candidate';
  const expected = candidate ? value.reviewable ? 'current_review_text' : 'withheld_not_reviewable'
    : value.state === 'tombstoned' ? 'withheld_tombstoned' : 'current_canonical_text';
  const invalid = value.content_disposition !== expected
    || (candidate && (!['pending_review', 'approved', 'rejected', 'expired', 'legacy_quarantined'].includes(value.state)
      || !value.session_id || !value.extraction_run_id || !value.source_manifest_ref
      || value.memory_governance_revision !== null || value.user_tier !== null || value.scope !== null
      || (value.reviewable && value.state !== 'pending_review')))
    || (!candidate && (!['active', 'forgotten', 'tombstoned'].includes(value.state) || value.reviewable
      || value.memory_governance_revision === null || value.user_tier === null
      || value.session_id !== null || value.extraction_run_id !== null || value.source_manifest_ref !== null))
    || (expected.startsWith('withheld') ? value.content !== null || value.category !== null || value.scope !== null
      : !value.content || !value.category || (!candidate && !value.scope));
  if (invalid) context.addIssue({ code: 'custom', message: 'Inventory content authority unavailable' });
});

export const memoryInventorySchema = z.object({
  schema: z.literal('mem00.inventory.v1'), memory_contract_epoch: z.literal(1), owner_id: z.string().min(1),
  scope: z.literal('current_saved_and_candidate_state'), view: z.enum(['all', 'saved', 'active', 'forgotten', 'pending_review']),
  status: z.literal('available'), snapshot_id: z.string().regex(/^[a-f0-9]{32}$/), after_key: z.string().nullable(),
  summary: z.object({ canonical_records: count, candidate_records: count, reviewable_pending: count,
    withheld_candidates: count, unavailable_review_sources: count, unfinished_extraction_runs: count }),
  total_count: count, records: z.array(record).max(200), next_after_key: z.string().nullable(),
  enumeration_complete: z.boolean(), next_cursor: z.string().min(1).max(512).nullable(),
  historical_versions_included: z.literal(false), source_transcripts_included: z.literal(false),
  provider_state_queried: z.literal(false), extraction_complete: z.literal(false),
}).superRefine((value, context) => {
  const keys = value.records.map((item) => `${item.kind}:${item.id}`);
  const invalid = new Set(keys).size !== keys.length || keys.some((key, i) => i > 0 && key <= keys[i - 1])
    || keys.some((key) => value.after_key !== null && key <= value.after_key)
    || value.total_count < keys.length || value.summary.candidate_records !== value.summary.reviewable_pending + value.summary.withheld_candidates
    || value.enumeration_complete !== (value.next_cursor === null && value.next_after_key === null)
    || (!value.enumeration_complete && (!keys.length || value.next_after_key !== keys.at(-1) || !value.next_cursor))
    || (value.after_key === null && value.enumeration_complete && keys.length !== value.total_count)
    || (value.view === 'all' && value.total_count !== value.summary.canonical_records + value.summary.candidate_records)
    || (value.view === 'pending_review' && (value.total_count !== value.summary.reviewable_pending || value.records.some((item) => item.kind !== 'candidate' || !item.reviewable)))
    || (['active', 'forgotten'].includes(value.view) && value.records.some((item) => item.kind !== 'memory' || item.state !== value.view))
    || (value.view === 'saved' && value.records.some((item) => item.kind !== 'memory' || !['active', 'forgotten'].includes(item.state)));
  if (invalid) context.addIssue({ code: 'custom', message: 'Inventory snapshot unavailable' });
});

export type MemoryInventory = z.infer<typeof memoryInventorySchema>;
export { record as memoryInventoryRecordSchema };

/** Publish only one completely enumerated snapshot, within explicit resource limits. */
export async function readCompleteInventory(ownerId: string, fetchPage: (cursor: string | null) => Promise<unknown>): Promise<MemoryInventory> {
  let cursor: string | null = null;
  let previousKey: string | null = null;
  let first: MemoryInventory | null = null;
  const records: MemoryInventory['records'] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let bytes = 0;
  for (let pageIndex = 0; pageIndex < 250; pageIndex++) {
    const raw = await fetchPage(cursor);
    bytes += new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    if (bytes > 8 * 1024 * 1024) throw new Error('Inventory export budget exceeded');
    const page = memoryInventorySchema.parse(raw);
    if (page.owner_id !== ownerId || page.view !== 'all' || page.after_key !== previousKey
      || (first && (page.snapshot_id !== first.snapshot_id || page.total_count !== first.total_count
        || JSON.stringify(page.summary) !== JSON.stringify(first.summary)))) throw new Error('Inventory snapshot changed');
    first ??= page;
    for (const item of page.records) {
      const key = `${item.kind}:${item.id}`;
      if (ids.has(key)) throw new Error('Inventory page repeated');
      ids.add(key); records.push(item);
    }
    if (records.length > first.total_count || records.length > 50000) throw new Error('Inventory export incomplete');
    if (page.enumeration_complete) {
      if (records.length !== first.total_count) throw new Error('Inventory export incomplete');
      return { ...first, records, enumeration_complete: true, next_after_key: null, next_cursor: null };
    }
    cursor = page.next_cursor;
    if (!cursor || cursors.has(cursor)) throw new Error('Inventory cursor repeated');
    cursors.add(cursor); previousKey = page.next_after_key;
  }
  throw new Error('Inventory export page budget exceeded');
}
