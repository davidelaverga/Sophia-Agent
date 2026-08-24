import { createHmac } from "node:crypto";

import { VoiceLabError, labError } from "./domain.js";

export interface CallerPartitionKeyRing {
  activeKeyId: string;
  keys: Readonly<Record<string, string>>;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Produces versioned, domain-separated opaque control-ledger identities.
 * Raw OAuth/static subjects never enter global audit or rolling-admission
 * rows. All configured keys remain queryable during rotation so an active
 * rolling window cannot be reset by switching the active key.
 */
export class CallerPartitioner {
  readonly #ring: CallerPartitionKeyRing;

  constructor(ring: CallerPartitionKeyRing) {
    const entries = Object.entries(ring.keys);
    if (!KEY_ID.test(ring.activeKeyId) || entries.length === 0 || entries.length > 4 || !(ring.activeKeyId in ring.keys)
      || entries.some(([keyId, secret]) => !KEY_ID.test(keyId) || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512)
      || new Set(entries.map(([, secret]) => secret)).size !== entries.length) {
      throw new VoiceLabError(labError("CONFIG_INVALID", "Caller-partition HMAC key ring is invalid.", "internal"));
    }
    this.#ring = { activeKeyId: ring.activeKeyId, keys: Object.freeze({ ...ring.keys }) };
  }

  callerIds(rawCaller: string): string[] {
    this.#assertRaw(rawCaller);
    return this.#ordered().map(([keyId, secret]) => `cp1:${keyId}:${mac(secret, "caller", rawCaller)}`);
  }

  activeCallerId(rawCaller: string): string { return this.callerIds(rawCaller)[0]!; }

  /** OAuth grants deliberately use a different HMAC domain from global
   * audit/admission rows. The same operator is therefore not linkable across
   * the two bounded control ledgers by comparing opaque partition values. */
  oauthSubjectIds(rawSubject: string): string[] {
    this.#assertRaw(rawSubject);
    return this.#ordered().map(([keyId, secret]) => `cp1:${keyId}:${mac(secret, "oauth-subject", rawSubject)}`);
  }

  activeOAuthSubjectId(rawSubject: string): string { return this.oauthSubjectIds(rawSubject)[0]!; }

  reservationKeys(rawReservationKey: string): string[] {
    if (!/^[a-f0-9]{64}$/.test(rawReservationKey)) throw new VoiceLabError(labError("ROLLING_ADMISSION_INVALID", "Rolling admission reservation identity is invalid.", "conflict"));
    return this.#ordered().map(([, secret]) => mac(secret, "reservation", rawReservationKey));
  }

  activeReservationKey(rawReservationKey: string): string { return this.reservationKeys(rawReservationKey)[0]!; }

  keyIds(): readonly string[] { return this.#ordered().map(([keyId]) => keyId); }

  /** Fail closed while any bounded control row still names a verify-only key.
   * This prevents key retirement from silently resetting a live rolling
   * budget, replay fence, or runless security-audit lookup. */
  assertLivePartitionIds(partitionIds: readonly string[]): void {
    const configured = new Set(this.keyIds());
    for (const partitionId of partitionIds) {
      const matched = /^cp1:([A-Za-z0-9_-]{1,32}):[a-f0-9]{64}$/.exec(partitionId);
      if (!matched || !configured.has(matched[1]!)) {
        throw new VoiceLabError(labError("CALLER_PARTITION_KEY_RETIRED_LIVE", "A live caller-partition row references an unconfigured verification key.", "internal", false, { partition_key_id: matched?.[1] ?? "malformed" }));
      }
    }
  }

  #ordered(): Array<[string, string]> {
    const active = this.#ring.activeKeyId;
    return [[active, this.#ring.keys[active]!], ...Object.entries(this.#ring.keys).filter(([keyId]) => keyId !== active).sort(([left], [right]) => left.localeCompare(right))];
  }

  #assertRaw(value: string): void {
    if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new VoiceLabError(labError("CALLER_PARTITION_INVALID", "Caller identity could not be partitioned safely.", "authorization"));
  }
}

function mac(secret: string, domain: "caller" | "oauth-subject" | "reservation", value: string): string {
  return createHmac("sha256", secret).update(`sophia-voice-lab-caller-partition-v1\n${domain}\n${value}`).digest("hex");
}
