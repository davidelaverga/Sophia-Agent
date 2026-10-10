import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  STUDIO_DEAD_OWNER_CLOCK_SKEW_MARGIN_MS,
  STUDIO_DEAD_OWNER_VERIFIED_KIND,
  STUDIO_PRESENCE_STUCK_CAP_MS,
  STUDIO_PRESENCE_VETO_BOUND_MS,
  decideStudioDeadOwnerRelease,
  type StudioDeadOwnerReleaseInput,
} from "../src/studio-g7/lease-release.js";

/**
 * The dead-owner release decision at each of its time and size bounds, one
 * millisecond below, at, and one above. The Studio suites reach these gates
 * only far from their edges, so an off-by-one in any of them (a `>=` turned
 * `>`) would pass them all; these pin every edge, and so prove that a
 * refactor of the decision kept them.
 */
const WORKER = "srv-bounds-owner";
const EPOCH = 3;
const T = Date.parse("2026-10-09T12:00:00.000Z");
const LIFETIME_MS = 3_600_000;
const STALE_MS = 30_000;
const SIGN_OUT_AT = T + 1_000;
const QUIET_AT = SIGN_OUT_AT + LIFETIME_MS;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Event = StudioDeadOwnerReleaseInput["events"][number];

function scenario() {
  let seq = 0;
  const events: Event[] = [];
  const add = (kind: string, source: Event["source"], payload: Record<string, unknown>, at: number): Event => {
    const event: Event = { kind, source, payload, at: new Date(at), seq: ++seq };
    events.push(event);
    return event;
  };
  const signOut = () => add("studio.cleanup.signed_out", "canonical", { scope: "global", confirmed: true }, SIGN_OUT_AT);
  const verification = (id: string, at: number, presence: "present" | "absent" | "unobservable", reason: string | null) => add(STUDIO_DEAD_OWNER_VERIFIED_KIND, "worker", {
    verification_id: id, exchange_not_live: true, signed_out: true, worker_id_sha256: sha256(WORKER), lease_epoch: EPOCH, room_presence: presence, room_presence_reason: reason,
  }, at);
  const decide = (overrides: Partial<StudioDeadOwnerReleaseInput>) => decideStudioDeadOwnerRelease({
    run: { state: "aborted_driver_restart", scenarioVersion: "studio-g7-v1" },
    lease: { workerId: WORKER, leaseEpoch: EPOCH, expiresAt: new Date(T) },
    ownerLastHeartbeatAt: null, ownerHeartbeatBootIdSha256: null, events, now: new Date(QUIET_AT + 60_000),
    verificationId: null, tokenMaxLifetimeMs: LIFETIME_MS, heartbeatStaleMs: STALE_MS, ...overrides,
  } as StudioDeadOwnerReleaseInput);
  return { add, signOut, verification, decide };
}

describe("dead-owner release bounds (each edge: 1 ms below, at, 1 ms above)", () => {
  it("the presence veto expires exactly STUDIO_PRESENCE_VETO_BOUND_MS after the last fresh present", () => {
    for (const delta of [-1, 0, 1]) {
      const s = scenario();
      s.signOut();
      const present = s.verification("present-1", QUIET_AT + 1_000, "present", null);
      const at = present.at.getTime() + STUDIO_PRESENCE_VETO_BOUND_MS + delta;
      s.verification("gone-1", at, "unobservable", "not_observed");
      const decision = s.decide({ now: new Date(at), verificationId: "gone-1" });
      if (delta < 0) expect(decision, String(delta)).toEqual({ release: false, reason: "principal_present_in_room" });
      else expect(decision, String(delta)).toMatchObject({ release: true, basis: "quiesced", presenceVetoExpired: { presentSeq: present.seq, presentAt: present.at } });
    }
  });

  it("a report stuck present is capped exactly STUDIO_PRESENCE_STUCK_CAP_MS after the first present", () => {
    for (const delta of [-1, 0, 1]) {
      const s = scenario();
      s.signOut();
      const first = s.verification("present-1", QUIET_AT + 1_000, "present", null);
      const at = first.at.getTime() + STUDIO_PRESENCE_STUCK_CAP_MS + delta;
      s.verification("present-2", at, "present", null);
      const decision = s.decide({ now: new Date(at), verificationId: "present-2" });
      if (delta < 0) expect(decision, String(delta)).toEqual({ release: false, reason: "principal_present_in_room" });
      else expect(decision, String(delta)).toMatchObject({ release: true, basis: "quiesced", presenceVetoCapped: { firstPresentSeq: first.seq, firstPresentAt: first.at } });
    }
  });

  it("the access-JWT lifetime after the post-expiry sign-out elapses exactly at the quiet point", () => {
    for (const delta of [-1, 0, 1]) {
      const s = scenario();
      s.signOut();
      expect(s.decide({ now: new Date(QUIET_AT + delta) }), String(delta)).toEqual({ release: false, reason: delta < 0 ? "access_token_lifetime_pending" : "fresh_exchange_verification_missing" });
    }
  });

  it("a verification counts from exactly the quiet point on", () => {
    for (const delta of [-1, 0, 1]) {
      const s = scenario();
      s.signOut();
      const verification = s.verification("absent-1", QUIET_AT + delta, "absent", null);
      const decision = s.decide({ now: new Date(QUIET_AT + 10_000), verificationId: "absent-1" });
      if (delta < 0) expect(decision, String(delta)).toEqual({ release: false, reason: "fresh_exchange_verification_missing" });
      else expect(decision, String(delta)).toEqual({ release: true, basis: "quiesced", signOutAt: new Date(SIGN_OUT_AT), signOutSeq: 1, verificationSeq: verification.seq });
    }
  });

  it("the configured token lifetime may be as low as exactly one minute", () => {
    for (const delta of [-1, 0, 1]) {
      const s = scenario();
      expect(s.decide({ tokenMaxLifetimeMs: 60_000 + delta }), String(delta)).toEqual({ release: false, reason: delta < 0 ? "token_lifetime_invalid" : "global_sign_out_after_expiry_missing" });
    }
  });

  it("the lease counts as expired from exactly its expiry on", () => {
    for (const delta of [-1, 0, 1]) {
      const s = scenario();
      const now = new Date(QUIET_AT);
      expect(s.decide({ now, lease: { workerId: WORKER, leaseEpoch: EPOCH, expiresAt: new Date(now.getTime() + delta) } }), String(delta)).toEqual({ release: false, reason: delta > 0 ? "lease_not_expired" : "global_sign_out_after_expiry_missing" });
    }
  });

  it("the owner's heartbeat is stale from exactly the stale bound plus the clock-skew margin on", () => {
    for (const delta of [-1, 0, 1]) {
      const s = scenario();
      const now = new Date(QUIET_AT);
      const heartbeat = new Date(now.getTime() - STALE_MS - STUDIO_DEAD_OWNER_CLOCK_SKEW_MARGIN_MS + delta);
      expect(s.decide({ now, ownerLastHeartbeatAt: heartbeat }), String(delta)).toEqual({ release: false, reason: delta > 0 ? "owner_heartbeat_live" : "global_sign_out_after_expiry_missing" });
    }
  });
});
