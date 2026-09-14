import { expect, it } from "vitest";
import { finalizeEspeakStdout, parseWav } from "../src/audio.js";

function stream() {
  // Exact OpenWavFile header from upstream espeak-ng tag 1.51,
  // src/espeak-ng.c; stdout deliberately retains the two placeholder lengths.
  const header = Buffer.from("5249464624f0ff7f57415645666d742010000000010001002256000044ac0000020010006461746100f0ff7f", "hex");
  return Buffer.concat([header, Buffer.alloc(44100, 1)]);
}
it("finalizes successful espeak stdout without changing its PCM samples", () => {
  const input = stream();
  expect(() => parseWav(input)).toThrow();
  const output = finalizeEspeakStdout(input);
  expect(parseWav(output)).toEqual({ sampleRate: 22050, channels: 1, durationMs: 1000 });
  expect(output.subarray(44)).toEqual(input.subarray(44));
  expect(input.readUInt32LE(40)).toBe(0x7ffff000);
  expect(output.readUInt32LE(4)).toBe(output.length - 8);
  expect(output.readUInt32LE(40)).toBe(output.length - 44);
  expect(finalizeEspeakStdout(output)).toEqual(output);
});
it.each(["empty", "odd", "other-size", "stereo", "byte-rate", "other-format"])("rejects unsupported %s output", kind => {
  let input = stream();
  if (kind === "empty") input = input.subarray(0, 44);
  if (kind === "odd") input = input.subarray(0, input.length - 1);
  if (kind === "other-size") input.writeUInt32LE(0x7ffff001, 40);
  if (kind === "stereo") input.writeUInt16LE(2, 22);
  if (kind === "byte-rate") input.writeUInt32LE(123, 28);
  if (kind === "other-format") input.writeUInt16LE(3, 20);
  expect(() => finalizeEspeakStdout(input)).toThrow();
});
