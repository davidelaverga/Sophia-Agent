import { z } from "zod";
import { BASE_MIGRATION_SHA256 } from "./migration-bundle.js";
import { canonicalRequestHash } from "./security.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.string().regex(/^(0|[1-9][0-9]*)$/);
const time = z.string().datetime().refine(value => new Date(value).toISOString() === value);
export const HistoricalInventoryBindingSchema = z.object({
  sourceMigrationSha256: z.literal(BASE_MIGRATION_SHA256),
  enumerationComplete: z.literal(true), tombstoneEnumerationComplete: z.literal(true),
  runCount: count, browserLeaseCount: count, tombstoneCount: count, unconfirmedTombstoneCount: count,
  entries: z.array(z.object({
    runIdSha256: hash, assessment: z.string().min(1).max(128),
    controlSha256: hash.optional(), liveCleanupComplete: z.boolean().optional(),
  }).strict()).max(10_000),
  tombstones: z.array(z.object({
    lookupIdSha256: hash, recoveryIdSha256: hash,
    remotePurgeStatus: z.enum(["confirmed", "unconfirmed"]), purgedAt: time, controlExpiresAt: time,
    assessment: z.literal("independent_historical_reconciliation_required"),
  }).strict()).max(10_000),
}).strict();

/** Stable content commitment for matching independently sourced reconciliation
 * to the complete locked inventory. This is NOT a signature, cleanup receipt,
 * source authentication or upgrade authorization. Observation time is excluded
 * so an unchanged later snapshot can be matched without weakening row binding. */
export function historicalInventoryCommitment(raw: unknown): string {
  const value = HistoricalInventoryBindingSchema.parse(raw);
  if (BigInt(value.runCount) !== BigInt(value.entries.length)
    || BigInt(value.tombstoneCount) !== BigInt(value.tombstones.length)
    || BigInt(value.unconfirmedTombstoneCount) !== BigInt(value.tombstones.filter(t => t.remotePurgeStatus === "unconfirmed").length)
    || new Set(value.entries.map(e => e.runIdSha256)).size !== value.entries.length
    || new Set(value.tombstones.map(t => t.lookupIdSha256)).size !== value.tombstones.length
    || value.tombstones.some(t => t.controlExpiresAt <= t.purgedAt)
    || value.entries.some(e => e.assessment === "historical_event_bound_exceeded")) {
    throw new Error("HISTORICAL_INVENTORY_INCOMPLETE_OR_CONFLICTING");
  }
  return canonicalRequestHash({
    schema: "sophia.voice-lab.historical-inventory-commitment.v1",
    ...value,
    entries: [...value.entries].sort((a, b) => a.runIdSha256.localeCompare(b.runIdSha256)),
    tombstones: [...value.tombstones].sort((a, b) => a.lookupIdSha256.localeCompare(b.lookupIdSha256)),
  });
}
