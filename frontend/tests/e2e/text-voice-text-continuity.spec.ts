import path from 'node:path';

import { expect, test, type Request } from '@playwright/test';

import {
  enableCaptureBridge,
  exportCapture,
  getCaptureEvents,
  openDashboard,
  seedSophiaBrowserState,
  sendTextTurn,
  startSessionFromDashboard,
  switchToTextMode,
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

type ContinuityRequestBody = {
  session_id?: unknown;
  thread_id?: unknown;
  platform?: unknown;
};

function parseJsonBody(request: Request): ContinuityRequestBody | null {
  const raw = request.postData();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as ContinuityRequestBody;
  } catch {
    return null;
  }
}

function getStringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

test('text to voice to text keeps the same session and thread ids', async ({ page }, testInfo) => {
  test.setTimeout(240_000);

  const chatBodies: ContinuityRequestBody[] = [];
  const voiceConnectBodies: ContinuityRequestBody[] = [];
  let captureExport: unknown = null;
  let captureEvents: CaptureEvent[] = [];

  page.on('request', (request) => {
    if (request.method().toUpperCase() !== 'POST') {
      return;
    }

    if (request.url().includes('/api/chat')) {
      const body = parseJsonBody(request);
      if (body) {
        chatBodies.push(body);
      }
      return;
    }

    if (request.url().includes('/api/sophia/') && request.url().includes('/voice/connect')) {
      const body = parseJsonBody(request);
      if (body) {
        voiceConnectBodies.push(body);
      }
    }
  });

  await seedSophiaBrowserState(page, { enableCapture: true });
  await openDashboard(page);
  await startSessionFromDashboard(page);
  await enableCaptureBridge(page);

  const uniqueToken = `TEXT-VOICE-TEXT-${Date.now()}`;

  await switchToTextMode(page);
  await sendTextTurn(
    page,
    `Please remember this exact continuity token: ${uniqueToken}. Reply briefly.`,
  );

  const voiceTab = page.getByRole('tab', { name: 'voice' });
  await voiceTab.click();
  await expect(voiceTab).toHaveAttribute('aria-selected', 'true');

  const micButton = page.getByRole('button', { name: 'Tap to speak' }).first();
  await expect(micButton).toBeVisible({ timeout: 20_000 });
  await micButton.click();

  try {
    await waitForCaptureEvent(page, { category: 'voice-session', name: 'credentials-received' }, 45_000);
    await waitForCaptureEvent(page, { category: 'stream-custom', name: 'sophia.user_transcript' }, 75_000);
    await waitForCaptureEvent(page, { category: 'stream-custom', name: 'sophia.artifact' }, 75_000);
  } finally {
    captureExport = await exportCapture(page).catch(() => null);
    captureEvents = await getCaptureEvents(page).catch(() => []);
  }

  const stopVoiceButton = page.getByRole('button', { name: /Listening|Thinking|Speaking/i }).first();
  if (await stopVoiceButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await stopVoiceButton.click({ force: true });
    await expect(page.getByRole('button', { name: 'Tap to speak' }).first()).toBeVisible({ timeout: 15_000 });
  }

  await switchToTextMode(page);
  await sendTextTurn(
    page,
    `Continuity check: answer in one short sentence and include this token exactly once: ${uniqueToken}`,
  );

  await testInfo.attach('text-voice-text-chat-bodies.json', {
    body: JSON.stringify(chatBodies, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('text-voice-text-voice-connect-bodies.json', {
    body: JSON.stringify(voiceConnectBodies, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('text-voice-text-capture-export.json', {
    body: JSON.stringify(captureExport, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('text-voice-text-capture-events.json', {
    body: JSON.stringify(captureEvents, null, 2),
    contentType: 'application/json',
  });

  expect(chatBodies.length).toBeGreaterThanOrEqual(2);
  expect(voiceConnectBodies.length).toBeGreaterThanOrEqual(1);

  const firstChatBody = chatBodies[0] ?? null;
  const secondChatBody = chatBodies.at(-1) ?? null;
  const voiceConnectBody = voiceConnectBodies.at(-1) ?? null;

  const firstSessionId = getStringField(firstChatBody?.session_id);
  const firstThreadId = getStringField(firstChatBody?.thread_id);
  const secondSessionId = getStringField(secondChatBody?.session_id);
  const secondThreadId = getStringField(secondChatBody?.thread_id);
  const voiceSessionId = getStringField(voiceConnectBody?.session_id);
  const voiceThreadId = getStringField(voiceConnectBody?.thread_id);

  expect(firstSessionId).toBeTruthy();
  expect(firstThreadId).toBeTruthy();
  expect(voiceSessionId).toBe(firstSessionId);
  expect(voiceThreadId).toBe(firstThreadId);
  expect(secondSessionId).toBe(firstSessionId);
  expect(secondThreadId).toBe(firstThreadId);
});