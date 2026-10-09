import type { LabEvent } from "../domain.js";

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
 */
export const STUDIO_GLOBAL_SIGNOUT_PENDING_KIND = "studio.cleanup.global_sign_out_pending";
export const STUDIO_GLOBAL_SIGNOUT_CLEARED_KIND = "studio.cleanup.global_sign_out_cleared";
export const STUDIO_GLOBAL_SIGNOUT_PENDING_CODE = "STUDIO_GLOBAL_SIGNOUT_PENDING";

/** True while the run's latest fence event is a pending marker. */
export function studioGlobalSignOutPending(events: ReadonlyArray<Pick<LabEvent, "kind" | "seq">>): boolean {
  let latest: Pick<LabEvent, "kind" | "seq"> | null = null;
  for (const event of events) {
    if (event.kind !== STUDIO_GLOBAL_SIGNOUT_PENDING_KIND && event.kind !== STUDIO_GLOBAL_SIGNOUT_CLEARED_KIND) continue;
    if (!latest || event.seq > latest.seq) latest = event;
  }
  return latest?.kind === STUDIO_GLOBAL_SIGNOUT_PENDING_KIND;
}
