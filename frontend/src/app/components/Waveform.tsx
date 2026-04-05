/**
 * @deprecated Use the reusable Waveform from ui/ folder instead.
 * This file is kept for backwards compatibility.
 * 
 * @example
 * // Preferred import:
 * import { Waveform } from "./ui/Waveform"
 */

import type { PresenceState } from "../stores/presence-store";
import { Waveform as UIWaveform, type WaveformState } from "./ui/Waveform";

interface WaveformProps {
  stream?: MediaStream;
  presenceState?: PresenceState;
  emotionRgb?: [number, number, number];
}

/** @deprecated Use UIWaveform from ./ui/Waveform instead */
export function Waveform({
  stream,
  presenceState = "resting",
  emotionRgb,
}: WaveformProps) {
  return (
    <UIWaveform 
      stream={stream} 
      state={presenceState as WaveformState}
      emotionRgb={emotionRgb}
    />
  );
}
