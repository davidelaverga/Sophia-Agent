import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

import { chromium } from '@playwright/test';

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.CAPTURE_BASE_URL || 'http://127.0.0.1:3000',
    route: '/session',
    headless: false,
    autoStopMs: 0,
    awaitArtifactMs: 0,
    settleMs: 1500,
    automation: 'manual',
    ritual: 'vent',
    fakeAudioFile: null,
    outputRoot: 'test-results/session-captures',
    profileDir: '.session-capture-profile',
    emitResultJson: false,
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--help' || current === '-h') {
      args.help = true;
      continue;
    }
    if (current === '--headless') {
      args.headless = true;
      continue;
    }
    if (current === '--verbose') {
      args.verbose = true;
      continue;
    }
    if (current === '--base-url') {
      args.baseUrl = argv[index + 1] || args.baseUrl;
      index += 1;
      continue;
    }
    if (current === '--route') {
      args.route = argv[index + 1] || args.route;
      index += 1;
      continue;
    }
    if (current === '--auto-stop-ms') {
      const parsed = Number(argv[index + 1] || '0');
      args.autoStopMs = Number.isFinite(parsed) ? parsed : 0;
      index += 1;
      continue;
    }
    if (current === '--await-artifact-ms') {
      const parsed = Number(argv[index + 1] || '0');
      args.awaitArtifactMs = Number.isFinite(parsed) ? parsed : 0;
      index += 1;
      continue;
    }
    if (current === '--settle-ms') {
      const parsed = Number(argv[index + 1] || '1500');
      args.settleMs = Number.isFinite(parsed) ? parsed : 1500;
      index += 1;
      continue;
    }
    if (current === '--automation') {
      args.automation = argv[index + 1] || args.automation;
      index += 1;
      continue;
    }
    if (current === '--ritual') {
      args.ritual = argv[index + 1] || args.ritual;
      index += 1;
      continue;
    }
    if (current === '--fake-audio-file') {
      args.fakeAudioFile = argv[index + 1] || args.fakeAudioFile;
      index += 1;
      continue;
    }
    if (current === '--output-root') {
      args.outputRoot = argv[index + 1] || args.outputRoot;
      index += 1;
      continue;
    }
    if (current === '--profile-dir') {
      args.profileDir = argv[index + 1] || args.profileDir;
      index += 1;
      continue;
    }
    if (current === '--emit-result-json') {
      args.emitResultJson = true;
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage: npm run capture:session -- [options]

Options:
  --base-url <url>        Base URL for the MVP frontend (default: http://127.0.0.1:3000)
  --route <path>          Route to open before capture (default: /session)
  --headless              Run Chromium headless
  --auto-stop-ms <ms>     End capture automatically after the given duration
  --await-artifact-ms <ms> Wait for artifact data before exporting
  --settle-ms <ms>        Extra wait after automation / artifact capture (default: 1500)
  --automation <mode>     manual | dashboard-voice (default: manual)
  --ritual <preset>       prepare | debrief | reset | vent | open (default: vent)
  --fake-audio-file <wav> Use a WAV file as Chromium's fake microphone input
  --output-root <path>    Directory for JSON bundle + screenshots
  --profile-dir <path>    Persistent browser profile directory
  --emit-result-json      Print a machine-readable capture result line at the end
  --verbose               Print browser console output during capture
  --help                  Show this message

Examples:
  npm run capture:session -- --route /session
  npm run capture:session -- --route /debug --headless --auto-stop-ms 2000
  npm run capture:session -- --route / --automation dashboard-voice --ritual vent --fake-audio-file ../voice/fixtures/audio/map_01_grief.wav --await-artifact-ms 35000 --headless
`);
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function resolveTargetUrl(baseUrl, route) {
  return new URL(route, baseUrl).toString();
}

function resolveCliPath(projectDir, candidate) {
  if (!candidate) return null;
  return path.isAbsolute(candidate) ? candidate : path.resolve(projectDir, candidate);
}

function buildFakeAudioCaptureArgument(fakeAudioFile) {
  if (!fakeAudioFile) {
    return null;
  }

  return fakeAudioFile.endsWith('%noloop') ? fakeAudioFile : `${fakeAudioFile}%noloop`;
}

function buildChromiumArgs(fakeAudioFile) {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  const fakeAudioCaptureArg = buildFakeAudioCaptureArgument(fakeAudioFile);

  if (fakeAudioCaptureArg) {
    args.push('--use-fake-ui-for-media-stream');
    args.push('--use-fake-device-for-media-stream');
    args.push(`--use-file-for-fake-audio-capture=${fakeAudioCaptureArg}`);
  }

  return args;
}

function parseWavMetadata(buffer) {
  if (buffer.length < 44) {
    return null;
  }

  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let audioFormat = null;
  let bitsPerSample = null;
  let channelCount = null;
  let dataBytes = null;
  let sampleRate = null;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > buffer.length) {
      break;
    }

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = buffer.readUInt16LE(chunkStart);
      channelCount = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    }

    if (chunkId === 'data') {
      dataBytes = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (
    sampleRate === null ||
    channelCount === null ||
    bitsPerSample === null ||
    dataBytes === null ||
    bitsPerSample <= 0
  ) {
    return null;
  }

  const bytesPerSample = bitsPerSample / 8;
  const durationMs =
    bytesPerSample > 0
      ? Math.round((dataBytes / (sampleRate * channelCount * bytesPerSample)) * 1000)
      : null;

  return {
    audioFormat,
    bitsPerSample,
    channelCount,
    dataBytes,
    durationMs,
    sampleRate,
  };
}

async function describeFakeAudioFile(fakeAudioFile) {
  if (!fakeAudioFile) {
    return null;
  }

  const [buffer, stats] = await Promise.all([fs.readFile(fakeAudioFile), fs.stat(fakeAudioFile)]);

  return {
    basename: path.basename(fakeAudioFile),
    path: fakeAudioFile,
    sizeBytes: stats.size,
    wav: parseWavMetadata(buffer),
  };
}

async function collectDomSummary(page) {
  return page.evaluate(() => {
    const clean = (value) => {
      if (!value) return null;
      const normalized = value.replace(/\s+/g, ' ').trim();
      return normalized.length > 0 ? normalized : null;
    };

    const transcriptRoot = document.querySelector('[role="log"][aria-label="Conversation with Sophia"]');
    const transcriptMessages = Array.from(transcriptRoot?.querySelectorAll('[role="article"]') ?? [])
      .map((article) => ({
        label: article.getAttribute('aria-label'),
        text: clean(article.textContent),
      }))
      .filter((entry) => entry.text !== null);

    return {
      href: window.location.href,
      title: document.title,
      transcriptMessages,
      artifactRailLabel: document.querySelector('button[aria-label^="Artifacts:"]')?.getAttribute('aria-label') ?? null,
      artifactsPanel: {
        visible:
          document.querySelector('[data-onboarding="artifact-takeaway"]') !== null ||
          document.querySelector('[data-onboarding="reflection-card"]') !== null ||
          document.querySelector('[data-onboarding="memory-candidates"]') !== null,
        takeawayText: clean(document.querySelector('[data-onboarding="artifact-takeaway"]')?.textContent),
        reflectionText: clean(document.querySelector('[data-onboarding="reflection-card"]')?.textContent),
        memoriesText: clean(document.querySelector('[data-onboarding="memory-candidates"]')?.textContent),
      },
      presenceLabels: Array.from(document.querySelectorAll('[aria-label^="Sophia is "]'))
        .map((element) => element.getAttribute('aria-label'))
        .filter(Boolean),
    };
  });
}

async function waitForCaptureApi(page) {
  await page.waitForFunction(() => Boolean(window.__sophiaCapture), undefined, {
    timeout: 20_000,
  }).catch(() => {});
}

async function waitForArtifactState(page, timeoutMs) {
  if (timeoutMs <= 0) {
    return false;
  }

  try {
    await page.waitForFunction(() => {
      const snapshot = window.__sophiaCapture?.snapshot?.();
      const artifacts = snapshot?.artifacts?.sessionArtifacts;

      if (!artifacts || typeof artifacts !== 'object') {
        return false;
      }

      const record = artifacts;
      const takeaway = typeof record.takeaway === 'string' ? record.takeaway.trim() : '';
      const reflection = record.reflection_candidate;
      const memories = Array.isArray(record.memory_candidates) ? record.memory_candidates : [];

      return Boolean(takeaway || reflection || memories.length > 0);
    }, undefined, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function waitForTurnDiagnostic(page, timeoutMs) {
  if (timeoutMs <= 0) {
    return false;
  }

  try {
    await page.waitForFunction(() => {
      const events = window.__sophiaCapture?.getEvents?.() ?? [];
      return events.some(
        (event) =>
          event?.category === 'stream-custom' &&
          event?.name === 'sophia.turn_diagnostic'
      );
    }, undefined, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function openArtifactsPanel(page) {
  const panelAlreadyVisible = await page.evaluate(() => {
    return Boolean(window.__sophiaCapture?.snapshot?.().artifacts.dom.panelVisible);
  }).catch(() => false);

  if (panelAlreadyVisible) {
    return;
  }

  const artifactsRail = page.locator('button[aria-label^="Artifacts:"]').first();
  if (await artifactsRail.count()) {
    await artifactsRail.click().catch(() => {});
    await page.waitForTimeout(750);
  }
}

async function dismissOnboardingIfPresent(page) {
  const skipTourButton = page.locator('button:has-text("Skip tour")').first();
  if (await skipTourButton.count()) {
    const isVisible = await skipTourButton.isVisible().catch(() => false);
    if (isVisible) {
      await skipTourButton.click();
      await page.waitForTimeout(750);
    }
  }
}

async function detectDashboardVoiceLanding(page, ritual, timeoutMs) {
  try {
    const stateHandle = await page.waitForFunction(
      ({ currentRitual }) => {
        const isVisible = (element) =>
          Boolean(
            element &&
              element instanceof HTMLElement &&
              element.isConnected &&
              element.offsetParent !== null
          );

        if (currentRitual) {
          const ritualCard = document.querySelector(
            `[data-onboarding="ritual-card-${currentRitual}"]`
          );
          if (isVisible(ritualCard)) {
            return 'ritual';
          }
        }

        const dashboardMic = document.querySelector('[data-onboarding="mic-cta"]');
        if (isVisible(dashboardMic)) {
          return 'dashboard-mic';
        }

        const sessionMic = document.querySelector(
          [
            'button[aria-label="Tap to speak"]',
            'button[aria-label="Listening..."]',
            'button[aria-label="Thinking..."]',
            'button[aria-label="Speaking..."]',
          ].join(', ')
        );
        if (isVisible(sessionMic)) {
          return 'session-mic';
        }

        const startFreshButton = Array.from(document.querySelectorAll('button')).find(
          (element) => element.textContent?.trim() === 'Start Fresh'
        );
        if (isVisible(startFreshButton)) {
          return 'start-fresh';
        }

        return null;
      },
      { currentRitual: ritual },
      { timeout: timeoutMs }
    );

    return stateHandle.jsonValue();
  } catch {
    return null;
  }
}

async function runDashboardVoiceAutomation(page, args) {
  console.log(`Running automation: ${args.automation} (${args.ritual})`);

  await dismissOnboardingIfPresent(page);

  const ritual = args.ritual && args.ritual !== 'open' ? args.ritual : null;
  const ritualSelector = ritual ? `[data-onboarding="ritual-card-${ritual}"]` : null;
  const dashboardMic = page.locator('[data-onboarding="mic-cta"]').first();
  const sessionMic = page
    .locator([
      'button[aria-label="Tap to speak"]',
      'button[aria-label="Listening..."]',
      'button[aria-label="Thinking..."]',
      'button[aria-label="Speaking..."]',
    ].join(', '))
    .first();

  const landingState = await detectDashboardVoiceLanding(page, ritual, 30_000);

  if (landingState === 'ritual' && ritualSelector) {
    await page.click(ritualSelector);
  }

  if (landingState === 'ritual' || landingState === 'dashboard-mic') {
    await dashboardMic.waitFor({ state: 'visible', timeout: 30_000 });
    await dashboardMic.click();

    try {
      await page.waitForURL((url) => url.pathname === '/session', {
        timeout: 5_000,
      });
    } catch {
      await dismissOnboardingIfPresent(page);

      const startFreshButton = page.locator('button:has-text("Start Fresh")').first();
      if (await startFreshButton.count()) {
        const isVisible = await startFreshButton.isVisible().catch(() => false);
        if (isVisible) {
          await startFreshButton.click();
        }
      }

      await page.waitForURL((url) => url.pathname === '/session', {
        timeout: 30_000,
      });
    }
  } else if (landingState === 'start-fresh') {
    await page.locator('button:has-text("Start Fresh")').first().click();
    await page.waitForURL((url) => url.pathname === '/session', {
      timeout: 30_000,
    });
  } else if (landingState !== 'session-mic') {
    throw new Error('Dashboard voice automation could not find a ritual card, dashboard mic, or session mic.');
  }

  await dismissOnboardingIfPresent(page);

  try {
    await sessionMic.waitFor({ state: 'visible', timeout: 8_000 });
  } catch {
    const voiceModeTab = page
      .locator('[role="tablist"][aria-label="Interaction mode"] [role="tab"]')
      .first();

    if (await voiceModeTab.count()) {
      const selected = await voiceModeTab.getAttribute('aria-selected');
      if (selected !== 'true') {
        await voiceModeTab.click();
      }
    }

    await sessionMic.waitFor({ state: 'visible', timeout: 30_000 });
  }

  const micLabel = await sessionMic.getAttribute('aria-label');

  if (micLabel === 'Tap to speak') {
    await sessionMic.click();
  }

  if (args.settleMs > 0) {
    await page.waitForTimeout(args.settleMs);
  }
}

async function waitForFinish(autoStopMs) {
  if (autoStopMs > 0) {
    console.log(`Auto-stopping capture after ${autoStopMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, autoStopMs));
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error('Interactive capture requires a TTY. Pass --auto-stop-ms for non-interactive runs.');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await rl.question('Press Enter when you want to export the capture bundle.\n');
  rl.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const projectDir = process.cwd();
  const runDir = path.resolve(projectDir, args.outputRoot, timestampSlug());
  const profileDir = path.resolve(projectDir, args.profileDir);
  const fakeAudioFile = resolveCliPath(projectDir, args.fakeAudioFile);
  const targetUrl = resolveTargetUrl(args.baseUrl, args.route);

  if (fakeAudioFile) {
    await fs.access(fakeAudioFile);
  }

  const fakeAudioMetadata = await describeFakeAudioFile(fakeAudioFile);

  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: args.headless,
    viewport: { width: 1440, height: 1100 },
    permissions: ['microphone'],
    args: buildChromiumArgs(fakeAudioFile),
  });

  await context.addInitScript(() => {
    window.__SOPHIA_CAPTURE_ENABLED__ = true;
    try {
      window.localStorage.setItem('sophia.capture.enabled', '1');
    } catch {
      // Ignore localStorage failures for capture setup.
    }
  });

  const page = context.pages()[0] ?? await context.newPage();

  if (args.verbose) {
    page.on('console', (message) => {
      console.log(`[browser:${message.type()}] ${message.text()}`);
    });
  }

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await waitForCaptureApi(page);
  await page.evaluate(() => {
    window.__sophiaCapture?.enable();
    window.__sophiaCapture?.clear();
  }).catch(() => {});

  console.log(`Capture browser ready at ${targetUrl}`);
  console.log(`Profile: ${profileDir}`);
  console.log(`Output: ${runDir}`);
  if (fakeAudioFile) {
    console.log(`Fake microphone WAV: ${fakeAudioFile}`);
  }
  console.log('If you are redirected to auth or consent, complete that flow in this browser, then run your session as usual.');

  if (args.automation === 'dashboard-voice') {
    await runDashboardVoiceAutomation(page, args);
  }

  let artifactObserved = false;
  if (args.awaitArtifactMs > 0) {
    console.log(`Waiting up to ${args.awaitArtifactMs}ms for artifact data...`);
    artifactObserved = await waitForArtifactState(page, args.awaitArtifactMs);
    console.log(artifactObserved ? 'Artifact data observed.' : 'Artifact data not observed before timeout.');
  }

  if (artifactObserved) {
    await openArtifactsPanel(page);
    const turnDiagnosticWaitMs = Math.max(args.settleMs, 5000);
    console.log(`Waiting up to ${turnDiagnosticWaitMs}ms for turn diagnostic...`);
    const turnDiagnosticObserved = await waitForTurnDiagnostic(page, turnDiagnosticWaitMs);
    console.log(
      turnDiagnosticObserved
        ? 'Turn diagnostic observed.'
        : 'Turn diagnostic not observed before timeout.'
    );

    if (turnDiagnosticObserved) {
      const postDiagnosticSettleMs = Math.min(args.settleMs, 250);
      if (postDiagnosticSettleMs > 0) {
        await page.waitForTimeout(postDiagnosticSettleMs);
      }
    }
  }

  if (args.autoStopMs > 0 || args.awaitArtifactMs <= 0) {
    await waitForFinish(args.autoStopMs);
  }

  const captureBundle = await page.evaluate(() => window.__sophiaCapture?.export?.() ?? null);
  const domSummary = await collectDomSummary(page);
  const microphoneSummary = captureBundle?.snapshot?.harness?.microphone ?? null;

  const screenshotPath = path.join(runDir, 'final-page.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const payload = {
    capturedAt: new Date().toISOString(),
    harness: {
      automation: args.automation,
      fakeAudioFile: fakeAudioMetadata,
      ritual: args.ritual,
    },
    targetUrl,
    profileDir,
    captureBundle,
    domSummary,
    screenshotPath,
  };

  const outputPath = path.join(runDir, 'capture.json');
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`Capture written to ${outputPath}`);
  if (microphoneSummary) {
    console.log(
      `Harness microphone: streams=${microphoneSummary.streamCount ?? 0}, tracks=${microphoneSummary.audioTrackCount ?? 0}, audioDetected=${microphoneSummary.detectedAudio === true ? 'yes' : 'no'}`
    );
  }
  if (args.emitResultJson) {
    console.log(`CAPTURE_RESULT ${JSON.stringify({
      outputPath,
      runDir,
      screenshotPath,
      artifactObserved,
      microphoneAudioDetected: microphoneSummary?.detectedAudio === true,
      microphoneStreamCount: microphoneSummary?.streamCount ?? 0,
    })}`);
  }

  await context.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});