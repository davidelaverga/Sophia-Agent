import { z } from "zod";
import { sha256, type CapabilityClaims } from "./security.js";
export type RecoveryAttemptIdentity = { recoveryId: string; attemptId: string; issuedAt: number };

/** Exact Gateway _recovery_id/_attempt_id recipe. No token or nonce is retained. */
export function recoveryAttemptIdentity(claims: Pick<CapabilityClaims, "cleanup_obligation_id" | "jti" | "nonce" | "iat">) {
  z.string().uuid().parse(claims.cleanup_obligation_id);
  z.string().regex(/^[a-f0-9]{32}$/).parse(claims.jti);
  z.string().regex(/^[a-f0-9]{32}$/).parse(claims.nonce);
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(claims.iat);
  const recoveryId = sha256(`sophia_voice_lab_recovery_v2\0${claims.cleanup_obligation_id}`);
  return { recoveryId, attemptId: sha256(`${recoveryId}\0${claims.jti}\0${claims.nonce}`), issuedAt: claims.iat };
}

/** Apply to the authenticated transport result, before it can settle retained
 * state. A correct run binding alone cannot distinguish a cached older attempt. */
export function assertRecoveryAttemptReceipt(input: unknown, expected: ReturnType<typeof recoveryAttemptIdentity>, observedAt: Date): void {
  const event = z.object({ kind: z.literal("cleanup.recovery"), source: z.literal("canonical"), payload: z.object({
    receipt: z.object({ recovery_id: z.literal(expected.recoveryId), attempt_id: z.literal(expected.attemptId),
      attempt_issued_at: z.literal(expected.issuedAt), recovered_at: z.string().datetime({ offset: true }) }).passthrough(),
  }).passthrough() }).passthrough().parse(input);
  const recovered = Date.parse(event.payload.receipt.recovered_at);
  const now = observedAt.getTime();
  if (!Number.isFinite(now) || recovered < expected.issuedAt * 1000 || recovered > now + 30_000) throw new Error("RECOVERY_ATTEMPT_TIME_INVALID");
}
