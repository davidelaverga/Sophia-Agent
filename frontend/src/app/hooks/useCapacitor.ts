"use client"

import { Capacitor } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import { useEffect, useState } from 'react'

import { logger } from '../lib/error-logger'

/** Read the current --bg CSS custom property value, with a dark-mode fallback. */
function getThemeBgColor(isDark: boolean): string {
  const computed = globalThis.document
    ? getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    : ''
  return computed || (isDark ? '#0a0a0f' : '#ffffff')
}

/**
 * useCapacitor - Initialize Capacitor plugins and provide platform info
 * 
 * This hook handles:
 * - Hiding splash screen after app loads
 * - Setting status bar style based on theme
 * - Providing platform detection utilities
 */
export function useCapacitor() {
  const [isReady, setIsReady] = useState(false)
  const isNative = Capacitor.isNativePlatform()
  const platform = Capacitor.getPlatform() // 'ios' | 'android' | 'web'

  useEffect(() => {
    async function initializeCapacitor() {
      if (!isNative) {
        setIsReady(true)
        return
      }

      try {
        // Hide splash screen after a brief delay to ensure UI is rendered
        await SplashScreen.hide({ fadeOutDuration: 300 })

        // Set initial status bar style
        const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches
        await StatusBar.setStyle({ 
          style: isDarkMode ? Style.Dark : Style.Light 
        })

        // On Android, set status bar background color
        if (platform === 'android') {
          await StatusBar.setBackgroundColor({ 
            color: getThemeBgColor(isDarkMode),
          })
        }
      } catch (error) {
        logger.logError(error, {
          component: 'useCapacitor',
          action: 'initialize',
        })
      }

      setIsReady(true)
    }

    void initializeCapacitor()
  }, [isNative, platform])

  // Update status bar when theme changes
  useEffect(() => {
    if (!isNative) return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    
    const updateThemeChange = async (e: MediaQueryListEvent) => {
      try {
        await StatusBar.setStyle({ 
          style: e.matches ? Style.Dark : Style.Light 
        })

        if (platform === 'android') {
          await StatusBar.setBackgroundColor({ 
            color: getThemeBgColor(e.matches),
          })
        }
      } catch (error) {
        logger.logError(error, {
          component: 'useCapacitor',
          action: 'status_bar_update',
        })
      }
    }

    const handleThemeChange = (e: MediaQueryListEvent) => {
      void updateThemeChange(e)
    }

    mediaQuery.addEventListener('change', handleThemeChange)
    return () => mediaQuery.removeEventListener('change', handleThemeChange)
  }, [isNative, platform])

  return {
    isReady,
    isNative,
    platform,
    isIOS: platform === 'ios',
    isAndroid: platform === 'android',
    isWeb: platform === 'web',
  }
}

/**
 * Update status bar style programmatically
 */
export async function setStatusBarStyle(isDark: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  try {
    await StatusBar.setStyle({ 
      style: isDark ? Style.Dark : Style.Light 
    })

    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ 
        color: getThemeBgColor(isDark),
      })
    }
  } catch (error) {
    logger.logError(error, {
      component: 'useCapacitor',
      action: 'status_bar_style_update',
    })
  }
}

/**
 * Show/hide status bar
 */
export async function toggleStatusBar(show: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  try {
    if (show) {
      await StatusBar.show()
    } else {
      await StatusBar.hide()
    }
  } catch (error) {
    logger.logError(error, {
      component: 'useCapacitor',
      action: 'status_bar_toggle',
    })
  }
}
