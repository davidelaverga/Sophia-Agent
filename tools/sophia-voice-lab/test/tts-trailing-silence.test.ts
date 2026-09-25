import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AudioResolver, parseWav } from "../src/audio.js";
import { sha256 } from "../src/security.js";
import { reserveAudioInput } from "../src/service.js";
import { testConfig } from "./helpers.js";
import { espeakLikeWav, trailingZeroSamples } from "./tts-silence-helper.js";

// C034 contract, deliberately a literal here rather than the source constant:
// every synthesized utterance ends with exactly this much zero PCM.
const TAIL_MS = 1_500;
const fixtureRoot = path.resolve(process.cwd(), "fixtures");

function resolverFor(wav: Buffer, env: Record<string, string> = {}) {
  return new AudioResolver(testConfig({ SOPHIA_VOICE_LAB_ESPEAK_VERSION: "9.9", ...env }), async () => wav, async () => "9.9");
}
const dataOf = (wav: Buffer) => wav.subarray(44);

describe("synthesized utterances carry a fixed post-speech silence tail", () => {
  it("appends exactly 1500 ms of zero PCM after the unchanged speech in a canonical PCM16 header", async () => {
    // espeak-ng shape observed live: speech, then only ~186 ms of zero PCM.
    const source = espeakLikeWav(3_000, 186);
    const resolver = resolverFor(source);
    await resolver.initialize();
    const resolved = await resolver.resolve({ text: "governed synthetic text" });
    const tailBytes = Math.round(22_050 * TAIL_MS / 1_000) * 2;
    expect(resolved.bytes.length).toBe(source.length + tailBytes);
    expect(resolved.bytes.readUInt32LE(4)).toBe(resolved.bytes.length - 8);
    expect(resolved.bytes.readUInt32LE(40)).toBe(resolved.bytes.length - 44);
    expect(parseWav(resolved.bytes)).toEqual({ sampleRate: 22_050, channels: 1, durationMs: parseWav(source).durationMs + TAIL_MS });
    expect(resolved.durationMs).toBe(parseWav(source).durationMs + TAIL_MS);
    expect(dataOf(resolved.bytes).subarray(0, dataOf(source).length).equals(dataOf(source))).toBe(true);
    expect(trailingZeroSamples(resolved.bytes)).toBeGreaterThanOrEqual(Math.round(22_050 * TAIL_MS / 1_000));
    expect(resolved.sha256).toBe(sha256(resolved.bytes));
    expect(resolved.synthesis).toMatchObject({ engine: "espeak-ng", format: "pcm16-wav", trailing_silence_ms: TAIL_MS });
  });

  it("reserves the tail on top of the longest synthesis the pre-tail fence admitted", async () => {
    const config = testConfig();
    for (const text of ["hi", "one two three four five six seven eight nine ten eleven twelve", "word ".repeat(40).trim()]) {
      const words = text.split(/\s+/u).length;
      const preTailMaximum = Math.max(500, Math.ceil(words / 155 * 60_000) + 1_000);
      const reservation = await reserveAudioInput({ text }, [], config);
      expect(reservation.duration_ms).toBe(Math.min(config.maxAudioDurationMs, preTailMaximum + TAIL_MS));
      const resolver = resolverFor(espeakLikeWav(preTailMaximum - 186, 186));
      await resolver.initialize();
      const resolved = await resolver.resolve({ text });
      expect(resolved.durationMs).toBeLessThanOrEqual(reservation.duration_ms);
      expect(resolved.bytes.byteLength).toBeLessThanOrEqual(reservation.bytes);
    }
  });

  it("keeps the existing duration and byte caps binding on the padded total", async () => {
    // Caps sit above the largest pinned fixture (10343 ms, ~331 KB), which
    // startup verifies against the same limits.
    const overDuration = resolverFor(espeakLikeWav(10_400, 186), { SOPHIA_VOICE_LAB_MAX_AUDIO_DURATION_MS: "12000" });
    await overDuration.initialize();
    await expect(overDuration.resolve({ text: "near the duration cap" })).rejects.toMatchObject({ detail: { code: "AUDIO_DURATION_LIMIT" } });
    const capped = await reserveAudioInput({ text: "word ".repeat(40).trim() }, [], testConfig({ SOPHIA_VOICE_LAB_MAX_AUDIO_DURATION_MS: "12000" }));
    expect(capped.duration_ms).toBe(12_000);
    const overBytes = resolverFor(espeakLikeWav(8_200, 186), { SOPHIA_VOICE_LAB_MAX_AUDIO_BYTES: "400000" });
    await overBytes.initialize();
    await expect(overBytes.resolve({ text: "near the byte cap" })).rejects.toMatchObject({ detail: { code: "AUDIO_TOO_LARGE" } });
  });

  it("never pads or relabels an immutable pinned fixture", async () => {
    const resolver = resolverFor(espeakLikeWav(1_000, 186));
    await resolver.initialize();
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8")) as { fixtures: Array<{ id: string; file: string; sha256: string; duration_ms: number }> };
    for (const fixture of manifest.fixtures) {
      const resolved = await resolver.resolve({ fixture_id: fixture.id });
      expect(resolved.bytes.equals(await readFile(path.join(fixtureRoot, "audio", fixture.file)))).toBe(true);
      expect(resolved.sha256).toBe(fixture.sha256);
      expect(resolved.durationMs).toBe(fixture.duration_ms);
      expect(resolved.synthesis).not.toHaveProperty("trailing_silence_ms");
    }
  });
});
