import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import typescript from 'typescript';

function parseArgs(argv) {
  const args = {
    analyzeOnly: false,
    baseUrl: process.env.CAPTURE_BASE_URL || 'http://127.0.0.1:3000',
    caseIds: [],
    headless: true,
    help: false,
    list: false,
    manifest: '../voice/fixtures/audio/benchmark-manifest.json',
    outputRoot: 'test-results/session-captures',
    reportsRoot: 'test-results/voice-benchmarks',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--help' || current === '-h') {
      args.help = true;
      continue;
    }
    if (current === '--list') {
      args.list = true;
      continue;
    }
    if (current === '--analyze-only') {
      args.analyzeOnly = true;
      continue;
    }
    if (current === '--headed') {
      args.headless = false;
      continue;
    }
    if (current === '--case') {
      const caseId = argv[index + 1];
      if (caseId) {
        args.caseIds.push(caseId);
      }
      index += 1;
      continue;
    }
    if (current === '--base-url') {
      args.baseUrl = argv[index + 1] || args.baseUrl;
      index += 1;
      continue;
    }
    if (current === '--manifest') {
      args.manifest = argv[index + 1] || args.manifest;
      index += 1;
      continue;
    }
    if (current === '--output-root') {
      args.outputRoot = argv[index + 1] || args.outputRoot;
      index += 1;
      continue;
    }
    if (current === '--reports-root') {
      args.reportsRoot = argv[index + 1] || args.reportsRoot;
      index += 1;
    }
  }

  return args;
}

function printUsage() {
  console.log(`Usage: npm run benchmark:voice -- [options]

Options:
  --manifest <path>       Benchmark manifest path (default: ../voice/fixtures/audio/benchmark-manifest.json)
  --case <id>             Run or analyze a single case (repeatable)
  --analyze-only          Reuse the latest capture per case instead of launching the browser
  --headed                Run Chromium headed instead of headless
  --base-url <url>        Base URL for the MVP frontend (default: http://127.0.0.1:3000)
  --output-root <path>    Root directory for session capture bundles
  --reports-root <path>   Root directory for benchmark reports
  --list                  Print manifest case IDs and exit
  --help                  Show this message

Examples:
  npm run benchmark:voice -- --analyze-only
  npm run benchmark:voice -- --case map_03_mixed
  npm run benchmark:voice -- --headed --case flow_02_pause_midthought
`);
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function ensureFileExists(filePath) {
  await fs.access(filePath);
  return filePath;
}

async function loadManifest(manifestPath) {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cases)) {
    throw new Error(`Invalid benchmark manifest at ${manifestPath}`);
  }

  return parsed;
}

async function loadAnalysisModule(projectDir) {
  const analysisPath = path.resolve(projectDir, 'src/app/lib/voice-benchmark-analysis.ts');
  const source = await fs.readFile(analysisPath, 'utf8');
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ES2022,
    },
    fileName: analysisPath,
  });

  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText, 'utf8').toString('base64')}`);
}

async function resolveLatestCaptureFile(caseOutputDir) {
  const directCapture = path.join(caseOutputDir, 'capture.json');
  try {
    await ensureFileExists(directCapture);
    return directCapture;
  } catch {}

  let entries = [];
  try {
    entries = await fs.readdir(caseOutputDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const directory of directories) {
    const candidate = path.join(caseOutputDir, directory, 'capture.json');
    try {
      await ensureFileExists(candidate);
      return candidate;
    } catch {}
  }

  return null;
}

function renderSummary(summary) {
  const turnClose = summary.median_turn_close_ms === null ? 'n/a' : `${summary.median_turn_close_ms}ms`;
  const rawTurnClose =
    summary.median_raw_turn_close_ms === null ? 'n/a' : `${summary.median_raw_turn_close_ms}ms`;
  const falseEnds =
    summary.median_false_user_ended_count === null
      ? 'n/a'
      : `${summary.median_false_user_ended_count}`;

  return [
    `Completion rate: ${summary.completed_cases}/${summary.total_cases} (${summary.completion_rate})`,
    `Harness input detected: ${summary.harness_input_detected_cases}/${summary.total_cases}`,
    `Harness input missing: ${summary.harness_input_missing_cases}`,
    `Median join latency: ${summary.median_join_latency_ms ?? 'n/a'}ms`,
    `Median committed turn close: ${turnClose}`,
    `Median raw turn close: ${rawTurnClose}`,
    `Median false user ended: ${falseEnds}`,
    `Emotion family hit rate: ${summary.emotion_family_hit_rate ?? 'n/a'}`,
    `Tone band hit rate: ${summary.tone_band_hit_rate ?? 'n/a'}`,
  ].join('\n');
}

async function runCaptureCase({
  baseUrl,
  caseDefinition,
  caseOutputDir,
  headless,
  manifestPath,
  projectDir,
}) {
  const captureScript = path.resolve(projectDir, 'scripts/capture-live-session.mjs');
  const manifestDirectory = path.dirname(manifestPath);
  const fakeAudioFile = path.resolve(manifestDirectory, caseDefinition.audioFile);
  const profileSlug = timestampSlug();
  const profileDir = caseDefinition.profileDir
    ? path.resolve(projectDir, caseDefinition.profileDir)
    : path.join(caseOutputDir, '.browser-profile', profileSlug);
  const args = [
    captureScript,
    '--route',
    caseDefinition.route,
    '--automation',
    caseDefinition.automation,
    '--ritual',
    caseDefinition.ritual,
    '--fake-audio-file',
    fakeAudioFile,
    '--await-artifact-ms',
    String(caseDefinition.awaitArtifactMs),
    '--settle-ms',
    String(caseDefinition.settleMs),
    '--output-root',
    caseOutputDir,
    '--profile-dir',
    profileDir,
    '--emit-result-json',
  ];

  if (headless) {
    args.push('--headless');
  }

  const stdoutChunks = [];

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectDir,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk.toString());
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Capture exited with code ${code}`));
    });
  });

  const markerLine = stdoutChunks
    .join('')
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith('CAPTURE_RESULT '));

  if (markerLine) {
    const parsed = JSON.parse(markerLine.slice('CAPTURE_RESULT '.length));
    if (parsed && typeof parsed.outputPath === 'string') {
      return parsed.outputPath;
    }
  }

  return resolveLatestCaptureFile(caseOutputDir);
}

function mergeCaseWithDefaults(defaults, caseDefinition) {
  return {
    ...defaults,
    ...caseDefinition,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const projectDir = process.cwd();
  const manifestPath = path.resolve(projectDir, args.manifest);
  const manifest = await loadManifest(manifestPath);
  const selectedCases = manifest.cases
    .map((caseDefinition) => mergeCaseWithDefaults(manifest.defaults ?? {}, caseDefinition))
    .filter((caseDefinition) => args.caseIds.length === 0 || args.caseIds.includes(caseDefinition.id));

  if (args.list) {
    for (const caseDefinition of selectedCases) {
      console.log(`${caseDefinition.id}: ${caseDefinition.label}`);
    }
    return;
  }

  if (selectedCases.length === 0) {
    throw new Error('No benchmark cases selected.');
  }

  const analysisModule = await loadAnalysisModule(projectDir);
  const reports = [];

  for (const caseDefinition of selectedCases) {
    const caseOutputDir = path.resolve(projectDir, args.outputRoot, caseDefinition.id);
    const captureFile = args.analyzeOnly
      ? await resolveLatestCaptureFile(caseOutputDir)
      : await runCaptureCase({
          baseUrl: args.baseUrl,
          caseDefinition,
          caseOutputDir,
          headless: args.headless,
          manifestPath,
          projectDir,
        });

    if (!captureFile) {
      throw new Error(`No capture.json found for ${caseDefinition.id} under ${caseOutputDir}`);
    }

    const capture = JSON.parse(await fs.readFile(captureFile, 'utf8'));
    const report = analysisModule.analyzeVoiceBenchmarkCapture({
      capture,
      capturePath: captureFile,
      definition: caseDefinition,
    });

    reports.push(report);
  }

  const summary = analysisModule.summarizeVoiceBenchmarkReports({
    manifest,
    reports,
  });
  const reportDir = path.resolve(projectDir, args.reportsRoot, timestampSlug());
  await fs.mkdir(reportDir, { recursive: true });

  const reportPath = path.join(reportDir, 'benchmark-report.json');
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        analyzeOnly: args.analyzeOnly,
        manifestPath,
        summary,
        reports,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`Benchmark report written to ${reportPath}`);
  console.log(renderSummary(summary));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});