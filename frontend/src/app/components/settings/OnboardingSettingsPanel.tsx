'use client';

import { RotateCcw, Volume2, VolumeX, Wand2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { haptic } from '../../hooks/useHaptics';
import { useOnboardingStore } from '../../stores/onboarding-store';
import { useUiStore } from '../../stores/ui-store';

export function OnboardingSettingsPanel() {
  const router = useRouter();
  const replayOnboarding = useOnboardingStore((state) => state.replayOnboarding);
  const voiceOverEnabled = useOnboardingStore((state) => state.preferences.voiceOverEnabled);
  const setVoiceOverEnabled = useOnboardingStore((state) => state.setVoiceOverEnabled);
  const showToast = useUiStore((state) => state.showToast);

  return (
    <section aria-labelledby="onboarding-settings-title" className="cosmic-surface-panel-strong rounded-[1.8rem] p-5 sm:p-6">
      <div>
        <p className="text-[11px] uppercase tracking-[0.16em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
          Onboarding
        </p>
        <h3 id="onboarding-settings-title" className="mt-1 font-cormorant text-[1.65rem] font-light" style={{ color: 'var(--cosmic-text-strong)' }}>
          Welcome flow controls
        </h3>
        <p className="mt-2 text-sm leading-6" style={{ color: 'var(--cosmic-text-muted)' }}>
          Replay Sophia&apos;s tour or choose whether onboarding tips can speak as part of the new field experience.
        </p>
      </div>

      <div className="mt-5 space-y-4">
        <div className="cosmic-surface-panel rounded-[1.4rem] p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>
                {voiceOverEnabled ? <Volume2 className="h-4 w-4 text-sophia-purple" /> : <VolumeX className="h-4 w-4 text-sophia-text2" />}
                <span>Onboarding voice-over</span>
              </div>
              <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--cosmic-text-muted)' }}>
                Controls spoken guidance during the tour and voice-enabled contextual tips.
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                haptic('light');
                const nextEnabled = !voiceOverEnabled;
                setVoiceOverEnabled(nextEnabled);
                showToast({
                  message: nextEnabled ? 'Onboarding voice-over enabled' : 'Onboarding voice-over muted',
                  variant: 'success',
                  durationMs: 2200,
                });
              }}
              aria-pressed={voiceOverEnabled}
              className={[
                'cosmic-focus-ring inline-flex h-10 min-w-[84px] items-center justify-center rounded-full px-4 text-[12px] font-medium transition-all duration-300',
                voiceOverEnabled ? 'cosmic-accent-pill' : 'cosmic-ghost-pill',
              ].join(' ')}
            >
              {voiceOverEnabled ? 'On' : 'Off'}
            </button>
          </div>
        </div>

        <div className="cosmic-surface-panel rounded-[1.4rem] p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--cosmic-text-strong)' }}>
                <Wand2 className="h-4 w-4 text-sophia-purple" />
                <span>Replay Sophia&apos;s tour</span>
              </div>
              <p className="mt-1 text-[12px] leading-5" style={{ color: 'var(--cosmic-text-muted)' }}>
                Starts the guided welcome again from the dashboard without clearing your saved preferences.
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                haptic('medium');
                replayOnboarding();
                showToast({
                  message: 'Replaying Sophia\'s tour on the dashboard',
                  variant: 'info',
                  durationMs: 2600,
                });
                router.push('/');
              }}
              className="cosmic-accent-pill cosmic-focus-ring inline-flex h-10 items-center gap-2 rounded-full px-4 text-[12px] font-medium transition-all duration-300"
            >
              <RotateCcw className="h-4 w-4" />
              Replay
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}