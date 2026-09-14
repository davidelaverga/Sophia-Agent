import { describe, expect, it } from "vitest";
import { productTurnId } from "../src/product-turn.js";

describe("product turn identity", () => {
  it("joins actual snake-case receipts and unambiguous legacy aliases", () => {
    expect(productTurnId({ turn_id: "gemini-response-123", phase: "agent_ended" })).toBe("gemini-response-123");
    expect(productTurnId({ turnId: "legacy" })).toBe("legacy");
    expect(productTurnId({ turn_id: "same", turnId: "same" })).toBe("same");
    expect(productTurnId({})).toBeNull();
    expect(productTurnId(undefined)).toBeNull();
  });
  it.each([{ turn_id: "one", turnId: "two" }, { turn_id: null }, { turnId: "" }, { turn_id: "a".repeat(129) }, { turn_id: "with space" }])("rejects malformed or conflicting identifiers: %j", data => {
    expect(() => productTurnId(data)).toThrow("malformed or contradictory");
  });
});
