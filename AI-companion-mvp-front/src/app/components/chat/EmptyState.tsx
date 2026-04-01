"use client"

import { useMemo } from "react"
import { useCopy, useTranslation } from "../../copy"
import { getTimeBasedGreeting } from "../../lib/time-greetings"

type EmptyStateProps = {
  onPromptSelect: (prompt: string) => void
}

export function EmptyState({ onPromptSelect }: EmptyStateProps) {
  const copy = useCopy()
  const { t } = useTranslation()

  // Get time-based greeting on mount (memoized to avoid recalculation on re-renders)
  const greeting = useMemo(() => getTimeBasedGreeting(copy), [copy])

  return (
    <div className="flex h-full flex-col justify-between gap-8 rounded-2xl bg-sophia-bubble p-8 text-sophia-text">
      <div className="space-y-4">
        {/* Presence indicator with breathing animation */}
        <p className="inline-flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-sophia-purple animate-breathe">
          <span className="text-base">{greeting.icon}</span>
          <span>{copy.home.hero.status}</span>
        </p>
        
        {/* Welcome message with time-based greeting */}
        <div className="space-y-3">
          <h2 className="text-3xl font-semibold text-sophia-text sm:text-4xl">
            {greeting.heading}
          </h2>
          <p className="text-base leading-relaxed text-sophia-text2 sm:text-lg">
            {greeting.body}
          </p>
        </div>
      </div>
      
      {/* Quick prompts with enhanced styling */}
      <div className="space-y-4">
        <p className="text-sm font-medium text-sophia-text2">{t("chat.quickStartTitle")}</p>
        <div className="flex flex-wrap gap-2.5">
          {copy.chat.quickPrompts.map((prompt, index) => (
            <button
              key={prompt.id}
              type="button"
              className="group cursor-pointer rounded-xl border border-sophia-surface-border bg-sophia-surface px-4 py-2.5 text-sm font-medium text-sophia-text shadow-soft transition-all duration-300 ease-out hover:scale-[1.02] hover:border-sophia-purple/40 hover:bg-sophia-button-hover hover:text-sophia-purple hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple/20"
              onClick={() => onPromptSelect(prompt.label)}
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <span className="mr-2 inline-block text-base transition-transform duration-300 group-hover:scale-110" aria-hidden>
                {prompt.emoji}
              </span>
              <span>{prompt.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
