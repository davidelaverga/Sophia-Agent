"use client"

import { useEffect } from 'react'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import { SplashScreen } from '@capacitor/splash-screen'
import { logger } from '../lib/error-logger'

/**
 * CapacitorInit - Initializes Capacitor plugins on app mount
 * 
 * This component should be rendered once at the app root.
 * It handles:
 * - Hiding splash screen after app loads
 * - Setting status bar style based on current theme
 * - Listening for theme changes to update status bar
 */
export function CapacitorInit() {
  useEffect(() => {
    const initCapacitor = async () => {
      if (!Capacitor.isNativePlatform()) return

      const platform = Capacitor.getPlatform()

      try {
        // Get current theme from document
        const currentTheme = document.documentElement.dataset.sophiaTheme || 'light'
        const isDark = currentTheme === 'dark'

        // Set status bar style
        await StatusBar.setStyle({ 
          style: isDark ? Style.Dark : Style.Light 
        })

        // On Android, set status bar background color
        if (platform === 'android') {
          await StatusBar.setBackgroundColor({ 
            color: isDark ? '#0a0a0f' : '#f8f7fa' 
          })
        }

        // Hide splash screen with fade animation
        await SplashScreen.hide({ fadeOutDuration: 300 })
      } catch (error) {
        logger.logError(error, { component: 'CapacitorInit', action: 'initialize' })
      }
    }

    // Run after a short delay to ensure DOM is ready
    const timer = setTimeout(initCapacitor, 100)
    return () => clearTimeout(timer)
  }, [])

  // Listen for theme changes and update status bar
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    const observer = new MutationObserver(async (mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'data-sophia-theme') {
          const newTheme = document.documentElement.dataset.sophiaTheme
          const isDark = newTheme === 'dark'
          const platform = Capacitor.getPlatform()

          try {
            await StatusBar.setStyle({ 
              style: isDark ? Style.Dark : Style.Light 
            })

            if (platform === 'android') {
              await StatusBar.setBackgroundColor({ 
                color: isDark ? '#0a0a0f' : '#f8f7fa' 
              })
            }
          } catch (error) {
            logger.logError(error, { component: 'CapacitorInit', action: 'update_status_bar' })
          }
        }
      }
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-sophia-theme'],
    })

    return () => observer.disconnect()
  }, [])

  return null
}
