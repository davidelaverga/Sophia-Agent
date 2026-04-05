/**
 * Format relative time with humanized, conversational language
 * 
 * Examples:
 * - "Just now" → within last minute
 * - "A moment ago" → 1-5 minutes
 * - "This morning" → today, before noon
 * - "Yesterday evening" → yesterday, after 6pm
 * - "A few days ago" → 4-6 days
 * - "Last week" → 7-13 days
 * - "Sep 15" → this year, older than a month
 * - "Sep 15, 2024" → last year or older
 */
export function formatRelativeTime(timestamp: number | Date): string {
  const date = typeof timestamp === "number" ? new Date(timestamp) : timestamp
  const now = Date.now()
  const diff = now - date.getTime()
  
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  const weeks = Math.floor(days / 7)
  
  // Current moment
  if (minutes < 1) return "Just now"
  
  // Within the last hour
  if (minutes < 60) {
    if (minutes < 5) return "A moment ago"
    if (minutes < 30) return "A few minutes ago"
    return "Earlier this hour"
  }
  
  // Today
  if (hours < 24) {
    const currentHour = new Date().getHours()
    const timestampHour = date.getHours()
    
    // Same time of day (morning/afternoon/evening)
    if (Math.abs(currentHour - timestampHour) < 3) {
      return "Earlier today"
    }
    
    // Different time of day
    if (timestampHour < 12) return "This morning"
    if (timestampHour < 17) return "This afternoon"
    return "This evening"
  }
  
  // Yesterday
  if (days === 1) {
    const hour = date.getHours()
    
    if (hour < 12) return "Yesterday morning"
    if (hour < 17) return "Yesterday afternoon"
    return "Yesterday evening"
  }
  
  // Recent days
  if (days === 2) return "Two days ago"
  if (days === 3) return "Three days ago"
  if (days < 7) return "A few days ago"
  
  // Recent weeks
  if (weeks === 1) return "Last week"
  if (weeks === 2) return "A couple weeks ago"
  if (weeks < 4) return "A few weeks ago"
  
  // Older - show date
  const month = date.toLocaleDateString('en-US', { month: 'short' })
  const day = date.getDate()
  
  // This year - just month and day
  if (date.getFullYear() === new Date().getFullYear()) {
    return `${month} ${day}`
  }
  
  // Last year or older - include year
  return `${month} ${day}, ${date.getFullYear()}`
}

/**
 * Format time for short display (e.g., in timestamps)
 * More compact than formatRelativeTime
 */
export function formatShortTime(timestamp: number | Date): string {
  const date = typeof timestamp === "number" ? new Date(timestamp) : timestamp
  const now = Date.now()
  const diff = now - date.getTime()
  
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  if (days === 1) return "yesterday"
  if (days < 7) return `${days}d`
  
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
