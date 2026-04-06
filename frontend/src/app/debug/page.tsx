'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { authBypassEnabled } from '@/app/lib/auth/dev-bypass'

import { useTranslation } from '../copy'
import { useAuth } from '../providers'
import { useOnboardingStore } from '../stores/onboarding-store'

// 🔒 SECURITY: Only allow debug page in development
const IS_DEV = process.env.NODE_ENV === 'development'

export default function DebugPage() {
  const router = useRouter()
  const [debugInfo, setDebugInfo] = useState<Record<string, unknown>>({})
  const { user } = useAuth()
  const { t } = useTranslation()
  const { hasCompletedOnboarding, resetOnboarding } = useOnboardingStore()

  // 🔒 SECURITY: Redirect to home if not in development
  useEffect(() => {
    if (!IS_DEV) {
      router.replace('/')
    }
  }, [router])

  useEffect(() => {
    // Skip in production
    if (!IS_DEV) return
    
    const collectDebugInfo = async () => {
      // Get current URL info
      const currentUrl = typeof window !== 'undefined' ? window.location.href : ''
      const origin = typeof window !== 'undefined' ? window.location.origin : ''
      
      // Get environment variables
      const apiUrl = process.env.NEXT_PUBLIC_API_URL
      const devBypass = authBypassEnabled
      
      // Get user session
      const sessionInfo = {
        hasSession: !!user,
        sessionUser: user?.email || 'No user',
      }
      
      // Test API connectivity
      let apiTest = 'Not tested'
      try {
        const response = await fetch(`${apiUrl}/health`)
        const data = await response.json()
        apiTest = `Success: ${JSON.stringify(data)}`
      } catch (error: unknown) {
        apiTest = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      }

      setDebugInfo({
        currentUrl,
        origin,
        apiUrl,
        devBypass,
        ...sessionInfo,
        apiTest,
        redirectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
        timestamp: new Date().toISOString()
      })
    }

    void collectDebugInfo()
  }, [user])

  // Don't render anything in production
  if (!IS_DEV) {
    return null
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <h1 className="text-3xl font-bold mb-8">{t("debugPage.title")}</h1>
      
      <div className="bg-gray-800 p-6 rounded-lg">
        <h2 className="text-xl font-semibold mb-4">{t("debugPage.environmentTitle")}</h2>
        <pre className="text-sm overflow-auto">
          {JSON.stringify(debugInfo, null, 2)}
        </pre>
      </div>

      <div className="mt-8 bg-blue-800 p-4 rounded">
        <h3 className="font-bold mb-2">{t("debugPage.expectedValuesTitle")}</h3>
        <ul className="text-sm space-y-1">
          <li>
            <strong>{t("debugPage.expected.apiUrlLabel")}</strong> https://sophia-1st-mvp-xjml.onrender.com
          </li>
          <li>
            <strong>{t("debugPage.expected.currentUrlLabel")}</strong>{" "}
            {t("debugPage.expected.currentUrlValue", {
              url: "https://sophia-1st-mvp-git-main-davidelavergas-projects.vercel.app",
            })}
          </li>
          <li>
            <strong>{t("debugPage.expected.apiTestLabel")}</strong>{" "}
            {t("debugPage.expected.apiTestValue")}
          </li>
          <li>
            <strong>{t("debugPage.expected.hasSessionLabel")}</strong>{" "}
            {t("debugPage.expected.hasSessionValue")}
          </li>
        </ul>
      </div>

      <div className="mt-4">
        <button 
          onClick={() => router.push('/')}
          className="bg-purple-600 px-4 py-2 rounded hover:bg-purple-700"
        >
          {t("debugPage.backToMainApp")}
        </button>
      </div>

      {/* Onboarding Debug Section */}
      <div className="mt-8 bg-gray-800 p-6 rounded-lg">
        <h2 className="text-xl font-semibold mb-4">🎓 Onboarding Debug</h2>
        <p className="text-sm mb-4">
          Status: <span className={hasCompletedOnboarding ? "text-green-400" : "text-yellow-400"}>
            {hasCompletedOnboarding ? "Completed ✓" : "Not completed"}
          </span>
        </p>
        <button
          onClick={() => {
            resetOnboarding()
            router.push('/')
          }}
          className="bg-yellow-600 px-4 py-2 rounded hover:bg-yellow-700 mr-2"
        >
          Reset Onboarding & Test
        </button>
      </div>
    </div>
  )
}