/**
 * CelestialComet — WebGL off-screen light source with volumetric god-rays.
 *
 * The light stays off-screen (upper corners/edges) and drifts slowly.
 * Only its light shafts reach into the scene. UI elements registered as
 * occluders block rays and cast shadows. Elements react to the light
 * direction via the sweepLight store.
 */
'use client';

import { useEffect, useRef } from 'react';

import { useDeviceFidelity } from '../../hooks/useDeviceFidelity';
import type { ContextMode } from '../../types/session';

import { sweepLight } from './sweepLight';

/* ─── Palettes ──────────────────────────────────────────────── */

type Rgb3 = [number, number, number];

const PALETTES: Record<ContextMode, { rays: Rgb3; core: Rgb3; ambient: Rgb3 }> = {
  gaming: { rays: [0.71, 0.55, 0.94], core: [0.90, 0.82, 1.0],  ambient: [0.55, 0.35, 0.75] },
  work:   { rays: [0.55, 0.71, 0.90], core: [0.82, 0.90, 1.0],  ambient: [0.33, 0.52, 0.68] },
  life:   { rays: [0.78, 0.59, 0.73], core: [1.0,  0.84, 0.92], ambient: [0.64, 0.41, 0.55] },
};

/*
 * Off-screen anchor points the light drifts between.
 * All positions are off-screen (negative Y or past edges).
 * [x, y] in 0-1 UV range — y < 0 = above viewport, x < 0 / x > 1 = past edges.
 */
const ANCHORS: [number, number][] = [
  [-0.18, -0.25],   // upper-left corner
  [ 0.25, -0.32],   // above left-of-center
  [ 0.50, -0.35],   // above center
  [ 0.75, -0.32],   // above right-of-center
  [ 1.18, -0.25],   // upper-right corner
  [ 1.25, -0.10],   // right edge, well above top
  [-0.25, -0.10],   // left edge, well above top
];

/* ─── GLSL shaders ──────────────────────────────────────────── */

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2  u_resolution;
uniform float u_time;
uniform vec2  u_lightPos;
uniform float u_fade;
uniform vec3  u_rayColor;
uniform vec3  u_coreColor;
uniform vec3  u_ambientColor;
uniform float u_quality;
uniform vec4  u_occ[8];

// ─── noise ───
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = rot * p * 2.0;
    a *= 0.5;
  }
  return v;
}

// ─── element occlusion — shadow cones behind UI elements ───
float occluderShadow(vec2 coord, vec2 lightUV, float aspect) {
  float shadow = 1.0;
  for (int j = 0; j < 8; j++) {
    if (u_occ[j].w < 0.5) continue;
    vec2 occCenter = u_occ[j].xy;
    float occR = u_occ[j].z;

    vec2 lightToFrag = (coord - lightUV) * vec2(aspect, 1.0);
    float lightToFragLen = length(lightToFrag);
    vec2 lightToOcc = (occCenter - lightUV) * vec2(aspect, 1.0);
    float lightToOccLen = length(lightToOcc);

    if (lightToFragLen < lightToOccLen * 0.8) continue;

    vec2 lightDir = lightToOcc / (lightToOccLen + 0.001);
    float proj = dot(lightToFrag, lightDir);
    if (proj < 0.0) continue;

    vec2 closest = lightDir * proj;
    float perpDist = length(lightToFrag - closest);

    float behindOcc = max(0.0, proj - lightToOccLen);
    float coneWidth = occR + behindOcc * 0.15;

    // Softer penumbra with noise on the edge
    float edgeNoise = fbm(coord * 12.0 + u_time * 0.02) * 0.3;
    float shadowFactor = smoothstep(coneWidth * 0.5, coneWidth * 1.6 + edgeNoise * coneWidth, perpDist);
    float distanceFade = 1.0 / (1.0 + behindOcc * 1.2);
    shadowFactor = mix(shadowFactor, 1.0, 1.0 - distanceFade);

    shadow *= shadowFactor;
  }
  return shadow;
}

// ─── volumetric god rays with occlusion ───
float godRays(vec2 uv, vec2 lightUV, float aspect) {
  int samples = int(64.0 * u_quality);
  float decay = 0.975;
  float density = 0.85;
  float weight = 0.018;

  vec2 delta = (uv - lightUV) / float(samples) * density;
  vec2 coord = uv;
  float illum = 0.0;
  float currentDecay = 1.0;

  for (int i = 0; i < 64; i++) {
    if (i >= samples) break;
    coord -= delta;
    float angle = atan(coord.y - lightUV.y, coord.x - lightUV.x);
    float dist  = length(coord - lightUV);

    // Three frequency layers: structure + medium detail + fine shimmer
    float broad  = fbm(vec2(angle * 3.0 + u_time * 0.03, dist * 3.5 - u_time * 0.06));
    float medium = fbm(vec2(angle * 6.0 - u_time * 0.015, dist * 5.5 + u_time * 0.04));
    float fine   = fbm(vec2(angle * 12.0 + u_time * 0.05, dist * 9.0 - u_time * 0.03));
    float occ    = broad * 0.55 + medium * 0.30 + fine * 0.15;

    // Vary shaft width along the radial — thicker near source, thinner far
    float shaftLow  = mix(0.28, 0.35, smoothstep(0.0, 1.5, dist));
    float shaftHigh = mix(0.50, 0.58, smoothstep(0.0, 1.5, dist));
    float shaft = smoothstep(shaftLow, shaftHigh, occ);

    float block = occluderShadow(coord, lightUV, aspect);
    illum += shaft * weight * currentDecay * block;
    currentDecay *= decay;
  }
  return illum;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 lightUV = u_lightPos;

  vec2 d = (uv - lightUV) * vec2(aspect, 1.0);
  float dist = length(d);

  // God rays from off-screen
  float rays = godRays(uv, lightUV, aspect) * u_fade;

  // Fade at screen edges — top is where light enters, fade at sides and bottom
  float edgeFade = smoothstep(0.0, 0.10, uv.x) * smoothstep(1.0, 0.90, uv.x)
                 * smoothstep(1.0, 0.70, uv.y);
  rays *= edgeFade;

  // Atmospheric scattering — only visible as faint top-edge wash, never as a visible core
  float scatter = exp(-dist * 2.5) * u_fade * 0.008;
  float scatterNoise = fbm(uv * 4.0 + u_time * 0.02) * 0.5 + 0.5;
  scatter *= (0.6 + 0.4 * scatterNoise);
  scatter *= smoothstep(0.12, -0.05, uv.y); // tight cutoff — nothing leaks on-screen

  // Rim light at occluder edges — light wrapping around elements
  float rim = 0.0;
  for (int j = 0; j < 8; j++) {
    if (u_occ[j].w < 0.5) continue;
    vec2 toOcc = (uv - u_occ[j].xy) * vec2(aspect, 1.0);
    float occDist = length(toOcc);
    float r = u_occ[j].z;

    // Tight rim band at element edge
    float rimBand = exp(-pow((occDist - r) / (r * 0.12), 2.0));
    // Wider secondary glow for atmosphere
    float outerGlow = exp(-pow((occDist - r * 1.3) / (r * 0.5), 2.0)) * 0.3;

    vec2 toLight = normalize((lightUV - u_occ[j].xy) * vec2(aspect, 1.0) + 0.001);
    vec2 toFrag = normalize(toOcc + 0.001);
    float litSide = max(0.0, dot(toFrag, toLight));

    // Sharper lit-side falloff for more directional feel
    rim += (rimBand + outerGlow) * litSide * litSide * litSide * u_fade * 0.10;
  }

  // Compose with chromatic depth — rays slightly warmer near source
  float warmth = smoothstep(1.5, 0.3, dist);
  vec3 warmRayCol = mix(u_rayColor, u_coreColor, warmth * 0.15);

  vec3 rayContrib = rays * warmRayCol * 0.18;
  vec3 scatterContrib = scatter * u_ambientColor * 0.6;
  vec3 rimContrib = rim * u_coreColor * 0.4;

  vec3 color = rayContrib + scatterContrib + rimContrib;
  color = color / (1.0 + color);
  gl_FragColor = vec4(color, 1.0);
}
`;

/* ─── WebGL helpers ─────────────────────────────────────────── */

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('Shader compile error:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('Program link error:', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

/* ─── Component ─────────────────────────────────────────────── */

export function CelestialComet({ contextMode }: { contextMode: ContextMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contextRef = useRef(contextMode);
  contextRef.current = contextMode;
  const { reducedMotion, reducedFidelity } = useDeviceFidelity();

  useEffect(() => {
    if (reducedMotion) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // Higher resolution keeps rays crisp — low-end still gets 0.45
    const RENDER_SCALE = reducedFidelity ? 0.45 : 0.75;

    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return;

    const prog = createProgram(gl);
    if (!prog) return;
    gl.useProgram(prog);

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Uniforms
    const uRes     = gl.getUniformLocation(prog, 'u_resolution');
    const uTime    = gl.getUniformLocation(prog, 'u_time');
    const uLight   = gl.getUniformLocation(prog, 'u_lightPos');
    const uFade    = gl.getUniformLocation(prog, 'u_fade');
    const uRayCol  = gl.getUniformLocation(prog, 'u_rayColor');
    const uCoreCol = gl.getUniformLocation(prog, 'u_coreColor');
    const uAmbCol  = gl.getUniformLocation(prog, 'u_ambientColor');
    const uQuality = gl.getUniformLocation(prog, 'u_quality');
    const uOcc: (WebGLUniformLocation | null)[] = [];
    for (let i = 0; i < 8; i++) uOcc.push(gl.getUniformLocation(prog, `u_occ[${i}]`));

    let raf = 0;
    let w = 0, h = 0;

    /* ── Drift state machine ── */
    // The light never enters the viewport; it drifts between off-screen anchors.
    let phase: 'idle' | 'drift' = 'idle';
    let phaseStart = 0;
    let anchorFrom = Math.floor(Math.random() * ANCHORS.length);
    let anchorTo = (anchorFrom + 1 + Math.floor(Math.random() * (ANCHORS.length - 1))) % ANCHORS.length;
    const FIRST_IDLE = 1500;  // short delay before first appearance
    const IDLE_MIN = 22000;
    const IDLE_VAR = 18000;
    const DRIFT_DUR = 25000;  // slow 25s drift between anchors
    let idleDur = FIRST_IDLE;

    /* ── Color lerp ── */
    const cur = {
      rays:    [...PALETTES[contextRef.current].rays]    as Rgb3,
      core:    [...PALETTES[contextRef.current].core]    as Rgb3,
      ambient: [...PALETTES[contextRef.current].ambient] as Rgb3,
    };
    const lerpV = (a: Rgb3, b: Rgb3, t: number): Rgb3 =>
      [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];

    const smoothStep = (t: number) => t * t * (3 - 2 * t);

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.style.width  = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width  = Math.round(w * RENDER_SCALE);
      canvas.height = Math.round(h * RENDER_SCALE);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const draw = (ts: number) => {
      if (phaseStart === 0) phaseStart = ts;
      const elapsed = ts - phaseStart;
      const time = ts * 0.001;

      // Palette lerp — reads latest contextMode via ref
      const tgt = PALETTES[contextRef.current];
      cur.rays    = lerpV(cur.rays,    tgt.rays,    0.012);
      cur.core    = lerpV(cur.core,    tgt.core,    0.012);
      cur.ambient = lerpV(cur.ambient, tgt.ambient, 0.012);

      if (phase === 'idle') {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        sweepLight.active = false;
        sweepLight.intensity = 0;
        if (elapsed >= idleDur) {
          phase = 'drift';
          phaseStart = ts;
          anchorFrom = anchorTo;
          anchorTo = (anchorFrom + 1 + Math.floor(Math.random() * (ANCHORS.length - 1))) % ANCHORS.length;
        }
        raf = requestAnimationFrame(draw);
        return;
      }

      /* ── DRIFT — light creeps between off-screen anchors ── */
      const rawT = Math.min(elapsed / DRIFT_DUR, 1);
      const posT = smoothStep(rawT);

      // Fade: gentle fade-in (20%) and fade-out (20%)
      let fade = 1;
      if      (rawT < 0.20) fade = rawT / 0.20;
      else if (rawT > 0.80) fade = (1 - rawT) / 0.20;
      fade = Math.max(0, Math.min(1, fade));
      fade = smoothStep(fade);

      const from = ANCHORS[anchorFrom]!;
      const to = ANCHORS[anchorTo]!;
      const lx = from[0] + (to[0] - from[0]) * posT;
      const ly = from[1] + (to[1] - from[1]) * posT;

      // Publish position (off-screen coords, in px) for UI elements
      sweepLight.x = lx * w;
      sweepLight.y = ly * h;
      sweepLight.active = true;
      sweepLight.intensity = fade;

      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, time);
      gl.uniform2f(uLight, lx, 1.0 - ly); // flip Y for GL
      gl.uniform1f(uFade, fade);
      gl.uniform3fv(uRayCol,  cur.rays);
      gl.uniform3fv(uCoreCol, cur.core);
      gl.uniform3fv(uAmbCol,  cur.ambient);
      gl.uniform1f(uQuality, reducedFidelity ? 0.6 : 1.0);

      // Pass element positions as light occluders
      for (let i = 0; i < 8; i++) {
        const occ = sweepLight.occluders[i];
        if (occ && uOcc[i]) {
          gl.uniform4f(uOcc[i], occ.cx / w, 1.0 - occ.cy / h, occ.r / h, 1.0);
        } else if (uOcc[i]) {
          gl.uniform4f(uOcc[i], 0, 0, 0, 0);
        }
      }

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (rawT >= 1) {
        phase = 'idle';
        phaseStart = ts;
        idleDur = IDLE_MIN + Math.random() * IDLE_VAR;
      }

      raf = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(raf);
      sweepLight.active = false;
      sweepLight.intensity = 0;
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
    };
  }, [reducedMotion, reducedFidelity]);

  if (reducedMotion) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 1, mixBlendMode: 'screen', imageRendering: 'pixelated' }}
    />
  );
}
