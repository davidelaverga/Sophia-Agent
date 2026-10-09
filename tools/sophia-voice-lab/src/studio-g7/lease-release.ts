import { createHash } from "node:crypto";

import { TERMINAL_RUN_STATES, type LabEvent, type RunState } from "../domain.js";
import { STUDIO_G7_SCENARIO_VERSION } from "./scenarios.js";
import { STUDIO_ACCESS_TOKEN_LIFETIME_BOUND_S } from "./supabase-session.js";

/**
 * Release of a dead foreign worker's Studio browser lease.
 *
 * Common gates: a Studio run in a terminal state, the lease expired on the
 * deciding ledger's clock, and the owner's heartbeat stale by more than
 * `heartbeatStaleMs` plus STUDIO_DEAD_OWNER_CLOCK_SKEW_MARGIN_MS (heartbeats
 * are stamped by each worker's own clock, so a live owner whose clock runs
 * behind must never look dead).
 *
 * Then one of two bases:
 *
 * 1. `owner_cleanup_complete`: the owner's own cleanup for THIS lease epoch
 *    is durable. Its browser (the execution epoch acquired under this lease)
 *    was proven closed, the principal was signed out globally and the run's
 *    exchange was confirmed ended after its join. Nothing of that browser can
 *    act any more, so the lease is released at once.
 *
 * 2. `quiesced`: otherwise the dead owner's browser cannot be proven closed by
 *    anyone else, so the lease is released only when it can no longer act on
 *    the product:
 *    - a global sign-out of the principal was confirmed after the lease
 *      expired (revoking every refresh token of the principal);
 *    - the longest access-JWT lifetime has elapsed since that sign-out
 *      (global sign-out does not revoke issued JWTs). The lifetime is the
 *      configured maximum, raised to any longer `expires_in` the product
 *      actually issued to this run, so a wrong setting never shortens it;
 *    - after that, a fresh worker verification found the run's exchange not
 *      live (ended through proven ownership, or observed not live), and did
 *      not find the principal in the room. That verification reads the room
 *      as the media bridge last saw it (A15 live presence): a fresh report
 *      with `selfPresent` true is evidence the orphan browser is still in the
 *      room and keeps the lease; a fresh `selfPresent` false is evidence it
 *      is gone and is recorded as `absent`. No report, a stale one, a 422
 *      `not_found` or an absent route (404) proves nothing either way: it is
 *      recorded `unobservable`. The latest decisive verification (present or
 *      absent) decides: after a present, an unobservable one never releases;
 *      a later fresh absent does. The browser process's close itself stays
 *      typed `unobservable`.
 *
 * Ordering-critical timestamps (the sign-out and the verification events) are
 * stamped on the PostgreSQL clock by the PostgreSQL ledger, the same clock as
 * the lease expiry and `now`; the memory ledger has a single process clock.
 * Both ledgers evaluate this same function inside their release transaction.
 */
export const STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA = "sophia_voice_lab_studio_g7_dead_owner_lease_release_v1" as const;
export const STUDIO_DEAD_OWNER_VERIFIED_KIND = "studio.cleanup.dead_owner_verified" as const;
/** One live-presence read of the run's room (A15), made by an API-only recovery. */
export const STUDIO_ROOM_PRESENCE_KIND = "studio.room.live_presence" as const;
export const STUDIO_ROOM_PRESENCE_SCHEMA = "sophia_voice_lab_studio_room_presence_v1" as const;
export const STUDIO_DEAD_OWNER_HEARTBEAT_STALE_MS = 30_000;
/** Allowance for a worker clock running behind the ledger's clock (heartbeats are worker-stamped). */
export const STUDIO_DEAD_OWNER_CLOCK_SKEW_MARGIN_MS = 60_000;
/**
 * How long a fresh "present" report vetoes a dead owner's lease release once
 * the run's exchange is proven not live. The media bridge reports presence
 * only while it is in the room, so after the exchange ended a fresh "absent"
 * may never come: past this bound, with no fresh report since and the
 * exchange verified not live after it, the lease is released and the release
 * records the expired veto (audit).
 */
export const STUDIO_PRESENCE_VETO_BOUND_MS = 15 * 60_000;
/**
 * Only these say the bridge's report no longer places anyone: no report, or
 * a stale one. A failed or refused read (presence_read_failed, a 5xx, an
 * absent route) is not evidence that the bridge left, and never counts
 * toward the bound.
 */
export const STUDIO_PRESENCE_GONE_REASONS: ReadonlySet<string> = new Set(["not_observed", "report_stale"]);
/**
 * A report that stays fresh `present` with the exchange proven not live (a
 * bridge stuck in the room) cannot hold the lease, and admission, forever:
 * past this cap from the first such present, the lease is released and the
 * release records the cap; the evaluator fails the orphan's presence. There
 * is no operator release.
 */
export const STUDIO_PRESENCE_STUCK_CAP_MS = 120 * 60_000;
/** Event kinds the PostgreSQL ledger stamps with clock_timestamp(), whatever time the worker passes. */
export const STUDIO_DATABASE_CLOCK_EVENT_KINDS: readonly string[] = ["studio.cleanup.signed_out", STUDIO_DEAD_OWNER_VERIFIED_KIND];
/** Every event kind the release decision reads. */
export const STUDIO_DEAD_OWNER_DECISION_EVENT_KINDS: readonly string[] = [
  "studio.cleanup.signed_out", STUDIO_DEAD_OWNER_VERIFIED_KIND, "studio.auth.session_established",
  "harness.browser_process_acquired", "harness.browser_runtime_acquired", "cleanup.browser_context_closed",
  "studio.cleanup.exchange_ended", "studio.exchange.opened", "studio.exchange.speak_requested", "cleanup.browser_lease_released",
];

type DecisionEvent = Pick<LabEvent, "kind" | "source" | "payload" | "at" | "seq">;

export interface StudioDeadOwnerReleaseInput {
  run: { state: RunState; scenarioVersion: string | null };
  lease: { workerId: string; leaseEpoch: number; expiresAt: Date };
  ownerLastHeartbeatAt: Date | null;
  events: DecisionEvent[];
  now: Date;
  /** The fresh not-live verification of basis 2; null when only basis 1 is being tried. */
  verificationId: string | null;
  tokenMaxLifetimeMs: number;
  heartbeatStaleMs: number;
}

export type StudioDeadOwnerReleaseDecision =
  | { release: true; basis: "owner_cleanup_complete"; closedSeq: number }
  | { release: true; basis: "quiesced"; signOutAt: Date; signOutSeq: number; verificationSeq: number; presenceVetoExpired?: { presentSeq: number; presentAt: Date }; presenceVetoCapped?: { firstPresentSeq: number; firstPresentAt: Date } }
  | { release: false; reason: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Earliest confirmed global sign-out strictly after `after`. */
export function earliestGlobalSignOutAfter(events: ReadonlyArray<DecisionEvent>, after: Date): { at: Date; seq: number } | null {
  const candidates = events
    .filter((event) => event.kind === "studio.cleanup.signed_out" && event.source === "canonical" && event.payload.confirmed === true && event.payload.scope === "global" && event.at.getTime() > after.getTime())
    .sort((left, right) => left.at.getTime() - right.at.getTime() || left.seq - right.seq);
  const first = candidates[0];
  return first ? { at: first.at, seq: first.seq } : null;
}

/**
 * The run's exchange join anchor: the latest durable join (`opened`) or Speak
 * intent. An exchange end counts only after it.
 */
export function studioExchangeJoinAnchorSeq(events: ReadonlyArray<DecisionEvent>): number {
  return events
    .filter((event) => event.source === "canonical" && (event.kind === "studio.exchange.opened" || event.kind === "studio.exchange.speak_requested"))
    .reduce((latest, event) => Math.max(latest, event.seq), 0);
}

/** Bases under which a settle observed the run's own joined exchange not live (or ended it). */
const JOINED_EXCHANGE_END_BASES: ReadonlySet<string> = new Set(["run_exchange_not_live", "run_exchange_not_live_other_exchange_live", "api_end", "already_ended"]);

/**
 * Whether one confirmed end counts for the run's exchange.
 *
 * A confirmation is evidence about the moment it was OBSERVED, not about the
 * moment it reached the ledger (a watchdog's result can be drained after the
 * write-ahead join). So once any Speak intent exists, an end counts only when
 * the observation itself says it was made after Speak was requested and by a
 * read-only member-API read (never the driver's own "never requested"), and
 * - with a joined exchange: names that exchange and a basis that observed it
 *   not live (or ended it by id);
 * - with no join: saw nothing live AFTER the principal left the room, i.e.
 *   after the run's browser close and a confirmed global sign-out, both
 *   stamped on the observation and both durable in the ledger after Speak. No
 *   time window is used: a window cannot prove an exchange will not open
 *   later, and clocks of different workers are never compared. If that can
 *   never be observed, the run stays not cleanup-complete.
 * Without any Speak intent, the run never asked for an exchange and any
 * confirmed end stands.
 */
function countsForRunExchange(event: DecisionEvent, intent: DecisionEvent | null, opened: DecisionEvent | null, principalLeftDurably: boolean): boolean {
  if (!intent && !opened) return true;
  const payload = event.payload;
  if (payload.verified_by !== "member_snapshot" || payload.speak_requested_before_observation !== true) return false;
  if (opened) return typeof payload.basis === "string" && JOINED_EXCHANGE_END_BASES.has(payload.basis) && payload.exchange_id === opened.payload.exchange_id;
  return payload.basis === "no_live_exchange_after_principal_left" && payload.browser_closed_before_observation === true && payload.signed_out_before_observation === true && principalLeftDurably;
}

/** After the Speak intent: the run's browser durably closed (or quiesced) and a confirmed global sign-out. */
function principalLeftDurably(events: ReadonlyArray<DecisionEvent>, intent: DecisionEvent | null): boolean {
  const after = intent?.seq ?? 0;
  const closed = events.some((event) => event.seq > after && ((event.kind === "cleanup.browser_context_closed" && event.source === "browser" && event.payload.close_resolved === true && event.payload.browser_registry_absent === true)
    || (event.kind === "cleanup.browser_lease_released" && event.payload.schema === STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA && event.payload.dead_owner_quiesced === true)));
  const signedOut = events.some((event) => event.seq > after && event.kind === "studio.cleanup.signed_out" && event.source === "canonical" && event.payload.confirmed === true && event.payload.scope === "global");
  return closed && signedOut;
}

/** The confirmed end that counts for the run's exchange (see countsForRunExchange), or null. */
export function studioExchangeEndAfterJoin<T extends DecisionEvent>(events: ReadonlyArray<T>): T | null {
  const anchor = studioExchangeJoinAnchorSeq(events);
  const intent = events.find((event) => event.kind === "studio.exchange.speak_requested" && event.source === "canonical") ?? null;
  const opened = [...events].filter((event) => event.kind === "studio.exchange.opened" && event.source === "canonical" && typeof event.payload.exchange_id === "string").sort((left, right) => right.seq - left.seq)[0] ?? null;
  const left = principalLeftDurably(events, intent);
  return events.find((event) => event.kind === "studio.cleanup.exchange_ended" && event.source === "canonical" && event.payload.confirmed === true
    && event.seq > anchor && countsForRunExchange(event, intent, opened, left)) ?? null;
}

/**
 * The access-JWT lifetime to wait out: the configured maximum, raised to the
 * longest `expires_in` the product issued to this run's sessions, never above
 * the 24 h bound. A grant above the bound is refused before any browser holds
 * it (supabase-session.ts), so such a value never becomes the wait.
 */
export function studioEffectiveTokenLifetimeMs(events: ReadonlyArray<DecisionEvent>, configuredMs: number): number {
  let longest = configuredMs;
  for (const event of events) {
    if (event.kind !== "studio.auth.session_established") continue;
    const seconds = event.payload.expires_in_s;
    if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= STUDIO_ACCESS_TOKEN_LIFETIME_BOUND_S) longest = Math.max(longest, seconds * 1_000);
  }
  return longest;
}

/**
 * Basis 1: the dead owner's own cleanup, bound to this lease epoch. The
 * browser runtime acquired under (owner, epoch) names its process
 * acquisition; that execution epoch's close must be proven, with a confirmed
 * global sign-out and a confirmed exchange end after the join, all after the
 * acquisition.
 */
export function ownerCleanupForLease(events: ReadonlyArray<DecisionEvent>, lease: StudioDeadOwnerReleaseInput["lease"]): { complete: true; closedSeq: number } | { complete: false; reason: string } {
  const workerHash = sha256(lease.workerId);
  const runtime = events.find((event) => event.kind === "harness.browser_runtime_acquired" && event.source === "canonical" && event.payload.worker_id_sha256 === workerHash && event.payload.browser_lease_epoch === lease.leaseEpoch);
  if (!runtime) return { complete: false, reason: "owner_runtime_not_bound_to_lease" };
  const acquisition = events
    .filter((event) => event.kind === "harness.browser_process_acquired" && event.source === "browser" && event.seq < runtime.seq && typeof event.payload.execution_epoch_sha256 === "string")
    .sort((left, right) => right.seq - left.seq)[0];
  if (!acquisition) return { complete: false, reason: "owner_process_not_bound_to_lease" };
  const epoch = acquisition.payload.execution_epoch_sha256;
  const closed = events.find((event) => event.kind === "cleanup.browser_context_closed" && event.source === "browser" && event.seq > runtime.seq
    && event.payload.execution_epoch_sha256 === epoch && event.payload.close_resolved === true && event.payload.browser_registry_absent === true);
  if (!closed) return { complete: false, reason: "owner_browser_close_not_proven" };
  const signedOut = events.some((event) => event.kind === "studio.cleanup.signed_out" && event.source === "canonical" && event.seq > runtime.seq && event.payload.confirmed === true && event.payload.scope === "global");
  if (!signedOut) return { complete: false, reason: "owner_sign_out_not_confirmed" };
  const ended = studioExchangeEndAfterJoin(events);
  if (!ended || ended.seq < runtime.seq) return { complete: false, reason: "owner_exchange_end_not_confirmed" };
  return { complete: true, closedSeq: closed.seq };
}

export function decideStudioDeadOwnerRelease(input: StudioDeadOwnerReleaseInput): StudioDeadOwnerReleaseDecision {
  if (input.run.scenarioVersion !== STUDIO_G7_SCENARIO_VERSION) return { release: false, reason: "not_studio_run" };
  if (!TERMINAL_RUN_STATES.has(input.run.state)) return { release: false, reason: "run_not_terminal" };
  if (input.lease.expiresAt.getTime() > input.now.getTime()) return { release: false, reason: "lease_not_expired" };
  if (input.ownerLastHeartbeatAt !== null && input.ownerLastHeartbeatAt.getTime() > input.now.getTime() - input.heartbeatStaleMs - STUDIO_DEAD_OWNER_CLOCK_SKEW_MARGIN_MS) return { release: false, reason: "owner_heartbeat_live" };
  const owner = ownerCleanupForLease(input.events, input.lease);
  if (owner.complete) return { release: true, basis: "owner_cleanup_complete", closedSeq: owner.closedSeq };
  if (!Number.isSafeInteger(input.tokenMaxLifetimeMs) || input.tokenMaxLifetimeMs < 60_000) return { release: false, reason: "token_lifetime_invalid" };
  const signOut = earliestGlobalSignOutAfter(input.events, input.lease.expiresAt);
  if (!signOut) return { release: false, reason: "global_sign_out_after_expiry_missing" };
  const quietAt = signOut.at.getTime() + studioEffectiveTokenLifetimeMs(input.events, input.tokenMaxLifetimeMs);
  if (input.now.getTime() < quietAt) return { release: false, reason: "access_token_lifetime_pending" };
  if (input.verificationId === null) return { release: false, reason: "fresh_exchange_verification_missing" };
  const verification = input.events.find((event) => event.kind === STUDIO_DEAD_OWNER_VERIFIED_KIND && event.source === "worker"
    && event.payload.verification_id === input.verificationId && event.payload.exchange_not_live === true && event.payload.signed_out === true
    && event.payload.worker_id_sha256 === sha256(input.lease.workerId) && event.payload.lease_epoch === input.lease.leaseEpoch
    && event.at.getTime() >= quietAt);
  if (!verification) return { release: false, reason: "fresh_exchange_verification_missing" };
  // Presence is decided by the LATEST decisive verification (a fresh report:
  // present or absent) of this owner and lease epoch after the quiet point,
  // never by the current one alone: once a fresh report placed the principal
  // in the room, a later stale or missing report (unobservable) does not
  // release; a later fresh absent does. The veto is bounded: once this
  // verification proves the exchange not live at least
  // STUDIO_PRESENCE_VETO_BOUND_MS after that present, with no fresh report
  // since, the lease is released and the release records the expired veto.
  const decisions = input.events
    .filter((event) => event.kind === STUDIO_DEAD_OWNER_VERIFIED_KIND && event.source === "worker"
      && event.payload.worker_id_sha256 === sha256(input.lease.workerId) && event.payload.lease_epoch === input.lease.leaseEpoch
      && event.at.getTime() >= quietAt && (event.payload.room_presence === "present" || event.payload.room_presence === "absent"))
    .sort((left, right) => left.seq - right.seq);
  const decisive = decisions.at(-1);
  if (decisive?.payload.room_presence === "present") {
    // Both times are the database clock (verification events are DB-stamped).
    // The bound runs only on evidence that the bridge's report is gone (no
    // report, or a stale one) in THIS verification; a failed read never counts.
    const gone = verification.seq > decisive.seq && verification.payload.room_presence === "unobservable" && STUDIO_PRESENCE_GONE_REASONS.has(String(verification.payload.room_presence_reason));
    if (gone && verification.at.getTime() - decisive.at.getTime() >= STUDIO_PRESENCE_VETO_BOUND_MS) {
      return { release: true, basis: "quiesced", signOutAt: signOut.at, signOutSeq: signOut.seq, verificationSeq: verification.seq, presenceVetoExpired: { presentSeq: decisive.seq, presentAt: decisive.at } };
    }
    // Stuck present: the first present of the current unbroken run of presents, capped.
    const lastAbsent = decisions.map((event) => event.payload.room_presence).lastIndexOf("absent");
    const firstPresent = decisions[lastAbsent + 1]!;
    if (verification.at.getTime() - firstPresent.at.getTime() >= STUDIO_PRESENCE_STUCK_CAP_MS) {
      return { release: true, basis: "quiesced", signOutAt: signOut.at, signOutSeq: signOut.seq, verificationSeq: verification.seq, presenceVetoCapped: { firstPresentSeq: firstPresent.seq, firstPresentAt: firstPresent.at } };
    }
    return { release: false, reason: "principal_present_in_room" };
  }
  return { release: true, basis: "quiesced", signOutAt: signOut.at, signOutSeq: signOut.seq, verificationSeq: verification.seq };
}
