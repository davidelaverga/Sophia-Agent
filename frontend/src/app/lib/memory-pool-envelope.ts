import { z } from 'zod';

const count = z.number().int().safe().nonnegative().max(50000);
const entry = z.object({
  id: z.string().uuid(), content: z.string().min(1), category: z.string().min(1), created_at: z.string(),
  metadata: z.object({
    authority: z.literal('sophia_canonical'), lifecycle: z.enum(['active', 'forgotten']),
    tier: z.enum(['conscious', 'subconscious', 'none']), scope: z.string().min(1),
    projection_state: z.literal('unavailable'), content_revision: z.number().int().safe().positive(),
    memory_governance_revision: z.number().int().safe().positive(),
  }),
});

export const memoryPoolSchema = z.object({
  schema: z.literal('mem00.pool.v1'), memory_contract_epoch: z.literal(1), authority: z.literal('sophia_canonical'),
  owner_id: z.string().min(1), view: z.enum(['active', 'forgotten']), status: z.literal('available'),
  snapshot_id: z.string().regex(/^[a-f0-9]{32}$/), snapshot_count: count,
  filters: z.object({ category: z.string().nullable(), search: z.string().nullable() }),
  entries: z.array(entry).max(50000), count, enumeration_complete: z.literal(true), next_cursor: z.null(),
  projection_status: z.literal('unavailable'), provider_state_queried: z.literal(false),
}).superRefine((value, context) => {
  const ids = value.entries.map(item => item.id);
  const invalid = new Set(ids).size !== ids.length || value.count !== ids.length || value.count > value.snapshot_count
    || (!value.filters.category && !value.filters.search && value.count !== value.snapshot_count)
    || value.entries.some(item => item.metadata.lifecycle !== value.view
      || (value.filters.category && item.category !== value.filters.category)
      || (value.filters.search && !item.content.toLowerCase().includes(value.filters.search)));
  if (invalid) context.addIssue({ code: 'custom', message: 'Complete current Pool unavailable' });
});

// Only the explicit durable-legacy server lane may return this shape. It is
// never a fallback for a missing/malformed canonical envelope or a complete Pool.
const legacyJournalSchema = z.object({
  schema: z.literal('sophia.journal-legacy.v1'), owner_id: z.string().min(1),
  authority: z.literal('legacy_provider'), enumeration_complete: z.literal(false),
  count, entries: z.array(z.object({
    id: z.string().min(1), content: z.string().min(1), category: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(), created_at: z.string().nullable(),
  })).max(50000),
}).superRefine((value, context) => {
  if (value.count !== value.entries.length || new Set(value.entries.map(item => item.id)).size !== value.count
    || value.entries.some(item => item.metadata?.authority === 'sophia_canonical')) {
    context.addIssue({ code: 'custom', message: 'Legacy Journal scope unavailable' });
  }
});

export const journalEnvelopeSchema = z.union([memoryPoolSchema, legacyJournalSchema]);
export type MemoryPool = z.infer<typeof memoryPoolSchema>;
export function parseJournalEnvelope(raw: unknown, owner: string, view?: 'active' | 'forgotten') {
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 8 * 1024 * 1024) throw new Error('Journal response budget exceeded');
  const value = journalEnvelopeSchema.parse(raw);
  if (value.owner_id !== owner || (value.schema === 'mem00.pool.v1' && view && value.view !== view)) throw new Error('Journal scope unavailable');
  if (value.schema === 'sophia.journal-legacy.v1') {
    return { ...value, entries: value.entries.map(item => ({
      id: item.id, content: item.content, category: item.category ?? null,
      metadata: item.metadata ?? null, created_at: item.created_at ?? null,
    })) };
  }
  return value;
}
