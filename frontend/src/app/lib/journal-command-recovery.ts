import { z } from 'zod';

import { commandStatusSchema, type CommandReceipt } from './memory-command-receipt';

// One independent storage item per command avoids cross-tab array overwrites.
// These are recovery references, not memory, eligibility or an offline outbox.
const namespace = 'sophia.memory.journal-command.v1:';
const referenceSchema = z.object({
  schema: z.literal('mem00.journal-command-reference.v1'),
  owner_id: z.string().min(1).max(200),
  command_key: z.string().regex(/^journal-(edit|forget|restore|delete)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  memory_id: z.string().uuid(), action: z.enum(['edit', 'forget', 'restore', 'delete']),
}).strict().refine(value => value.command_key.startsWith(`journal-${value.action}-`));
export type JournalCommandReference = z.infer<typeof referenceSchema>;
export type JournalCommandAction = JournalCommandReference['action'];
export const journalCommandEvents = { edit: 'memory_edited', forget: 'memory_forgotten', restore: 'memory_restored', delete: 'memory_tombstoned' } as const;
export type RecoveredJournalCommand = { reference: JournalCommandReference; status: 'committed' | 'fresh_review_required'; receipt: CommandReceipt | null };
const unavailable = () => new Error('Previous memory command recovery unavailable');
function prefix(owner: string) {
  if (!owner || owner.length > 200) throw unavailable();
  return namespace + encodeURIComponent(owner) + ':';
}
function key(reference: JournalCommandReference) { return prefix(reference.owner_id) + reference.command_key; }

export function readJournalCommandReferences(owner: string, storage: Storage = localStorage): JournalCommandReference[] {
  try {
    const ownedPrefix = prefix(owner);
    if (storage.length > 5000) throw unavailable();
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((item): item is string => Boolean(item?.startsWith(ownedPrefix)));
    if (keys.length > 100) throw unavailable();
    return keys.sort().flatMap((item) => {
      const text = storage.getItem(item);
      if (text === null) return []; // Another tab already acknowledged this reference.
      if (text.length > 2048) throw unavailable();
      const reference = referenceSchema.parse(JSON.parse(text));
      if (reference.owner_id !== owner || key(reference) !== item) throw unavailable();
      return [reference];
    });
  } catch { throw unavailable(); }
}

export function rememberJournalCommand(owner: string, memoryId: string, commandKey: string, action: JournalCommandAction = 'edit', storage: Storage = localStorage): JournalCommandReference {
  try {
    const reference = referenceSchema.parse({ schema: 'mem00.journal-command-reference.v1', owner_id: owner,
      memory_id: memoryId, command_key: commandKey, action });
    const existing = readJournalCommandReferences(owner, storage);
    const sameKey = existing.find(item => item.command_key === commandKey);
    if (sameKey && sameKey.memory_id !== memoryId) throw unavailable();
    if (existing.some(item => item.memory_id === memoryId && item.command_key !== commandKey)) throw unavailable();
    if (!sameKey && existing.length >= 100) throw unavailable();
    const text = JSON.stringify(reference);
    storage.setItem(key(reference), text);
    // No request is sent if this reference cannot be retained for reload recovery.
    if (storage.getItem(key(reference)) !== text) throw unavailable();
    return reference;
  } catch { throw unavailable(); }
}

export function acknowledgeJournalCommand(reference: JournalCommandReference, storage: Storage = localStorage): void {
  const validated = referenceSchema.parse(reference);
  const item = key(validated);
  const current = storage.getItem(item);
  if (current === null) return;
  const stored = referenceSchema.parse(JSON.parse(current));
  if (JSON.stringify(stored) !== JSON.stringify(validated)) throw unavailable();
  storage.removeItem(item); // Only this owner/command reference, never unrelated storage.
}

export async function recoverJournalCommands(owner: string, signal: AbortSignal): Promise<RecoveredJournalCommand[]> {
  const references = readJournalCommandReferences(owner);
  const recovered: RecoveredJournalCommand[] = [];
  for (const reference of references) {
    if (signal.aborted) throw unavailable();
    const response = await fetch(`/api/memory/commands/${encodeURIComponent(reference.command_key)}`, { method: 'GET', cache: 'no-store', signal });
    if (!response.ok) throw unavailable();
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 65536) throw unavailable();
    const result = commandStatusSchema.parse(JSON.parse(text));
    if (signal.aborted) throw unavailable();
    if (result.status === 'not_found') {
      recovered.push({ reference, status: 'fresh_review_required', receipt: null });
    } else {
      const receipt = result.receipt;
      if (receipt.memory_id !== reference.memory_id || receipt.event_type !== journalCommandEvents[reference.action]
        || !receipt.content_revision || !receipt.memory_governance_revision) throw unavailable();
      if (reference.action === 'delete' && (receipt.resulting_lifecycle !== 'tombstoned'
        || receipt.status !== 'accepted_and_fenced' || !receipt.tombstone_id)) throw unavailable();
      recovered.push({ reference, status: 'committed', receipt });
    }
  }
  return recovered;
}
