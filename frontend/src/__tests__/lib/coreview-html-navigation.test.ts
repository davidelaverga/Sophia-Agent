import { describe, expect, it } from "vitest"

import {
  buildCoreviewHtmlSectionIndex,
  cleanHtmlNavigationTarget,
  resolveCoreviewHtmlNavigationTarget,
} from "../../app/lib/coreview-html-navigation"

function documentFromHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html")
}

describe("Coreview HTML navigation resolver", () => {
  it("resolves id targets", () => {
    const documentRef = documentFromHtml("<main><section id='features'><h2>Features</h2></section></main>")

    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "#features" })).toMatchObject({
      ok: true,
      targetKind: "id",
      targetLabelSafe: "features",
      reason: null,
      rawHtmlExcluded: true,
      rawArtifactTextExcluded: true,
    })
  })

  it("resolves heading text", () => {
    const documentRef = documentFromHtml("<main><h2>Platform Features</h2></main>")

    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "features" })).toMatchObject({
      ok: true,
      targetKind: "heading",
      targetLabelSafe: "Platform Features",
    })
  })

  it("resolves nav link text", () => {
    const documentRef = documentFromHtml("<nav><a href='#features'>Explore Features</a></nav>")

    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "Explore Features" })).toMatchObject({
      ok: true,
      targetKind: "nav",
      targetLabelSafe: "Explore Features",
    })
  })

  it("resolves href fragment and path forms", () => {
    const documentRef = documentFromHtml("<main><h2 id='features'>Features</h2></main>")

    expect(cleanHtmlNavigationTarget("/#features")).toBe("features")
    expect(cleanHtmlNavigationTarget("/features")).toBe("features")
    expect(cleanHtmlNavigationTarget("./#features")).toBe("features")
    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "/features" })).toMatchObject({
      ok: true,
      targetKind: "id",
    })
  })

  it("resolves Coreview and co review aliases", () => {
    const documentRef = documentFromHtml("<main><h2>Coreview Review Room</h2></main>")

    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "co review" })).toMatchObject({
      ok: true,
      targetKind: "heading",
      targetLabelSafe: "Coreview Review Room",
    })
  })

  it("resolves top, home, hero, bottom, and docs aliases", () => {
    const documentRef = documentFromHtml("<main><h1>Hero</h1><h2>Documentation</h2></main>")

    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "front page" })).toMatchObject({
      ok: true,
      targetKind: "top",
    })
    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "home" })).toMatchObject({
      ok: true,
      targetKind: "top",
    })
    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "bottom" })).toMatchObject({
      ok: true,
      targetKind: "bottom",
    })
    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "docs" })).toMatchObject({
      ok: true,
      targetKind: "heading",
      targetLabelSafe: "Documentation",
    })
  })

  it("returns section_not_found for missing targets", () => {
    const documentRef = documentFromHtml("<main><h2>Features</h2></main>")

    expect(resolveCoreviewHtmlNavigationTarget(documentRef, { target: "pricing" })).toMatchObject({
      ok: false,
      targetKind: "unknown",
      reason: "section_not_found",
    })
  })

  it("does not expose raw HTML or full text in index telemetry", () => {
    const longText = "A".repeat(300)
    const documentRef = documentFromHtml(`<main><p>${longText}</p></main>`)
    const index = buildCoreviewHtmlSectionIndex(documentRef)

    expect(index.rawHtmlExcluded).toBe(true)
    expect(index.rawArtifactTextExcluded).toBe(true)
    expect(JSON.stringify(index)).not.toContain(longText)
    expect(index.entries.every((entry) => entry.targetLabelSafe.length <= 140)).toBe(true)
  })
})
