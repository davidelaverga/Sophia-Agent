import { describe, expect, it } from "vitest";

import { exactPositiveProviderEpoch } from "../src/worker.js";

describe("provider epoch joins", () => {
  it("ignores the pre-activation epoch zero and accepts only positive owning epochs", () => {
    expect(exactPositiveProviderEpoch(0)).toBeNull();
    expect(exactPositiveProviderEpoch(1)).toBe(1);
    expect(exactPositiveProviderEpoch(7)).toBe(7);
    expect(exactPositiveProviderEpoch(-1)).toBeNull();
    expect(exactPositiveProviderEpoch(1.5)).toBeNull();
  });
});
