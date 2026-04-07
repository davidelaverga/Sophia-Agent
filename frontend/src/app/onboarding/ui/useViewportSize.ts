"use client"

import { useEffect, useState } from "react"

type ViewportSize = {
  width: number
  height: number
}

function readViewportSize(): ViewportSize {
  if (typeof window === "undefined") {
    return {
      width: 0,
      height: 0,
    }
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  }
}

export function useViewportSize(): ViewportSize {
  const [viewportSize, setViewportSize] = useState<ViewportSize>(() => readViewportSize())

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined
    }

    let orientationTimer: ReturnType<typeof setTimeout> | null = null

    const updateViewportSize = () => {
      setViewportSize(readViewportSize())
    }

    const handleOrientationChange = () => {
      if (orientationTimer) {
        clearTimeout(orientationTimer)
      }

      orientationTimer = setTimeout(updateViewportSize, 200)
    }

    updateViewportSize()
    window.addEventListener("resize", updateViewportSize)
    window.addEventListener("orientationchange", handleOrientationChange)

    return () => {
      window.removeEventListener("resize", updateViewportSize)
      window.removeEventListener("orientationchange", handleOrientationChange)

      if (orientationTimer) {
        clearTimeout(orientationTimer)
      }
    }
  }, [])

  return viewportSize
}