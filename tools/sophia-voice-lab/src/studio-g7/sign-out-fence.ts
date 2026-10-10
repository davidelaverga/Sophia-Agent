import { createHash } from "node:crypto";

import type { LabEvent } from "../domain.js";
import { STUDIO_DEAD_OWNER_CLOCK_SKEW_MARGIN_MS, STUDIO_DEAD_OWNER_HEARTBEAT_STALE_MS } from "./lease-release.js";

/**
 * The durable fence around a Studio global sign-out.
 *
 * A global sign-out revokes every refresh token of the one synthetic
 * principal, so it must never land while another run of that principal can
 * hold a live session. Both ledgers therefore, in one critical section that
 * admission also takes (the PostgreSQL run-quota advisory lock; the memory
 * ledger's synchronous section):
 * 1. count the other runs that can hold a live principal session: runs not in
 *    a terminal state, or still holding a browser lease. A terminal run whose
 *    browser is closed holds no session a sign-out could revoke, so it never
 *    blocks (waiting on it could deadlock: P2 of the third review);
 * 2. if there are none, mark the sign-out pending: the run holds admission
 *    (cleanup_complete=false) and a pending marker event is written.
 * Admission refuses with STUDIO_GLOBAL_SIGNOUT_PENDING while a marker is
 * pending. The marker is cleared after the sign-out (confirmed) or when it is
 * abandoned; a run that stays not cleanup-complete keeps holding admission
 * until its recovery completes.
 *
 * No wait cycle: a deferral waits only on a live run (not terminal, or
 * leased). Admission admits one run at a time, and a run never leaves a
 * terminal state or regains a lease, so at most one run is live; its own
 * recovery never waits on a terminal, lease-free run, and the marker is held
 * only for one recovery call (cleared in a finally).
 *
 * Same-run serialization (root's P2): markers are matched by id. A marker is
 * outstanding until a clear for THAT marker id; a worker clears only its own.
 * A begin is refused (`sign_out_in_flight`) while the run has any
 * outstanding marker that is not provably abandoned, and admission stays
 * closed while any run has one, whatever its cleanup flag. A marker is
 * provably abandoned only under the dead-owner rules: on the ledger's clock it
 * is older than STUDIO_GLOBAL_SIGNOUT_OWNER_STALE_MS and its owner's heartbeat
 * is absent or older than that (the heartbeat staleness plus the clock-skew
 * margin), or the latest heartbeat under its owner's id comes from another
 * process boot (the marker records its owner's boot id: a worker restarted
 * under the same instance id is not the process that wrote it); the begin
 * that takes over clears it (`abandoned_owner_dead`). Before its global
 * logout the holder re-checks, in the ledger, that its marker is still
 * outstanding and not abandoned (holdsStudioGlobalSignOut); a holder whose
 * marker was taken over or abandoned signs out only its own session
 * (scope=local), and never counts that as the run's sign-out.
 *
 * A marker never outlives its owner's ability to clear it: a worker clears,
 * during maintenance, every outstanding marker carrying its own worker id
 * that no recovery of this process holds (a clear that failed, or one its
 * previous boot left behind: `abandoned_owner_restarted`).
 */
export const STUDIO_GLOBAL_SIGNOUT_PENDING_KIND = "studio.cleanup.global_sign_out_pending";
export const STUDIO_GLOBAL_SIGNOUT_CLEARED_KIND = "studio.cleanup.global_sign_out_cleared";
export const STUDIO_GLOBAL_SIGNOUT_PENDING_CODE = "STUDIO_GLOBAL_SIGNOUT_PENDING";

/** A marker older than this, whose owner's heartbeat is absent or older than this, is provably abandoned. */
export const STUDIO_GLOBAL_SIGNOUT_OWNER_STALE_MS = STUDIO_DEAD_OWNER_HEARTBEAT_STALE_MS + STUDIO_DEAD_OWNER_CLOCK_SKEW_MARGIN_MS;

export interface StudioSignOutMarker { markerId: string; ownerWorkerIdSha256: string | null; ownerBootIdSha256: string | null; at: Date; seq: number }

/** How a marker's clear is recorded. */
export type StudioSignOutClearOutcome = "confirmed" | "abandoned" | "abandoned_owner_restarted";

/** The latest heartbeat under a marker owner's worker id: when, and from which process boot. */
export interface StudioSignOutOwnerHeartbeat { at: Date; bootIdSha256: string | null }

export function studioWorkerIdSha256(workerId: string): string {
  return createHash("sha256").update(workerId, "utf8").digest("hex");
}

/** Pending markers of one run with no clear for their own marker id. */
export function studioOutstandingSignOutMarkers(events: ReadonlyArray<Pick<LabEvent, "kind" | "seq" | "payload" | "at">>): StudioSignOutMarker[] {
  const cleared = new Set(events.filter((event) => event.kind === STUDIO_GLOBAL_SIGNOUT_CLEARED_KIND && typeof event.payload.marker_id === "string").map((event) => event.payload.marker_id as string));
  return events
    .filter((event) => event.kind === STUDIO_GLOBAL_SIGNOUT_PENDING_KIND && typeof event.payload.marker_id === "string" && !cleared.has(event.payload.marker_id))
    .map((event) => ({ markerId: event.payload.marker_id as string, ownerWorkerIdSha256: typeof event.payload.owner_worker_id_sha256 === "string" ? event.payload.owner_worker_id_sha256 : null, ownerBootIdSha256: typeof event.payload.owner_boot_id_sha256 === "string" ? event.payload.owner_boot_id_sha256 : null, at: event.at, seq: event.seq }))
    .sort((left, right) => left.seq - right.seq);
}

/**
 * Provably abandoned: old enough, and its owner dead on the deciding ledger's
 * clock: no heartbeat under its id, a stale one, or one from another process
 * boot than the one that wrote the marker.
 */
export function studioSignOutMarkerAbandoned(marker: StudioSignOutMarker, owner: StudioSignOutOwnerHeartbeat | null, now: Date): boolean {
  const cutoff = now.getTime() - STUDIO_GLOBAL_SIGNOUT_OWNER_STALE_MS;
  if (marker.at.getTime() >= cutoff) return false;
  if (owner === null || owner.at.getTime() < cutoff) return true;
  return marker.ownerBootIdSha256 !== null && owner.bootIdSha256 !== marker.ownerBootIdSha256;
}

/** The process boot a heartbeat came from (its attestation's boot id), or null. */
export function studioHeartbeatBootIdSha256(attestation: unknown): string | null {
  const boot = attestation !== null && typeof attestation === "object" && !Array.isArray(attestation) ? (attestation as Record<string, unknown>).worker_boot_id_sha256 : null;
  return typeof boot === "string" && /^[a-f0-9]{64}$/.test(boot) ? boot : null;
}

/** True while the run has any outstanding marker (abandoned or not). */
export function studioGlobalSignOutPending(events: ReadonlyArray<Pick<LabEvent, "kind" | "seq" | "payload" | "at">>): boolean {
  return studioOutstandingSignOutMarkers(events).length > 0;
}
