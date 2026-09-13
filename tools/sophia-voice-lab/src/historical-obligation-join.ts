import { z } from "zod";
import { HistoricalInventoryBindingSchema, historicalInventoryCommitment } from "./historical-inventory-commitment.js";
import { retentionHmac } from "./retention-identity.js";
import { canonicalRequestHash, sha256 } from "./security.js";

/** Private identifier join, not a source attestation. Candidates must come from
 * an authorized owning-system read. No raw candidate, HMAC or key leaves this
 * function. A match proves only consistency with the retained recovery key;
 * it does not reconstruct the run/caller, ownership, or cleanup evidence. */
export function joinHistoricalObligations(rawInventory: unknown, rawCandidates: unknown, retentionKey: string) {
  const inventorySha256 = historicalInventoryCommitment(rawInventory);
  const inventory = HistoricalInventoryBindingSchema.parse(rawInventory);
  const candidates = z.array(z.string().uuid()).max(10_000).parse(rawCandidates);
  if (typeof retentionKey !== "string" || retentionKey.length === 0 || retentionKey.length > 4096
    || new Set(candidates).size !== candidates.length) throw new Error("HISTORICAL_JOIN_INPUT_INVALID");
  const byRecovery = new Map<string, typeof inventory.tombstones>();
  for (const row of inventory.tombstones) {
    const rows = byRecovery.get(row.recoveryIdSha256) ?? [];
    rows.push(row);
    byRecovery.set(row.recoveryIdSha256, rows);
  }
  const entries = candidates.map(id => {
    const cleanupObligationIdSha256 = sha256(id);
    const matches = byRecovery.get(sha256(retentionHmac(retentionKey, "recovery", id))) ?? [];
    if (matches.length > 1) throw new Error("HISTORICAL_JOIN_AMBIGUOUS");
    return matches.length === 1
      ? { cleanupObligationIdSha256, status: "keyed_identity_match" as const,
        lookupIdSha256: matches[0]!.lookupIdSha256, recoveryIdSha256: matches[0]!.recoveryIdSha256 }
      : { cleanupObligationIdSha256, status: "not_matched" as const };
  }).sort((a, b) => a.cleanupObligationIdSha256.localeCompare(b.cleanupObligationIdSha256));
  const matched = new Set(entries.flatMap(e => e.status === "keyed_identity_match" ? [e.lookupIdSha256] : []));
  const result = { schema: "sophia.voice-lab.historical-obligation-join.v1" as const,
    inventorySha256, sourceAuthenticated: false as const, ownershipProven: false as const,
    cleanupProven: false as const, upgradeAuthorized: false as const, entries,
    unmatchedTombstones: inventory.tombstones.map(t => t.lookupIdSha256).filter(id => !matched.has(id)).sort() };
  return { ...result, reportSha256: canonicalRequestHash(result) };
}
