'use client'

import { X, Shield, AlertCircle } from 'lucide-react'
import { useState } from 'react'

import { useCopy, useTranslation } from '../copy'
import { useAuth } from '../providers'

interface ConsentModalProps {
  onAccept: () => void
  onClose: () => void
}

export default function ConsentModal({ onAccept, onClose }: ConsentModalProps) {
  const copy = useCopy()
  const { t } = useTranslation()

  const { user } = useAuth()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleAccept = async () => {
    if (!user) return

    setIsSubmitting(true)
    setError('')

    try {
      const response = await fetch('/api/consent/accept', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: user.id,
          timestamp: new Date().toISOString(),
          ipAddress: 'client-side' // Will be replaced server-side
        })
      })

      if (response.ok) {
        onAccept()
      } else {
        // Log error but still allow user to continue
        setError(t('consentModal.errors.save'))
        
        // Allow user to continue after 3 seconds even if save fails
        setTimeout(() => {
          onAccept()
        }, 3000)
      }
    } catch {
      // Log error but still allow user to continue
      setError(t('consentModal.errors.network'))
      
      // Allow user to continue after 3 seconds even if save fails
      setTimeout(() => {
        onAccept()
      }, 3000)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-sophia-bg/70 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full max-w-md sm:max-w-lg bg-sophia-surface/95 backdrop-blur-xl border border-sophia-surface-border rounded-t-3xl sm:rounded-3xl max-h-[90vh] flex flex-col shadow-soft">
        {/* Header */}
        <div className="flex items-center justify-between p-5 sm:p-6 pb-0 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-sophia-purple" />
            <h3 className="text-lg font-semibold text-sophia-text">{t('consentModal.title')}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 -mr-2 text-sophia-text2 hover:text-sophia-text transition-colors rounded-lg hover:bg-sophia-purple/10"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-5 sm:p-6 space-y-4">
          <p className="text-sm sm:text-base text-sophia-text2 leading-relaxed">{t('consentModal.intro')}</p>

          {/* Notice box */}
          <div className="bg-sophia-purple/10 border border-sophia-purple/20 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-sophia-purple flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="text-sophia-text font-medium mb-1">{t('consentModal.noticeTitle')}</p>
                <p className="text-sophia-text2">{t('consentModal.noticeBody')}</p>
              </div>
            </div>
          </div>

          {/* What we collect */}
          <div className="text-sm">
            <h4 className="font-medium text-sophia-text mb-2">{t('consentModal.whatTitle')}</h4>
            <ul className="list-disc pl-5 text-sophia-text2 space-y-1">
              {copy.consentModal.whatItems.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>

          {/* How we use it */}
          <div className="text-sm">
            <h4 className="font-medium text-sophia-text mb-2">{t('consentModal.howTitle')}</h4>
            <ul className="list-disc pl-5 text-sophia-text2 space-y-1">
              {copy.consentModal.howItems.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>

          {/* Retention notice */}
          <div className="bg-sophia-bg/50 rounded-xl p-3">
            <p className="text-xs text-sophia-text2 leading-relaxed">
              {t('consentModal.retention')}
            </p>
            <a 
              href="/privacy" 
              target="_blank"
              className="text-xs text-sophia-purple hover:underline mt-2 inline-block"
            >
              Read our full Privacy Policy →
            </a>
          </div>

          {/* Error message */}
          {error && (
            <div className="bg-sophia-error/10 border border-sophia-error/30 rounded-xl p-3">
              <p className="text-sophia-error text-sm">{error}</p>
            </div>
          )}
        </div>

        {/* Footer buttons - fixed at bottom */}
        <div className="flex gap-3 p-5 sm:p-6 pt-4 flex-shrink-0 border-t border-sophia-surface-border pb-safe">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="flex-1 h-12 px-4 border border-sophia-surface-border text-sophia-text2 rounded-xl bg-transparent transition-all hover:bg-sophia-purple/10 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
          >
            {t('consentModal.buttons.cancel')}
          </button>
          <button
            onClick={handleAccept}
            disabled={isSubmitting}
            className="flex-1 h-12 px-4 bg-gradient-to-r from-sophia-purple to-sophia-glow text-sophia-bg font-medium rounded-xl transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
          >
            {isSubmitting ? t('consentModal.buttons.saving') : t('consentModal.buttons.accept')}
          </button>
        </div>
      </div>
    </div>
  )
}
