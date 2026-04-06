'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { History, Settings } from 'lucide-react';

import { cn } from '../lib/utils';
import { haptic } from '../hooks/useHaptics';
import { ThemeToggle } from './ThemeToggle';
import { HistoryDrawer } from './HistoryDrawer';
import { ResumeBanner } from './session/ResumeBanner';
import { EnhancedFieldBackground } from './dashboard/EnhancedFieldBackground';
import { RitualThread } from './dashboard/RitualThread';
import { SettingsDrawer } from './dashboard/SettingsDrawer';
import { RitualOrbit } from './dashboard/RitualOrbit';
import { ContextTabs } from './dashboard/ContextTabs';
import { CONTEXTS } from './dashboard/types';
import { useDashboardEntryState } from './dashboard/useDashboardEntryState';
import type { ContextMode } from '../types/session';

function getGreeting(contextValue: (typeof CONTEXTS)[number]) {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return contextValue.greetings[part];
}

function FieldChromeButton({
  onClick,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-200',
        'border-black/8 bg-white/78 text-black/55 shadow-[0_12px_30px_rgba(0,0,0,0.08)] hover:bg-white/90 hover:text-black/72',
        'dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-white/55 dark:shadow-[0_16px_40px_rgba(0,0,0,0.35)] dark:hover:bg-white/[0.08] dark:hover:text-white/78',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sophia-purple)]'
      )}
    >
      {children}
    </button>
  );
}

export function EnhancedFieldDashboard() {
  const {
    currentContext,
    contextMode,
    setContextMode,
    selectedRitual,
    handleRitualSelect,
    micState,
    isOffline,
    isConnecting,
    isVisible,
    bootstrapOpener,
    hasMeaningfulBootstrapOpener,
    shouldShowResumeSurface,
    backendActiveSession,
    activeSession,
    sessionSummary,
    isStartingSession,
    showSettingsDrawer,
    setShowSettingsDrawer,
    showHistoryDrawer,
    setShowHistoryDrawer,
    showReplaceSessionConfirm,
    replaceModalRef,
    handleConfirmReplaceSession,
    handleCancelReplaceSession,
    handleCallSophia,
    handleContinueSession,
    handleDismissResumeBanner,
    handleResumeBanner,
    handleStartFresh,
    handleConversationLoaded,
  } = useDashboardEntryState();

  const contextConfig = CONTEXTS.find((context) => context.value === currentContext) ?? CONTEXTS[0];
  const greeting = getGreeting(contextConfig);
  const subtitle = selectedRitual
    ? contextConfig.ritualPrompts[selectedRitual]
    : contextConfig.subtitle;

  // ── Entrance choreography ──────────────────────────────────
  // Matches prototype: tabs(100ms) → greeting(200ms) → mic(500ms) → orbit(700ms)
  const [greetingVisible, setGreetingVisible] = useState(false);
  const [micVisible, setMicVisible] = useState(false);
  const [orbitRevealed, setOrbitRevealed] = useState(false);
  const [tabsVisible, setTabsVisible] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setTabsVisible(true), 100);
    const t2 = setTimeout(() => setGreetingVisible(true), 200);
    const t3 = setTimeout(() => setMicVisible(true), 500);
    const t4 = setTimeout(() => setOrbitRevealed(true), 700);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, []);

  // ── Context-switch crossfade ────────────────────────────────
  // Greeting fades out → text updates → fades back in
  // Orbit: switching ON (collapse 0.25s) → 300ms → switching OFF (stagger slide back)
  // IMPORTANT: `revealed` stays true — only `switching` toggles, matching the prototype.
  const [orbitSwitching, setOrbitSwitching] = useState(false);
  const prevContextRef = useRef<ContextMode>(contextMode);

  const handleContextSwitch = useCallback(
    (next: ContextMode) => {
      if (next === prevContextRef.current) return;
      prevContextRef.current = next;

      // Fade out greeting
      setGreetingVisible(false);
      // Collapse orbit — revealed stays true, switching overrides it
      setOrbitSwitching(true);

      // After 300ms: update context labels, remove switching → nodes slide back in
      setTimeout(() => {
        setContextMode(next);
        setOrbitSwitching(false);
      }, 300);

      // After 350ms: greeting fades back in with new text
      setTimeout(() => setGreetingVisible(true), 350);
    },
    [setContextMode],
  );

  return (
    <div
      className={cn(
        'relative min-h-screen overflow-hidden transition-opacity duration-500',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
    >
      <EnhancedFieldBackground contextMode={contextMode} />
      <RitualThread selectedRitual={selectedRitual} isActive={micState !== 'idle' || isStartingSession} />

      <div className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-start justify-end px-4 py-4 sm:px-6">
        <div className="pointer-events-auto flex items-center gap-2">
          <ThemeToggle />
          <FieldChromeButton
            ariaLabel="Open history"
            onClick={() => {
              haptic('light');
              setShowHistoryDrawer(true);
            }}
          >
            <History className="h-4 w-4" />
          </FieldChromeButton>
          <FieldChromeButton
            ariaLabel="Open settings"
            onClick={() => {
              haptic('light');
              setShowSettingsDrawer(true);
            }}
          >
            <Settings className="h-4 w-4" />
          </FieldChromeButton>
        </div>
      </div>

      {showReplaceSessionConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-black/30 backdrop-blur-[2px] dark:bg-black/40"
            onClick={handleCancelReplaceSession}
          />
          <div
            ref={replaceModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="replace-session-title"
            className={cn(
              'relative w-full max-w-sm rounded-[14px] p-5 backdrop-blur-[20px]',
              'border border-black/[0.06] bg-white/60',
              'dark:border-white/[0.04] dark:bg-[rgba(8,8,18,0.45)]'
            )}
          >
            <h3
              id="replace-session-title"
              className="font-cormorant text-[1.35rem] font-light leading-snug text-black/72 dark:text-white/72"
            >
              You have an active session
            </h3>
            <p className="mt-1.5 text-[13px] font-light text-black/40 dark:text-white/28">
              Would you like to continue where you left off, or start over?
            </p>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={handleContinueSession}
                className={cn(
                  'flex-1 rounded-full px-4 py-2.5 text-[12px] font-medium tracking-[0.02em]',
                  'bg-[rgba(var(--sophia-glow-rgb,124,92,170),0.12)] text-[rgba(var(--sophia-glow-rgb,124,92,170),0.85)]',
                  'border border-[rgba(var(--sophia-glow-rgb,124,92,170),0.2)]',
                  'transition-all duration-300 hover:bg-[rgba(var(--sophia-glow-rgb,124,92,170),0.18)]',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sophia-purple)]'
                )}
              >
                Continue
              </button>
              <button
                type="button"
                onClick={handleConfirmReplaceSession}
                className={cn(
                  'flex-1 rounded-full px-4 py-2.5 text-[12px] font-medium tracking-[0.02em]',
                  'text-black/40 dark:text-white/28',
                  'border border-black/[0.06] dark:border-white/[0.04]',
                  'transition-all duration-300 hover:text-black/55 hover:border-black/[0.12] dark:hover:text-white/40 dark:hover:border-white/[0.08]',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sophia-purple)]'
                )}
              >
                Start fresh
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="relative z-10 flex min-h-screen flex-col px-6 sm:px-8">
        {/* Greeting — near top, matching prototype clamp(28px,6vh,48px) */}
        <div className="pointer-events-none mx-auto max-w-[480px] pt-[clamp(28px,6vh,48px)] text-center">
          <h1
            className={cn(
              'font-cormorant text-[clamp(24px,3.5vw,32px)] font-light leading-[1.4] tracking-[0.01em]',
              'transition-all duration-[1.8s] ease-out',
              greetingVisible
                ? 'translate-y-0 text-black/88 dark:text-white/72'
                : 'translate-y-2 text-transparent',
            )}
          >
            {greeting}
          </h1>
          <p
            className={cn(
              'mt-2 text-[13px] font-light tracking-[0.02em]',
              'transition-all duration-[2s] ease-out delay-[0.4s]',
              greetingVisible
                ? 'translate-y-0 text-black/52 dark:text-white/44'
                : 'translate-y-1.5 text-transparent',
            )}
          >
            {subtitle}
          </p>
          {shouldShowResumeSurface && (backendActiveSession || sessionSummary) ? (
            <div
              className={cn(
                'pointer-events-auto transition-all duration-[1.6s] ease-out delay-[0.5s]',
                greetingVisible
                  ? 'translate-y-0 opacity-100'
                  : 'translate-y-1 opacity-0',
              )}
            >
              <ResumeBanner
                sessionType={(backendActiveSession?.session_type || sessionSummary?.sessionType || 'open') as never}
                contextMode={(backendActiveSession?.preset_context || activeSession?.contextMode || 'gaming') as 'gaming' | 'work' | 'life'}
                startedAt={backendActiveSession?.started_at || sessionSummary?.startedAt || new Date().toISOString()}
                messageCount={backendActiveSession?.turn_count || sessionSummary?.messageCount || 0}
                lastMessagePreview={sessionSummary?.lastMessagePreview}
                onResume={handleResumeBanner}
                onStartFresh={handleStartFresh}
                onDismiss={handleDismissResumeBanner}
              />
            </div>
          ) : hasMeaningfulBootstrapOpener ? (
            <p className="mx-auto mt-3 max-w-md font-cormorant italic text-[13px] text-black/34 dark:text-white/28">
              {bootstrapOpener?.opener_text}
            </p>
          ) : null}
        </div>

        {/* Orbit — centered in remaining vertical space */}
        <div
          className={cn(
            'flex flex-1 items-center justify-center transition-opacity duration-[0.8s] ease-out delay-[0.3s]',
            micVisible ? 'opacity-100' : 'opacity-0',
          )}
        >
          <RitualOrbit
            context={contextMode}
            selectedRitual={selectedRitual}
            suggestedRitual={bootstrapOpener?.suggested_ritual ?? null}
            micState={micState}
            isOffline={isOffline}
            isConnecting={isConnecting}
            isStartingSession={isStartingSession}
            onSelectRitual={handleRitualSelect}
            onCallSophia={handleCallSophia}
            onContinueSession={handleContinueSession}
            revealed={orbitRevealed}
            switching={orbitSwitching}
          />
        </div>

        {/* Context tabs — near bottom */}
        <div
          className={cn(
            'relative z-20 mx-auto pb-[clamp(16px,3vh,28px)] transition-opacity duration-[0.8s] ease-out',
            tabsVisible ? 'opacity-100' : 'opacity-0',
          )}
        >
          <ContextTabs selected={contextMode} onSelect={handleContextSwitch} />
        </div>
      </div>

      <HistoryDrawer
        isOpen={showHistoryDrawer}
        onClose={() => setShowHistoryDrawer(false)}
        onConversationLoaded={handleConversationLoaded}
      />

      <SettingsDrawer
        isOpen={showSettingsDrawer}
        onClose={() => setShowSettingsDrawer(false)}
        onShowHistory={() => {
          setShowSettingsDrawer(false);
          setShowHistoryDrawer(true);
        }}
      />
    </div>
  );
}

export default EnhancedFieldDashboard;