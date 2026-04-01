/**
 * Utility functions for Sophia V2
 * Sprint 1 - Week 1
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind CSS classes with clsx
 * Handles conditional classes and deduplication
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Generate a unique message ID using crypto.randomUUID with fallback
 * Used for chat messages, voice history, etc.
 */
export function createMessageId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

/**
 * Generate a unique ID for local use
 * Format: prefix_timestamp_random
 */
export function generateLocalId(prefix: string = 'local'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Check if a string is a valid UUID (v1-v5)
 */
export function isUuid(value: string | undefined | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Format duration in seconds to human readable string
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Get color class for emotion tag based on common emotion categories
 */
export function getEmotionColor(emotion: string): string {
  const emotionLower = emotion.toLowerCase();
  
  // Positive emotions
  if (['joy', 'happy', 'excited', 'hopeful', 'proud', 'confident', 'calm'].includes(emotionLower)) {
    return 'bg-green-900/50 text-green-300 border-green-700';
  }
  
  // Negative emotions
  if (['angry', 'frustrated', 'annoyed', 'irritated', 'rage'].includes(emotionLower)) {
    return 'bg-red-900/50 text-red-300 border-red-700';
  }
  
  // Sad emotions
  if (['sad', 'disappointed', 'defeated', 'hopeless', 'down'].includes(emotionLower)) {
    return 'bg-blue-900/50 text-blue-300 border-blue-700';
  }
  
  // Anxious emotions
  if (['anxious', 'nervous', 'worried', 'stressed', 'overwhelmed'].includes(emotionLower)) {
    return 'bg-yellow-900/50 text-yellow-300 border-yellow-700';
  }
  
  // Neutral/default
  return 'bg-gray-700/50 text-gray-300 border-gray-600';
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  
  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      func(...args);
    }, wait);
  };
}

/**
 * Check if we're running in a browser environment
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Safe localStorage access with fallback
 */
export const safeLocalStorage = {
  getItem: (key: string): string | null => {
    if (!isBrowser()) return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  
  setItem: (key: string, value: string): boolean => {
    if (!isBrowser()) return false;
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  
  removeItem: (key: string): boolean => {
    if (!isBrowser()) return false;
    try {
      localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  },
};
