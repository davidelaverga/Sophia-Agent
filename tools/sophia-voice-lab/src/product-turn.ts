import { VoiceLabError, labError } from "./domain.js";

/** Product receipts use snake_case; accept the legacy spelling only unambiguously. */
export function productTurnId(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const values = [data.turn_id, data.turnId].filter(value => value !== undefined);
  if (values.length === 0) return null;
  if (values.some(value => typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    || (values.length === 2 && values[0] !== values[1])) {
    throw new VoiceLabError(labError("PRODUCT_TURN_BINDING_INVALID", "Product turn identifiers are malformed or contradictory.", "evidence", false));
  }
  return values[0] as string;
}
