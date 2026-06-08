import { describe, expect, it, vi } from "vitest"

import {
  CoreviewHtmlNavigationController,
  type HtmlNavigationControllerTransport,
  type HtmlNavigationReadyState,
  type HtmlNavigationTransportCommand,
  type HtmlNavigationTransportResult,
} from "../../app/lib/coreview-html-navigation-controller"

function readyState(overrides: Partial<HtmlNavigationReadyState> = {}): HtmlNavigationReadyState {
  return {
    htmlBridgeReady: true,
    htmlSectionIndexReady: true,
    htmlSectionIndexEntryCount: 4,
    htmlSectionIndexBuildResult: "success",
    scrollTop: 0,
    scrollHeight: 1600,
    viewportHeight: 500,
    currentSection: "Hero",
    ...overrides,
  }
}

function createTransport(options: {
  state?: HtmlNavigationReadyState | null
  dispatch?: (command: HtmlNavigationTransportCommand) => Promise<HtmlNavigationTransportResult>
  waitForReady?: () => Promise<void>
} = {}) {
  let state = options.state ?? readyState()
  const dispatch = vi.fn(options.dispatch ?? (async (command: HtmlNavigationTransportCommand) => {
    const before = state?.scrollTop ?? 0
    state = readyState({ ...state, scrollTop: before + 360 })
    return {
      ok: true,
      commandId: command.commandId,
      targetSafe: "features",
      targetKind: "heading",
      method: "heading",
      scrollTopBefore: before,
      scrollTopAfter: state.scrollTop,
      scrolled: true,
      targetConfirmedVisible: true,
      state,
    }
  }))
  const waitForReady = vi.fn(options.waitForReady ?? (async () => undefined))
  const dropCommand = vi.fn()
  const transport: HtmlNavigationControllerTransport = {
    getState: () => state,
    waitForReady,
    dispatch,
    dropCommand,
  }
  return {
    transport,
    dispatch,
    waitForReady,
    dropCommand,
    setState: (next: HtmlNavigationReadyState | null) => {
      state = next
    },
  }
}

describe("Coreview HTML navigation controller", () => {
  it("waits for iframe bridge and section index readiness before dispatching", async () => {
    const harness = createTransport({
      state: readyState({ htmlBridgeReady: false, htmlSectionIndexReady: false }),
      waitForReady: async () => {
        harness.setState(readyState({ scrollTop: 12 }))
      },
    })
    const controller = new CoreviewHtmlNavigationController(harness.transport)

    const result = await controller.execute({
      kind: "focus_section",
      targetText: "Features",
      source: "voice",
      rendererKind: "html",
    })

    expect(harness.waitForReady).toHaveBeenCalledTimes(1)
    expect(harness.dispatch).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.waitedForReady).toBe(true)
    expect(result.htmlBridgeReady).toBe(true)
    expect(result.htmlSectionIndexReady).toBe(true)
  })

  it("times out safely and drops the pending command", async () => {
    vi.useFakeTimers()
    const harness = createTransport({
      dispatch: () => new Promise(() => undefined),
    })
    const controller = new CoreviewHtmlNavigationController(harness.transport, {
      commandTimeoutMs: 20,
    })

    const pending = controller.execute({
      commandId: "nav-timeout",
      kind: "focus_section",
      targetText: "Features",
      source: "tool",
      rendererKind: "html",
    })
    await vi.advanceTimersByTimeAsync(25)
    const result = await pending
    vi.useRealTimers()

    expect(result).toMatchObject({
      ok: false,
      commandId: "nav-timeout",
      reason: "command_timeout",
      timedOut: true,
      scrolled: false,
    })
    expect(harness.dropCommand).toHaveBeenCalledWith("nav-timeout")
  })

  it("returns exactly one result per command id", async () => {
    let resolves = 0
    const harness = createTransport({
      dispatch: async (command) => {
        resolves += 1
        return {
          ok: true,
          commandId: command.commandId,
          scrollTopBefore: 0,
          scrollTopAfter: 320,
          scrolled: true,
          targetConfirmedVisible: true,
          targetSafe: "features",
          targetKind: "heading",
          method: "heading",
          state: readyState({ scrollTop: 320 }),
        }
      },
    })
    const controller = new CoreviewHtmlNavigationController(harness.transport)

    const result = await controller.execute({
      commandId: "same-command",
      kind: "focus_section",
      targetText: "Features",
      source: "voice",
      rendererKind: "html",
    })

    expect(result.ok).toBe(true)
    expect(resolves).toBe(1)
    expect(harness.dispatch).toHaveBeenCalledTimes(1)
  })

  it("confirms scroll success before returning ok", async () => {
    const harness = createTransport({
      dispatch: async (command) => ({
        ok: true,
        commandId: command.commandId,
        targetSafe: "features",
        targetKind: "heading",
        method: "heading",
        scrollTopBefore: 0,
        scrollTopAfter: 0,
        scrolled: false,
        targetConfirmedVisible: false,
        state: readyState({ scrollTop: 0 }),
      }),
    })
    const controller = new CoreviewHtmlNavigationController(harness.transport)

    const result = await controller.execute({
      kind: "focus_section",
      targetText: "Features",
      source: "voice",
      rendererKind: "html",
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe("section_not_found")
    expect(result.scrolled).toBe(false)
  })

  it("returns section_not_found for a missing target", async () => {
    const harness = createTransport({
      dispatch: async (command) => ({
        ok: false,
        commandId: command.commandId,
        reason: "section_not_found",
        targetSafe: "missing",
        targetKind: "unknown",
        scrollTopBefore: 0,
        scrollTopAfter: 0,
        scrolled: false,
        targetConfirmedVisible: false,
        state: readyState(),
      }),
    })
    const controller = new CoreviewHtmlNavigationController(harness.transport)

    const result = await controller.execute({
      kind: "focus_section",
      targetText: "Missing",
      source: "voice",
      rendererKind: "html",
    })

    expect(result).toMatchObject({
      ok: false,
      targetSafe: "missing",
      targetKind: "unknown",
      reason: "section_not_found",
      rawHtmlExcluded: true,
      rawArtifactTextExcluded: true,
    })
  })
})
