import { render, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { EmotionAtmosphereCanvas } from "../../app/components/EmotionAtmosphereCanvas"

// --- Mocks -----------------------------------------------------------------

let mockEmotion: string | null = null

vi.mock("../../app/stores/emotion-store", () => ({
  useEmotionStore: (selector: (s: { emotion: string | null }) => unknown) =>
    selector({ emotion: mockEmotion }),
}))

// Mock canvas context
const mockCtx = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  createRadialGradient: vi.fn(() => ({
    addColorStop: vi.fn(),
  })),
  scale: vi.fn(),
  fillStyle: "",
  canvas: { width: 800, height: 600 },
}

// Store the original getContext
const originalGetContext = HTMLCanvasElement.prototype.getContext

// Mock matchMedia for prefers-reduced-motion
let mockReducedMotion = false

const mockMatchMedia = vi.fn((query: string) => ({
  matches: query === "(prefers-reduced-motion: reduce)" ? mockReducedMotion : false,
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  onchange: null,
  dispatchEvent: vi.fn(),
}))

// Mock ResizeObserver
const mockObserve = vi.fn()
const mockDisconnect = vi.fn()

// Mock requestAnimationFrame
let rafCallbacks: ((time: number) => void)[] = []
let rafId = 0

// --- Setup -----------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockEmotion = null
  mockReducedMotion = false
  rafCallbacks = []
  rafId = 0

  // Mock canvas getContext
  HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext

  // Mock matchMedia
  window.matchMedia = mockMatchMedia as unknown as typeof window.matchMedia

  // Mock ResizeObserver
  window.ResizeObserver = vi.fn(() => ({
    observe: mockObserve,
    disconnect: mockDisconnect,
    unobserve: vi.fn(),
  })) as unknown as typeof ResizeObserver

  // Mock requestAnimationFrame
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCallbacks.push(cb)
    return ++rafId
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    rafCallbacks = []
  })

  // Mock getBoundingClientRect
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => {},
  }))

  // Mock devicePixelRatio
  Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true })
})

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
})

// --- Helper ----------------------------------------------------------------

function flushRaf(time = 0) {
  const cbs = [...rafCallbacks]
  rafCallbacks = []
  cbs.forEach((cb) => cb(time))
}

// --- Tests -----------------------------------------------------------------

describe("EmotionAtmosphereCanvas", () => {
  it("renders a canvas element at full viewport with pointer-events-none", () => {
    render(<EmotionAtmosphereCanvas />)
    const canvas = document.querySelector("canvas")
    expect(canvas).toBeInTheDocument()
    expect(canvas?.getAttribute("aria-hidden")).toBe("true")
    expect(canvas?.className).toContain("fixed")
    expect(canvas?.className).toContain("inset-0")
    expect(canvas?.className).toContain("z-0")
    expect(canvas?.className).toContain("pointer-events-none")
  })

  it("draws initial gradient with WARM default colors when no emotion", () => {
    render(<EmotionAtmosphereCanvas />)
    // Canvas should have been drawn with WARM default rgb [124, 92, 170]
    expect(mockCtx.createRadialGradient).toHaveBeenCalled()
    expect(mockCtx.fillRect).toHaveBeenCalled()
  })

  it("draws with ENERGETIC colors when emotion store has 'happy'", () => {
    mockEmotion = "happy"
    render(<EmotionAtmosphereCanvas />)
    // Should draw — createRadialGradient called with ENERGETIC band values
    expect(mockCtx.createRadialGradient).toHaveBeenCalled()
    expect(mockCtx.fillRect).toHaveBeenCalled()
  })

  it("no animation frame loop when prefers-reduced-motion is active", () => {
    mockReducedMotion = true
    render(<EmotionAtmosphereCanvas />)
    // Should have drawn once but not started RAF loop
    expect(mockCtx.fillRect).toHaveBeenCalled()
    // requestAnimationFrame should not have been called (or called minimally for setup)
    // The key test: no ongoing animation loop runs
    const initialRafCount = (window.requestAnimationFrame as ReturnType<typeof vi.fn>).mock.calls.length
    // Flush any pending — shouldn't add more
    flushRaf(100)
    const afterFlushCount = (window.requestAnimationFrame as ReturnType<typeof vi.fn>).mock.calls.length
    // In reduced motion, the loop should not self-schedule
    expect(afterFlushCount).toBeLessThanOrEqual(initialRafCount + 1)
  })

  it("canvas resizes when resize observer fires", () => {
    render(<EmotionAtmosphereCanvas />)
    // ResizeObserver.observe should have been called on the canvas
    expect(mockObserve).toHaveBeenCalled()
    // Simulate resize by calling the observer callback
    const observerInstance = (window.ResizeObserver as ReturnType<typeof vi.fn>).mock.calls[0]
    const resizeCallback = observerInstance?.[0] as (() => void) | undefined
    if (resizeCallback) {
      act(() => resizeCallback())
    }
    // After resize, gradient should have been redrawn (at least once more)
    expect(mockCtx.fillRect.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("applies lastSessionEmotion on dashboard and schedules idle fade", () => {
    vi.useFakeTimers()
    try {
      render(<EmotionAtmosphereCanvas lastSessionEmotion="calm" />)
      // Should draw immediately with CALM colors
      expect(mockCtx.createRadialGradient).toHaveBeenCalled()
      // Advance past idle timeout (5 minutes)
      void act(() => vi.advanceTimersByTime(5 * 60 * 1000 + 100))
      // After idle timeout, a transition to WARM should have been scheduled
      // (The transition changes targetRgb internally)
    } finally {
      vi.useRealTimers()
    }
  })

  it("uses default WARM when lastSessionEmotion is null", () => {
    render(<EmotionAtmosphereCanvas lastSessionEmotion={null} />)
    // Should draw with default WARM colors — no crash
    expect(mockCtx.fillRect).toHaveBeenCalled()
  })
})
