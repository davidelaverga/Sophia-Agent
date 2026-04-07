"use client"

 

import { ArrowLeft, Shield, Eye, Database, Lock, Users, Mail, Calendar, Heart, Sparkles } from "lucide-react"
import Link from "next/link"

import { useTranslation } from "../copy"

const LAST_UPDATED = "December 7, 2025"

export default function PrivacyPolicyPage() {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen bg-sophia-bg">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-sophia-surface-border bg-sophia-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-4">
          <Link 
            href="/"
            className="flex items-center gap-2 rounded-xl p-2 text-sophia-text2 transition-all duration-300 hover:bg-sophia-purple/10 hover:text-sophia-purple hover:scale-105"
            aria-label={t("privacyPolicy.backToHomeAriaLabel")}
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sophia-purple text-sm font-semibold text-white shadow-md animate-breatheSlow">
              S
            </div>
            <div>
              <h1 className="text-xl font-semibold text-sophia-text">{t("privacyPolicy.headerTitle")}</h1>
              <p className="text-xs text-sophia-text2">{t("privacyPolicy.headerLastUpdated", { date: LAST_UPDATED })}</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* Sophia's voice introduction */}
        <section className="mb-10 animate-fadeIn">
          <div className="rounded-3xl bg-gradient-to-br from-sophia-purple/10 via-sophia-surface to-sophia-surface p-8 ring-1 ring-sophia-purple/20 shadow-soft">
            <div className="flex items-start gap-5">
              <div className="rounded-2xl bg-sophia-purple/20 p-4 animate-breatheSlow">
                <Heart className="h-7 w-7 text-sophia-purple" />
              </div>
              <div className="space-y-3">
                <h2 className="text-xl font-semibold text-sophia-text">Your trust means everything to me</h2>
                <p className="text-sophia-text2 leading-relaxed italic">
                  {t("privacyPolicy.intro.quote")}
                </p>
                <p className="text-sm text-sophia-text2">
                  {t("privacyPolicy.intro.signature")}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Policy sections */}
        <div className="space-y-6">
          
          {/* What We Collect */}
          <section className="rounded-2xl bg-sophia-surface p-6 ring-1 ring-sophia-text/5 transition-all duration-300 hover:ring-sophia-purple/20 hover:shadow-soft/50">
            <div className="mb-5 flex items-center gap-3">
              <div className="rounded-xl bg-sophia-purple/10 p-2.5">
                <Database className="h-5 w-5 text-sophia-purple" />
              </div>
              <h2 className="text-lg font-semibold text-sophia-text">{t("privacyPolicy.sections.collect.title")}</h2>
            </div>
            <div className="space-y-4 text-sophia-text2">
              <div className="rounded-xl bg-sophia-bg/50 p-4">
                <h3 className="font-medium text-sophia-text flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-sophia-purple" />
                  {t("privacyPolicy.sections.collect.cards.conversations.title")}
                </h3>
                <p className="mt-2 leading-relaxed text-sm">
                  {t("privacyPolicy.sections.collect.cards.conversations.body")}
                </p>
              </div>
              <div className="rounded-xl bg-sophia-bg/50 p-4">
                <h3 className="font-medium text-sophia-text flex items-center gap-2">
                  <Users className="h-4 w-4 text-sophia-purple" />
                  {t("privacyPolicy.sections.collect.cards.account.title")}
                </h3>
                <p className="mt-2 leading-relaxed text-sm">
                  {t("privacyPolicy.sections.collect.cards.account.body")}
                </p>
              </div>
              <div className="rounded-xl bg-sophia-bg/50 p-4">
                <h3 className="font-medium text-sophia-text flex items-center gap-2">
                  <Eye className="h-4 w-4 text-sophia-purple" />
                  {t("privacyPolicy.sections.collect.cards.connection.title")}
                </h3>
                <p className="mt-2 leading-relaxed text-sm">
                  {t("privacyPolicy.sections.collect.cards.connection.body")}
                </p>
              </div>
            </div>
          </section>

          {/* How We Use Your Data */}
          <section className="rounded-2xl bg-sophia-surface p-6 ring-1 ring-sophia-text/5 transition-all duration-300 hover:ring-sophia-purple/20 hover:shadow-soft/50">
            <div className="mb-5 flex items-center gap-3">
              <div className="rounded-xl bg-sophia-purple/10 p-2.5">
                <Heart className="h-5 w-5 text-sophia-purple" />
              </div>
              <h2 className="text-lg font-semibold text-sophia-text">{t("privacyPolicy.sections.use.title")}</h2>
            </div>
            <ul className="space-y-3 text-sophia-text2">
              <li className="flex items-start gap-3 rounded-lg p-2 transition-colors hover:bg-sophia-bg/50">
                <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-sophia-purple animate-breatheSlow" />
                <span>{t("privacyPolicy.sections.use.bullets.personal")}</span>
              </li>
              <li className="flex items-start gap-3 rounded-lg p-2 transition-colors hover:bg-sophia-bg/50">
                <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-sophia-purple animate-breatheSlow" />
                <span>{t("privacyPolicy.sections.use.bullets.remember")}</span>
              </li>
              <li className="flex items-start gap-3 rounded-lg p-2 transition-colors hover:bg-sophia-bg/50">
                <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-sophia-purple animate-breatheSlow" />
                <span>{t("privacyPolicy.sections.use.bullets.reflectionCards")}</span>
              </li>
              <li className="flex items-start gap-3 rounded-lg p-2 transition-colors hover:bg-sophia-bg/50">
                <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-sophia-purple animate-breatheSlow" />
                <span>{t("privacyPolicy.sections.use.bullets.improve")}</span>
              </li>
            </ul>
          </section>

          {/* Community Sharing */}
          <section className="rounded-2xl bg-sophia-surface p-6 ring-1 ring-sophia-text/5 transition-all duration-300 hover:ring-sophia-purple/20 hover:shadow-soft/50">
            <div className="mb-5 flex items-center gap-3">
              <div className="rounded-xl bg-sophia-purple/10 p-2.5">
                <Users className="h-5 w-5 text-sophia-purple" />
              </div>
              <h2 className="text-lg font-semibold text-sophia-text">{t("privacyPolicy.sections.sharing.title")}</h2>
            </div>
            <div className="space-y-4 text-sophia-text2">
              <p className="leading-relaxed">
                {t("privacyPolicy.sections.sharing.intro")}
              </p>
              <div className="rounded-xl bg-gradient-to-r from-sophia-purple/5 to-transparent p-4 border-l-2 border-sophia-purple">
                <ul className="space-y-3 text-sm">
                  <li className="flex items-center gap-3">
                    <Shield className="h-4 w-4 text-sophia-purple flex-shrink-0" />
                    <span>
                      {t("privacyPolicy.sections.sharing.protections.nameNever.before")}{" "}
                      <strong className="text-sophia-text">{t("privacyPolicy.sections.sharing.protections.nameNever.emphasis")}</strong>{" "}
                      {t("privacyPolicy.sections.sharing.protections.nameNever.after")}
                    </span>
                  </li>
                  <li className="flex items-center gap-3">
                    <Lock className="h-4 w-4 text-sophia-purple flex-shrink-0" />
                    <span>{t("privacyPolicy.sections.sharing.protections.onlyWisdom")}</span>
                  </li>
                  <li className="flex items-center gap-3">
                    <Heart className="h-4 w-4 text-sophia-purple flex-shrink-0" />
                    <span>{t("privacyPolicy.sections.sharing.protections.keepPrivate")}</span>
                  </li>
                </ul>
              </div>
            </div>
          </section>

          {/* Data Security */}
          <section className="rounded-2xl bg-sophia-surface p-6 ring-1 ring-sophia-text/5 transition-all duration-300 hover:ring-sophia-purple/20 hover:shadow-soft/50">
            <div className="mb-5 flex items-center gap-3">
              <div className="rounded-xl bg-sophia-purple/10 p-2.5">
                <Lock className="h-5 w-5 text-sophia-purple" />
              </div>
              <h2 className="text-lg font-semibold text-sophia-text">{t("privacyPolicy.sections.security.title")}</h2>
            </div>
            <div className="space-y-4 text-sophia-text2">
              <p className="leading-relaxed">
                {t("privacyPolicy.sections.security.intro")}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-sophia-bg/50 p-4 text-center">
                  <div className="mx-auto mb-2 h-10 w-10 rounded-full bg-sophia-purple/10 flex items-center justify-center">
                    <Lock className="h-5 w-5 text-sophia-purple" />
                  </div>
                  <p className="text-sm font-medium text-sophia-text">{t("privacyPolicy.sections.security.grid.transit.title")}</p>
                  <p className="text-xs mt-1">{t("privacyPolicy.sections.security.grid.transit.body")}</p>
                </div>
                <div className="rounded-xl bg-sophia-bg/50 p-4 text-center">
                  <div className="mx-auto mb-2 h-10 w-10 rounded-full bg-sophia-purple/10 flex items-center justify-center">
                    <Database className="h-5 w-5 text-sophia-purple" />
                  </div>
                  <p className="text-sm font-medium text-sophia-text">{t("privacyPolicy.sections.security.grid.rest.title")}</p>
                  <p className="text-xs mt-1">{t("privacyPolicy.sections.security.grid.rest.body")}</p>
                </div>
                <div className="rounded-xl bg-sophia-bg/50 p-4 text-center">
                  <div className="mx-auto mb-2 h-10 w-10 rounded-full bg-sophia-purple/10 flex items-center justify-center">
                    <Shield className="h-5 w-5 text-sophia-purple" />
                  </div>
                  <p className="text-sm font-medium text-sophia-text">{t("privacyPolicy.sections.security.grid.isolated.title")}</p>
                  <p className="text-xs mt-1">{t("privacyPolicy.sections.security.grid.isolated.body")}</p>
                </div>
                <div className="rounded-xl bg-sophia-bg/50 p-4 text-center">
                  <div className="mx-auto mb-2 h-10 w-10 rounded-full bg-sophia-purple/10 flex items-center justify-center">
                    <Eye className="h-5 w-5 text-sophia-purple" />
                  </div>
                  <p className="text-sm font-medium text-sophia-text">{t("privacyPolicy.sections.security.grid.audits.title")}</p>
                  <p className="text-xs mt-1">{t("privacyPolicy.sections.security.grid.audits.body")}</p>
                </div>
              </div>
            </div>
          </section>

          {/* Your Rights */}
          <section className="rounded-2xl bg-sophia-surface p-6 ring-1 ring-sophia-text/5 transition-all duration-300 hover:ring-sophia-purple/20 hover:shadow-soft/50">
            <div className="mb-5 flex items-center gap-3">
              <div className="rounded-xl bg-sophia-purple/10 p-2.5">
                <Sparkles className="h-5 w-5 text-sophia-purple" />
              </div>
              <h2 className="text-lg font-semibold text-sophia-text">{t("privacyPolicy.sections.rights.title")}</h2>
            </div>
            <div className="space-y-4 text-sophia-text2">
              <p className="leading-relaxed">
                {t("privacyPolicy.sections.rights.intro")}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-sophia-bg/50 p-4 border border-transparent hover:border-sophia-purple/20 transition-colors">
                  <h3 className="font-medium text-sophia-text">{t("privacyPolicy.sections.rights.cards.export.title")}</h3>
                  <p className="mt-1 text-sm">{t("privacyPolicy.sections.rights.cards.export.body")}</p>
                </div>
                <div className="rounded-xl bg-sophia-bg/50 p-4 border border-transparent hover:border-sophia-purple/20 transition-colors">
                  <h3 className="font-medium text-sophia-text">{t("privacyPolicy.sections.rights.cards.delete.title")}</h3>
                  <p className="mt-1 text-sm">{t("privacyPolicy.sections.rights.cards.delete.body")}</p>
                </div>
                <div className="rounded-xl bg-sophia-bg/50 p-4 border border-transparent hover:border-sophia-purple/20 transition-colors">
                  <h3 className="font-medium text-sophia-text">{t("privacyPolicy.sections.rights.cards.withdraw.title")}</h3>
                  <p className="mt-1 text-sm">{t("privacyPolicy.sections.rights.cards.withdraw.body")}</p>
                </div>
                <div className="rounded-xl bg-sophia-bg/50 p-4 border border-transparent hover:border-sophia-purple/20 transition-colors">
                  <h3 className="font-medium text-sophia-text">{t("privacyPolicy.sections.rights.cards.logs.title")}</h3>
                  <p className="mt-1 text-sm">{t("privacyPolicy.sections.rights.cards.logs.body")}</p>
                </div>
              </div>
            </div>
          </section>

          {/* Contact */}
          <section className="rounded-2xl bg-gradient-to-br from-sophia-purple/10 via-sophia-surface to-sophia-surface p-6 ring-1 ring-sophia-purple/20 shadow-soft">
            <div className="mb-5 flex items-center gap-3">
              <div className="rounded-xl bg-sophia-purple/20 p-2.5">
                <Mail className="h-5 w-5 text-sophia-purple" />
              </div>
              <h2 className="text-lg font-semibold text-sophia-text">{t("privacyPolicy.contact.title")}</h2>
            </div>
            <p className="text-sophia-text2 leading-relaxed">
              {t("privacyPolicy.contact.body")}
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <a 
                href="mailto:jorge@withsophia.com"
                className="inline-flex items-center gap-2 rounded-xl bg-sophia-purple px-5 py-2.5 text-sm font-medium text-white shadow-soft/30 transition-all duration-300 hover:bg-sophia-glow hover:scale-105"
              >
                <Mail className="h-4 w-4" />
                jorge@withsophia.com
              </a>
            </div>
          </section>

          {/* Last updated notice */}
          <div className="flex items-center justify-center gap-2 pt-6 text-sm text-sophia-text2">
            <Calendar className="h-4 w-4" />
            <span>{t("privacyPolicy.footerLastUpdatedWithLove", { date: LAST_UPDATED })}</span>
          </div>
        </div>
      </main>
    </div>
  )
}
