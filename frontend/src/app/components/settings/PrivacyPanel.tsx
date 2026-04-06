"use client"

import Link from "next/link"

import { useTranslation } from "../../copy"

export function PrivacyPanel() {
  const { t } = useTranslation()

  return (
    <section aria-labelledby="privacy-panel-title" className="rounded-3xl border-2 border-sophia-surface-border bg-sophia-surface p-4 shadow-lg">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p id="privacy-panel-title" className="text-base font-semibold text-sophia-text">
            {t("privacyPanel.title")}
          </p>
          <p className="text-sm text-sophia-text2">{t("privacyPanel.subtitle")}</p>
        </div>
      </div>

      {/* Privacy policy link */}
      <Link
        href="/privacy"
        className="mt-3 inline-flex items-center gap-1 text-sm text-sophia-purple hover:underline"
      >
        {t("privacyPanel.readPolicyLink")}
      </Link>

      {/* Export and Delete buttons are disabled until backend support is ready */}
    </section>
  )
}



