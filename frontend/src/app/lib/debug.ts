/**
 * Debug utility that only logs in development mode.
 * All logs are stripped in production builds.
 * 
 * Usage:
 *   import { debug } from '@/app/lib/debug'
 *   debug.log('[component]', 'message', data)
 *   debug.warn('[component]', 'warning message')
 *   debug.error('[component]', 'error message', error)
 */

const isDev = process.env.NODE_ENV === 'development'
const verboseFromEnv = process.env.NEXT_PUBLIC_VERBOSE_LOGS === 'true'
const verboseStorageKey = 'sophia:verbose-logs'

type LogLevel = 'log' | 'warn' | 'error' | 'debug' | 'info'

const createLogger = (level: LogLevel) => {
  return (...args: unknown[]) => {
    if (isDev) {
       
      console[level](...args)
    }
  }
}

const logDebug = createLogger('log')

export const isVerboseDebugEnabled = (): boolean => {
  if (!isDev) return false
  if (verboseFromEnv) return true
  if (typeof window === 'undefined') return false

  try {
    return window.localStorage.getItem(verboseStorageKey) === '1'
  } catch {
    return false
  }
}

const createVerboseLogger = (level: LogLevel) => {
  return (...args: unknown[]) => {
    if (isVerboseDebugEnabled()) {
       
      console[level](...args)
    }
  }
}

export const debug = {
  log: createLogger('log'),
  warn: createLogger('warn'),
  error: createLogger('error'),
  debug: createLogger('debug'),
  info: createLogger('info'),
  verbose: createVerboseLogger('debug'),
  
  /**
   * Log only once per key (useful for repeated renders)
   */
  once: (() => {
    const logged = new Set<string>()
    return (key: string, ...args: unknown[]) => {
      if (isDev && !logged.has(key)) {
        logged.add(key)
        logDebug(`[once:${key}]`, ...args)
      }
    }
  })(),
  
  /**
   * Group related logs together
   */
  group: (label: string, fn: () => void) => {
    if (isDev) {
       
      console.group(label)
      fn()
       
      console.groupEnd()
    }
  },
  
  /**
   * Time a function execution
   */
  time: <T>(label: string, fn: () => T): T => {
    if (isDev) {
       
      console.time(label)
      const result = fn()
       
      console.timeEnd(label)
      return result
    }
    return fn()
  },
}

// Also export individual functions for convenience
export const { log, warn, error, info } = debug
