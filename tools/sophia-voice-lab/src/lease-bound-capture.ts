import { VoiceLabError, labError, type LabEvent } from "./domain.js";
import type { EventAppendInput } from "./ledger.js";
import { canonicalRequestHash } from "./security.js";

/**
 * Plans one lease-bound browser capture batch (#151) against the events
 * already durable under the same dedupe keys, before anything is written: an
 * exact replay is skipped, a key reused with different evidence is refused,
 * and a key repeated inside the batch is written once, as consecutive single
 * appends would write it. Both ledgers write the returned inputs only while
 * the exact lease holds, in one atomic step.
 */
export function pendingCaptureInputs(inputs: readonly EventAppendInput[], durable: ReadonlyMap<string, Pick<LabEvent, "kind" | "source" | "payload">>): EventAppendInput[] {
  const seen = new Map(durable);
  const pending: EventAppendInput[] = [];
  for (const input of inputs) {
    const prior = input.dedupeKey === undefined ? undefined : seen.get(input.dedupeKey);
    if (prior) {
      if (prior.kind !== input.kind || prior.source !== input.source || canonicalRequestHash(prior.payload) !== canonicalRequestHash(input.payload)) {
        throw new VoiceLabError(labError("DEDUPE_CONFLICT", "Event dedupe key was reused with different canonical evidence.", "conflict"));
      }
      continue;
    }
    if (input.dedupeKey !== undefined) seen.set(input.dedupeKey, input);
    pending.push(input);
  }
  return pending;
}
