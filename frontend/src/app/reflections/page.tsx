"use client"

/* eslint-disable react/no-unescaped-entities */

import { useState, useMemo, useEffect } from "react"
import { Sparkles, Heart, Send, Calendar, Search, ArrowLeft, Quote, Users, TrendingUp, Star, Loader2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useSupabase } from "../providers"
import { logger } from "../lib/error-logger"
import { formatRelativeTime } from "../lib/format-time"
import { useTranslation } from "../copy"
import { ProtectedRoute } from "../components/ProtectedRoute"

// TEMPORARILY DISABLED FOR PRODUCTION LAUNCH
// This page will redirect to home until the Reflections feature is ready
const ENABLE_REFLECTIONS = false

// Types for API responses
type CommunityInsight = {
  title: string
  insight: string
  sophia_emotion: { label: string; confidence: number }
  reflection_id: string | null
}

type UserImpact = {
  user_id: string
  session_count: number
  reflections_created: number
  reflections_shared: number
  last_session_at: string | null
}

// Type for user reflections
type Reflection = {
  id: string
  text: string
  reason: string
  createdAt: Date
  shared: boolean
  likes: number
}

type FilterType = "all" | "shared" | "private"

export default function ReflectionsPage() {
  return (
    <ProtectedRoute>
      <ReflectionsPageContent />
    </ProtectedRoute>
  );
}

function ReflectionsPageContent() {
  const { t } = useTranslation()
  const router = useRouter()
  const { user } = useSupabase()
  const [filter, setFilter] = useState<FilterType>("all")
  const [searchQuery, setSearchQuery] = useState("")
  
  // Real data states
  const [reflections, setReflections] = useState<Reflection[]>([])
  const [isLoadingReflections, setIsLoadingReflections] = useState(true)
  const [communityInsight, setCommunityInsight] = useState<CommunityInsight | null>(null)
  const [userImpact, setUserImpact] = useState<UserImpact | null>(null)
  const [isLoadingCommunity, setIsLoadingCommunity] = useState(true)
  const [isLoadingImpact, setIsLoadingImpact] = useState(true)

  // TEMPORARILY DISABLED - Redirect to home if feature is disabled
  useEffect(() => {
    if (!ENABLE_REFLECTIONS) {
      router.replace("/")
    }
  }, [router])

  // Fetch user's reflections
  useEffect(() => {
    if (!ENABLE_REFLECTIONS || !user?.id) {
      setIsLoadingReflections(false)
      return
    }
    async function fetchReflections() {
      try {
        const response = await fetch(`/api/reflections/list?user_id=${encodeURIComponent(user!.id)}`)
        if (response.ok) {
          const data = await response.json()
          // Transform API response to match Reflection type
          setReflections(data.reflections?.map((r: { id: string; text: string; reason: string; created_at: string; shared: boolean; likes: number }) => ({
            id: r.id,
            text: r.text,
            reason: r.reason,
            createdAt: new Date(r.created_at),
            shared: r.shared,
            likes: r.likes || 0,
          })) || [])
        }
      } catch (error) {
        logger.logError(error, { component: "ReflectionsPage", action: "fetch_reflections" })
      } finally {
        setIsLoadingReflections(false)
      }
    }
    fetchReflections()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Fetch community insights on mount
  useEffect(() => {
    if (!ENABLE_REFLECTIONS) return
    async function fetchCommunityInsight() {
      try {
        const response = await fetch("/api/community/latest-learning")
        if (response.ok) {
          const data = await response.json()
          setCommunityInsight(data)
        }
      } catch (error) {
        logger.logError(error, { component: "ReflectionsPage", action: "fetch_community_insight" })
      } finally {
        setIsLoadingCommunity(false)
      }
    }
    fetchCommunityInsight()
  }, [])

  // Fetch user impact when user is available
  useEffect(() => {
    if (!ENABLE_REFLECTIONS) return
    async function fetchUserImpact() {
      if (!user?.id) {
        setIsLoadingImpact(false)
        return
      }
      try {
        const response = await fetch(`/api/community/user-impact?user_id=${encodeURIComponent(user.id)}`)
        if (response.ok) {
          const data = await response.json()
          setUserImpact(data)
        }
      } catch (error) {
        logger.logError(error, { component: "ReflectionsPage", action: "fetch_user_impact" })
      } finally {
        setIsLoadingImpact(false)
      }
    }
    fetchUserImpact()
  }, [user?.id])

  const filteredReflections = useMemo(() => {
    if (!ENABLE_REFLECTIONS) return []
    let result = reflections

    // Filter by type
    if (filter === "shared") {
      result = result.filter(r => r.shared)
    } else if (filter === "private") {
      result = result.filter(r => !r.shared)
    }

    // Filter by search
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(r => 
        r.text.toLowerCase().includes(query) ||
        r.reason.toLowerCase().includes(query)
      )
    }

    return result
  }, [filter, searchQuery, reflections])

  // If feature is disabled, show nothing while redirecting
  if (!ENABLE_REFLECTIONS) {
    return null
  }

  return (
    <div className="min-h-screen bg-sophia-bg">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-sophia-surface-border bg-sophia-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <Link 
              href="/"
              className="flex items-center gap-2 rounded-xl p-2 text-sophia-text2 transition-colors hover:bg-sophia-purple/10 hover:text-sophia-purple"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div>
              <h1 className="text-xl font-semibold text-sophia-text">{t("reflectionsPage.headerTitle")}</h1>
              <p className="text-sm text-sophia-text2">{t("reflectionsPage.headerSubtitle")}</p>
            </div>
          </div>
          
          {/* Impact stats mini */}
          <div className="hidden items-center gap-4 sm:flex">
            {userImpact && (
              <>
                <div className="flex items-center gap-1.5 text-sm text-sophia-text2">
                  <Star className="h-4 w-4 text-sophia-glow" />
                  <span>
                    {userImpact.session_count} {t("reflectionsPage.stats.sessions")}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-sm text-sophia-text2">
                  <Heart className="h-4 w-4 text-sophia-purple" />
                  <span>
                    {userImpact.reflections_shared} {t("reflectionsPage.stats.shared")}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid gap-6 lg:grid-cols-3">
          
          {/* Main content - Reflections list */}
          <div className="lg:col-span-2">
            {/* Search and filter bar */}
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {/* Search */}
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sophia-text2" />
                <input
                  type="text"
                  placeholder={t("reflectionsPage.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-xl border-2 border-sophia-surface-border bg-sophia-surface py-2.5 pl-10 pr-4 text-sm text-sophia-text placeholder:text-sophia-text2/50 focus-visible:border-sophia-purple focus-visible:outline-none"
                />
              </div>

              {/* Filter tabs */}
              <div className="flex items-center gap-1 rounded-xl bg-sophia-surface p-1">
                {(["all", "shared", "private"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                      filter === f
                        ? "bg-sophia-purple text-white shadow-sm"
                        : "text-sophia-text2 hover:text-sophia-text"
                    }`}
                  >
                    {t(`reflectionsPage.filters.${f}`)}
                  </button>
                ))}
              </div>
            </div>

            {/* Reflections list */}
            <div className="space-y-4">
              {isLoadingReflections ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-sophia-purple" />
                </div>
              ) : filteredReflections.length === 0 ? (
                <div className="rounded-2xl border-2 border-dashed border-sophia-surface-border bg-sophia-surface/50 px-6 py-12 text-center">
                  <Sparkles className="mx-auto mb-3 h-10 w-10 text-sophia-purple/40" />
                  <p className="text-sophia-text2">{t("reflectionsPage.emptyTitle")}</p>
                  <p className="mt-1 text-sm text-sophia-text2/70">
                    {searchQuery ? t("reflectionsPage.emptyTryDifferent") : t("reflectionsPage.emptyStartConversation")}
                  </p>
                </div>
              ) : (
                filteredReflections.map((reflection) => (
                  <article
                    key={reflection.id}
                    className="group relative overflow-hidden rounded-2xl border border-sophia-surface-border bg-sophia-surface p-5 shadow-sm transition-all hover:shadow-md dark:shadow-sophia-purple/10 dark:hover:shadow-lg dark:hover:shadow-sophia-purple/20"
                  >
                    {/* Quote icon */}
                    <Quote className="absolute right-4 top-4 h-8 w-8 text-sophia-purple/10 transition-colors group-hover:text-sophia-purple/20" />
                    
                    {/* Content */}
                    <p className="pr-10 text-sophia-text leading-relaxed">
                      "{reflection.text}"
                    </p>

                    {/* Meta row */}
                    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
                      {/* Reason tag */}
                      <span className="inline-flex items-center gap-1 rounded-full bg-sophia-purple/10 px-2.5 py-1 font-medium text-sophia-purple">
                        <Sparkles className="h-3 w-3" />
                        {reflection.reason}
                      </span>

                      {/* Shared badge - uses sophia-purple for theme consistency */}
                      {reflection.shared ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sophia-purple/15 px-2.5 py-1 font-medium text-sophia-purple">
                          <Send className="h-3 w-3" />
                          {t("reflectionsPage.badges.shared")}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sophia-purple/10 px-2.5 py-1 font-medium text-sophia-text2">
                          <Heart className="h-3 w-3" />
                          {t("reflectionsPage.badges.private")}
                        </span>
                      )}

                      {/* Likes */}
                      {reflection.shared && reflection.likes > 0 && (
                        <span className="inline-flex items-center gap-1 text-sophia-text2">
                          <Heart className="h-3 w-3 fill-sophia-purple text-sophia-purple" />
                          {reflection.likes}
                        </span>
                      )}

                      {/* Time */}
                      <span className="ml-auto inline-flex items-center gap-1 text-sophia-text2">
                        <Calendar className="h-3 w-3" />
                        {formatRelativeTime(reflection.createdAt)}
                      </span>
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>

          {/* Sidebar */}
          <aside className="space-y-6">
            {/* User Impact Card */}
            <div className="rounded-2xl border border-sophia-surface-border bg-gradient-to-br from-sophia-purple/20 via-sophia-card to-sophia-card p-5 shadow-sm dark:shadow-lg dark:shadow-sophia-purple/20">
              <div className="mb-4 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-sophia-purple" />
                <h2 className="font-semibold text-sophia-text">{t("reflectionsPage.sidebar.yourImpactTitle")}</h2>
              </div>

              {isLoadingImpact ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-sophia-purple" />
                </div>
              ) : userImpact ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded-xl bg-sophia-bg/50 p-3 text-center">
                      <p className="text-2xl font-bold text-sophia-purple">{userImpact.reflections_created}</p>
                      <p className="text-xs text-sophia-text2">{t("reflectionsPage.stats.reflections")}</p>
                    </div>
                    <div className="rounded-xl bg-sophia-bg/50 p-3 text-center">
                      <p className="text-2xl font-bold text-sophia-purple">{userImpact.reflections_shared}</p>
                      <p className="text-xs text-sophia-text2">{t("reflectionsPage.stats.shared")}</p>
                    </div>
                    <div className="rounded-xl bg-sophia-bg/50 p-3 text-center">
                      <p className="text-2xl font-bold text-sophia-purple">{userImpact.session_count}</p>
                      <p className="text-xs text-sophia-text2">{t("reflectionsPage.stats.sessions")}</p>
                    </div>
                    <div className="rounded-xl bg-sophia-bg/50 p-3 text-center">
                      <p className="text-2xl font-bold text-sophia-glow">
                        {userImpact.last_session_at ? t("reflectionsPage.status.active") : "—"}
                      </p>
                      <p className="text-xs text-sophia-text2">{t("reflectionsPage.stats.status")}</p>
                    </div>
                  </div>

                  {/* Rank badge */}
                  <div className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sophia-purple to-sophia-glow p-2.5">
                    <Star className="h-4 w-4 text-white" />
                    <span className="text-sm font-semibold text-white">
                      {userImpact.reflections_shared >= 5
                        ? t("reflectionsPage.rank.wisdomSharer")
                        : userImpact.reflections_created >= 3
                          ? t("reflectionsPage.rank.reflector")
                          : t("reflectionsPage.rank.explorer")}
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-center text-sm text-sophia-text2 py-4">
                  {t("reflectionsPage.sidebar.signInToSeeImpact")}
                </p>
              )}
            </div>

            {/* Community Insights */}
            <div className="rounded-2xl border border-sophia-surface-border bg-sophia-surface p-5 shadow-sm dark:shadow-lg dark:shadow-sophia-purple/20">
              <div className="mb-4 flex items-center gap-2">
                <Users className="h-5 w-5 text-sophia-purple" />
                <h2 className="font-semibold text-sophia-text">{t("reflectionsPage.community.title")}</h2>
              </div>

              {isLoadingCommunity ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-sophia-purple" />
                </div>
              ) : communityInsight ? (
                <div className="space-y-4">
                  <div className="border-b border-sophia-surface-border pb-4">
                    <p className="text-xs font-medium text-sophia-purple mb-2">
                      {communityInsight.title}
                    </p>
                    <p className="text-sm leading-relaxed text-sophia-text">
                      "{communityInsight.insight}"
                    </p>
                    <div className="mt-2 flex items-center justify-between text-xs text-sophia-text2">
                      <span>{t("reflectionsPage.community.anonymousWisdom")}</span>
                      <span className="flex items-center gap-1 capitalize">
                        <Sparkles className="h-3 w-3 text-sophia-purple" />
                        {communityInsight.sophia_emotion.label}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-center text-sm text-sophia-text2 py-4">
                  {t("reflectionsPage.community.empty")}
                </p>
              )}

              <Link
                href="#"
                className="mt-4 block rounded-xl border-2 border-sophia-surface-border p-2.5 text-center text-sm font-medium text-sophia-text2 transition-all hover:border-sophia-purple/30 hover:text-sophia-purple"
              >
                {t("reflectionsPage.community.viewAllCta")}
              </Link>
            </div>
          </aside>
        </div>
      </main>
    </div>
  )
}
