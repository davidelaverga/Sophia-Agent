/**
 * Settings Page
 * Unified settings experience shared by dashboard and session entry points.
 */

'use client';

import { ArrowLeft, Heart, LogOut, Settings, Shield, Sparkles, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { EnhancedFieldBackground } from '../components/dashboard/EnhancedFieldBackground';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { PrivacyPanel } from '../components/settings/PrivacyPanel';
import { VisualQualityPicker } from '../components/settings/VisualQualityPicker';
import { ThemeToggle } from '../components/ThemeToggle';
import { haptic } from '../hooks/useHaptics';
import { authBypassConfiguredValue, authBypassEnabled, authBypassSource } from '../lib/auth/dev-bypass';
import { clearLocalSessionData } from '../lib/debug-tools';
import { logger } from '../lib/error-logger';
import { teardownSessionClientState } from '../lib/session-teardown';
import { useAuth } from '../providers';
import { useAuthTokenStore } from '../stores/auth-token-store';
import { useSessionStore, selectSession } from '../stores/session-store';
import { useUiStore } from '../stores/ui-store';
import { useUsageLimitStore } from '../stores/usage-limit-store';

export default function SettingsPage() {
  const router = useRouter();
  const { signOut } = useAuth();

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const showToast = useUiStore((state) => state.showToast);
  const v2Session = useSessionStore(selectSession);

  const planTier = useUsageLimitStore((state) => state.planTier);
  const isFoundingSupporter = planTier === 'FOUNDING_SUPPORTER';
  const authModeSourceLabel = authBypassSource
    ? `${authBypassSource}=${authBypassConfiguredValue}`
    : authBypassEnabled
      ? 'development default'
      : 'no bypass override';

  const handleSignOut = async () => {
    if (authBypassEnabled) {
      showToast({
        message: `Auth bypass is active via ${authModeSourceLabel}. Disable it and restart the dev server to test real sign out.`,
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
      <main className="relative min-h-screen overflow-x-hidden bg-sophia-bg">
        <div className="absolute inset-0">
          <EnhancedFieldBackground contextMode="life" />
        </div>
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg) 15%, transparent) 0%, color-mix(in srgb, var(--bg) 38%, transparent) 100%)',
          }}
        />

        <div className="relative z-10 mx-auto max-w-6xl px-5 pb-14 pt-5 sm:px-6 lg:px-8">
          <header className="sticky top-0 z-20 mb-6">
            <div className="cosmic-surface-panel-strong flex items-center justify-between rounded-[1.8rem] px-4 py-3 sm:px-5">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => router.back()}
                  className="cosmic-chrome-button cosmic-focus-ring group/btn relative flex h-10 w-10 items-center justify-center rounded-2xl transition-all duration-200 hover:scale-105"
                  aria-label="Go back"
                >
                  <ArrowLeft className="h-5 w-5 text-sophia-text2 transition-colors group-hover/btn:text-sophia-purple" />
                </button>

                <div className="flex items-center gap-3">
                  <div className="cosmic-surface-panel flex h-11 w-11 items-center justify-center rounded-2xl text-[var(--sophia-purple)]">
                    <Settings className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                      Field controls
                    </p>
                    <h1 className="font-cormorant text-[1.9rem] font-light leading-none sm:text-[2.25rem]" style={{ color: 'var(--cosmic-text-strong)' }}>
                      Settings
                    </h1>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <ThemeToggle />
              </div>
            </div>
          </header>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
            <section className="space-y-6">
              <div className="cosmic-surface-panel-strong relative overflow-hidden rounded-[2rem] p-6 sm:p-7">
                <div
                  className="pointer-events-none absolute opacity-40"
                  style={{
                    inset: 'auto auto 0 -10%',
                    width: '16rem',
                    height: '16rem',
                    background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 18%, transparent) 0%, transparent 72%)',
                  }}
                />
                <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div className="max-w-2xl">
                    <p className="text-[11px] uppercase tracking-[0.18em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                      Account and privacy
                    </p>
                    <h2 className="mt-2 font-cormorant text-[2rem] font-light leading-[1.02] sm:text-[2.4rem]" style={{ color: 'var(--cosmic-text-strong)' }}>
                      A quieter control room for everything around your sessions.
                    </h2>
                    <p className="mt-3 max-w-xl text-sm leading-6" style={{ color: 'var(--cosmic-text-muted)' }}>
                      Manage how Sophia behaves on this device and review privacy options without dropping back into the old settings chrome.
                    </p>
                  </div>

                  <div className="cosmic-surface-panel rounded-[1.4rem] px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="cosmic-surface-soft flex h-10 w-10 items-center justify-center rounded-2xl text-[var(--sophia-purple)]">
                        <Shield className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Protected route</p>
                        <p className="text-[12px]" style={{ color: 'var(--cosmic-text-muted)' }}>
                          {authBypassEnabled
                            ? `Dev auth bypass is active in this environment (${authModeSourceLabel}).`
                            : `Real auth is active in this environment (${authModeSourceLabel}).`}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <PrivacyPanel />
            </section>

            <aside className="space-y-6">
              {isFoundingSupporter ? (
                <section className="cosmic-surface-panel-strong rounded-[1.8rem] p-5 sm:p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,var(--sophia-purple),var(--sophia-glow))] text-white shadow-[0_10px_30px_color-mix(in_srgb,var(--sophia-purple)_28%,transparent)]">
                      <Heart className="h-5 w-5" fill="currentColor" />
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>Supporter status</p>
                      <h3 className="mt-1 font-cormorant text-[1.65rem] font-light" style={{ color: 'var(--cosmic-text-strong)' }}>
                        Founding Supporter
                      </h3>
                      <p className="mt-2 text-sm leading-6" style={{ color: 'var(--cosmic-text-muted)' }}>
                        You already support Sophia. Thanks for helping fund the product while it sharpens into its final form.
                      </p>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="cosmic-surface-panel-strong rounded-[1.8rem] p-5 sm:p-6">
                  <div className="flex items-start gap-4">
                    <div className="cosmic-surface-panel flex h-12 w-12 items-center justify-center rounded-2xl text-[var(--sophia-purple)]">
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>Support Sophia</p>
                      <h3 className="mt-1 font-cormorant text-[1.65rem] font-light" style={{ color: 'var(--cosmic-text-strong)' }}>
                        Become a Founding Supporter
                      </h3>
                      <p className="mt-2 text-sm leading-6" style={{ color: 'var(--cosmic-text-muted)' }}>
                        Support the project and unlock supporter perks while keeping the new field direction moving forward.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => router.push('/founding-supporter')}
                    className="cosmic-accent-pill cosmic-focus-ring mt-5 inline-flex rounded-full px-5 py-2.5 text-[12px] font-medium tracking-[0.02em] transition-all duration-300"
                  >
                    Support Sophia
                  </button>
                </section>
              )}

              <VisualQualityPicker />

              <section className="cosmic-surface-panel-strong rounded-[1.8rem] p-5 sm:p-6">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                    Session and account
                  </p>
                  <h3 className="mt-1 font-cormorant text-[1.7rem] font-light" style={{ color: 'var(--cosmic-text-strong)' }}>
                    Device-level actions
                  </h3>
                  <p className="mt-2 text-sm leading-6" style={{ color: 'var(--cosmic-text-muted)' }}>
                    Reset local conversation residue or close the current device session cleanly.
                  </p>
                </div>

                <div className="mt-5 space-y-4">
                  <div className="cosmic-surface-panel rounded-[1.5rem] p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5 text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>
                          <Trash2 className="h-4 w-4 text-[var(--sophia-purple)]" />
                          <span>Reset local session</span>
                        </div>
                        <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--cosmic-text-muted)' }}>
                          Clears pending interrupts, local recap cache, and session residue on this device. You stay signed in.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          haptic('light');
                          setShowResetConfirm(true);
                          setShowSignOutConfirm(false);
                        }}
                        className="cosmic-ghost-pill cosmic-focus-ring inline-flex h-11 items-center justify-center rounded-full px-4 text-sm font-medium transition-all duration-300"
                      >
                        Reset
                      </button>
                    </div>

                    {showResetConfirm && (
                      <div className="mt-4 rounded-[1.25rem] border p-4" style={{ borderColor: 'var(--cosmic-border-soft)', background: 'var(--cosmic-panel-soft)' }}>
                        <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Reset local session?</p>
                        <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--cosmic-text-muted)' }}>
                          This only clears local session state on this device. Your account and backend data remain intact.
                        </p>
                        <div className="mt-4 flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setShowResetConfirm(false)}
                            className="cosmic-ghost-pill cosmic-focus-ring rounded-full px-4 py-2 text-[12px] font-medium transition-all duration-300"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              clearLocalSessionData();
                              showToast({ message: 'Local session cleared', variant: 'success', durationMs: 2400 });
                              setShowResetConfirm(false);
                            }}
                            className="cosmic-accent-pill cosmic-focus-ring rounded-full px-4 py-2 text-[12px] font-medium transition-all duration-300"
                          >
                            Confirm reset
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="cosmic-surface-panel rounded-[1.5rem] p-4">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5 text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>
                          <LogOut className="h-4 w-4 text-[color-mix(in_srgb,var(--sophia-error)_75%,white_5%)]" />
                          <span>Sign out</span>
                        </div>
                        <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--cosmic-text-muted)' }}>
                          Ends the Better Auth session, clears the backend token cookie, and returns you to home.
                        </p>
                        {authBypassEnabled && (
                          <p className="mt-2 text-[11px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                            Dev auth bypass is enabled by {authModeSourceLabel}. Sign out is intentionally disabled because the app auto-authenticates in that mode. If you just changed frontend/.env, restart the Next dev server.
                          </p>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          haptic('medium');
                          setShowSignOutConfirm(true);
                          setShowResetConfirm(false);
                        }}
                        disabled={authBypassEnabled || isSigningOut || showSignOutConfirm}
                        className="cosmic-focus-ring inline-flex h-11 items-center justify-center rounded-full border px-4 text-sm font-medium transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-45 hover:bg-[color-mix(in_srgb,var(--sophia-error)_10%,transparent)] hover:text-[color-mix(in_srgb,var(--sophia-error)_72%,white_10%)]"
                        style={{ borderColor: 'var(--cosmic-border-soft)', background: 'var(--cosmic-panel-soft)', color: 'var(--cosmic-text-whisper)' }}
                      >
                        Sign out
                      </button>
                    </div>

                    {showSignOutConfirm && (
                      <div
                        className="mt-4 rounded-[1.25rem] border p-4"
                        style={{
                          borderColor: 'color-mix(in srgb, var(--sophia-error) 28%, var(--cosmic-border-soft))',
                          background: 'linear-gradient(180deg, color-mix(in srgb, var(--sophia-error) 10%, transparent), var(--cosmic-panel-soft))',
                        }}
                      >
                        <p className="text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>Sign out of this device?</p>
                        <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--cosmic-text-muted)' }}>
                          This clears your current web session and the backend token cookie, then sends you back to the home surface.
                        </p>
                        <div className="mt-4 flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              haptic('light');
                              setShowSignOutConfirm(false);
                            }}
                            className="cosmic-ghost-pill cosmic-focus-ring rounded-full px-4 py-2 text-[12px] font-medium transition-all duration-300"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              haptic('error');
                              void handleSignOut();
                            }}
                            disabled={isSigningOut}
                            className="cosmic-focus-ring rounded-full px-4 py-2 text-[12px] font-medium text-white transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-45"
                            style={{ background: 'color-mix(in srgb, var(--sophia-error) 78%, black 8%)' }}
                          >
                            {isSigningOut ? 'Signing out…' : 'Confirm sign out'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </aside>
          </div>
        </div>
      </main>
    </ProtectedRoute>
  );
}
