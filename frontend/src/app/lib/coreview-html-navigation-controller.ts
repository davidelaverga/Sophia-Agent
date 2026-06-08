import {
  cleanHtmlNavigationTarget,
  hrefNavigationTarget,
  safeHtmlNavigationLabel,
  type CoreviewHtmlNavigationFailureReason,
  type CoreviewHtmlNavigationTargetKind,
} from "./coreview-html-navigation"

export type HtmlNavigationCommandKind =
  | "scroll_down"
  | "scroll_up"
  | "go_top"
  | "go_bottom"
  | "focus_section"
  | "focus_text"
  | "internal_link"
  | "current_view"

export type HtmlNavigationCommandSource =
  | "voice"
  | "tool"
  | "internal_link"
  | "manual"

export interface HtmlNavigationCommand {
  commandId?: string | null
  kind: HtmlNavigationCommandKind
  targetText?: string | null
  href?: string | null
  source: HtmlNavigationCommandSource
  artifactStableIdentity?: string | null
  rendererKind: "html"
}

export interface HtmlNavigationReadyState {
  htmlBridgeReady: boolean
  htmlSectionIndexReady: boolean
  htmlSectionIndexEntryCount: number | null
  htmlSectionIndexBuildResult: string | null
  scrollTop: number | null
  scrollHeight: number | null
  viewportHeight: number | null
  currentSection?: string | null
}

export interface HtmlNavigationTransportCommand {
  commandId: string
  command: "scroll_by" | "scroll_to" | "focus_text" | "current_view"
  deltaY?: number
  position?: "top" | "bottom"
  text?: string
  waitedForReady: boolean
  source: HtmlNavigationCommandSource
  originalKind: HtmlNavigationCommandKind
}

export interface HtmlNavigationTransportResult {
  ok: boolean
  commandId?: string | null
  reason?: CoreviewHtmlNavigationFailureReason | null
  targetSafe?: string | null
  targetKind?: CoreviewHtmlNavigationTargetKind | string | null
  scrollTopBefore?: number | null
  scrollTopAfter?: number | null
  scrolled?: boolean | null
  targetConfirmedVisible?: boolean | null
  timedOut?: boolean | null
  waitedForReady?: boolean | null
  state?: HtmlNavigationReadyState | null
  method?: string | null
}

export interface HtmlNavigationControllerTransport {
  getState(): HtmlNavigationReadyState | null
  waitForReady(timeoutMs: number): Promise<void>
  dispatch(command: HtmlNavigationTransportCommand): Promise<HtmlNavigationTransportResult>
  dropCommand?(commandId: string): void
}

export interface HtmlNavigationResult {
  ok: boolean
  commandId: string
  kind: HtmlNavigationCommandKind
  targetSafe: string | null
  targetKind: string | null
  method: string | null
  scrollTopBefore: number | null
  scrollTopAfter: number | null
  scrolled: boolean
  targetConfirmedVisible: boolean
  reason: CoreviewHtmlNavigationFailureReason | null
  htmlBridgeReady: boolean | null
  htmlSectionIndexReady: boolean | null
  htmlSectionIndexEntryCount: number | null
  htmlSectionIndexBuildResult: string | null
  timedOut: boolean
  waitedForReady: boolean
  navigationModel: "scroll_document"
  rawHtmlExcluded: true
  rawArtifactTextExcluded: true
  rawCommentTextExcluded: true
  rawFrameExcluded: true
}

export interface HtmlNavigationControllerOptions {
  readyTimeoutMs?: number
  commandTimeoutMs?: number
  scrollFraction?: number
  minScrollDelta?: number
  idPrefix?: string
}

const DEFAULT_READY_TIMEOUT_MS = 850
const DEFAULT_COMMAND_TIMEOUT_MS = 1100
const DEFAULT_SCROLL_FRACTION = 0.72
const DEFAULT_MIN_SCROLL_DELTA = 240

export class CoreviewHtmlNavigationController {
  private commandCounter = 0
  private queue: Promise<void> = Promise.resolve()
  private completedCommandIds = new Set<string>()

  constructor(
    private readonly transport: HtmlNavigationControllerTransport,
    private readonly options: HtmlNavigationControllerOptions = {},
  ) {}

  execute(command: HtmlNavigationCommand): Promise<HtmlNavigationResult> {
    const commandId = safeCommandId(command.commandId) ?? this.nextCommandId()
    const queued = this.queue.then(() => this.runCommand({ ...command, commandId }))
    this.queue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  private async runCommand(command: HtmlNavigationCommand & { commandId: string }): Promise<HtmlNavigationResult> {
    if (this.completedCommandIds.has(command.commandId)) {
      return this.resultFromState(command, this.transport.getState(), {
        ok: false,
        reason: "command_timeout",
        timedOut: true,
      })
    }
    this.completedCommandIds.add(command.commandId)

    const initialState = this.transport.getState()
    if (!initialState?.htmlBridgeReady || !initialState.htmlSectionIndexReady) {
      await this.transport.waitForReady(this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    }
    const readyState = this.transport.getState()
    const waitedForReady = !Boolean(initialState?.htmlBridgeReady && initialState.htmlSectionIndexReady)

    if (!readyState?.htmlBridgeReady) {
      return this.resultFromState(command, readyState, {
        ok: false,
        reason: "iframe_not_ready",
        waitedForReady,
        timedOut: waitedForReady,
      })
    }
    if (!readyState.htmlSectionIndexReady) {
      return this.resultFromState(command, readyState, {
        ok: false,
        reason: "section_index_not_ready",
        waitedForReady,
      })
    }

    const transportCommand = this.toTransportCommand(command, readyState, waitedForReady)
    if (!transportCommand) {
      return this.resultFromState(command, readyState, {
        ok: false,
        reason: "section_not_found",
        waitedForReady,
      })
    }

    const dispatched = await this.withTimeout(
      this.transport.dispatch(transportCommand),
      command.commandId,
      command,
      readyState,
      waitedForReady,
    )
    return this.resultFromTransport(command, readyState, dispatched, waitedForReady)
  }

  private toTransportCommand(
    command: HtmlNavigationCommand & { commandId: string },
    state: HtmlNavigationReadyState,
    waitedForReady: boolean,
  ): HtmlNavigationTransportCommand | null {
    const viewportHeight = Math.max(0, state.viewportHeight ?? 0)
    const scrollDelta = Math.max(
      this.options.minScrollDelta ?? DEFAULT_MIN_SCROLL_DELTA,
      Math.round(viewportHeight * (this.options.scrollFraction ?? DEFAULT_SCROLL_FRACTION)),
    )

    if (command.kind === "scroll_down" || command.kind === "scroll_up") {
      return {
        commandId: command.commandId,
        command: "scroll_by",
        deltaY: command.kind === "scroll_down" ? scrollDelta : -scrollDelta,
        waitedForReady,
        source: command.source,
        originalKind: command.kind,
      }
    }
    if (command.kind === "go_top" || command.kind === "go_bottom") {
      return {
        commandId: command.commandId,
        command: "scroll_to",
        position: command.kind === "go_bottom" ? "bottom" : "top",
        waitedForReady,
        source: command.source,
        originalKind: command.kind,
      }
    }
    if (command.kind === "current_view") {
      return {
        commandId: command.commandId,
        command: "current_view",
        waitedForReady,
        source: command.source,
        originalKind: command.kind,
      }
    }

    const target = targetForCommand(command, state)
    if (!target) {
      return null
    }
    return {
      commandId: command.commandId,
      command: "focus_text",
      text: target,
      waitedForReady,
      source: command.source,
      originalKind: command.kind,
    }
  }

  private async withTimeout(
    promise: Promise<HtmlNavigationTransportResult>,
    commandId: string,
    command: HtmlNavigationCommand,
    state: HtmlNavigationReadyState,
    waitedForReady: boolean,
  ): Promise<HtmlNavigationTransportResult> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<HtmlNavigationTransportResult>((resolve) => {
      timeoutId = setTimeout(() => {
        this.transport.dropCommand?.(commandId)
        resolve({
          ok: false,
          commandId,
          reason: "command_timeout",
          targetSafe: safeTargetForCommand(command, state),
          targetKind: "unknown",
          scrollTopBefore: state.scrollTop,
          scrollTopAfter: state.scrollTop,
          scrolled: false,
          targetConfirmedVisible: false,
          timedOut: true,
          waitedForReady,
          state,
        })
      }, this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
    })

    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }

  private resultFromTransport(
    command: HtmlNavigationCommand & { commandId: string },
    stateBeforeDispatch: HtmlNavigationReadyState,
    transportResult: HtmlNavigationTransportResult,
    waitedForReady: boolean,
  ): HtmlNavigationResult {
    const state = transportResult.state ?? this.transport.getState() ?? stateBeforeDispatch
    const scrollTopBefore = numberOrNull(transportResult.scrollTopBefore ?? stateBeforeDispatch.scrollTop)
    const scrollTopAfter = numberOrNull(transportResult.scrollTopAfter ?? state.scrollTop)
    const scrolled = transportResult.scrolled === true
      || (scrollTopBefore !== null && scrollTopAfter !== null && Math.abs(scrollTopAfter - scrollTopBefore) > 1)
    const targetConfirmedVisible = transportResult.targetConfirmedVisible === true
      || targetVisibleFromScrollBoundary(command.kind, state, scrollTopAfter)
    const ok = transportResult.ok === true && (scrolled || targetConfirmedVisible || command.kind === "current_view")
    const reason = ok ? null : transportResult.reason ?? "section_not_found"
    return {
      ok,
      commandId: command.commandId,
      kind: command.kind,
      targetSafe: safeHtmlNavigationLabel(
        transportResult.targetSafe
          ?? safeTargetForCommand(command, state)
          ?? null,
      ) || null,
      targetKind: typeof transportResult.targetKind === "string" && transportResult.targetKind.trim()
        ? transportResult.targetKind.trim().slice(0, 48)
        : null,
      method: typeof transportResult.method === "string" && transportResult.method.trim()
        ? transportResult.method.trim().slice(0, 48)
        : null,
      scrollTopBefore,
      scrollTopAfter,
      scrolled,
      targetConfirmedVisible,
      reason,
      htmlBridgeReady: state.htmlBridgeReady,
      htmlSectionIndexReady: state.htmlSectionIndexReady,
      htmlSectionIndexEntryCount: state.htmlSectionIndexEntryCount,
      htmlSectionIndexBuildResult: state.htmlSectionIndexBuildResult,
      timedOut: transportResult.timedOut === true,
      waitedForReady: transportResult.waitedForReady ?? waitedForReady,
      navigationModel: "scroll_document",
      rawHtmlExcluded: true,
      rawArtifactTextExcluded: true,
      rawCommentTextExcluded: true,
      rawFrameExcluded: true,
    }
  }

  private resultFromState(
    command: HtmlNavigationCommand & { commandId: string },
    state: HtmlNavigationReadyState | null,
    details: {
      ok: boolean
      reason: CoreviewHtmlNavigationFailureReason
      timedOut?: boolean
      waitedForReady?: boolean
    },
  ): HtmlNavigationResult {
    return {
      ok: false,
      commandId: command.commandId,
      kind: command.kind,
      targetSafe: safeTargetForCommand(command, state) ?? null,
      targetKind: targetKindForCommand(command.kind),
      method: null,
      scrollTopBefore: numberOrNull(state?.scrollTop),
      scrollTopAfter: numberOrNull(state?.scrollTop),
      scrolled: false,
      targetConfirmedVisible: false,
      reason: details.reason,
      htmlBridgeReady: state?.htmlBridgeReady ?? null,
      htmlSectionIndexReady: state?.htmlSectionIndexReady ?? null,
      htmlSectionIndexEntryCount: state?.htmlSectionIndexEntryCount ?? null,
      htmlSectionIndexBuildResult: state?.htmlSectionIndexBuildResult ?? null,
      timedOut: details.timedOut === true,
      waitedForReady: details.waitedForReady === true,
      navigationModel: "scroll_document",
      rawHtmlExcluded: true,
      rawArtifactTextExcluded: true,
      rawCommentTextExcluded: true,
      rawFrameExcluded: true,
    }
  }

  private nextCommandId(): string {
    this.commandCounter += 1
    return `${this.options.idPrefix ?? "html-nav"}-${Date.now().toString(36)}-${this.commandCounter}`
  }
}

export function htmlNavigationResultTelemetry(result: HtmlNavigationResult): {
  htmlBridgeReady: boolean | null
  htmlSectionIndexReady: boolean | null
  htmlSectionIndexEntryCount: number | null
  htmlSectionIndexBuildResult: string | null
  htmlNavigationControllerActive: true
  htmlNavigationRouterUsed: true
  htmlNavigationCommandKind: HtmlNavigationCommandKind
  htmlNavigationTargetSafe: string | null
  htmlNavigationTargetKind: string | null
  htmlNavigationResult: string
  htmlNavigationFailureReason: CoreviewHtmlNavigationFailureReason | null
  htmlNavigationScrollTopBefore: number | null
  htmlNavigationScrollTopAfter: number | null
  htmlNavigationScrolled: boolean
  htmlNavigationCommandId: string
  htmlNavigationTimedOut: boolean
  htmlNavigationWaitedForReady: boolean
  htmlNavigationPreventedPdfFallback: true
  htmlNavigationResultConfirmedBeforeFeedback: boolean
  rawHtmlExcluded: true
  rawArtifactTextExcluded: true
  rawCommentTextExcluded: true
  rawFrameExcluded: true
} {
  return {
    htmlBridgeReady: result.htmlBridgeReady,
    htmlSectionIndexReady: result.htmlSectionIndexReady,
    htmlSectionIndexEntryCount: result.htmlSectionIndexEntryCount,
    htmlSectionIndexBuildResult: result.htmlSectionIndexBuildResult,
    htmlNavigationControllerActive: true,
    htmlNavigationRouterUsed: true,
    htmlNavigationCommandKind: result.kind,
    htmlNavigationTargetSafe: result.targetSafe,
    htmlNavigationTargetKind: result.targetKind,
    htmlNavigationResult: result.ok ? "success" : result.reason ?? "failed",
    htmlNavigationFailureReason: result.ok ? null : result.reason,
    htmlNavigationScrollTopBefore: result.scrollTopBefore,
    htmlNavigationScrollTopAfter: result.scrollTopAfter,
    htmlNavigationScrolled: result.scrolled,
    htmlNavigationCommandId: result.commandId,
    htmlNavigationTimedOut: result.timedOut,
    htmlNavigationWaitedForReady: result.waitedForReady,
    htmlNavigationPreventedPdfFallback: true,
    htmlNavigationResultConfirmedBeforeFeedback: result.ok,
    rawHtmlExcluded: true,
    rawArtifactTextExcluded: true,
    rawCommentTextExcluded: true,
    rawFrameExcluded: true,
  }
}

function targetForCommand(command: HtmlNavigationCommand, state: HtmlNavigationReadyState): string | null {
  if (command.kind === "internal_link") {
    return hrefNavigationTarget(command.href) || cleanHtmlNavigationTarget(command.targetText)
  }
  const cleaned = cleanHtmlNavigationTarget(command.targetText)
  const normalized = cleaned.toLowerCase()
  if (normalized === "current section" || normalized === "current") {
    return safeHtmlNavigationLabel(state.currentSection) || null
  }
  return cleaned || null
}

function safeTargetForCommand(
  command: HtmlNavigationCommand,
  state: HtmlNavigationReadyState | null,
): string | null {
  if (command.kind === "go_top") return "top"
  if (command.kind === "go_bottom") return "bottom"
  if (command.kind === "scroll_down") return "scroll down"
  if (command.kind === "scroll_up") return "scroll up"
  if (command.kind === "current_view") return safeHtmlNavigationLabel(state?.currentSection) || "current view"
  return targetForCommand(command, state ?? {
    htmlBridgeReady: false,
    htmlSectionIndexReady: false,
    htmlSectionIndexEntryCount: null,
    htmlSectionIndexBuildResult: null,
    scrollTop: null,
    scrollHeight: null,
    viewportHeight: null,
  })
}

function targetKindForCommand(kind: HtmlNavigationCommandKind): string {
  if (kind === "go_top" || kind === "scroll_up") return "top"
  if (kind === "go_bottom" || kind === "scroll_down") return "bottom"
  if (kind === "internal_link") return "path"
  if (kind === "current_view") return "text"
  return "unknown"
}

function targetVisibleFromScrollBoundary(
  kind: HtmlNavigationCommandKind,
  state: HtmlNavigationReadyState,
  scrollTopAfter: number | null,
): boolean {
  if (scrollTopAfter === null) {
    return false
  }
  if (kind === "go_top" || kind === "scroll_up") {
    return scrollTopAfter <= 1
  }
  if (kind === "go_bottom" || kind === "scroll_down") {
    const bottom = Math.max(0, (state.scrollHeight ?? 0) - (state.viewportHeight ?? 0))
    return scrollTopAfter >= bottom - 1
  }
  return false
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
}

function safeCommandId(value: string | null | undefined): string | null {
  const normalized = safeHtmlNavigationLabel(value, 96)
  return normalized || null
}
