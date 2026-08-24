import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.resolve(packageRoot, "fixtures/audio");
const sources = JSON.parse(await readFile(path.resolve(packageRoot, "fixtures/sources.json"), "utf8"));
const PINNED_MACOS_BUILD = "25F71";
const PINNED_VOICE = "Samantha";
const PINNED_RATE = "155";

function parsePcm16MonoWav(bytes) {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("not wav");
  let offset = 12; let sampleRate = 0; let samples = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); const start = offset + 8;
    if (id === "fmt ") {
      if (bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt16LE(start + 14) !== 16) throw new Error("expected mono pcm16");
      sampleRate = bytes.readUInt32LE(start + 4);
    }
    if (id === "data") samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + start + size));
    offset = start + size + (size % 2);
  }
  if (!sampleRate || !samples) throw new Error("invalid wav");
  return { sampleRate, samples };
}

function wav(sampleRate, samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) bytes.writeInt16LE(samples[index], 44 + index * 2);
  return bytes;
}

function seededNoise(index) {
  let value = (index + 1) * 0x9e3779b1;
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b); value ^= value >>> 13;
  return ((value >>> 0) / 0xffffffff) * 2 - 1;
}

async function synthesizePinned(text, name, scratch) {
  const aiff = path.join(scratch, `${name}.aiff`); const output = path.join(scratch, `${name}.wav`);
  await execute("/usr/bin/say", ["-v", PINNED_VOICE, "-r", PINNED_RATE, "-o", aiff, text], { timeout: 30_000, maxBuffer: 64_000 });
  await execute("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, output], { timeout: 30_000, maxBuffer: 64_000 });
  return parsePcm16MonoWav(await readFile(output));
}

if (process.platform !== "darwin") throw new Error("Fixture regeneration is allowed only on the pinned macOS speech generator image; committed WAVs are runtime inputs.");
const { stdout: build } = await execute("/usr/bin/sw_vers", ["-buildVersion"], { timeout: 2_000 });
if (build.trim() !== PINNED_MACOS_BUILD) throw new Error(`Pinned generator build ${PINNED_MACOS_BUILD} required; observed ${build.trim()}.`);

await mkdir(outputRoot, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), "sophia-vt00-a02-"));
try {
  const shortSource = await synthesizePinned(sources.sources.short_command.text, "short", scratch);
  const longSource = await synthesizePinned(sources.sources.long_brief.text, "long", scratch);
  const silence = new Int16Array(16_000 * 2);
  const trailing = new Int16Array(shortSource.samples.length + Math.round(shortSource.sampleRate * 1.5)); trailing.set(shortSource.samples);
  const noisy = Int16Array.from(shortSource.samples, (sample, index) => Math.max(-32768, Math.min(32767, Math.round(sample + seededNoise(index) * 1_600))));
  const outputs = [
    ["a02_short_command.wav", wav(shortSource.sampleRate, shortSource.samples)],
    ["a02_long_brief.wav", wav(longSource.sampleRate, longSource.samples)],
    ["a02_silence.wav", wav(16_000, silence)],
    ["a02_trailing_pause.wav", wav(shortSource.sampleRate, trailing)],
    ["a02_noisy_command.wav", wav(shortSource.sampleRate, noisy)],
  ];
  for (const [name, bytes] of outputs) {
    await writeFile(path.join(outputRoot, name), bytes, { mode: 0o644 });
    const parsed = parsePcm16MonoWav(bytes);
    process.stdout.write(`${name} ${createHash("sha256").update(bytes).digest("hex")} ${parsed.sampleRate} ${Math.round(parsed.samples.length / parsed.sampleRate * 1000)} ${bytes.length}\n`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
