/**
 * Humanize Time
 * Sprint 1+ - UX Polish
 * 
 * Makes timestamps feel conversational, not robotic.
 * "2:30 PM" → "just now", "2m ago", "earlier today"
 */

export type TimeStyle = 'relative' | 'friendly' | 'minimal';

interface HumanizedTime {
  /** The human-readable string */
  text: string;
  /** Tooltip with exact time */
  tooltip: string;
  /** Should auto-update (within last minute) */
  shouldUpdate: boolean;
}

/**
 * Convert timestamp to human-friendly format
 * 
 * @example
 * humanizeTime(Date.now() - 30000) // { text: "just now", ... }
 * humanizeTime(Date.now() - 180000) // { text: "3m ago", ... }
 * humanizeTime(yesterday) // { text: "yesterday", ... }
 */
export function humanizeTime(
  timestamp: Date | string | number,
  style: TimeStyle = 'relative'
): HumanizedTime {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  // Full tooltip
  const tooltip = date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  
  // Minimal style - just time or date
  if (style === 'minimal') {
    if (diffDays === 0) {
      return {
        text: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        tooltip,
        shouldUpdate: false,
      };
    }
    return {
      text: date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      tooltip,
      shouldUpdate: false,
    };
  }
  
  // Relative style - "2m ago", "3h ago"
  if (style === 'relative') {
    if (diffSeconds < 30) {
      return { text: 'just now', tooltip, shouldUpdate: true };
    }
    if (diffSeconds < 60) {
      return { text: `${diffSeconds}s ago`, tooltip, shouldUpdate: true };
    }
    if (diffMinutes < 60) {
      return { text: `${diffMinutes}m ago`, tooltip, shouldUpdate: diffMinutes < 5 };
    }
    if (diffHours < 24) {
      return { text: `${diffHours}h ago`, tooltip, shouldUpdate: false };
    }
    if (diffDays === 1) {
      return { text: 'yesterday', tooltip, shouldUpdate: false };
    }
    if (diffDays < 7) {
      return { text: `${diffDays}d ago`, tooltip, shouldUpdate: false };
    }
    return {
      text: date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      tooltip,
      shouldUpdate: false,
    };
  }
  
  // Friendly style - conversational
  if (diffSeconds < 30) {
    return { text: 'just now', tooltip, shouldUpdate: true };
  }
  if (diffSeconds < 60) {
    return { text: 'moments ago', tooltip, shouldUpdate: true };
  }
  if (diffMinutes === 1) {
    return { text: 'a minute ago', tooltip, shouldUpdate: true };
  }
  if (diffMinutes < 5) {
    return { text: 'a few minutes ago', tooltip, shouldUpdate: true };
  }
  if (diffMinutes < 60) {
    return { text: `${diffMinutes} minutes ago`, tooltip, shouldUpdate: false };
  }
  if (diffHours === 1) {
    return { text: 'an hour ago', tooltip, shouldUpdate: false };
  }
  if (diffHours < 6) {
    return { text: `${diffHours} hours ago`, tooltip, shouldUpdate: false };
  }
  
  // Same day
  if (isSameDay(date, now)) {
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffHours < 12) {
      return { text: `earlier today at ${timeStr}`, tooltip, shouldUpdate: false };
    }
    return { text: `today at ${timeStr}`, tooltip, shouldUpdate: false };
  }
  
  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(date, yesterday)) {
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { text: `yesterday at ${timeStr}`, tooltip, shouldUpdate: false };
  }
  
  // Within a week
  if (diffDays < 7) {
    const dayName = date.toLocaleDateString([], { weekday: 'long' });
    return { text: dayName, tooltip, shouldUpdate: false };
  }
  
  // Older
  return {
    text: date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    tooltip,
    shouldUpdate: false,
  };
}

/**
 * Check if two dates are the same calendar day
 */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Format duration in a friendly way
 * 
 * @example
 * humanizeDuration(180) // "3 min"
 * humanizeDuration(3600) // "1 hr"
 * humanizeDuration(90) // "1.5 min"
 */
export function humanizeDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    const mins = Math.round(seconds / 60);
    return `${mins} min`;
  }
  const hours = Math.round(seconds / 360) / 10; // One decimal
  return hours === 1 ? '1 hr' : `${hours} hrs`;
}

/**
 * Get a greeting based on time elapsed since last interaction
 * 
 * @example
 * getReturnGreeting(Date.now() - 3600000) // "Hey, you're back!"
 * getReturnGreeting(yesterday) // "Good to see you again"
 */
export function getReturnGreeting(lastSeen: Date | string | number): string {
  const date = new Date(lastSeen);
  const now = new Date();
  const diffHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);
  
  if (diffHours < 1) {
    return "Back so soon?";
  }
  if (diffHours < 6) {
    return "Hey, you're back!";
  }
  if (diffHours < 24) {
    return "Good to see you again";
  }
  if (diffHours < 48) {
    return "Welcome back";
  }
  if (diffHours < 168) { // 1 week
    return "It's been a few days";
  }
  return "Long time no see";
}
