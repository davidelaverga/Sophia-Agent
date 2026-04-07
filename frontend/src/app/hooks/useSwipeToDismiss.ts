"use client"

import { useState, useCallback, useRef, type TouchEvent } from "react"

/**
 * useSwipeToDismiss - Elegant swipe gesture to dismiss modals/sheets
 * 
 * Provides a natural feeling swipe-to-close interaction for bottom sheets
 * and modals. The element follows the finger and dismisses when swiped
 * past a threshold.
 */

type SwipeDirection = 'down' | 'up' | 'left' | 'right'

interface UseSwipeToDismissOptions {
  /** Callback when swipe dismisses the element */
  onDismiss: () => void
  /** Direction to swipe for dismissal (default: 'down') */
  direction?: SwipeDirection
  /** Minimum distance to trigger dismiss in pixels (default: 100) */
  threshold?: number
  /** Enable/disable the gesture (default: true) */
  enabled?: boolean
  /** Velocity threshold for quick swipes in px/ms (default: 0.5) */
  velocityThreshold?: number
}

interface SwipeState {
  /** Current offset in pixels (for CSS transform) */
  offset: number
  /** Whether user is currently swiping */
  isSwiping: boolean
  /** Opacity based on swipe progress (0-1) */
  opacity: number
  /** Whether the gesture should transition back */
  isTransitioning: boolean
}

export function useSwipeToDismiss({
  onDismiss,
  direction = 'down',
  threshold = 100,
  enabled = true,
  velocityThreshold = 0.5,
}: UseSwipeToDismissOptions) {
  const [state, setState] = useState<SwipeState>({
    offset: 0,
    isSwiping: false,
    opacity: 1,
    isTransitioning: false,
  })
  
  const startPos = useRef(0)
  const startTime = useRef(0)
  const currentPos = useRef(0)
  
  // Get the primary axis based on direction
  const isVertical = direction === 'down' || direction === 'up'
  const isPositive = direction === 'down' || direction === 'right'
  
  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!enabled) return
    
    const touch = e.touches[0]
    startPos.current = isVertical ? touch.clientY : touch.clientX
    currentPos.current = startPos.current
    startTime.current = Date.now()
    
    setState(prev => ({ ...prev, isSwiping: true, isTransitioning: false }))
  }, [enabled, isVertical])
  
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!enabled || !state.isSwiping) return
    
    const touch = e.touches[0]
    currentPos.current = isVertical ? touch.clientY : touch.clientX
    const delta = currentPos.current - startPos.current
    
    // Only allow movement in the correct direction
    const adjustedDelta = isPositive ? Math.max(0, delta) : Math.min(0, delta)
    const absoluteDelta = Math.abs(adjustedDelta)
    
    // Calculate opacity based on progress (fade out as user swipes)
    const progress = Math.min(absoluteDelta / threshold, 1)
    const opacity = 1 - (progress * 0.3) // Only fade to 70% opacity max while swiping
    
    setState(prev => ({
      ...prev,
      offset: adjustedDelta,
      opacity,
    }))
  }, [enabled, state.isSwiping, isVertical, isPositive, threshold])
  
  const handleTouchEnd = useCallback(() => {
    if (!enabled || !state.isSwiping) return
    
    const delta = currentPos.current - startPos.current
    const absoluteDelta = Math.abs(delta)
    const timeDelta = Date.now() - startTime.current
    const velocity = absoluteDelta / timeDelta
    
    // Check if should dismiss (either past threshold or fast swipe)
    const isPastThreshold = absoluteDelta >= threshold
    const isFastSwipe = velocity >= velocityThreshold && absoluteDelta > 30
    const isCorrectDirection = isPositive ? delta > 0 : delta < 0
    
    if ((isPastThreshold || isFastSwipe) && isCorrectDirection) {
      // Dismiss
      onDismiss()
    }
    
    // Reset state with transition
    setState({
      offset: 0,
      isSwiping: false,
      opacity: 1,
      isTransitioning: true,
    })
    
    // Remove transitioning flag after animation
    setTimeout(() => {
      setState(prev => ({ ...prev, isTransitioning: false }))
    }, 300)
  }, [enabled, state.isSwiping, threshold, velocityThreshold, isPositive, onDismiss])
  
  // Generate CSS transform value
  const transform = isVertical 
    ? `translateY(${state.offset}px)` 
    : `translateX(${state.offset}px)`
  
  return {
    /** Spread these handlers on the swipeable element */
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
    /** CSS styles to apply to the element */
    style: {
      transform,
      opacity: state.opacity,
      transition: state.isTransitioning ? 'transform 0.3s ease-out, opacity 0.3s ease-out' : undefined,
      willChange: state.isSwiping ? 'transform, opacity' : undefined,
    },
    /** Whether user is currently swiping */
    isSwiping: state.isSwiping,
    /** Current offset in pixels */
    offset: state.offset,
  }
}
