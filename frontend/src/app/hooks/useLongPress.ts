"use client"

import { useCallback, useRef } from "react"

export interface UseLongPressOptions {
  /** Duration in ms before long-press triggers (default: 300) */
  threshold?: number
  /** Movement distance in px that cancels press (default: 10) */
  moveThreshold?: number
  /** Called when long-press is detected */
  onLongPressStart?: () => void
  /** Called when release after long-press */
  onLongPressEnd?: () => void
  /** Called on short tap (< threshold) */
  onShortPress?: () => void
}

export interface UseLongPressReturn {
  isLongPressing: boolean
  longPressHandlers: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerCancel: () => void
  }
}

export function useLongPress(options: UseLongPressOptions = {}): UseLongPressReturn {
  const {
    threshold = 300,
    moveThreshold = 10,
    onLongPressStart,
    onLongPressEnd,
    onShortPress,
  } = options

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isLongPressingRef = useRef(false)
  const startPosRef = useRef<{ x: number; y: number } | null>(null)

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (isLongPressingRef.current) {
      isLongPressingRef.current = false
      onLongPressEnd?.()
    }
    startPosRef.current = null
  }, [onLongPressEnd])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startPosRef.current = { x: e.clientX, y: e.clientY }
    isLongPressingRef.current = false

    timerRef.current = setTimeout(() => {
      isLongPressingRef.current = true
      onLongPressStart?.()
    }, threshold)
  }, [threshold, onLongPressStart])

  const onPointerUp = useCallback((_e: React.PointerEvent) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (isLongPressingRef.current) {
      isLongPressingRef.current = false
      onLongPressEnd?.()
    } else {
      onShortPress?.()
    }
    startPosRef.current = null
  }, [onLongPressEnd, onShortPress])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startPosRef.current) return
    const dx = e.clientX - startPosRef.current.x
    const dy = e.clientY - startPosRef.current.y
    if (Math.sqrt(dx * dx + dy * dy) > moveThreshold) {
      cancel()
    }
  }, [moveThreshold, cancel])

  const onPointerCancel = useCallback(() => {
    cancel()
  }, [cancel])

  return {
    isLongPressing: isLongPressingRef.current,
    longPressHandlers: {
      onPointerDown,
      onPointerUp,
      onPointerMove,
      onPointerCancel,
    },
  }
}
