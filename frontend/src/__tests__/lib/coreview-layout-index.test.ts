import { describe, expect, it } from "vitest"

import { createUnavailableCoreviewLayoutIndex } from "../../app/lib/coreview-layout-index"

describe("Coreview layout index contract", () => {
  it("creates an unavailable placeholder without implementing OCR or future parsers", () => {
    expect(createUnavailableCoreviewLayoutIndex("ocr_future")).toEqual({
      status: "unavailable",
      source: "ocr_future",
      supportsBoundingBoxes: false,
    })
  })
})
