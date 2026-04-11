import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  enableCaptureBridge,
  exportCapture,
  getCaptureEvents,
  openDashboard,
  seedSophiaBrowserState,
  startSessionFromDashboard,
  waitForCaptureEvent,
  type CaptureEvent,
} from './live-sophia.helpers';

const fakeMicAudioArg = `--use-file-for-fake-audio-capture=${path
  .resolve(process.cwd(), '../voice/fixtures/audio/map_01_grief.wav')
  .replace(/\\/g, '/')}%noloop`;

test.describe.configure({ mode: 'serial' });

test.use({
  headless: false,
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      fakeMicAudioArg,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

function getLastEvent(events: CaptureEvent[], name: string): CaptureEvent | undefined {
  return [...events].reverse().find((event) => event.name === name);
}

test('voice route accepts fake mic audio and emits transcript plus artifact', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  let captureExport: unknown = null;
  let events: CaptureEvent[] = [];

  await seedSophiaBrowserState(page, { enableCapture: true });
  await openDashboard(page);
  await startSessionFromDashboard(page);
  await enableCaptureBridge(page);

  const micButton = page.getByRole('button', { name: 'Tap to speak' }).first();
  await expect(micButton).toBeVisible({ timeout: 20_000 });
  await micButton.click();

  try {
    await waitForCaptureEvent(page, { category: 'voice-session', name: 'credentials-received' }, 45_000);
    await waitForCaptureEvent(page, { category: 'harness-input', name: 'microphone-stream-acquired' }, 45_000);
    await waitForCaptureEvent(page, { category: 'harness-input', name: 'microphone-audio-detected' }, 45_000);
    await waitForCaptureEvent(page, { category: 'stream-custom', name: 'sophia.user_transcript' }, 75_000);
    await waitForCaptureEvent(page, { category: 'stream-custom', name: 'sophia.artifact' }, 75_000);
  } finally {
    captureExport = await exportCapture(page).catch(() => null);
    events = await getCaptureEvents(page).catch(() => []);

    await testInfo.attach('voice-capture-export.json', {
      body: JSON.stringify(captureExport, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('voice-capture-events.json', {
      body: JSON.stringify(events, null, 2),
      contentType: 'application/json',
    });
  }

  const startupFailure = events.find((event) => {
    return (
      event.category === 'voice-session' &&
      ['start-talking-failed', 'missing-session-id', 'startup-ready-timeout', 'stream-error'].includes(event.name)
    );
  });

  expect(startupFailure).toBeUndefined();

  const transcriptEvent = getLastEvent(events, 'sophia.user_transcript');
  const transcriptPayload = transcriptEvent?.payload as { data?: { text?: unknown } } | undefined;
  const transcriptText = typeof transcriptPayload?.data?.text === 'string'
    ? transcriptPayload.data.text.trim()
    : '';

  expect(transcriptText.length).toBeGreaterThan(10);

  const artifactEvent = getLastEvent(events, 'sophia.artifact');
  const artifactPayload = artifactEvent?.payload as { data?: Record<string, unknown> } | undefined;
  const artifactData = artifactPayload?.data ?? {};

  expect(typeof artifactData.active_tone_band).toBe('string');
  expect(typeof artifactData.voice_emotion_primary).toBe('string');

  const audioDetectedEvent = getLastEvent(events, 'microphone-audio-detected');
  const captureErrors = events.filter((event) => {
    return event.category === 'harness-input' && ['microphone-probe-error', 'microphone-request-failed'].includes(event.name);
  });

  expect(audioDetectedEvent).toBeDefined();
  expect(captureErrors).toHaveLength(0);
});