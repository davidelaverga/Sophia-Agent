import { renderHook, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { useLongPress } from "../../app/hooks/useLongPress"

// --- Helpers ---------------------------------------------------------------

function makePointerEvent(overrides: Partial<React.PointerEvent> = {}): React.PointerEvent {
  return { clientX: 0, clientY: 0, ...overrides } as React.PointerEvent
}

// --- Tests -----------------------------------------------------------------

describe("useLongPress", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("calls onShortPress on quick tap (<300ms)", () => {
    const onShortPress = vi.fn()
    const onLongPressStart = vi.fn()
    const { result } = renderHook(() =>
      useLongPress({ onShortPress, onLongPressStart })
    )

    act(() => {
      result.current.longPressHandlers.onPointerDown(makePointerEvent())
    })
    // Release before threshold
    act(() => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      result.current.longPressHandlers.onPointerUp(makePointerEvent())
    })

    expect(onShortPress).toHaveBeenCalledTimes(1)
    expect(onLongPressStart).not.toHaveBeenCalled()
  })

  it("calls onLongPressStart after threshold (300ms)", () => {
    const onLongPressStart = vi.fn()
    const onShortPress = vi.fn()
    const { result } = renderHook(() =>
      useLongPress({ onLongPressStart, onShortPress })
    )

    act(() => {
      result.current.longPressHandlers.onPointerDown(makePointerEvent())
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(onLongPressStart).toHaveBeenCalledTimes(1)
    expect(onShortPress).not.toHaveBeenCalled()
  })

  it("calls onLongPressEnd on release after long-press", () => {
    const onLongPressStart = vi.fn()
    const onLongPressEnd = vi.fn()
    const { result } = renderHook(() =>
      useLongPress({ onLongPressStart, onLongPressEnd })
    )

    act(() => {
      result.current.longPressHandlers.onPointerDown(makePointerEvent())
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    act(() => {
      result.current.longPressHandlers.onPointerUp(makePointerEvent())
    })

    expect(onLongPressEnd).toHaveBeenCalledTimes(1)
  })

  it("cancels long-press when finger moves >10px", () => {
    const onLongPressStart = vi.fn()
    const onShortPress = vi.fn()
    const { result } = renderHook(() =>
      useLongPress({ onLongPressStart, onShortPress })
    )

    act(() => {
      result.current.longPressHandlers.onPointerDown(makePointerEvent({ clientX: 100, clientY: 100 }))
    })
    // Move 15px away
    act(() => {
      result.current.longPressHandlers.onPointerMove(makePointerEvent({ clientX: 115, clientY: 100 }))
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(onLongPressStart).not.toHaveBeenCalled()
  })

  it("does not cancel when finger moves <10px", () => {
    const onLongPressStart = vi.fn()
    const { result } = renderHook(() =>
      useLongPress({ onLongPressStart })
    )

    act(() => {
      result.current.longPressHandlers.onPointerDown(makePointerEvent({ clientX: 100, clientY: 100 }))
    })
    // Move only 5px
    act(() => {
      result.current.longPressHandlers.onPointerMove(makePointerEvent({ clientX: 105, clientY: 100 }))
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(onLongPressStart).toHaveBeenCalledTimes(1)
  })

  it("calls onLongPressEnd when cancelled during active long-press", () => {
    const onLongPressStart = vi.fn()
    const onLongPressEnd = vi.fn()
    const { result } = renderHook(() =>
      useLongPress({ onLongPressStart, onLongPressEnd })
    )

    act(() => {
      result.current.longPressHandlers.onPointerDown(makePointerEvent({ clientX: 100, clientY: 100 }))
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onLongPressStart).toHaveBeenCalledTimes(1)

    // Now move finger far away while actively long-pressing
    act(() => {
      result.current.longPressHandlers.onPointerMove(makePointerEvent({ clientX: 200, clientY: 200 }))
    })
    expect(onLongPressEnd).toHaveBeenCalledTimes(1)
  })

  it("respects custom threshold", () => {
    const onLongPressStart = vi.fn()
    const { result } = renderHook(() =>
      useLongPress({ onLongPressStart, threshold: 500 })
    )

    act(() => {
      result.current.longPressHandlers.onPointerDown(makePointerEvent())
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onLongPressStart).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(onLongPressStart).toHaveBeenCalledTimes(1)
  })

  it("handles onPointerCancel gracefully", () => {
    const onLongPressStart = vi.fn()
    const onLongPressEnd = vi.fn()
    const { result } = renderHook(() =>
      useLongPress({ onLongPressStart, onLongPressEnd })
    )

    act(() => {
      result.current.longPressHandlers.onPointerDown(makePointerEvent())
    })
    act(() => {
      result.current.longPressHandlers.onPointerCancel()
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(onLongPressStart).not.toHaveBeenCalled()
    expect(onLongPressEnd).not.toHaveBeenCalled()
  })
})
