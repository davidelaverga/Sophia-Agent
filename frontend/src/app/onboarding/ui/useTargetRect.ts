"use client"

import { useEffect, useRef, useState } from "react"

import type { OnboardingTargetRect } from "../types"

type ResolveTargetOptions = {
  root?: ParentNode
  attempts?: number
  delayMs?: number
}

type UseTargetRectOptions = {
  enabled?: boolean
  attempts?: number
  delayMs?: number
  scrollIntoViewIfNeeded?: boolean
}

type UseTargetRectResult = {
  rect: OnboardingTargetRect | null
  element: HTMLElement | null
  isResolved: boolean
}

type UseTargetRectsResult = {
  rects: OnboardingTargetRect[]
  elements: HTMLElement[]
  isResolved: boolean
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

export function cloneTargetRect(rect: Pick<OnboardingTargetRect, "x" | "y" | "width" | "height" | "top" | "right" | "bottom" | "left">): OnboardingTargetRect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  }
}

export function getElementTargetRect(element: Element): OnboardingTargetRect {
  const rect = element.getBoundingClientRect()

  return cloneTargetRect({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  })
}

export function isTargetRectEqual(a: OnboardingTargetRect | null, b: OnboardingTargetRect | null): boolean {
  if (a === b) {
    return true
  }

  if (!a || !b) {
    return false
  }

  return a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height
    && a.top === b.top
    && a.right === b.right
    && a.bottom === b.bottom
    && a.left === b.left
}

export function isRectWithinViewport(rect: OnboardingTargetRect): boolean {
  if (typeof window === "undefined") {
    return true
  }

  return rect.bottom > 0
    && rect.right > 0
    && rect.top < window.innerHeight
    && rect.left < window.innerWidth
}

export async function resolveOnboardingTargetElement(
  selector: string,
  options: ResolveTargetOptions = {},
): Promise<HTMLElement | null> {
  if (typeof document === "undefined" || !selector) {
    return null
  }

  const {
    root = document,
    attempts = 3,
    delayMs = 100,
  } = options

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const element = root.querySelector(selector)
    if (element instanceof HTMLElement) {
      return element
    }

    if (attempt < attempts - 1) {
      await wait(delayMs)
    }
  }

  return null
}

export async function resolveOnboardingTargetElements(
  selectors: string[],
  options: ResolveTargetOptions = {},
): Promise<HTMLElement[]> {
  if (typeof document === "undefined" || selectors.length === 0) {
    return []
  }

  const resolved = await Promise.all(selectors.map((selector) => resolveOnboardingTargetElement(selector, options)))
  return resolved.filter((element): element is HTMLElement => element instanceof HTMLElement)
}

export function getUnionTargetRect(rects: OnboardingTargetRect[]): OnboardingTargetRect | null {
  if (rects.length === 0) {
    return null
  }

  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.right))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  const left = Math.min(...rects.map((rect) => rect.left))

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    top,
    right,
    bottom,
    left,
  }
}

function areTargetRectListsEqual(a: OnboardingTargetRect[], b: OnboardingTargetRect[]): boolean {
  if (a === b) {
    return true
  }

  if (a.length !== b.length) {
    return false
  }

  return a.every((rect, index) => isTargetRectEqual(rect, b[index] ?? null))
}

function scrollElementIntoViewIfNeeded(element: HTMLElement, rect: OnboardingTargetRect): void {
  if (typeof element.scrollIntoView !== "function") {
    return
  }

  if (isRectWithinViewport(rect)) {
    return
  }

  element.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  })
}

export function useTargetRect(
  selector: string | null | undefined,
  options: UseTargetRectOptions = {},
): UseTargetRectResult {
  const {
    enabled = true,
    attempts = 3,
    delayMs = 100,
    scrollIntoViewIfNeeded = false,
  } = options

  const [rect, setRect] = useState<OnboardingTargetRect | null>(null)
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [isResolved, setIsResolved] = useState(false)

  const animationFrameRef = useRef<number | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const mutationObserverRef = useRef<MutationObserver | null>(null)

  useEffect(() => {
    if (!enabled || !selector || typeof document === "undefined") {
      setElement(null)
      setRect(null)
      setIsResolved(false)
      return undefined
    }

    let isMounted = true
    let currentElement: HTMLElement | null = null

    const clearScheduledFrame = () => {
      if (animationFrameRef.current !== null) {
        const cancelFrame = typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function"
          ? window.cancelAnimationFrame.bind(window)
          : clearTimeout

        cancelFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }

    const disconnectObservers = () => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      mutationObserverRef.current?.disconnect()
      mutationObserverRef.current = null
    }

    const updateRect = () => {
      if (!isMounted || !currentElement) {
        return
      }

      const nextRect = getElementTargetRect(currentElement)

      if (scrollIntoViewIfNeeded) {
        scrollElementIntoViewIfNeeded(currentElement, nextRect)
      }

      setRect((previousRect) => isTargetRectEqual(previousRect, nextRect) ? previousRect : nextRect)
    }

    const scheduleRectUpdate = () => {
      if (animationFrameRef.current !== null) {
        return
      }

      const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16))

      animationFrameRef.current = requestFrame(() => {
        animationFrameRef.current = null
        updateRect()
      })
    }

    const connectObservers = () => {
      if (!currentElement) {
        return
      }

      disconnectObservers()

      if (typeof ResizeObserver !== "undefined") {
        resizeObserverRef.current = new ResizeObserver(() => {
          scheduleRectUpdate()
        })
        resizeObserverRef.current.observe(currentElement)
      }

      if (typeof MutationObserver !== "undefined") {
        mutationObserverRef.current = new MutationObserver(() => {
          scheduleRectUpdate()
        })

        mutationObserverRef.current.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
        })
      }

      window.addEventListener("scroll", scheduleRectUpdate, true)
      window.addEventListener("resize", scheduleRectUpdate)
      window.addEventListener("orientationchange", scheduleRectUpdate)
    }

    const disconnectListeners = () => {
      window.removeEventListener("scroll", scheduleRectUpdate, true)
      window.removeEventListener("resize", scheduleRectUpdate)
      window.removeEventListener("orientationchange", scheduleRectUpdate)
    }

    void resolveOnboardingTargetElement(selector, { attempts, delayMs }).then((resolvedElement) => {
      if (!isMounted) {
        return
      }

      currentElement = resolvedElement
      setElement(resolvedElement)
      setIsResolved(true)

      if (!resolvedElement) {
        setRect(null)
        return
      }

      updateRect()
      connectObservers()
    })

    return () => {
      isMounted = false
      currentElement = null
      clearScheduledFrame()
      disconnectObservers()
      disconnectListeners()
    }
  }, [attempts, delayMs, enabled, scrollIntoViewIfNeeded, selector])

  return {
    rect,
    element,
    isResolved,
  }
}

export function useTargetRects(
  selectors: string[] | null | undefined,
  options: UseTargetRectOptions = {},
): UseTargetRectsResult {
  const {
    enabled = true,
    attempts = 3,
    delayMs = 100,
    scrollIntoViewIfNeeded = false,
  } = options

  const [rects, setRects] = useState<OnboardingTargetRect[]>([])
  const [elements, setElements] = useState<HTMLElement[]>([])
  const [isResolved, setIsResolved] = useState(false)

  const animationFrameRef = useRef<number | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const mutationObserverRef = useRef<MutationObserver | null>(null)

  useEffect(() => {
    if (!enabled || !selectors?.length || typeof document === "undefined") {
      setElements([])
      setRects([])
      setIsResolved(false)
      return undefined
    }

    let isMounted = true
    let currentElements: HTMLElement[] = []

    const clearScheduledFrame = () => {
      if (animationFrameRef.current !== null) {
        const cancelFrame = typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function"
          ? window.cancelAnimationFrame.bind(window)
          : clearTimeout

        cancelFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }

    const disconnectObservers = () => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      mutationObserverRef.current?.disconnect()
      mutationObserverRef.current = null
    }

    const updateRects = () => {
      if (!isMounted || currentElements.length === 0) {
        return
      }

      const nextRects = currentElements.map((element) => getElementTargetRect(element))

      if (scrollIntoViewIfNeeded) {
        nextRects.forEach((rect, index) => {
          const element = currentElements[index]
          if (element) {
            scrollElementIntoViewIfNeeded(element, rect)
          }
        })
      }

      setRects((previousRects) => areTargetRectListsEqual(previousRects, nextRects) ? previousRects : nextRects)
    }

    const scheduleRectUpdate = () => {
      if (animationFrameRef.current !== null) {
        return
      }

      const requestFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16))

      animationFrameRef.current = requestFrame(() => {
        animationFrameRef.current = null
        updateRects()
      })
    }

    const connectObservers = () => {
      if (currentElements.length === 0) {
        return
      }

      disconnectObservers()

      if (typeof ResizeObserver !== "undefined") {
        resizeObserverRef.current = new ResizeObserver(() => {
          scheduleRectUpdate()
        })

        currentElements.forEach((element) => resizeObserverRef.current?.observe(element))
      }

      if (typeof MutationObserver !== "undefined") {
        mutationObserverRef.current = new MutationObserver(() => {
          scheduleRectUpdate()
        })

        mutationObserverRef.current.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
        })
      }

      window.addEventListener("scroll", scheduleRectUpdate, true)
      window.addEventListener("resize", scheduleRectUpdate)
      window.addEventListener("orientationchange", scheduleRectUpdate)
    }

    const disconnectListeners = () => {
      window.removeEventListener("scroll", scheduleRectUpdate, true)
      window.removeEventListener("resize", scheduleRectUpdate)
      window.removeEventListener("orientationchange", scheduleRectUpdate)
    }

    void resolveOnboardingTargetElements(selectors, { attempts, delayMs }).then((resolvedElements) => {
      if (!isMounted) {
        return
      }

      currentElements = resolvedElements
      setElements(resolvedElements)
      setIsResolved(true)

      if (resolvedElements.length === 0) {
        setRects([])
        return
      }

      updateRects()
      connectObservers()
    })

    return () => {
      isMounted = false
      clearScheduledFrame()
      disconnectObservers()
      disconnectListeners()
    }
  }, [attempts, delayMs, enabled, scrollIntoViewIfNeeded, selectors])

  return {
    rects,
    elements,
    isResolved,
  }
}