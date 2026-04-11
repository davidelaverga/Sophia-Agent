'use client';

import { BookOpen, Settings } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { haptic } from '../hooks/useHaptics';
import { cn } from '../lib/utils';
import type { ContextMode } from '../types/session';

import { CelestialComet } from './dashboard/CelestialComet';
import { ContextTabs } from './dashboard/ContextTabs';
import { EnhancedFieldBackground } from './dashboard/EnhancedFieldBackground';
import { RitualOrbit } from './dashboard/RitualOrbit';
import { RitualThread } from './dashboard/RitualThread';
import { SettingsDrawer } from './dashboard/SettingsDrawer';
import { useSweepGlow } from './dashboard/sweepLight';
import { CONTEXTS } from './dashboard/types';
import { useDashboardEntryState } from './dashboard/useDashboardEntryState';
import { ResumeBanner } from './session/ResumeBanner';
import { ThemeToggle } from './ThemeToggle';

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
        'cosmic-chrome-button flex h-10 w-10 items-center justify-center rounded-full transition-all duration-200'
      )}
    >
      {children}
    </button>
  );
}

export function EnhancedFieldDashboard() {
  const router = useRouter();
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
    showReplaceSessionConfirm,
    replaceModalRef,
    showFreshStartPrompt,
    freshStartModalRef,
    handleConfirmReplaceSession,
    handleCancelReplaceSession,
    handleCallSophia,
    handleContinueSession,
    handleDismissResumeBanner,
    handleResumeBanner,
    handleStartFresh,
    handleCancelFreshStart,
    handleRestartWithSameRitual,
    handleChooseDifferentRitual,
  } = useDashboardEntryState();

  const contextConfig = CONTEXTS.find((context) => context.value === currentContext) ?? CONTEXTS[0];
  const greeting = getGreeting(contextConfig);
  const greetingGlowRef = useSweepGlow();
  const subtitle = selectedRitual
    ? contextConfig.ritualPrompts[selectedRitual]
    : contextConfig.subtitle;
  const resumableSessionType = backendActiveSession?.session_type || sessionSummary?.sessionType || activeSession?.presetType || 'open';
  const resumableSessionUsesRitual = resumableSessionType === 'prepare' || resumableSessionType === 'debrief' || resumableSessionType === 'reset' || resumableSessionType === 'vent';

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
      <CelestialComet contextMode={contextMode} />
      <RitualThread selectedRitual={selectedRitual} isActive={micState !== 'idle' || isStartingSession} />

      <div className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-start justify-end px-4 py-4 sm:px-6">
        <div className="pointer-events-auto flex items-center gap-2">
          <ThemeToggle />
          <FieldChromeButton
            ariaLabel="Open journal"
            onClick={() => {
              haptic('light');
              router.push('/journal');
            }}
          >
            <BookOpen className="h-4 w-4" />
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
            className="cosmic-modal-backdrop absolute inset-0"
            onClick={handleCancelReplaceSession}
          />
          <div
            ref={replaceModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="replace-session-title"
            className={cn(
              'cosmic-surface-panel-strong relative w-full max-w-sm rounded-[14px] p-5'
            )}
          >
            <h3
              id="replace-session-title"
              className="font-cormorant text-[1.35rem] font-light leading-snug"
              style={{ color: 'var(--cosmic-text-strong)' }}
            >
              You have an active session
            </h3>
            <p className="mt-1.5 text-[13px] font-light" style={{ color: 'var(--cosmic-text-muted)' }}>
              Would you like to continue where you left off, or start over?
            </p>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={handleContinueSession}
                className={cn(
                  'cosmic-accent-pill cosmic-focus-ring flex-1 rounded-full px-4 py-2.5 text-[12px] font-medium tracking-[0.02em] transition-all duration-300'
                )}
              >
                Continue
              </button>
              <button
                type="button"
                onClick={handleConfirmReplaceSession}
                className={cn(
                  'cosmic-ghost-pill cosmic-focus-ring flex-1 rounded-full px-4 py-2.5 text-[12px] font-medium tracking-[0.02em] transition-all duration-300'
                )}
              >
                Start fresh
              </button>
            </div>
          </div>
        </div>
      )}

      {showFreshStartPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
          <button
            type="button"
            aria-label="Close"
            className="cosmic-modal-backdrop absolute inset-0"
            onClick={handleCancelFreshStart}
          />
          <div
            ref={freshStartModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="start-fresh-title"
            className={cn(
              'cosmic-surface-panel-strong relative w-full max-w-sm rounded-[14px] p-5'
            )}
          >
            <h3
              id="start-fresh-title"
              className="font-cormorant text-[1.35rem] font-light leading-snug"
              style={{ color: 'var(--cosmic-text-strong)' }}
            >
              Start fresh
            </h3>
            <p className="mt-1.5 text-[13px] font-light" style={{ color: 'var(--cosmic-text-muted)' }}>
              {resumableSessionUsesRitual
                ? 'We can clear this session and begin again. Do you want to keep the same ritual, or choose a different one first?'
                : 'We can clear this session and begin again. Do you want another open session, or would you rather choose a ritual first?'}
            </p>
            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={handleRestartWithSameRitual}
                className={cn(
                  'cosmic-accent-pill cosmic-focus-ring flex-1 rounded-full px-4 py-2.5 text-[12px] font-medium tracking-[0.02em] transition-all duration-300'
                )}
              >
                {resumableSessionUsesRitual ? 'Same ritual' : 'Start open'}
              </button>
              <button
                type="button"
                onClick={handleChooseDifferentRitual}
                className={cn(
                  'cosmic-ghost-pill cosmic-focus-ring flex-1 rounded-full px-4 py-2.5 text-[12px] font-medium tracking-[0.02em] transition-all duration-300'
                )}
              >
                Choose ritual
              </button>
            </div>
            <button
              type="button"
              onClick={handleCancelFreshStart}
              className="mt-3 w-full text-center text-[12px] font-light transition-colors duration-300 hover:text-[var(--cosmic-text)]"
              style={{ color: 'var(--cosmic-text-whisper)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="relative z-10 flex min-h-screen flex-col px-6 sm:px-8">
        {/* Greeting — near top, matching prototype clamp(28px,6vh,48px) */}
        <div
          ref={greetingGlowRef as React.RefObject<HTMLDivElement>}
          className="pointer-events-none mx-auto max-w-[480px] pt-[clamp(28px,6vh,48px)] text-center"
          style={{
            filter: 'brightness(calc(1 + var(--sweep-glow, 0) * 0.18))',
            textShadow: [
              // Directional shadow — cast away from the light
              'calc(6px * var(--sweep-sx, 0) * var(--sweep-glow, 0))',
              'calc(6px * var(--sweep-sy, 0) * var(--sweep-glow, 0))',
              'calc(12px * var(--sweep-glow, 0))',
              'rgba(0, 0, 0, calc(var(--sweep-glow, 0) * 0.18))',
            ].join(' ') + ', ' + [
              // Ambient glow halo
              '0 0',
              'calc(10px * var(--sweep-glow, 0))',
              'rgba(200, 180, 255, calc(var(--sweep-glow, 0) * 0.20))',
            ].join(' '),
          }}
        >
          <h1
            className={cn(
              'font-cormorant text-[clamp(24px,3.5vw,32px)] font-light leading-[1.4] tracking-[0.01em]',
              'transition-all duration-[1.8s] ease-out',
              greetingVisible
                ? 'translate-y-0'
                : 'translate-y-2 text-transparent',
            )}
            style={greetingVisible ? { color: 'var(--cosmic-text-strong)' } : undefined}
          >
            {greeting}
          </h1>
          <p
            className={cn(
              'mt-2 text-[13px] font-light tracking-[0.02em]',
              'transition-all duration-[2s] ease-out delay-[0.4s]',
              greetingVisible
                ? 'translate-y-0'
                : 'translate-y-1.5 text-transparent',
            )}
            style={greetingVisible ? { color: 'var(--cosmic-text)' } : undefined}
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
            <p className="mx-auto mt-3 max-w-md font-cormorant italic text-[13px]" style={{ color: 'var(--cosmic-text-whisper)' }}>
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

      <SettingsDrawer
        isOpen={showSettingsDrawer}
        onClose={() => setShowSettingsDrawer(false)}
      />
    </div>
  );
}

export default EnhancedFieldDashboard;