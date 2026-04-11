"use client"

import { ArrowUpRight, ShieldCheck } from "lucide-react"
import Link from "next/link"

import { useTranslation } from "../../copy"

export function PrivacyPanel() {
  const { t } = useTranslation()

  return (
    <section aria-labelledby="privacy-panel-title" className="cosmic-surface-panel-strong rounded-[1.8rem] p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <div className="cosmic-surface-panel flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-[var(--sophia-purple)]">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
            Privacy
          </p>
          <h3 id="privacy-panel-title" className="mt-1 font-cormorant text-[1.65rem] font-light" style={{ color: 'var(--cosmic-text-strong)' }}>
            {t("privacyPanel.title")}
          </h3>
          <p className="mt-2 text-sm leading-6" style={{ color: 'var(--cosmic-text-muted)' }}>
            {t("privacyPanel.subtitle")}
          </p>
        </div>
      </div>

      <div className="cosmic-surface-panel mt-5 rounded-[1.35rem] p-4">
        <p className="text-[12px] leading-5" style={{ color: 'var(--cosmic-text-muted)' }}>
          Privacy export and destructive account controls stay hidden until the backend surfaces are fully ready. The live action today is the full privacy policy.
        </p>

        <Link
          href="/privacy"
          className="cosmic-accent-pill cosmic-focus-ring mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-medium tracking-[0.02em] transition-all duration-300"
        >
          <span>{t("privacyPanel.readPolicyLink")}</span>
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  )
}



