import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AudioResolver } from "../src/audio.js";
import { BUNDLED_FIXTURE_MANIFEST_SHA256, loadConfig } from "../src/config.js";
import { testConfig } from "./helpers.js";

const fixtureRoot = path.resolve(import.meta.dirname, "../fixtures");

describe("governed deterministic V-A02 fixtures", () => {
  it("contains only committed synthetic sources with exact text/audio hashes and pinned generator metadata", async () => {
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
    expect(createHash("sha256").update(await readFile(path.join(fixtureRoot, "manifest.json"))).digest("hex")).toBe(BUNDLED_FIXTURE_MANIFEST_SHA256);
    const sources = JSON.parse(await readFile(path.join(fixtureRoot, "sources.json"), "utf8"));
    expect(sources.generator).toMatchObject({ engine: "apple-speech-synthesis", engine_version: "macOS-26.5-build-25F71", voice: "Samantha-en_US", rate: "155-wpm" });
    expect(JSON.stringify(manifest)).not.toMatch(/inherited|human|source_unavailable/i);
    for (const fixture of manifest.fixtures) {
      const bytes = await readFile(path.join(fixtureRoot, "audio", fixture.file));
      expect(createHash("sha256").update(bytes).digest("hex"), fixture.id).toBe(fixture.sha256);
      expect(fixture.source_text.status).toBe("available");
      expect(fixture.provenance.kind).toMatch(/committed-(?:pinned-synthetic-tts|deterministic-generation)/);
      expect(fixture.synthesis.engine_version).toBeTruthy();
      if (fixture.source_text.governed_source_id === "silence") {
        expect(fixture.source_text.sha256).toBe(createHash("sha256").update("").digest("hex"));
      } else {
        const governed = sources.sources[fixture.source_text.governed_source_id];
        expect(governed).toBeTruthy();
        expect(createHash("sha256").update(governed.text).digest("hex")).toBe(fixture.source_text.sha256);
        expect(fixture.source_text.expected_tokens).toEqual(governed.expected_tokens);
        expect(fixture.source_text.expected_slots).toEqual(governed.expected_slots);
      }
    }
  });

  it("has all five explicit fixture classes with silence governed as no-turn input", async () => {
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
    expect(manifest.fixtures.map((fixture: any) => fixture.fixture_class).sort()).toEqual(["long_brief", "noisy_command", "short_command", "silence", "trailing_pause"]);
    expect(manifest.fixtures.find((fixture: any) => fixture.fixture_class === "silence").assertion_policy).toMatchObject({ expect_transcript: false, semantic_threshold: "no_fabricated_injected_or_product_turn" });
  });

  it("records the observed adaptive TTS engine version and fails closed on mismatch", async () => {
    const wav = await readFile(path.join(fixtureRoot, "audio", "a02_short_command.wav"));
    const verified = new AudioResolver(testConfig({ SOPHIA_VOICE_LAB_ESPEAK_VERSION: "9.9" }), async () => wav, async () => "9.9");
    await verified.initialize();
    expect(verified.ttsInfo()).toMatchObject({ observedVersion: "9.9", expectedVersion: "9.9", status: "verified", available: true });
    expect((await verified.resolve({ text: "governed synthetic text" })).synthesis.engine_version).toBe("9.9");

    const mismatch = new AudioResolver(testConfig({ SOPHIA_VOICE_LAB_ESPEAK_VERSION: "9.9" }), async () => wav, async () => "1.51");
    await mismatch.initialize();
    expect(mismatch.readiness()).toMatchObject({ ok: false, detail: { status: "version_mismatch", expected_version: "9.9", observed_version: "1.51" } });
    await expect(mismatch.resolve({ text: "must not synthesize" })).rejects.toMatchObject({ detail: { code: "TTS_VERSION_UNVERIFIED" } });

    const productionMismatch = new AudioResolver({ ...testConfig({ SOPHIA_VOICE_LAB_ESPEAK_VERSION: "9.9" }), nodeEnv: "production" }, async () => wav, async () => "1.51");
    await expect(productionMismatch.initialize()).rejects.toMatchObject({ detail: { code: "TTS_VERSION_UNVERIFIED" } });
  });

  it("fails startup before any TTS or run allocation for malformed, oversized, or over-duration immutable fixtures", async () => {
    const committed = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
    const fixture = committed.fixtures.find((candidate: any) => candidate.id === "a02_short_command");
    const validBytes = await readFile(path.join(fixtureRoot, "audio", fixture.file));
    const cases = [
      { id: "malformed", bytes: Buffer.from("not-a-wave"), maxBytes: 8_000_000, maxDuration: 30_000, expected: "AUDIO_FORMAT_UNSUPPORTED" },
      { id: "oversized", bytes: validBytes, maxBytes: 64_000, maxDuration: 30_000, expected: "AUDIO_TOO_LARGE" },
      { id: "over-duration", bytes: validBytes, maxBytes: 8_000_000, maxDuration: 1_000, expected: "AUDIO_DURATION_LIMIT" },
    ] as const;
    for (const candidate of cases) {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "voice-lab-fixture-startup-")));
      try {
        const audioRoot = path.join(root, "audio");
        await mkdir(audioRoot);
        const row = { ...fixture, sha256: createHash("sha256").update(candidate.bytes).digest("hex") };
        await writeFile(path.join(audioRoot, fixture.file), candidate.bytes);
        const manifestPath = path.join(root, "manifest.json");
        const manifestBytes = Buffer.from(JSON.stringify({ version: 1, fixtures: [row] }));
        await writeFile(manifestPath, manifestBytes);
        let synthesisCalls = 0;
        const resolver = new AudioResolver({ ...testConfig(), fixtureManifestPath: manifestPath, fixtureRoot: audioRoot, fixtureManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), maxAudioBytes: candidate.maxBytes, maxAudioDurationMs: candidate.maxDuration }, async () => { synthesisCalls += 1; return validBytes; }, async () => "1.52.0");
        await expect(resolver.initialize(), candidate.id).rejects.toMatchObject({ detail: { code: candidate.expected } });
        expect(synthesisCalls, candidate.id).toBe(0);
        expect(resolver.fixtureReadiness(), candidate.id).toMatchObject({ status: "unavailable", immutable_files_verified: false, raw_audio_public_surface: false });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects a coherent same-version manifest/audio substitution against the compiled release pin", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "voice-lab-fixture-substitute-")));
    try {
      const audioRoot = path.join(root, "audio");
      await mkdir(audioRoot);
      const committed = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
      const fixture = structuredClone(committed.fixtures[0]);
      const bytes = await readFile(path.join(fixtureRoot, "audio", fixture.file));
      fixture.family = `${fixture.family}-substitute`;
      fixture.sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(path.join(audioRoot, fixture.file), bytes);
      const manifestPath = path.join(root, "manifest.json");
      await writeFile(manifestPath, JSON.stringify({ version: 1, fixtures: [fixture] }));
      const resolver = new AudioResolver({ ...testConfig(), fixtureManifestPath: manifestPath, fixtureRoot: audioRoot, fixtureManifestSha256: BUNDLED_FIXTURE_MANIFEST_SHA256 }, async () => bytes, async () => "1.51");
      await expect(resolver.initialize()).rejects.toMatchObject({ detail: { code: "FIXTURE_MANIFEST_INTEGRITY_FAILED" } });
      expect(resolver.fixtureReadiness()).toMatchObject({ status: "unavailable", expected_manifest_sha256: BUNDLED_FIXTURE_MANIFEST_SHA256, observed_manifest_sha256: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects fixture symlinks even when the test manifest digest is exact", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "voice-lab-fixture-symlink-")));
    try {
      const audioRoot = path.join(root, "audio");
      await mkdir(audioRoot);
      const committed = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
      const fixture = committed.fixtures[0];
      const sourcePath = path.join(fixtureRoot, "audio", fixture.file);
      await symlink(sourcePath, path.join(audioRoot, fixture.file));
      const manifestBytes = Buffer.from(JSON.stringify({ version: 1, fixtures: [fixture] }));
      const manifestPath = path.join(root, "manifest.json");
      await writeFile(manifestPath, manifestBytes);
      const resolver = new AudioResolver({ ...testConfig(), fixtureManifestPath: manifestPath, fixtureRoot: audioRoot, fixtureManifestSha256: createHash("sha256").update(manifestBytes).digest("hex") }, undefined, async () => "1.51");
      await expect(resolver.initialize()).rejects.toMatchObject({ detail: { code: "FIXTURE_PATH_INVALID" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects production fixture path and digest overrides", () => {
    const production = { ...process.env, NODE_ENV: "production", RENDER_GIT_COMMIT: "a".repeat(40), SOPHIA_VOICE_LAB_REPOSITORY_CANDIDATE_SHA: "a".repeat(40), SOPHIA_VOICE_LAB_FIXTURE_MANIFEST: "/tmp/substitute.json" };
    expect(() => loadConfig(production)).toThrowError(/fixture manifest\/root paths are immutable/i);
    const digest = { ...production, SOPHIA_VOICE_LAB_FIXTURE_MANIFEST: undefined, SOPHIA_VOICE_LAB_FIXTURE_MANIFEST_SHA256: "e".repeat(64) };
    expect(() => loadConfig(digest)).toThrowError(/conflicts with the compiled release pin/i);
  });
});
