import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { VoiceLabConfig } from "./config.js";
import { VoiceLabError, labError } from "./domain.js";
import { sha256 } from "./security.js";
import type { FixtureSummary } from "./service.js";

const ManifestSchema = z.object({
  version: z.literal(1),
  fixtures: z.array(z.object({
    id: z.string().min(1),
    fixture_version: z.string().regex(/^\d+\.\d+\.\d+$/),
    family: z.string().min(1).max(64),
    fixture_class: z.enum(["short_command", "long_brief", "silence", "trailing_pause", "noisy_command"]),
    file: z.string().regex(/^[A-Za-z0-9._-]+\.wav$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sample_rate: z.number().int().positive(),
    channels: z.number().int().min(1).max(2),
    duration_ms: z.number().int().positive(),
    source_text: z.union([
      z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
      z.object({ status: z.literal("available"), sha256: z.string().regex(/^[a-f0-9]{64}$/), governed_source_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/), expected_tokens: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(64), expected_slots: z.record(z.string(), z.unknown()) }).strict(),
    ]),
    synthesis: z.object({ engine: z.string().min(1), engine_version: z.string().min(1), voice: z.string().min(1), rate: z.string().min(1) }).strict(),
    provenance: z.object({ kind: z.string().min(1), suite: z.string().min(1), manifest_version: z.number().int().positive() }).strict(),
    assertion_policy: z.object({ expect_transcript: z.boolean(), semantic_threshold: z.string().min(1), trailing_silence_ms: z.number().int().nonnegative().optional(), noise_seed: z.string().optional() }).strict(),
  }).strict()),
}).strict();

interface FixtureEntry extends FixtureSummary { file: string; }
export interface ResolvedAudio {
  id: string;
  sha256: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  bytes: Buffer;
  source: "fixture" | "tts";
  fixture?: FixtureSummary;
  sourceTextHash?: string;
  synthesis: { engine: string; engine_version: string; voice: string; rate: string; speed?: number; format?: string };
}

export interface TtsEngineInfo {
  engine: "espeak-ng";
  expectedVersion: string;
  observedVersion: string | null;
  voice: "en-us";
  rate: "155-wpm";
  available: boolean;
  status: "verified" | "unavailable" | "version_mismatch";
}
export interface FixtureStartupReadiness {
  schema: "sophia_voice_lab_fixture_startup_v1";
  status: "unavailable" | "verified";
  expected_manifest_sha256: string;
  observed_manifest_sha256: string | null;
  manifest_version: number | null;
  fixture_count: number;
  immutable_files_verified: boolean;
  raw_audio_public_surface: false;
}

let sharedEspeakProbe: Promise<string | null> | null = null;

export class AudioResolver {
  readonly #entries = new Map<string, FixtureEntry>();
  readonly #cache = new Map<string, ResolvedAudio>();
  readonly config: VoiceLabConfig;
  readonly synthesize: (text: string, signal?: AbortSignal) => Promise<Buffer>;
  readonly versionProbe: () => Promise<string | null>;
  #ttsInfo: TtsEngineInfo;
  #fixtureReadiness: FixtureStartupReadiness;

  constructor(config: VoiceLabConfig, synthesize?: (text: string, signal?: AbortSignal) => Promise<Buffer>, versionProbe?: () => Promise<string | null>) {
    this.config = config;
    this.synthesize = synthesize ?? ((text, signal) => synthesizeEspeak(text, config.ttsTimeoutMs, config.maxAudioBytes, signal));
    this.versionProbe = versionProbe ?? (() => {
      sharedEspeakProbe ??= probeEspeakVersion(Math.min(3_000, config.ttsTimeoutMs));
      return sharedEspeakProbe;
    });
    this.#ttsInfo = { engine: "espeak-ng", expectedVersion: config.ttsExpectedVersion, observedVersion: null, voice: "en-us", rate: "155-wpm", available: false, status: "unavailable" };
    this.#fixtureReadiness = { schema: "sophia_voice_lab_fixture_startup_v1", status: "unavailable", expected_manifest_sha256: config.fixtureManifestSha256, observed_manifest_sha256: null, manifest_version: null, fixture_count: 0, immutable_files_verified: false, raw_audio_public_surface: false };
  }

  async initialize(): Promise<void> {
    const manifestPath = path.resolve(this.config.fixtureManifestPath);
    const fixtureRoot = path.resolve(this.config.fixtureRoot);
    const [manifestStat, rootStat, manifestRealPath, fixtureRealRoot] = await Promise.all([lstat(manifestPath), lstat(fixtureRoot), realpath(manifestPath), realpath(fixtureRoot)]);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || rootStat.isSymbolicLink() || !rootStat.isDirectory() || manifestRealPath !== manifestPath || fixtureRealRoot !== fixtureRoot) {
      throw new VoiceLabError(labError("FIXTURE_PATH_INVALID", "Fixture manifest/root must be direct immutable bundled files, not symlinks or redirected paths.", "authorization"));
    }
    const rawBytes = await readFile(manifestPath);
    const observedManifestSha256 = sha256(rawBytes);
    if (observedManifestSha256 !== this.config.fixtureManifestSha256) throw new VoiceLabError(labError("FIXTURE_MANIFEST_INTEGRITY_FAILED", "Fixture manifest bytes do not match the compiled release digest.", "validation", false, { expected_sha256: this.config.fixtureManifestSha256, observed_sha256: observedManifestSha256 }));
    const raw = rawBytes.toString("utf8");
    const manifest = ManifestSchema.parse(JSON.parse(raw));
    const verifiedEntries = new Map<string, FixtureEntry>();
    const verifiedCache = new Map<string, ResolvedAudio>();
    for (const fixture of manifest.fixtures) {
      if (verifiedEntries.has(fixture.id)) throw new VoiceLabError(labError("FIXTURE_DUPLICATE", `Duplicate fixture ${fixture.id}.`, "validation"));
      if (fixture.duration_ms > this.config.maxAudioDurationMs) throw new VoiceLabError(labError("AUDIO_DURATION_LIMIT", `Fixture ${fixture.id} exceeds the immutable startup duration limit.`, "validation"));
      const entry: FixtureEntry = { id: fixture.id, fixtureVersion: fixture.fixture_version, family: fixture.family, fixtureClass: fixture.fixture_class, file: fixture.file, sha256: fixture.sha256, sampleRate: fixture.sample_rate, channels: fixture.channels, durationMs: fixture.duration_ms, sourceText: fixture.source_text, synthesis: fixture.synthesis, provenance: { kind: fixture.provenance.kind, suite: fixture.provenance.suite, manifestVersion: fixture.provenance.manifest_version }, assertionPolicy: { expect_transcript: fixture.assertion_policy.expect_transcript, semantic_threshold: fixture.assertion_policy.semantic_threshold, ...(fixture.assertion_policy.trailing_silence_ms === undefined ? {} : { trailing_silence_ms: fixture.assertion_policy.trailing_silence_ms }), ...(fixture.assertion_policy.noise_seed === undefined ? {} : { noise_seed: fixture.assertion_policy.noise_seed }) } };
      const filePath = path.resolve(fixtureRoot, entry.file);
      if (path.dirname(filePath) !== fixtureRoot) throw new VoiceLabError(labError("FIXTURE_PATH_INVALID", "Fixture escaped its configured root.", "authorization"));
      const [fileStat, fileRealPath] = await Promise.all([lstat(filePath), realpath(filePath)]);
      if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileRealPath !== filePath || path.dirname(fileRealPath) !== fixtureRealRoot) throw new VoiceLabError(labError("FIXTURE_PATH_INVALID", "Fixture audio must be a direct immutable file inside the bundled fixture root.", "authorization"));
      const bytes = await readFile(filePath);
      assertAudioByteLimit(bytes.byteLength, this.config.maxAudioBytes);
      if (sha256(bytes) !== entry.sha256) throw new VoiceLabError(labError("FIXTURE_INTEGRITY_FAILED", `Fixture ${entry.id} failed immutable startup integrity validation.`, "validation"));
      const metadata = parseWav(bytes);
      if (metadata.durationMs > this.config.maxAudioDurationMs) throw new VoiceLabError(labError("AUDIO_DURATION_LIMIT", `Fixture ${entry.id} exceeds the immutable startup duration limit.`, "validation"));
      if (metadata.sampleRate !== entry.sampleRate || metadata.channels !== entry.channels || Math.abs(metadata.durationMs - entry.durationMs) > 1) throw new VoiceLabError(labError("FIXTURE_METADATA_MISMATCH", `Fixture ${entry.id} metadata does not match its manifest.`, "validation"));
      verifiedEntries.set(entry.id, entry);
      const { file: _file, ...summary } = entry;
      verifiedCache.set(`fixture:${entry.id}`, { id: entry.id, sha256: entry.sha256, sampleRate: entry.sampleRate, channels: entry.channels, durationMs: entry.durationMs, bytes, source: "fixture", fixture: summary, synthesis: entry.synthesis });
    }
    this.#entries.clear();
    this.#cache.clear();
    for (const [id, entry] of verifiedEntries) this.#entries.set(id, entry);
    for (const [id, audio] of verifiedCache) this.#cache.set(id, audio);
    this.#fixtureReadiness = { schema: "sophia_voice_lab_fixture_startup_v1", status: "verified", expected_manifest_sha256: this.config.fixtureManifestSha256, observed_manifest_sha256: observedManifestSha256, manifest_version: manifest.version, fixture_count: manifest.fixtures.length, immutable_files_verified: true, raw_audio_public_surface: false };
    const observedVersion = await this.versionProbe().catch(() => null);
    const status = observedVersion === null ? "unavailable" : observedVersion === this.config.ttsExpectedVersion ? "verified" : "version_mismatch";
    this.#ttsInfo = { engine: "espeak-ng", expectedVersion: this.config.ttsExpectedVersion, observedVersion, voice: "en-us", rate: "155-wpm", available: status === "verified", status };
    if (this.config.nodeEnv !== "test" && status !== "verified") throw new VoiceLabError(labError("TTS_VERSION_UNVERIFIED", "The pinned espeak-ng engine is missing or does not match the configured deployment version.", "harness", true, { expected_version: this.config.ttsExpectedVersion, observed_version: observedVersion }));
  }

  summaries(): FixtureSummary[] {
    return [...this.#entries.values()].map(({ file: _file, ...summary }) => summary);
  }

  ttsInfo(): TtsEngineInfo { return { ...this.#ttsInfo }; }
  fixtureReadiness(): FixtureStartupReadiness { return { ...this.#fixtureReadiness }; }
  readiness(): { ok: boolean; detail: Record<string, unknown> } { return { ok: this.#ttsInfo.available && this.#fixtureReadiness.status === "verified", detail: { engine: this.#ttsInfo.engine, status: this.#ttsInfo.status, expected_version: this.#ttsInfo.expectedVersion, observed_version: this.#ttsInfo.observedVersion, voice: this.#ttsInfo.voice, rate: this.#ttsInfo.rate, fixture_manifest: this.fixtureReadiness() } }; }

  async resolve(input: { fixture_id?: string; text?: string }, signal?: AbortSignal): Promise<ResolvedAudio> {
    if (input.fixture_id !== undefined) return this.#resolveFixture(input.fixture_id, signal);
    if (input.text === undefined) throw new VoiceLabError(labError("AUDIO_INPUT_REQUIRED", "Text or fixture ID is required.", "validation"));
    if (!this.#ttsInfo.available || this.#ttsInfo.observedVersion === null) throw new VoiceLabError(labError("TTS_VERSION_UNVERIFIED", "Adaptive TTS is disabled because the deployed engine version was not verified at startup.", "harness", true, { status: this.#ttsInfo.status }));
    const cacheKey = `tts:${sha256(input.text)}`;
    const bytes = await this.synthesize(input.text, signal);
    assertAudioByteLimit(bytes.byteLength, this.config.maxAudioBytes);
    const metadata = parseWav(bytes);
    if (metadata.durationMs > this.config.maxAudioDurationMs) throw new VoiceLabError(labError("AUDIO_DURATION_LIMIT", "Synthesized audio exceeds the per-utterance duration limit.", "validation"));
    const resolved: ResolvedAudio = { id: cacheKey, bytes, source: "tts", sourceTextHash: sha256(input.text), synthesis: { engine: "espeak-ng", engine_version: this.#ttsInfo.observedVersion, voice: "en-us", rate: "155-wpm", speed: 155, format: "pcm16-wav" }, sha256: sha256(bytes), ...metadata };
    return cloneAudio(resolved);
  }

  async #resolveFixture(id: string, signal?: AbortSignal): Promise<ResolvedAudio> {
    const cached = this.#cache.get(`fixture:${id}`);
    if (cached) return cloneAudio(cached);
    const entry = this.#entries.get(id);
    if (!entry) throw new VoiceLabError(labError("FIXTURE_NOT_FOUND", `Fixture ${id} is not allowlisted.`, "validation"));
    const filePath = path.resolve(this.config.fixtureRoot, entry.file);
    if (path.dirname(filePath) !== path.resolve(this.config.fixtureRoot)) throw new VoiceLabError(labError("FIXTURE_PATH_INVALID", "Fixture escaped its configured root.", "authorization"));
    const bytes = await readFile(filePath, { signal });
    assertAudioByteLimit(bytes.byteLength, this.config.maxAudioBytes);
    if (sha256(bytes) !== entry.sha256) throw new VoiceLabError(labError("FIXTURE_INTEGRITY_FAILED", `Fixture ${id} failed immutable integrity validation.`, "validation"));
    const metadata = parseWav(bytes);
    if (metadata.sampleRate !== entry.sampleRate || metadata.channels !== entry.channels || Math.abs(metadata.durationMs - entry.durationMs) > 1) throw new VoiceLabError(labError("FIXTURE_METADATA_MISMATCH", `Fixture ${id} metadata does not match its manifest.`, "validation"));
    const { file: _file, ...summary } = entry;
    const resolved: ResolvedAudio = { id: entry.id, sha256: entry.sha256, sampleRate: entry.sampleRate, channels: entry.channels, durationMs: entry.durationMs, bytes, source: "fixture", fixture: summary, synthesis: entry.synthesis };
    this.#cache.set(`fixture:${id}`, resolved);
    return cloneAudio(resolved);
  }
}

function cloneAudio(audio: ResolvedAudio): ResolvedAudio { return { ...audio, bytes: Buffer.from(audio.bytes) }; }

export function parseWav(bytes: Buffer): { sampleRate: number; channels: number; durationMs: number } {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new VoiceLabError(labError("AUDIO_FORMAT_UNSUPPORTED", "Only RIFF/WAVE audio is accepted.", "validation"));
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new VoiceLabError(labError("AUDIO_FORMAT_INVALID", "WAVE chunk exceeds the input bounds.", "validation"));
    if (id === "fmt " && size >= 16) {
      if (bytes.readUInt16LE(start) !== 1) throw new VoiceLabError(labError("AUDIO_FORMAT_UNSUPPORTED", "Only PCM WAVE fixtures are accepted.", "validation"));
      channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      byteRate = bytes.readUInt32LE(start + 8);
      if (bytes.readUInt16LE(start + 14) !== 16) throw new VoiceLabError(labError("AUDIO_FORMAT_UNSUPPORTED", "Only PCM16 WAVE fixtures are accepted.", "validation"));
    } else if (id === "data") dataBytes += size;
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !byteRate || !dataBytes || channels < 1 || channels > 2) throw new VoiceLabError(labError("AUDIO_FORMAT_INVALID", "WAVE audio lacks valid PCM metadata.", "validation"));
  return { sampleRate, channels, durationMs: Math.round((dataBytes / byteRate) * 1_000) };
}

export function assertAudioByteLimit(byteLength: number, maxBytes: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxBytes) throw new VoiceLabError(labError("AUDIO_TOO_LARGE", "Audio exceeds the configured immutable byte limit.", "validation"));
}

export function synthesizeEspeak(text: string, timeoutMs = 10_000, maxBytes = 8_000_000, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("espeak-ng", ["--stdout", "--stdin", "-v", "en-us", "-s", "155"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timer: NodeJS.Timeout;
    const finish = (error: VoiceLabError | null, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      error ? reject(error) : resolve(bytes ?? Buffer.alloc(0));
    };
    const terminate = () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      if (killTimer) clearTimeout(killTimer);
      // Do not clear this escalation when the Promise rejects. A child that
      // ignores SIGTERM must still be reaped after the caller has observed the
      // bounded cancellation/timeout result.
      killTimer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 500);
      killTimer.unref();
    };
    const onAbort = () => {
      terminate();
      finish(new VoiceLabError(labError("OPERATION_CANCELLED", "Audio synthesis was cancelled before completion.", "harness", true)));
    };
    timer = setTimeout(() => {
      terminate();
      finish(new VoiceLabError(labError("TTS_TIMEOUT", "Local espeak-ng synthesis exceeded its bounded timeout.", "harness", true)));
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        terminate();
        finish(new VoiceLabError(labError("AUDIO_TOO_LARGE", "Synthesized audio exceeded its bounded output size.", "validation")));
        return;
      }
      stdout.push(chunk);
    });
    // Drain stderr but never persist or return it because engines may echo input.
    child.stderr.resume();
    child.on("error", () => finish(new VoiceLabError(labError("TTS_UNAVAILABLE", "Local espeak-ng could not be started.", "harness", true))));
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) { finish(new VoiceLabError(labError("TTS_FAILED", `Local espeak-ng failed with exit code ${code}.`, "harness", true))); return; }
      const bytes = Buffer.concat(stdout);
      try { parseWav(bytes); }
      catch { finish(new VoiceLabError(labError("TTS_OUTPUT_INVALID", "Local espeak-ng returned empty or invalid WAV output.", "harness", true))); return; }
      finish(null, bytes);
    });
    if (signal?.aborted) { onAbort(); child.stdin.destroy(); }
    else { signal?.addEventListener("abort", onAbort, { once: true }); child.stdin.end(text); }
  });
}

export function probeEspeakVersion(timeoutMs = 3_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("espeak-ng", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (value: string | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); finish(null); }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes <= 4_096) chunks.push(chunk); });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      if (code !== 0 || bytes > 4_096) { finish(null); return; }
      const match = Buffer.concat(chunks).toString("utf8").match(/(?:text-to-speech:\s*)?(\d+\.\d+(?:\.\d+)?)/i);
      finish(match?.[1] ?? null);
    });
  });
}
