import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  isSafeReturnPath,
  resolveSafeCallbackURL,
} from "../../app/lib/auth/safe-redirect"

describe("isSafeReturnPath", () => {
  it("accepts simple absolute paths", () => {
    expect(isSafeReturnPath("/")).toBe(true)
    expect(isSafeReturnPath("/recap/abc")).toBe(true)
    expect(isSafeReturnPath("/path?q=1&r=2")).toBe(true)
  })

  it("rejects protocol-relative URLs", () => {
    expect(isSafeReturnPath("//evil.com")).toBe(false)
    expect(isSafeReturnPath("/\\evil.com")).toBe(false)
  })

  it("rejects backslash injection", () => {
    expect(isSafeReturnPath("/foo\\..\\bar")).toBe(false)
    expect(isSafeReturnPath("/\\\\evil.com")).toBe(false)
  })

  it("rejects scheme-prefixed URLs", () => {
    expect(isSafeReturnPath("https://evil.com")).toBe(false)
    expect(isSafeReturnPath("javascript:alert(1)")).toBe(false)
  })

  it("rejects empty / null / non-string", () => {
    expect(isSafeReturnPath("")).toBe(false)
    expect(isSafeReturnPath(null)).toBe(false)
    expect(isSafeReturnPath(undefined)).toBe(false)
  })

  it("rejects values longer than 256 chars", () => {
    expect(isSafeReturnPath("/" + "a".repeat(256))).toBe(false)
    expect(isSafeReturnPath("/" + "a".repeat(254))).toBe(true)
  })
})

describe("resolveSafeCallbackURL", () => {
  const ORIGINAL_LOCATION = window.location

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: ORIGINAL_LOCATION,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: ORIGINAL_LOCATION,
    })
  })

  function setLocation(href: string, pathname: string, search: string) {
    Object.defineProperty(window, "location", {
      writable: true,
      value: {
        href,
        pathname,
        search,
      } as Location,
    })
  }

  it("uses ?next= when same-origin path-only", () => {
    setLocation(
      "https://app.example.com/recap/abc?next=%2Frecap%2Fabc",
      "/recap/abc",
      "?next=%2Frecap%2Fabc",
    )
    expect(resolveSafeCallbackURL()).toBe("/recap/abc")
  })

  it("falls back to current pathname (without query) when no ?next", () => {
    setLocation(
      "https://app.example.com/recap/xyz?other=1",
      "/recap/xyz",
      "?other=1",
    )
    // Query is stripped intentionally — see safe-redirect.ts docstring.
    expect(resolveSafeCallbackURL()).toBe("/recap/xyz")
  })

  it("falls back to / when on the root", () => {
    setLocation("https://app.example.com/", "/", "")
    expect(resolveSafeCallbackURL()).toBe("/")
  })

  it("drops unsafe ?next values", () => {
    setLocation(
      "https://app.example.com/?next=https%3A%2F%2Fevil.com",
      "/",
      "?next=https%3A%2F%2Fevil.com",
    )
    expect(resolveSafeCallbackURL()).toBe("/")
  })

  it("drops protocol-relative ?next values", () => {
    setLocation(
      "https://app.example.com/?next=%2F%2Fevil.com",
      "/",
      "?next=%2F%2Fevil.com",
    )
    expect(resolveSafeCallbackURL()).toBe("/")
  })
})
