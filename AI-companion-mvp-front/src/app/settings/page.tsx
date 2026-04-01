/**
 * Settings Page
 * Unified settings experience shared by dashboard and session entry points.
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Heart, LogOut, Settings, Trash2 } from 'lucide-react';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { useSupabase } from '../providers';
import { haptic } from '../hooks/useHaptics';
import { PrivacyPanel } from '../components/settings/PrivacyPanel';
import { OnboardingSettingsPanel } from '../components/settings/OnboardingSettingsPanel';
import { useSessionStore, selectSession } from '../stores/session-store';
import { useAuthTokenStore } from '../stores/auth-token-store';
import { useUsageLimitStore } from '../stores/usage-limit-store';
import { clearLocalSessionData } from '../lib/debug-tools';
import { logger } from '../lib/error-logger';
import { useUiStore } from '../stores/ui-store';
import { teardownSessionClientState } from '../lib/session-teardown';

export default function SettingsPage() {
  const router = useRouter();
  const { supabase } = useSupabase();

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const showToast = useUiStore((state) => state.showToast);
  const v2Session = useSessionStore(selectSession);

  const planTier = useUsageLimitStore((state) => state.planTier);
  const isFoundingSupporter = planTier === 'FOUNDING_SUPPORTER';

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      await supabase.auth.signOut();
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
      <main className="min-h-screen bg-sophia-bg pb-10">
        <div className="max-w-3xl mx-auto px-5 sm:px-6">
          <header className="sticky top-0 z-20 bg-sophia-bg/85 backdrop-blur-sm py-5 mb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => router.back()}
                  className="group/btn relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 border border-sophia-surface-border bg-sophia-button hover:bg-sophia-button-hover hover:scale-105 shadow-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple"
                  aria-label="Go back"
                >
                  <ArrowLeft className="w-5 h-5 text-sophia-text2 group-hover/btn:text-sophia-purple transition-colors" />
                </button>
                <div className="flex items-center gap-2.5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sophia-purple/15 border border-sophia-surface-border">
                    <Settings className="w-5 h-5 text-sophia-purple" />
                  </div>
                  <div>
                    <h1 className="text-xl sm:text-2xl font-semibold text-sophia-text">Settings</h1>
                    <p className="text-xs sm:text-sm text-sophia-text2">Manage your account and privacy preferences.</p>
                  </div>
                </div>
              </div>
            </div>
          </header>

          <section className="space-y-5">
            <PrivacyPanel />
            <OnboardingSettingsPanel />

            {isFoundingSupporter ? (
              <div className="rounded-2xl border border-sophia-purple/30 bg-gradient-to-br from-sophia-purple/5 to-sophia-glow/5 px-4 py-4 shadow-soft">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-sophia-purple to-sophia-glow shadow-soft">
                    <Heart className="h-5 w-5 text-white" fill="white" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-sophia-purple">Founding Supporter</p>
                    <p className="text-xs text-sophia-text2 mt-0.5">You already support Sophia. Thank you for backing this project.</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="group rounded-2xl border border-sophia-surface-border bg-sophia-surface px-4 py-4 shadow-soft transition-all hover:border-sophia-purple/30 hover:shadow-md">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base">💜</span>
                      <p className="text-sm font-semibold text-sophia-text">Become a Founding Supporter</p>
                    </div>
                    <p className="text-xs text-sophia-text2 mt-1">Support Sophia and unlock supporter perks.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => router.push('/founding-supporter')}
                    className="rounded-xl bg-sophia-purple px-4 py-2 text-xs font-semibold text-white shadow-soft transition-all hover:bg-sophia-glow hover:scale-[1.03]"
                  >
                    Support Sophia
                  </button>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                haptic('light');
                setShowResetConfirm(true);
              }}
              className="flex w-full h-12 items-center justify-center gap-2 rounded-xl border border-sophia-surface-border bg-sophia-button px-4 text-sm font-medium text-sophia-text2 transition-all hover:border-sophia-purple/30 hover:bg-sophia-purple/5"
            >
              <Trash2 className="h-4 w-4" />
              Reset local session
            </button>

            {showResetConfirm && (
              <div className="rounded-2xl border border-sophia-purple/20 bg-sophia-surface p-5 shadow-soft">
                <p className="text-base font-semibold text-sophia-text">Reset local session?</p>
                <p className="text-sm text-sophia-text2 mt-1">
                  This clears local session data, pending interrupts, and cached recap state. You&apos;ll stay signed in.
                </p>
                <div className="flex items-center justify-end gap-3 mt-4">
                  <button
                    type="button"
                    onClick={() => setShowResetConfirm(false)}
                    className="px-4 py-2 text-sm font-medium text-sophia-text2 hover:text-sophia-text"
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
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-sophia-purple text-white hover:bg-sophia-purple/90"
                  >
                    Reset
                  </button>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                haptic('medium');
                setShowSignOutConfirm(true);
              }}
              disabled={isSigningOut || showSignOutConfirm}
              className="flex w-full h-12 items-center justify-center gap-2 rounded-xl border border-sophia-surface-border bg-sophia-button px-4 text-sm font-medium text-sophia-text2 transition-all hover:border-red-400/40 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/20 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>

            {showSignOutConfirm && (
              <div className="rounded-2xl border border-red-200 dark:border-red-900/50 bg-gradient-to-b from-red-50 to-white dark:from-red-950/30 dark:to-sophia-surface p-5 shadow-lg">
                <p className="text-base font-semibold text-sophia-text">Sign out?</p>
                <p className="text-sm text-sophia-text2 mt-1">You&apos;ll be logged out on this device and return to home.</p>
                <div className="flex gap-3 mt-4">
                  <button
                    type="button"
                    onClick={() => {
                      haptic('light');
                      setShowSignOutConfirm(false);
                    }}
                    className="flex-1 h-11 rounded-xl border border-sophia-surface-border bg-sophia-surface text-sm font-medium text-sophia-text"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      haptic('error');
                      handleSignOut();
                    }}
                    disabled={isSigningOut}
                    className="flex-1 h-11 rounded-xl bg-red-500 hover:bg-red-600 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSigningOut ? 'Signing out…' : 'Sign out'}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </ProtectedRoute>
  );
}
