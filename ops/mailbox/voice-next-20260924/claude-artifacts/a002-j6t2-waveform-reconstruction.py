"""Deterministically rebuild the J6 turn-2 Lab WAV and map its pauses.

Usage:
  printf '%s' "Let's just discuss calm. Please suggest one small way to feel calm." \
    | espeak-ng --stdout --stdin -v en-us -s 155 > raw.wav
  python3 a002-j6t2-waveform-reconstruction.py raw.wav

Mirrors tools/sophia-voice-lab/src/audio.ts finalizeEspeakStdout +
appendZeroPcmTail(1500 ms). Prints SHA256 for comparison with the Lab speak
receipt (event 814) and the voiced/silent map. The rebuilt audio is local and
transient: it is never committed to the mailbox (raw-audio rule).
"""
import hashlib, struct, sys
import numpy as np

raw = open(sys.argv[1], "rb").read()
pcm, sr = raw[44:], struct.unpack("<I", raw[24:28])[0]
data = pcm + bytes(round(sr * 1500 / 1000) * 2)
hdr = (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
       + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16) + b"data" + struct.pack("<I", len(data)))
print("sr", sr, "duration_ms", round(len(data) / 2 / sr * 1000), "sha256", hashlib.sha256(hdr + data).hexdigest())
x = np.frombuffer(pcm, dtype="<i2").astype(float) / 32768
w = int(0.02 * sr)
voiced = np.array([np.sqrt(np.mean(x[i:i + w] ** 2)) > 0.01 for i in range(0, len(x) - w, w)])
runs, start = [], 0
for i in range(1, len(voiced) + 1):
    if i == len(voiced) or voiced[i] != voiced[start]:
        runs.append(("speech" if voiced[start] else "pause", round(start * 0.02, 2), round(i * 0.02, 2)))
        start = i
print([r for r in runs if r[0] == "speech" or r[2] - r[1] >= 0.08])
