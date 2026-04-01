/**
 * Localized Time Formatting
 * ==========================
 * 
 * Format relative time with translations.
 * Uses the app's translation system for localized strings.
 */

type TimeTranslations = {
  justNow: string
  momentAgo: string
  fewMinutesAgo: string
  earlierThisHour: string
  earlierToday: string
  thisMorning: string
  thisAfternoon: string
  thisEvening: string
  yesterdayMorning: string
  yesterdayAfternoon: string
  yesterdayEvening: string
  twoDaysAgo: string
  threeDaysAgo: string
  fewDaysAgo: string
  lastWeek: string
  coupleWeeksAgo: string
  fewWeeksAgo: string
}

/**
 * Format relative time with localized strings.
 * 
 * @param timestamp - Unix timestamp or Date
 * @param translations - Localized time strings from t("welcomeBack.time")
 * @param locale - Locale for date formatting (e.g., "es", "en", "it")
 * @returns Localized relative time string
 */
export function formatLocalizedRelativeTime(
  timestamp: number | Date,
  translations: TimeTranslations,
  locale: string = "en"
): string {
  const date = typeof timestamp === "number" ? new Date(timestamp) : timestamp
  const now = Date.now()
  const diff = now - date.getTime()
  
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  const weeks = Math.floor(days / 7)
  
  // Current moment
  if (minutes < 1) return translations.justNow
  
  // Within the last hour
  if (minutes < 60) {
    if (minutes < 5) return translations.momentAgo
    if (minutes < 30) return translations.fewMinutesAgo
    return translations.earlierThisHour
  }
  
  // Today
  if (hours < 24) {
    const currentHour = new Date().getHours()
    const timestampHour = date.getHours()
    
    // Same time of day (morning/afternoon/evening)
    if (Math.abs(currentHour - timestampHour) < 3) {
      return translations.earlierToday
    }
    
    // Different time of day
    if (timestampHour < 12) return translations.thisMorning
    if (timestampHour < 17) return translations.thisAfternoon
    return translations.thisEvening
  }
  
  // Yesterday
  if (days === 1) {
    const hour = date.getHours()
    
    if (hour < 12) return translations.yesterdayMorning
    if (hour < 17) return translations.yesterdayAfternoon
    return translations.yesterdayEvening
  }
  
  // Recent days
  if (days === 2) return translations.twoDaysAgo
  if (days === 3) return translations.threeDaysAgo
  if (days < 7) return translations.fewDaysAgo
  
  // Recent weeks
  if (weeks === 1) return translations.lastWeek
  if (weeks === 2) return translations.coupleWeeksAgo
  if (weeks < 4) return translations.fewWeeksAgo
  
  // Older - show localized date
  const localeMap: Record<string, string> = {
    en: "en-US",
    es: "es-ES",
    it: "it-IT",
  }
  
  const dateLocale = localeMap[locale] || "en-US"
  const month = date.toLocaleDateString(dateLocale, { month: "short" })
  const day = date.getDate()
  
  // This year - just month and day
  if (date.getFullYear() === new Date().getFullYear()) {
    return `${day} ${month}`
  }
  
  // Last year or older - include year
  return `${day} ${month} ${date.getFullYear()}`
}
