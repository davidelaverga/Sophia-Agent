"use client";

import { useEffect, useMemo, useRef } from "react";

import { useVisualTier } from "../../hooks/useVisualTier";
import { getWaveformProfile, shouldSkipTierFrame } from "../../lib/visual-tier-profiles";

/**
 * Visual presence states for the Waveform component.
 * These match the PresenceState from session-store for compatibility.
 */
export type WaveformState = 
  | "resting"
  | "listening"
  | "thinking"
  | "reflecting"
  | "speaking";

interface WaveformProps {
  /** Audio stream to visualize (required for listening state) */
  stream?: MediaStream;
  /** Current visual state */
  state?: WaveformState;
  /** Height of the canvas in pixels (default: 80) */
  height?: number;
  /** Additional CSS classes */
  className?: string;
  /** Dynamic emotion color RGB tuple — defaults to Sophia purple [139, 92, 246] */
  emotionRgb?: [number, number, number];
}

/**
 * Animated waveform visualization component.
 * 
 * Displays different animations based on the current state:
 * - resting: subtle pulsing dot
 * - listening: frequency bars + pulsing circle (requires stream)
 * - thinking: gentle breathing presence
 * - reflecting: spiral animation
 * - speaking: concentric ripples
 * 
 * @example
 * ```tsx
 * <Waveform state="listening" stream={mediaStream} />
 * ```
 */
export function Waveform({
  stream,
  state = "resting",
  height = 80,
  className = "",
  emotionRgb = [139, 92, 246],
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const analyserRef = useRef<AnalyserNode | undefined>(undefined);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const smoothedVolumeRef = useRef(0);
  const { tier, reducedMotion, dprCap } = useVisualTier();
  const renderProfile = useMemo(() => getWaveformProfile(tier), [tier]);

  const isListening = state === "listening";
  const shouldAnimate = !reducedMotion || isListening;

  useEffect(() => {
    if (!stream || !isListening) {
      // Clean up analyzer
      if (analyserRef.current) {
        analyserRef.current.disconnect();
        analyserRef.current = undefined;
      }
      smoothedVolumeRef.current = 0;
      return;
    }

    // Set up Web Audio API
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);

    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.85;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    analyserRef.current = analyser;
    dataArrayRef.current = dataArray;

    return () => {
      source.disconnect();
      analyser.disconnect();
      void audioContext.close();
    };
  }, [stream, isListening]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let canvasHeight = 0;
    let centerX = 0;
    let centerY = 0;
    let baseRadius = 0;
    let lastFrameTime = 0;

    const stopLoop = () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = undefined;
      }
      lastFrameTime = 0;
    };

    const isDocumentHidden = () => document.visibilityState === "hidden";

    const handleResize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);

      width = rect.width;
      canvasHeight = rect.height;
      centerX = width / 2;
      centerY = canvasHeight / 2;
      baseRadius = Math.min(width, canvasHeight) * 0.15;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(canvasHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    // Dynamic emotion colors
    const [eR, eG, eB] = emotionRgb;
    // Secondary is a slightly muted/shifted variant
    const sR = Math.round(eR * 0.71);
    const sG = Math.round(eG * 1.1);
    const sB = Math.round(eB * 0.97);

    let animationTime = 0;

    const draw = (ts: number) => {
      if (shouldAnimate && shouldSkipTierFrame(ts, lastFrameTime, renderProfile.frameIntervalMs)) {
        animationFrameRef.current = requestAnimationFrame(draw);
        return;
      }

      const deltaSeconds = lastFrameTime === 0 ? 1 / 60 : Math.min(0.05, (ts - lastFrameTime) / 1000);
      lastFrameTime = ts;

      ctx.clearRect(0, 0, width, canvasHeight);

      if (state === "thinking") {
        // Thinking: Gentle breathing presence - calm, alive, ready to help
        animationTime += deltaSeconds * 0.9;
        
        // Gentle breathing cycle
        const breathingPhase = Math.sin(animationTime * 0.5);
        const breathingIntensity = (breathingPhase + 1) / 2;
        
        // Layer 1: Soft outer glow that breathes
        const outerGlowRadius = baseRadius * (1.3 + breathingIntensity * 0.4);
        const outerGradient = ctx.createRadialGradient(
          centerX, centerY, baseRadius * 0.6,
          centerX, centerY, outerGlowRadius
        );
        outerGradient.addColorStop(0, `rgba(${eR}, ${eG}, ${eB}, ${0.12 + breathingIntensity * 0.08})`);
        outerGradient.addColorStop(0.6, `rgba(${sR}, ${sG}, ${sB}, ${0.08 + breathingIntensity * 0.05})`);
        outerGradient.addColorStop(1, `rgba(${sR}, ${sG}, ${sB}, 0)`);
        ctx.fillStyle = outerGradient;
        ctx.beginPath();
        ctx.arc(centerX, centerY, outerGlowRadius, 0, Math.PI * 2);
        ctx.fill();
        
        // Layer 2: Gentle pulsing ring
        const ringPulse = breathingIntensity;
        const ringRadius = baseRadius * (0.7 + ringPulse * 0.3);
        ctx.beginPath();
        ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${eR}, ${eG}, ${eB}, ${0.2 + ringPulse * 0.15})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        // Layer 3: Central core - gentle pulse
        const corePulse = (Math.sin(animationTime * 0.7) + 1) / 2;
        const coreRadius = baseRadius * (0.35 + corePulse * 0.15);
        const coreGradient = ctx.createRadialGradient(
          centerX, centerY, 0,
          centerX, centerY, coreRadius
        );
        coreGradient.addColorStop(0, `rgba(${eR}, ${eG}, ${eB}, ${0.35 + corePulse * 0.2})`);
        coreGradient.addColorStop(0.7, `rgba(${sR}, ${sG}, ${sB}, ${0.18 + corePulse * 0.12})`);
        coreGradient.addColorStop(1, `rgba(${sR}, ${sG}, ${sB}, 0)`);
        ctx.fillStyle = coreGradient;
        ctx.beginPath();
        ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
        ctx.fill();
        
        // Layer 4: Subtle orbiting particles
        const particleCount = renderProfile.thinkingParticleCount;
        for (let i = 0; i < particleCount; i++) {
          const particleAngle = (animationTime * 0.3 + (i / particleCount) * Math.PI * 2);
          const particleOrbitRadius = baseRadius * (1.1 + breathingIntensity * 0.2);
          const particleX = centerX + Math.cos(particleAngle) * particleOrbitRadius;
          const particleY = centerY + Math.sin(particleAngle) * particleOrbitRadius;
          const particlePulse = (Math.sin(animationTime * 0.8 + i) + 1) / 2;
          const particleSize = baseRadius * (0.06 + particlePulse * 0.04);
          
          // Very subtle particle glow
          const particleGlow = ctx.createRadialGradient(particleX, particleY, 0, particleX, particleY, particleSize * 3);
          particleGlow.addColorStop(0, `rgba(${eR}, ${eG}, ${eB}, ${0.25 + particlePulse * 0.15})`);
          particleGlow.addColorStop(0.6, `rgba(${sR}, ${sG}, ${sB}, ${0.12 + particlePulse * 0.08})`);
          particleGlow.addColorStop(1, `rgba(${sR}, ${sG}, ${sB}, 0)`);
          ctx.fillStyle = particleGlow;
          ctx.beginPath();
          ctx.arc(particleX, particleY, particleSize * 3, 0, Math.PI * 2);
          ctx.fill();
          
          // Gentle particle core
          ctx.fillStyle = `rgba(${eR}, ${eG}, ${eB}, ${0.4 + particlePulse * 0.2})`;
          ctx.beginPath();
          ctx.arc(particleX, particleY, particleSize, 0, Math.PI * 2);
          ctx.fill();
        }

      } else if (state === "reflecting") {
        // Reflecting: gentle spiral
        animationTime += deltaSeconds * 1.2;
        
        const spiralTurns = 2;
        const spiralPoints = renderProfile.reflectingSpiralPoints;
        
        ctx.beginPath();
        for (let i = 0; i < spiralPoints; i++) {
          const progress = i / spiralPoints;
          const angle = (animationTime + progress * spiralTurns * Math.PI * 2) % (Math.PI * 2);
          const radius = baseRadius * 0.3 + (progress * baseRadius * 1.5);
          const x = centerX + Math.cos(angle) * radius;
          const y = centerY + Math.sin(angle) * radius;
          
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        
        const spiralGradient = ctx.createLinearGradient(centerX - baseRadius * 2, centerY, centerX + baseRadius * 2, centerY);
        spiralGradient.addColorStop(0, `rgba(${eR}, ${eG}, ${eB}, 0.1)`);
        spiralGradient.addColorStop(0.5, "rgba(217, 179, 140, 0.3)");
        spiralGradient.addColorStop(1, `rgba(${eR}, ${eG}, ${eB}, 0.1)`);
        ctx.strokeStyle = spiralGradient;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Central glow
        const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, baseRadius);
        gradient.addColorStop(0, "rgba(217, 179, 140, 0.15)");
        gradient.addColorStop(1, `rgba(${eR}, ${eG}, ${eB}, 0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius, 0, Math.PI * 2);
        ctx.fill();

      } else if (state === "speaking") {
        // Speaking: concentric ripples
        animationTime += deltaSeconds * 1.2;
        
        for (let i = 0; i < renderProfile.speakingRippleCount; i++) {
          const offset = i * 0.8;
          const ripplePhase = (animationTime + offset) % 2;
          const rippleRadius = baseRadius + (ripplePhase * baseRadius * 1.5);
          const rippleOpacity = Math.max(0, 0.3 - ripplePhase * 0.15);

          ctx.beginPath();
          ctx.arc(centerX, centerY, rippleRadius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${eR}, ${eG}, ${eB}, ${rippleOpacity})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Central glow
        const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, baseRadius);
        gradient.addColorStop(0, `rgba(${eR}, ${eG}, ${eB}, 0.15)`);
        gradient.addColorStop(1, `rgba(${eR}, ${eG}, ${eB}, 0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius, 0, Math.PI * 2);
        ctx.fill();

      } else if (state === "listening" && analyserRef.current && dataArrayRef.current) {
        // User speaking: frequency bars + pulsing circle
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        analyserRef.current.getByteFrequencyData(dataArrayRef.current as any);

        // Calculate average volume and frequency distribution
        let sum = 0;
        let maxFreq = 0;
        for (const value of dataArrayRef.current) {
          sum += value;
          if (value > maxFreq) maxFreq = value;
        }
        const avgVolume = sum / dataArrayRef.current.length / 255;

        // Smooth the volume changes
        const targetVolume = avgVolume;
        smoothedVolumeRef.current += (targetVolume - smoothedVolumeRef.current) * 0.2;

        // Pulse radius based on volume
        const pulseAmount = smoothedVolumeRef.current * 0.8;
        const currentRadius = baseRadius * (1 + pulseAmount * 0.5);

        // Draw frequency bars around the circle
        const barCount = renderProfile.listeningBarCount;
        const barWidth = (Math.PI * 2) / barCount;
        const innerRadius = baseRadius * 0.6;
        const maxBarHeight = baseRadius * 0.8;

        for (let i = 0; i < barCount; i++) {
          const freqIndex = Math.floor((i / barCount) * dataArrayRef.current.length);
          const freqValue = dataArrayRef.current[freqIndex] / 255;
          
          if (freqValue > 0.1) {
            const angle = (i * barWidth) - Math.PI / 2;
            const barHeight = freqValue * maxBarHeight;
            
            const x1 = centerX + Math.cos(angle) * innerRadius;
            const y1 = centerY + Math.sin(angle) * innerRadius;
            const x2 = centerX + Math.cos(angle) * (innerRadius + barHeight);
            const y2 = centerY + Math.sin(angle) * (innerRadius + barHeight);
            
            const intensity = Math.min(1, freqValue * 2);
            const hue = 250 + (freqValue * 20);
            ctx.strokeStyle = `hsla(${hue}, 70%, ${50 + intensity * 30}%, ${0.4 + intensity * 0.6})`;
            ctx.lineWidth = 2 + intensity * 2;
            ctx.lineCap = "round";
            
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          }
        }

        // Outer glow
        const outerGlow = ctx.createRadialGradient(
          centerX, centerY, currentRadius * 0.5,
          centerX, centerY, currentRadius * 2.2
        );
        outerGlow.addColorStop(0, `rgba(${eR}, ${eG}, ${eB}, ${0.3 + pulseAmount * 0.4})`);
        outerGlow.addColorStop(0.5, `rgba(${sR}, ${sG}, ${sB}, ${0.2 + pulseAmount * 0.3})`);
        outerGlow.addColorStop(1, `rgba(${eR}, ${eG}, ${eB}, 0)`);
        ctx.fillStyle = outerGlow;
        ctx.beginPath();
        ctx.arc(centerX, centerY, currentRadius * 2.2, 0, Math.PI * 2);
        ctx.fill();

        // Main circle
        const mainGradient = ctx.createRadialGradient(
          centerX, centerY, 0,
          centerX, centerY, currentRadius
        );
        mainGradient.addColorStop(0, `rgba(${eR}, ${eG}, ${eB}, ${0.5 + pulseAmount * 0.4})`);
        mainGradient.addColorStop(0.7, `rgba(${sR}, ${sG}, ${sB}, ${0.3 + pulseAmount * 0.3})`);
        mainGradient.addColorStop(1, `rgba(${eR}, ${eG}, ${eB}, ${0.15 + pulseAmount * 0.25})`);
        ctx.fillStyle = mainGradient;
        ctx.beginPath();
        ctx.arc(centerX, centerY, currentRadius, 0, Math.PI * 2);
        ctx.fill();

        // Animated ring
        ctx.beginPath();
        ctx.arc(centerX, centerY, currentRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${eR}, ${eG}, ${eB}, ${0.4 + pulseAmount * 0.5})`;
        ctx.lineWidth = 2 + pulseAmount * 2;
        ctx.stroke();
        
        // Inner core
        const coreRadius = baseRadius * 0.3 * (1 + pulseAmount * 0.8);
        const coreGradient = ctx.createRadialGradient(
          centerX, centerY, 0,
          centerX, centerY, coreRadius
        );
        coreGradient.addColorStop(0, `rgba(255, 255, 255, ${0.3 + pulseAmount * 0.4})`);
        coreGradient.addColorStop(1, `rgba(${eR}, ${eG}, ${eB}, ${0.2 + pulseAmount * 0.3})`);
        ctx.fillStyle = coreGradient;
        ctx.beginPath();
        ctx.arc(centerX, centerY, coreRadius, 0, Math.PI * 2);
        ctx.fill();

      } else {
        // Resting state: subtle pulsing dot
        animationTime += deltaSeconds * 0.6;
        const pulseScale = 1 + Math.sin(animationTime) * 0.1;
        const pulseRadius = baseRadius * 0.5 * pulseScale;
        
        const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, pulseRadius);
        gradient.addColorStop(0, `rgba(${eR}, ${eG}, ${eB}, 0.15)`);
        gradient.addColorStop(1, `rgba(${eR}, ${eG}, ${eB}, 0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(centerX, centerY, pulseRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      if (shouldAnimate) {
        animationFrameRef.current = requestAnimationFrame(draw);
      }
    };

    const startLoop = () => {
      if (!shouldAnimate || animationFrameRef.current !== undefined || isDocumentHidden()) {
        return;
      }

      animationFrameRef.current = requestAnimationFrame(draw);
    };

    const handleVisibilityChange = () => {
      if (!shouldAnimate) {
        return;
      }

      if (isDocumentHidden()) {
        stopLoop();
        return;
      }

      startLoop();
    };

    if (shouldAnimate) {
      document.addEventListener("visibilitychange", handleVisibilityChange);
      startLoop();
    } else {
      draw(performance.now());
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopLoop();
    };
  }, [dprCap, emotionRgb, renderProfile, shouldAnimate, state]);

  return (
    <canvas
      ref={canvasRef}
      className={`w-full ${className}`}
      style={{ height: `${height}px` }}
      aria-hidden="true"
    />
  );
}
