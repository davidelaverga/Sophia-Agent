/**
 * Hook for trapping focus within a modal or dialog
 * Implements WCAG 2.1 focus management best practices
 */

import { useEffect, useRef } from "react"

const FOCUSABLE_ELEMENTS = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
]

export function useFocusTrap(isActive: boolean = true) {
  const containerRef = useRef<HTMLDivElement>(null)
  const previouslyFocusedElement = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!isActive) return

    // Store the element that had focus before the modal opened
    previouslyFocusedElement.current = document.activeElement as HTMLElement

    const container = containerRef.current
    if (!container) return

    // Focus first focusable element
    const focusableElements = container.querySelectorAll<HTMLElement>(
      FOCUSABLE_ELEMENTS.join(',')
    )
    
    if (focusableElements.length > 0) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        focusableElements[0]?.focus()
      }, 50)
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return

      const focusableElements = container.querySelectorAll<HTMLElement>(
        FOCUSABLE_ELEMENTS.join(',')
      )
      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]

      // Shift + Tab: if on first element, go to last
      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault()
          lastElement?.focus()
        }
      } 
      // Tab: if on last element, go to first
      else {
        if (document.activeElement === lastElement) {
          e.preventDefault()
          firstElement?.focus()
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('keydown', handleKeyDown)
    }
  }, [isActive])

  /**
   * Restore focus to previously focused element
   * Call this when closing the modal
   */
  const restoreFocus = () => {
    if (previouslyFocusedElement.current) {
      // Small delay to ensure modal is closed
      setTimeout(() => {
        previouslyFocusedElement.current?.focus()
        previouslyFocusedElement.current = null
      }, 50)
    }
  }

  return {
    containerRef,
    restoreFocus,
  }
}
