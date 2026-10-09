import { createHash } from "node:crypto";

import { TERMINAL_RUN_STATES, type LabEvent, type RunState } from "../domain.js";
import { STUDIO_G7_SCENARIO_VERSION } from "./scenarios.js";

/**
 * Release of a dead foreign worker's Studio browser lease.
 *
 * A dead worker's Chromium cannot be proven closed by anyone else, so the
 * lease is released only when that browser can no longer act on the product:
 * - the lease has expired and its owner's heartbeat is stale;
 * - a global sign-out of the principal was confirmed after the lease expired
 *   (revoking every refresh token of the principal);
 * - the longest access-JWT lifetime has elapsed since that sign-out (global
 *   sign-out does not revoke issued JWTs, so until then the orphan could still
 *   call the member API);
 * - after that, a fresh worker verification found the run's exchange not
 *   live (ended through proven ownership, or observed not live).
 * The orphan's LiveKit room presence is not observable through the member API
 * and stays a named gap; the close itself is typed `unobservable`.
 *
 * Both ledgers evaluate this same function inside their release transaction,
 * against their own clock.
 */
export const STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA = "sophia_voice_lab_studio_g7_dead_owner_lease_release_v1" as const;
export const STUDIO_DEAD_OWNER_VERIFIED_KIND = "studio.cleanup.dead_owner_verified" as const;
export const STUDIO_DEAD_OWNER_HEARTBEAT_STALE_MS = 30_000;

export interface StudioDeadOwnerReleaseInput {
  run: { state: RunState; scenarioVersion: string | null };
  lease: { workerId: string; leaseEpoch: number; expiresAt: Date };
  ownerLastHeartbeatAt: Date | null;
  events: Array<Pick<LabEvent, "kind" | "source" | "payload" | "at" | "seq">>;
  now: Date;
  verificationId: string;
  tokenMaxLifetimeMs: number;
  heartbeatStaleMs: number;
}

export type StudioDeadOwnerReleaseDecision =
  | { release: true; signOutAt: Date; signOutSeq: number; verificationSeq: number }
  | { release: false; reason: string };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Earliest confirmed global sign-out strictly after `after`. */
export function earliestGlobalSignOutAfter(events: StudioDeadOwnerReleaseInput["events"], after: Date): { at: Date; seq: number } | null {
  const candidates = events
    .filter((event) => event.kind === "studio.cleanup.signed_out" && event.source === "canonical" && event.payload.confirmed === true && event.payload.scope === "global" && event.at.getTime() > after.getTime())
    .sort((left, right) => left.at.getTime() - right.at.getTime() || left.seq - right.seq);
  const first = candidates[0];
  return first ? { at: first.at, seq: first.seq } : null;
}

export function decideStudioDeadOwnerRelease(input: StudioDeadOwnerReleaseInput): StudioDeadOwnerReleaseDecision {
  if (input.run.scenarioVersion !== STUDIO_G7_SCENARIO_VERSION) return { release: false, reason: "not_studio_run" };
  if (!TERMINAL_RUN_STATES.has(input.run.state)) return { release: false, reason: "run_not_terminal" };
  if (input.lease.expiresAt.getTime() > input.now.getTime()) return { release: false, reason: "lease_not_expired" };
  if (input.ownerLastHeartbeatAt !== null && input.ownerLastHeartbeatAt.getTime() > input.now.getTime() - input.heartbeatStaleMs) return { release: false, reason: "owner_heartbeat_live" };
  if (!Number.isSafeInteger(input.tokenMaxLifetimeMs) || input.tokenMaxLifetimeMs < 60_000) return { release: false, reason: "token_lifetime_invalid" };
  const signOut = earliestGlobalSignOutAfter(input.events, input.lease.expiresAt);
  if (!signOut) return { release: false, reason: "global_sign_out_after_expiry_missing" };
  const quietAt = signOut.at.getTime() + input.tokenMaxLifetimeMs;
  if (input.now.getTime() < quietAt) return { release: false, reason: "access_token_lifetime_pending" };
  const verification = input.events.find((event) => event.kind === STUDIO_DEAD_OWNER_VERIFIED_KIND && event.source === "worker"
    && event.payload.verification_id === input.verificationId && event.payload.exchange_not_live === true && event.payload.signed_out === true
    && event.payload.worker_id_sha256 === sha256(input.lease.workerId) && event.payload.lease_epoch === input.lease.leaseEpoch
    && event.at.getTime() >= quietAt);
  if (!verification) return { release: false, reason: "fresh_exchange_verification_missing" };
  return { release: true, signOutAt: signOut.at, signOutSeq: signOut.seq, verificationSeq: verification.seq };
}
