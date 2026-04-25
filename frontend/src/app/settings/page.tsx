/**
 * Settings Page
 * Clean single-column settings with grouped sections.
 */

'use client';

import { ArrowLeft, ArrowUpRight, Heart, LogOut, RotateCcw, Shield, Sparkles, Trash2, Volume2, VolumeX } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { EnhancedFieldBackground } from '../components/dashboard/EnhancedFieldBackground';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { TelegramConnectCard } from '../components/settings/TelegramConnectCard';
import { VisualQualityPicker } from '../components/settings/VisualQualityPicker';
import { haptic } from '../hooks/useHaptics';
import { authBypassConfiguredValue, authBypassEnabled, authBypassSource } from '../lib/auth/dev-bypass';
import { clearLocalSessionData } from '../lib/debug-tools';
import { logger } from '../lib/error-logger';
import { teardownSessionClientState } from '../lib/session-teardown';
import { useAuth } from '../providers';
import { useAuthTokenStore } from '../stores/auth-token-store';
import { useOnboardingStore } from '../stores/onboarding-store';
import { useSessionStore, selectSession } from '../stores/session-store';
import { useUiStore } from '../stores/ui-store';
import { useUsageLimitStore } from '../stores/usage-limit-store';

export default function SettingsPage() {
  const router = useRouter();
  const { signOut } = useAuth();

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const showToast = useUiStore((s) => s.showToast);
  const v2Session = useSessionStore(selectSession);
  const planTier = useUsageLimitStore((s) => s.planTier);
  const isFoundingSupporter = planTier === 'FOUNDING_SUPPORTER';

  const voiceOverEnabled = useOnboardingStore((s) => s.preferences.voiceOverEnabled);
  const setVoiceOverEnabled = useOnboardingStore((s) => s.setVoiceOverEnabled);

  const authModeSourceLabel = authBypassSource
    ? `${authBypassSource}=${authBypassConfiguredValue}`
    : authBypassEnabled
      ? 'development default'
      : 'no bypass override';

  const handleSignOut = async () => {
    if (authBypassEnabled) {
      showToast({
        message: `Auth bypass is active (${authModeSourceLabel}). Disable it to test sign out.`,
        variant: 'info',
        durationMs: 4200,
      });
      setShowSignOutConfirm(false);
      return;
    }

    setIsSigningOut(true);
    try {
      await signOut();
      teardownSessionClientState(v2Session?.sessionId);
      clearLocalSessionData();
      useAuthTokenStore.getState().clearToken();
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      window.location.href = '/';
    } catch (error) {
      logger.logError(error, { component: 'SettingsPage', action: 'sign_out' });
      setIsSigningOut(false);
    }
  };

  return (
    <ProtectedRoute>
      <main className="relative min-h-screen bg-sophia-bg">
        <div className="absolute inset-0">
          <EnhancedFieldBackground contextMode="life" />
        </div>
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg) 20%, transparent) 0%, color-mix(in srgb, var(--bg) 50%, transparent) 100%)',
          }}
        />

        <div className="relative z-10 mx-auto max-w-xl px-5 pb-16 pt-6 sm:px-6">
          {/* Header */}
          <header className="mb-8 flex items-center gap-4">
            <button
              onClick={() => router.back()}
              className="cosmic-chrome-button cosmic-focus-ring flex h-10 w-10 items-center justify-center rounded-2xl transition-all duration-200 hover:scale-105"
              aria-label="Go back"
            >
              <ArrowLeft className="h-5 w-5 text-sophia-text2" />
            </button>
            <h1
              className="font-cormorant text-[2.2rem] font-light leading-none"
              style={{ color: 'var(--cosmic-text-strong)' }}
            >
              Settings
            </h1>
          </header>

          <div className="space-y-4">
            {/* ── Supporter ── */}
            <section className="cosmic-surface-panel-strong rounded-[1.6rem] p-5">
              <div className="flex items-center gap-4">
                {isFoundingSupporter ? (
                  <>
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,var(--sophia-purple),var(--sophia-glow))] text-white shadow-[0_8px_24px_color-mix(in_srgb,var(--sophia-purple)_24%,transparent)]">
                      <Heart className="h-[18px] w-[18px]" fill="currentColor" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Founding Supporter</p>
                      <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
                        Thanks for supporting Sophia while it takes shape.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="cosmic-surface-panel flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-[var(--sophia-purple)]">
                      <Sparkles className="h-[18px] w-[18px]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Support Sophia</p>
                      <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
                        Unlock supporter perks and help move the project forward.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => router.push('/founding-supporter')}
                      className="cosmic-accent-pill cosmic-focus-ring shrink-0 rounded-full px-4 py-2 text-[12px] font-medium transition-all duration-300"
                    >
                      Learn more
                    </button>
                  </>
                )}
              </div>
            </section>

            {/* ── Preferences ── */}
            <section className="cosmic-surface-panel-strong overflow-hidden rounded-[1.6rem]">
              <div className="px-5 pb-1 pt-5">
                <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                  Preferences
                </p>
              </div>

              {/* Performance mode */}
              <div className="px-5 py-4">
                <VisualQualityPicker />
              </div>

              <div className="mx-5 h-px" style={{ background: 'var(--cosmic-border-soft)' }} />

              {/* Onboarding voice-over */}
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="flex items-center gap-3">
                  {voiceOverEnabled
                    ? <Volume2 className="h-4 w-4 shrink-0 text-sophia-purple" />
                    : <VolumeX className="h-4 w-4 shrink-0" style={{ color: 'var(--cosmic-text-whisper)' }} />
                  }
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Onboarding voice-over</p>
                    <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>Spoken guidance during the welcome tour</p>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={voiceOverEnabled}
                  onClick={() => {
                    haptic('light');
                    const next = !voiceOverEnabled;
                    setVoiceOverEnabled(next);
                    showToast({
                      message: next ? 'Voice-over enabled' : 'Voice-over muted',
                      variant: 'success',
                      durationMs: 2000,
                    });
                  }}
                  className="cosmic-focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-200"
                  style={{
                    background: voiceOverEnabled
                      ? 'color-mix(in srgb, var(--sophia-purple) 28%, transparent)'
                      : 'color-mix(in srgb, var(--cosmic-text-whisper) 25%, transparent)',
                  }}
                >
                  <span
                    className="absolute h-5 w-5 rounded-full transition-transform duration-200"
                    style={{
                      left: 4,
                      transform: voiceOverEnabled ? 'translateX(20px)' : 'translateX(0)',
                      background: voiceOverEnabled ? 'var(--sophia-purple)' : 'var(--cosmic-text-strong)',
                    }}
                  />
                </button>
              </div>

              <div className="mx-5 h-px" style={{ background: 'var(--cosmic-border-soft)' }} />

              {/* Replay tour */}
              <button
                type="button"
                onClick={() => {
                  haptic('medium');
                  localStorage.removeItem('sophia-onboarded');
                  showToast({ message: 'Replaying the welcome tour', variant: 'info', durationMs: 2400 });
                  router.push('/');
                }}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--sophia-purple)_4%,transparent)]"
              >
                <div className="flex items-center gap-3">
                  <RotateCcw className="h-4 w-4 shrink-0 text-sophia-purple" />
                  <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Replay welcome tour</p>
                </div>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--cosmic-text-whisper)' }} />
              </button>
            </section>

            {/* ── Integrations ── */}
            <TelegramConnectCard />

            {/* ── Privacy ── */}
            <section className="cosmic-surface-panel-strong rounded-[1.6rem] p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Shield className="h-4 w-4 shrink-0 text-sophia-purple" />
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Privacy</p>
                    <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>How Sophia handles your data</p>
                  </div>
                </div>
                <Link
                  href="/privacy"
                  className="cosmic-accent-pill cosmic-focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-all duration-300"
                >
                  Read policy
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </section>

            {/* ── Account ── */}
            <section className="cosmic-surface-panel-strong overflow-hidden rounded-[1.6rem]">
              <div className="px-5 pb-1 pt-5">
                <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                  Account
                </p>
              </div>

              {/* Reset session */}
              <div className="px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Trash2 className="h-4 w-4 shrink-0 text-[var(--sophia-purple)]" />
                    <div>
                      <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Reset local session</p>
                      <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>Clears local cache and session residue</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      haptic('light');
                      setShowResetConfirm(true);
                      setShowSignOutConfirm(false);
                    }}
                    className="cosmic-ghost-pill cosmic-focus-ring shrink-0 rounded-full px-4 py-2 text-[12px] font-medium transition-all duration-300"
                  >
                    Reset
                  </button>
                </div>
                {showResetConfirm && (
                  <div
                    className="mt-3 flex items-center justify-between gap-3 rounded-2xl border p-3"
                    style={{ borderColor: 'var(--cosmic-border-soft)', background: 'var(--cosmic-panel-soft)' }}
                  >
                    <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>Clear local session data?</p>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => setShowResetConfirm(false)}
                        className="cosmic-ghost-pill cosmic-focus-ring rounded-full px-3 py-1.5 text-[11px] font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          clearLocalSessionData();
                          showToast({ message: 'Session cleared', variant: 'success', durationMs: 2400 });
                          setShowResetConfirm(false);
                        }}
                        className="cosmic-accent-pill cosmic-focus-ring rounded-full px-3 py-1.5 text-[11px] font-medium"
                      >
                        Confirm
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="mx-5 h-px" style={{ background: 'var(--cosmic-border-soft)' }} />

              {/* Sign out */}
              <div className="px-5 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <LogOut className="h-4 w-4 shrink-0" style={{ color: 'color-mix(in srgb, var(--sophia-error) 75%, white 5%)' }} />
                    <div>
                      <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Sign out</p>
                      <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
                        {authBypassEnabled ? `Dev bypass active (${authModeSourceLabel})` : 'End session on this device'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      haptic('medium');
                      setShowSignOutConfirm(true);
                      setShowResetConfirm(false);
                    }}
                    disabled={authBypassEnabled || isSigningOut || showSignOutConfirm}
                    className="cosmic-focus-ring shrink-0 rounded-full border px-4 py-2 text-[12px] font-medium transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-45"
                    style={{
                      borderColor: 'var(--cosmic-border-soft)',
                      background: 'var(--cosmic-panel-soft)',
                      color: 'var(--cosmic-text-whisper)',
                    }}
                  >
                    Sign out
                  </button>
                </div>
                {showSignOutConfirm && (
                  <div
                    className="mt-3 flex items-center justify-between gap-3 rounded-2xl border p-3"
                    style={{
                      borderColor: 'color-mix(in srgb, var(--sophia-error) 24%, var(--cosmic-border-soft))',
                      background: 'color-mix(in srgb, var(--sophia-error) 6%, var(--cosmic-panel-soft))',
                    }}
                  >
                    <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>Sign out of this device?</p>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          haptic('light');
                          setShowSignOutConfirm(false);
                        }}
                        className="cosmic-ghost-pill cosmic-focus-ring rounded-full px-3 py-1.5 text-[11px] font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSignOut}
                        disabled={isSigningOut}
                        className="cosmic-focus-ring rounded-full px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-45"
                        style={{ background: 'color-mix(in srgb, var(--sophia-error) 78%, black 8%)' }}
                      >
                        {isSigningOut ? 'Signing out…' : 'Confirm'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </main>
    </ProtectedRoute>
  );
}

