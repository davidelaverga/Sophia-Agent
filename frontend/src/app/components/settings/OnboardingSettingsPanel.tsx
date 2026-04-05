'use client';

import { useRouter } from 'next/navigation';
import { RotateCcw, Volume2, VolumeX, Wand2 } from 'lucide-react';
import { useOnboardingStore } from '../../stores/onboarding-store';
import { useUiStore } from '../../stores/ui-store';
import { haptic } from '../../hooks/useHaptics';

export function OnboardingSettingsPanel() {
  const router = useRouter();
  const replayOnboarding = useOnboardingStore((state) => state.replayOnboarding);
  const voiceOverEnabled = useOnboardingStore((state) => state.preferences.voiceOverEnabled);
  const setVoiceOverEnabled = useOnboardingStore((state) => state.setVoiceOverEnabled);
  const showToast = useUiStore((state) => state.showToast);

  return (
    <section aria-labelledby="onboarding-settings-title" className="rounded-3xl border-2 border-sophia-surface-border bg-sophia-surface p-4 shadow-lg">
      <div>
        <p id="onboarding-settings-title" className="text-base font-semibold text-sophia-text">
          Onboarding
        </p>
        <p className="text-sm text-sophia-text2">
          Replay Sophia&apos;s tour or choose whether onboarding tips can speak.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-sophia-surface-border bg-sophia-bg/40 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-sophia-text">
              {voiceOverEnabled ? <Volume2 className="h-4 w-4 text-sophia-purple" /> : <VolumeX className="h-4 w-4 text-sophia-text2" />}
              <span>Onboarding voice-over</span>
            </div>
            <p className="mt-1 text-xs text-sophia-text2">
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
              'inline-flex h-9 min-w-[72px] items-center justify-center rounded-full border px-3 text-xs font-semibold transition-all',
              voiceOverEnabled
                ? 'border-sophia-purple/30 bg-sophia-purple text-white'
                : 'border-sophia-surface-border bg-sophia-button text-sophia-text2 hover:text-sophia-text',
            ].join(' ')}
          >
            {voiceOverEnabled ? 'On' : 'Off'}
          </button>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-2xl border border-sophia-surface-border bg-sophia-bg/40 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-sophia-text">
              <Wand2 className="h-4 w-4 text-sophia-purple" />
              <span>Replay Sophia&apos;s tour</span>
            </div>
            <p className="mt-1 text-xs text-sophia-text2">
              Starts the guided welcome again from the dashboard without clearing your tips or preferences.
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
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-sophia-purple px-4 text-sm font-semibold text-white shadow-soft transition-all hover:bg-sophia-glow hover:scale-[1.02]"
          >
            <RotateCcw className="h-4 w-4" />
            Replay
          </button>
        </div>
      </div>
    </section>
  );
}