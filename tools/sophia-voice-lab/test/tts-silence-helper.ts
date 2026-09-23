/** Deterministic espeak-ng-shaped PCM16 mono 22050 Hz WAV: voiced syllables
 * (with short intra-speech gaps) followed by `tailMs` of exact zero PCM. */
export function espeakLikeWav(speechMs: number, tailMs: number, sampleRate = 22_050): Buffer {
  const speech = Math.round(sampleRate * speechMs / 1_000);
  const samples = speech + Math.round(sampleRate * tailMs / 1_000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < speech; index += 1) {
    const t = index / sampleRate;
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t));
    const voiced = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 720 * t) + 0.25 * Math.sin(2 * Math.PI * 1_900 * t);
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, 0.35 * syllable * voiced + 0.02 * Math.sin(2 * Math.PI * 97 * t))) * 32_767), 44 + index * 2);
  }
  return bytes;
}

/** Count of exact-zero PCM16 mono samples at the end of a canonical WAV. */
export function trailingZeroSamples(wav: Buffer): number {
  let count = 0;
  for (let offset = wav.length - 2; offset >= 44 && wav.readInt16LE(offset) === 0; offset -= 2) count += 1;
  return count;
}
