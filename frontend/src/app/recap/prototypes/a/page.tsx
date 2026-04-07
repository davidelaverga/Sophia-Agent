/**
 * Recap Prototype A v4 — "Cosmic Pool"
 *
 * Max-fidelity immersive recap. Three visual layers:
 *   1. Aurora + starfield background (WebGL)
 *   2. 3D-perspective cosmic pool surface (WebGL) with caustics,
 *      ripple rings from memory drops, and settled glow points
 *   3. Ethereal orbs with internal mist + micro-sparkles
 *
 * When a memory is approved, a luminous drop falls from the orb into
 * the pool; on impact, concentric ripples spread outward and a
 * persistent glow settles — the pool holding your memories.
 *
 * Palette: sophia-purple (#B8A4E8) primary, amber (#F2B36B) warm
 * accent, teal (#59BEAD) secondary — cohesive with session + dashboard.
 */

'use client';

import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Home,
  Pencil,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../../lib/utils';

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Types                                                                    */
/* ═══════════════════════════════════════════════════════════════════════════ */

type Decision = 'idle' | 'approved' | 'edited' | 'discarded';

interface PoolRipple {
  x: number;     // UV 0-1 on pool surface
  y: number;
  time: number;  // seconds since mount
  intensity: number;
}

interface SettledGlow {
  x: number;
  y: number;
}

interface ActiveDrop {
  id: string;
  startX: number;
  startY: number;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Mock Data                                                                */
/* ═══════════════════════════════════════════════════════════════════════════ */

const MOCK_TAKEAWAY = 'Work-mode alertness is leaking into rest';

const MOCK_CANDIDATES = [
  {
    id: 'mem_01',
    text: 'Feels good when your brain is OFF and present. Struggles to sustain this state.',
    category: 'emotional_patterns',
    confidence: 0.89,
    reason: 'You described this feeling multiple times during the session.',
  },
  {
    id: 'mem_02',
    text: 'Pattern: always trying to be alert and take charge of situations.',
    category: 'identity_profile',
    confidence: 0.82,
    reason: 'This pattern surfaced across two separate topics.',
  },
  {
    id: 'mem_03',
    text: 'Work-brain optimization mode bleeds into rest, sees this as a pattern to address.',
    category: 'goals_projects',
    confidence: 0.76,
    reason: 'You explicitly named this as something to change.',
  },
  {
    id: 'mem_04',
    text: 'Has trouble setting boundaries with the team after hours — wants to change this.',
    category: 'preferences_boundaries',
    confidence: 0.71,
    reason: 'Mentioned when discussing evening routines.',
  },
];

const MOCK_REFLECTION = {
  prompt: 'Where did you learn that you had to always be alert and in charge?',
};

const CATEGORY_MAP: Record<string, { label: string; icon: string }> = {
  emotional_patterns: { label: 'Emotional Patterns', icon: '💜' },
  identity_profile: { label: 'Identity', icon: '🪪' },
  goals_projects: { label: 'Goals & Projects', icon: '🎯' },
  preferences_boundaries: { label: 'Preferences', icon: '⚙️' },
};

function getCat(c?: string) {
  return CATEGORY_MAP[c ?? ''] ?? { label: 'Memory', icon: '•' };
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Shaders                                                                  */
/* ═══════════════════════════════════════════════════════════════════════════ */

const VERT = `attribute vec2 pos;void main(){gl_Position=vec4(pos,0,1);}`;

/* ─── Background: aurora curtains (no stars) ─── */

const BG_FRAG = `
precision highp float;
uniform float u_time;
uniform vec2  u_res;
uniform vec2  u_mouse;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm3(vec2 p){
  float v=0.0,a=0.5;
  for(int i=0;i<3;i++){v+=a*noise(p);p=p*2.1+100.0;a*=0.5;}
  return v;
}

float aurora(vec2 uv,float t,float spd,float freq,float off){
  float w=uv.x*freq+off;
  float n1=fbm3(vec2(w*0.5,t*spd*0.3));
  float n2=fbm3(vec2(w*0.8+5.0,t*spd*0.2+3.0));
  float c=sin(w+n1*4.0+t*spd)*0.5+0.5;
  c*=sin(w*0.7+n2*3.0-t*spd*0.5)*0.5+0.5;
  c*=smoothstep(0.85,0.4,uv.y)*smoothstep(-0.1,0.2,uv.y);
  return pow(c,2.5)*0.6;
}

void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  float asp=u_res.x/u_res.y;
  vec2 p=vec2((uv.x-0.5)*asp,uv.y-0.5);
  float t=u_time;
  vec2 mp=(u_mouse-0.5)*0.03;

  vec3 c_purple=vec3(0.72,0.64,0.91);
  vec3 c_glow  =vec3(0.83,0.77,1.0);
  vec3 c_amber =vec3(0.95,0.70,0.42);
  vec3 c_teal  =vec3(0.35,0.75,0.68);

  // Deep void base with subtle radial warmth
  vec3 col=vec3(0.012,0.012,0.024);
  col+=mix(c_purple,c_teal,0.5)*exp(-dot(p,p)*2.5)*0.06;

  // Soft ambient nebula wash (very subtle, fills the void)
  float neb=fbm3(p*1.8+t*0.015);
  float neb2=fbm3(p*2.5+vec2(5.0)+t*0.01);
  col+=c_purple*neb*0.025;
  col+=c_teal*neb2*0.012;

  // Aurora curtains
  float a1=aurora(uv+mp*0.6,t,0.12,3.5,0.0);
  float a2=aurora(uv+mp*0.4,t,0.09,2.8,2.5);
  float a3=aurora(uv+mp*0.2,t,0.07,4.2,5.0);
  col+=c_purple*a1*0.50;
  col+=c_amber *a2*0.35;
  col+=c_teal  *a3*0.28;
  col+=c_glow*pow(max(a1,max(a2,a3)),3.0)*0.30;

  float vig=1.0-dot(uv-0.5,uv-0.5)*2.2;
  col*=smoothstep(0.0,0.55,vig);
  col=col/(col+0.55);col=pow(col,vec3(0.9));
  gl_FragColor=vec4(col,1.0);
}
`;

/* ─── Cosmic Pool: caustics + ripples + settled glows ─── */

const POOL_FRAG = `
precision highp float;
uniform float u_time;
uniform vec2  u_res;
uniform vec4  u_r0,u_r1,u_r2,u_r3,u_r4,u_r5,u_r6,u_r7;
uniform vec2  u_g0,u_g1,u_g2,u_g3;
uniform float u_gc;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){
  float v=0.0,a=0.5;
  for(int i=0;i<3;i++){v+=a*noise(p);p*=2.1;p+=100.0;a*=0.5;}
  return v;
}

// Recreate the aurora function so the pool can reflect it
float aurora(vec2 uv,float t,float spd,float freq,float off){
  float w=uv.x*freq+off;
  float n1=fbm(vec2(w*0.5,t*spd*0.3));
  float n2=fbm(vec2(w*0.8+5.0,t*spd*0.2+3.0));
  float c=sin(w+n1*4.0+t*spd)*0.5+0.5;
  c*=sin(w*0.7+n2*3.0-t*spd*0.5)*0.5+0.5;
  // No vertical fade here — pool handles its own depth
  return pow(c,2.5)*0.6;
}

float ripple(vec2 uv,vec4 r){
  if(r.w<0.01)return 0.0;
  float el=u_time-r.z;
  if(el<0.0||el>6.0)return 0.0;
  float d=length(uv-r.xy);
  float rad=el*0.22;
  float ring=exp(-pow((d-rad)*14.0,2.0));
  float inner=exp(-pow((d-rad*0.6)*18.0,2.0))*0.35;
  float wave=sin((d-rad)*45.0)*0.5+0.5;
  float fade=exp(-el*0.7)*r.w;
  return (ring+inner)*wave*fade*smoothstep(0.0,0.08,el);
}

float glow(vec2 uv,vec2 gp,float idx){
  float d=length(uv-gp);
  float g=exp(-d*d*55.0);
  float pulse=sin(u_time*0.4+idx*1.5)*0.12+0.88;
  float core=exp(-d*d*180.0)*0.08;
  return (g*0.14+core)*pulse;
}

void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  float asp=u_res.x/u_res.y;
  vec2 p=vec2(uv.x*asp,uv.y);
  float t=u_time;

  vec3 c_purple=vec3(0.72,0.64,0.91);
  vec3 c_glow  =vec3(0.83,0.77,1.0);
  vec3 c_amber =vec3(0.95,0.70,0.42);
  vec3 c_teal  =vec3(0.35,0.75,0.68);

  // Depth: near edge (uv.y=1) brighter, far (uv.y=0) darker
  float depth=smoothstep(0.0,0.85,uv.y);

  // ── Water surface distortion for reflection lookup ──
  // Slow rippling noise displaces the reflection UV
  float n1=noise(p*3.0+t*0.08);
  float n2=noise(p*5.0-t*0.06+vec2(7.0,3.0));
  float n3=noise(p*8.0+t*0.12+vec2(2.0,11.0));
  vec2 distort=vec2(
    (n1-0.5)*0.06+(n2-0.5)*0.03+(n3-0.5)*0.015,
    (n1-0.5)*0.04+(n2-0.5)*0.025
  );

  // Add ripple-based distortion (active ripples warp the reflection)
  float tr=0.0;
  tr+=ripple(uv,u_r0);tr+=ripple(uv,u_r1);tr+=ripple(uv,u_r2);tr+=ripple(uv,u_r3);
  tr+=ripple(uv,u_r4);tr+=ripple(uv,u_r5);tr+=ripple(uv,u_r6);tr+=ripple(uv,u_r7);
  distort+=vec2(tr*0.04,tr*0.03);

  // ── Reflected aurora — mirror the sky ──
  // Flip Y and apply distortion for wavy reflected aurora
  vec2 refUV=vec2(uv.x,1.0-uv.y)+distort;
  float a1=aurora(refUV,t,0.12,3.5,0.0);
  float a2=aurora(refUV,t,0.09,2.8,2.5);
  float a3=aurora(refUV,t,0.07,4.2,5.0);

  // Deep dark base
  vec3 col=vec3(0.008,0.008,0.018);

  // Reflected aurora colors (attenuated — water absorbs light)
  float reflStr=0.55*depth;
  col+=c_purple*a1*0.40*reflStr;
  col+=c_amber *a2*0.28*reflStr;
  col+=c_teal  *a3*0.22*reflStr;
  col+=c_glow*pow(max(a1,max(a2,a3)),3.0)*0.18*reflStr;

  // Subtle nebula undertone in the water
  float neb=fbm(p*2.0+t*0.02);
  col+=mix(c_purple,c_teal,neb)*0.015*depth;

  // Fresnel — near edge is brighter/more reflective
  float fresnel=pow(depth,0.7);
  col*=0.6+fresnel*0.6;

  // Surface sheen — faint specular highlights from distortion peaks
  float sheen=pow(max(n1*n2,0.0),3.0)*0.08;
  col+=c_glow*sheen*depth;

  // ── Ripple highlights (bright ring on surface) ──
  col+=mix(c_amber,c_glow,0.5)*tr*0.55;
  col+=vec3(1.0,0.98,0.95)*pow(tr,2.5)*0.30;

  // ── Settled memory glows ──
  float tg=0.0;
  if(u_gc>0.5)tg+=glow(uv,u_g0,0.0);
  if(u_gc>1.5)tg+=glow(uv,u_g1,1.0);
  if(u_gc>2.5)tg+=glow(uv,u_g2,2.0);
  if(u_gc>3.5)tg+=glow(uv,u_g3,3.0);
  col+=mix(c_purple,c_amber,0.3)*tg;

  // Near-edge glow line
  col+=c_glow*smoothstep(0.1,0.0,1.0-uv.y)*0.035;
  float sh=smoothstep(0.015,0.0,1.0-uv.y)*smoothstep(0.0,0.004,1.0-uv.y);
  sh*=sin(uv.x*55.0+t*0.5)*0.5+0.5;
  col+=c_glow*sh*0.10;

  // Vignette
  float vig=smoothstep(0.0,0.18,uv.x)*smoothstep(1.0,0.82,uv.x);
  vig*=smoothstep(0.0,0.12,uv.y)*smoothstep(1.0,0.7,uv.y);
  col*=vig;

  // Alpha fade
  float alpha=smoothstep(0.0,0.12,uv.y)*smoothstep(1.0,0.72,uv.y);
  alpha*=smoothstep(0.0,0.15,uv.x)*smoothstep(1.0,0.85,uv.x);

  col=col/(col+0.5);col=pow(col,vec3(0.92));
  gl_FragColor=vec4(col,alpha);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  WebGL helpers                                                            */
/* ═══════════════════════════════════════════════════════════════════════════ */

function compileShader(gl: WebGLRenderingContext, src: string, type: number) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('Shader error:', gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

function buildProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string) {
  const prog = gl.createProgram();
  const vs = compileShader(gl, vertSrc, gl.VERTEX_SHADER);
  const fs = compileShader(gl, fragSrc, gl.FRAGMENT_SHADER);
  if (!vs || !fs) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Link error:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

function setupQuad(gl: WebGLRenderingContext, prog: WebGLProgram) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Background: aurora + stars + drifting motes                              */
/* ═══════════════════════════════════════════════════════════════════════════ */

interface Mote {
  x: number; y: number; vx: number; vy: number;
  size: number; alpha: number; phase: number;
  speed: number; depth: number; hue: number;
}

const MOTE_COLORS: [number, number, number][] = [
  [184, 164, 232], // sophia-purple
  [242, 179, 107], // amber
  [89, 190, 173],  // teal
];

function createMotes(w: number, h: number): Mote[] {
  return Array.from({ length: 100 }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.03,
    vy: -Math.random() * 0.025 - 0.008,
    size: Math.random() * 1.3 + 0.3,
    alpha: Math.random() * 0.35 + 0.06,
    phase: Math.random() * Math.PI * 2,
    speed: 0.2 + Math.random() * 0.5,
    depth: Math.random(),
    hue: Math.floor(Math.random() * 3),
  }));
}

function AuroraBackground() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const moteRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    gl: WebGLRenderingContext;
    u: Record<string, WebGLUniformLocation | null>;
  } | null>(null);
  const motesRef = useRef<Mote[]>([]);
  const mouseRef = useRef({ x: 0.5, y: 0.5 });
  const rafRef = useRef(0);
  const t0 = useRef(performance.now());

  useEffect(() => {
    const glC = glRef.current;
    const mC = moteRef.current;
    if (!glC || !mC) return;

    const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
    const resize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      glC.width = Math.round(w * dpr); glC.height = Math.round(h * dpr);
      glC.style.width = `${w}px`; glC.style.height = `${h}px`;
      mC.width = w; mC.height = h;
      if (!motesRef.current.length) motesRef.current = createMotes(w, h);
    };
    resize();
    window.addEventListener('resize', resize);

    const gl = glC.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) return;
    const prog = buildProgram(gl, VERT, BG_FRAG);
    if (!prog) return;
    gl.useProgram(prog);
    setupQuad(gl, prog);
    const u: Record<string, WebGLUniformLocation | null> = {
      t: gl.getUniformLocation(prog, 'u_time'),
      r: gl.getUniformLocation(prog, 'u_res'),
      m: gl.getUniformLocation(prog, 'u_mouse'),
    };
    stateRef.current = { gl, u };

    const onMove = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX / window.innerWidth;
      mouseRef.current.y = e.clientY / window.innerHeight;
    };
    window.addEventListener('mousemove', onMove);

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const t = (performance.now() - t0.current) / 1000;
      const mx = mouseRef.current.x, my = mouseRef.current.y;

      // WebGL
      const s = stateRef.current;
      if (s) {
        const { gl: g, u: loc } = s;
        g.viewport(0, 0, g.canvas.width, g.canvas.height);
        g.uniform1f(loc.t, t);
        g.uniform2f(loc.r, g.canvas.width, g.canvas.height);
        g.uniform2f(loc.m, mx, 1 - my);
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      }

      // Motes
      const ctx = mC.getContext('2d');
      if (ctx) {
        const w = mC.width, h = mC.height;
        ctx.clearRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'screen';
        for (const m of motesRef.current) {
          m.x += m.vx + (mx - 0.5) * 0.12 * (0.3 + m.depth * 0.7);
          m.y += m.vy;
          if (m.x < -10) m.x = w + 10;
          if (m.x > w + 10) m.x = -10;
          if (m.y < -10) { m.y = h + 10; m.x = Math.random() * w; }
          if (m.y > h + 10) m.y = -10;
          const tw = (Math.sin(t * m.speed + m.phase) * 0.5 + 0.5) ** 2;
          const a = m.alpha * tw * 0.4;
          if (a < 0.006) continue;
          const c = MOTE_COLORS[m.hue];
          const sz = m.size * (0.85 + tw * 0.3);
          const gr = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, sz * 5);
          gr.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a * 0.5})`);
          gr.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
          ctx.fillStyle = gr;
          ctx.fillRect(m.x - sz * 5, m.y - sz * 5, sz * 10, sz * 10);
          ctx.beginPath();
          ctx.arc(m.x, m.y, sz * 0.4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,250,245,${a * 0.8})`;
          ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-0" aria-hidden="true">
      <canvas ref={glRef} className="absolute inset-0 w-full h-full" />
      <canvas ref={moteRef} className="absolute inset-0 w-full h-full mix-blend-screen" style={{ opacity: 0.6 }} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Cosmic Pool — 3D tilted WebGL surface                                    */
/* ═══════════════════════════════════════════════════════════════════════════ */

function CosmicPool({
  ripples,
  settledMemories,
  timeOrigin,
  visible,
}: {
  ripples: PoolRipple[];
  settledMemories: SettledGlow[];
  timeOrigin: number;
  visible: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glState = useRef<{
    gl: WebGLRenderingContext;
    u: Record<string, WebGLUniformLocation | null>;
  } | null>(null);
  const rafRef = useRef(0);

  // Keep refs synced so the animation loop reads latest data
  const ripplesRef = useRef(ripples);
  ripplesRef.current = ripples;
  const settledRef = useRef(settledMemories);
  settledRef.current = settledMemories;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio ?? 1, 1.5);
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const prog = buildProgram(gl, VERT, POOL_FRAG);
    if (!prog) return;
    gl.useProgram(prog);
    setupQuad(gl, prog);

    const u: Record<string, WebGLUniformLocation | null> = {
      t: gl.getUniformLocation(prog, 'u_time'),
      r: gl.getUniformLocation(prog, 'u_res'),
    };
    // ripple uniforms
    for (let i = 0; i < 8; i++) u[`r${i}`] = gl.getUniformLocation(prog, `u_r${i}`);
    // glow uniforms
    for (let i = 0; i < 4; i++) u[`g${i}`] = gl.getUniformLocation(prog, `u_g${i}`);
    u.gc = gl.getUniformLocation(prog, 'u_gc');

    glState.current = { gl, u };

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const t = (performance.now() - timeOrigin) / 1000;
      const s = glState.current;
      if (!s) return;
      const { gl: g, u: loc } = s;

      g.viewport(0, 0, g.canvas.width, g.canvas.height);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);

      g.uniform1f(loc.t, t);
      g.uniform2f(loc.r, g.canvas.width, g.canvas.height);

      // Set ripple uniforms
      const rp = ripplesRef.current;
      for (let i = 0; i < 8; i++) {
        const ri = rp[i];
        g.uniform4f(loc[`r${i}`], ri?.x ?? -1, ri?.y ?? -1, ri?.time ?? 0, ri?.intensity ?? 0);
      }

      // Set glow uniforms
      const sm = settledRef.current;
      for (let i = 0; i < 4; i++) {
        g.uniform2f(loc[`g${i}`], sm[i]?.x ?? -2, sm[i]?.y ?? -2);
      }
      g.uniform1f(loc.gc, Math.min(sm.length, 4));

      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [timeOrigin]);

  return (
    <div
      className={cn(
        'fixed bottom-0 left-[-15%] z-[2] transition-opacity duration-[2000ms]',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      style={{
        width: '130%',
        height: '48%',
        perspective: '900px',
        perspectiveOrigin: '50% 0%',
      }}
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{
          transform: 'rotateX(62deg)',
          transformOrigin: '50% 0%',
          background: 'transparent',
        }}
      />
      {/* Near-edge glow line */}
      <div
        className="absolute top-0 left-[8%] right-[8%] h-[2px] pointer-events-none"
        style={{
          background: 'linear-gradient(to right, transparent 0%, rgba(184,164,232,0.12) 30%, rgba(212,196,255,0.18) 50%, rgba(184,164,232,0.12) 70%, transparent 100%)',
          filter: 'blur(1px)',
          boxShadow: '0 0 12px rgba(184,164,232,0.08), 0 0 30px rgba(184,164,232,0.04)',
        }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Volumetric Pool Fog — animated wisps over the pool surface               */
/* ═══════════════════════════════════════════════════════════════════════════ */

interface FogWisp {
  x: number; y: number;
  vx: number; vy: number;
  rx: number; ry: number;  // radii (elliptical)
  alpha: number;
  phase: number;
  speed: number;
  color: number;  // 0=purple, 1=teal, 2=glow
  drift: number;  // lateral drift amplitude
}

const FOG_COLORS: [number, number, number][] = [
  [184, 164, 232],  // sophia-purple
  [89, 190, 173],   // teal
  [212, 196, 255],  // glow
  [160, 148, 205],  // muted purple
];

function createFogWisps(w: number, h: number): FogWisp[] {
  return Array.from({ length: 40 }, () => {
    const band = Math.random();  // 0=bottom, 1=top of fog region
    return {
      x: Math.random() * w * 1.4 - w * 0.2,
      y: h * (0.15 + band * 0.7),
      vx: (Math.random() - 0.5) * 0.15,
      vy: (Math.random() - 0.5) * 0.04,
      rx: 80 + Math.random() * 200,
      ry: 25 + Math.random() * 60,
      alpha: 0.03 + Math.random() * 0.06,
      phase: Math.random() * Math.PI * 2,
      speed: 0.15 + Math.random() * 0.35,
      color: Math.floor(Math.random() * 4),
      drift: 15 + Math.random() * 40,
    };
  });
}

function PoolFog({ intensity }: { intensity: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wispsRef = useRef<FogWisp[]>([]);
  const rafRef = useRef(0);
  const t0 = useRef(performance.now());
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      if (!wispsRef.current.length) {
        wispsRef.current = createFogWisps(rect.width, rect.height);
      }
    };
    resize();
    window.addEventListener('resize', resize);

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.width, h = canvas.height;
      const t = (performance.now() - t0.current) / 1000;
      const inten = intensityRef.current;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';

      for (const wisp of wispsRef.current) {
        // Slow lateral drift with sinusoidal motion
        wisp.x += wisp.vx + Math.sin(t * wisp.speed * 0.4 + wisp.phase) * 0.08;
        wisp.y += wisp.vy + Math.cos(t * wisp.speed * 0.3 + wisp.phase * 1.7) * 0.02;

        // Wrap horizontally
        if (wisp.x < -wisp.rx * 2) wisp.x = w + wisp.rx;
        if (wisp.x > w + wisp.rx * 2) wisp.x = -wisp.rx;
        // Soft vertical bounds
        if (wisp.y < h * 0.05) wisp.vy += 0.003;
        if (wisp.y > h * 0.95) wisp.vy -= 0.003;
        wisp.vy *= 0.998;

        // Pulsing opacity
        const pulse = (Math.sin(t * wisp.speed + wisp.phase) * 0.5 + 0.5);
        const breathe = 0.6 + pulse * 0.4;
        const a = wisp.alpha * breathe * (0.7 + inten * 0.6);
        if (a < 0.001) continue;

        // Drift offset
        const driftX = Math.sin(t * wisp.speed * 0.25 + wisp.phase) * wisp.drift;

        const cx = wisp.x + driftX;
        const cy = wisp.y;

        // Dynamic size — wisps gently expand and contract
        const sizeBreath = 1.0 + Math.sin(t * wisp.speed * 0.5 + wisp.phase * 2.3) * 0.15;
        const rx = wisp.rx * sizeBreath;
        const ry = wisp.ry * sizeBreath;

        const c = FOG_COLORS[wisp.color];

        // Elliptical radial gradient for wisp shape
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, ry / rx);
        const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        gr.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a * 1.2})`);
        gr.addColorStop(0.3, `rgba(${c[0]},${c[1]},${c[2]},${a * 0.7})`);
        gr.addColorStop(0.65, `rgba(${c[0]},${c[1]},${c[2]},${a * 0.25})`);
        gr.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
        ctx.fillStyle = gr;
        ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
        ctx.restore();
      }

      // Top-of-fog gradient mask — fog fades to transparent upward
      ctx.globalCompositeOperation = 'destination-in';
      const mask = ctx.createLinearGradient(0, 0, 0, h);
      mask.addColorStop(0, 'rgba(0,0,0,0)');
      mask.addColorStop(0.15, 'rgba(0,0,0,0.3)');
      mask.addColorStop(0.4, 'rgba(0,0,0,0.8)');
      mask.addColorStop(0.7, 'rgba(0,0,0,1)');
      mask.addColorStop(1, 'rgba(0,0,0,0.6)');
      ctx.fillStyle = mask;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = 'source-over';
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="fixed left-0 right-0 z-[3] pointer-events-none" style={{ bottom: '30%', height: '28%' }}>
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ opacity: 1 }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Memory Drop — luminous drop falling from orb to pool                     */
/* ═══════════════════════════════════════════════════════════════════════════ */

function MemoryDrop({
  startX,
  startY,
  onImpact,
}: {
  startX: number;
  startY: number;
  onImpact: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const impactCalled = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const targetY = window.innerHeight * 0.56;
    const duration = 750;
    const start = performance.now();

    let raf = 0;
    const animate = () => {
      const elapsed = performance.now() - start;
      const p = Math.min(elapsed / duration, 1);
      // Quadratic ease-in (gravity)
      const easedP = p * p;

      const currentY = startY + (targetY - startY) * easedP;
      const scale = 1 - p * 0.6;
      const opacity = p < 0.85 ? 0.9 : 0.9 * (1 - (p - 0.85) / 0.15);
      // Trail height grows as drop accelerates
      const trailH = 6 + p * 30;

      el.style.transform = `translate(${startX}px, ${currentY}px)`;
      el.style.opacity = String(opacity);

      const dropEl = el.firstElementChild as HTMLElement;
      if (dropEl) {
        dropEl.style.transform = `translate(-50%, -50%) scale(${scale})`;
      }

      const trail = el.querySelector('[data-trail]');
      if (trail) {
        trail.style.height = `${trailH}px`;
        trail.style.opacity = String(Math.min(p * 2, 0.6));
      }

      if (p < 1) {
        raf = requestAnimationFrame(animate);
      } else if (!impactCalled.current) {
        impactCalled.current = true;
        onImpact();
      }
    };
    raf = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(raf);
  }, [startX, startY, onImpact]);

  return (
    <div ref={ref} className="fixed z-[40] pointer-events-none" style={{ left: 0, top: 0, opacity: 0 }}>
      <div className="relative" style={{ transform: 'translate(-50%, -50%)' }}>
        {/* Main drop */}
        <div
          className="w-4 h-4 rounded-full"
          style={{
            background: 'radial-gradient(circle at 35% 35%, rgba(255,252,245,0.95), rgba(212,196,255,0.7) 45%, rgba(184,164,232,0.3) 75%, transparent)',
            boxShadow: '0 0 18px rgba(212,196,255,0.5), 0 0 40px rgba(184,164,232,0.2)',
          }}
        />
        {/* Glow halo */}
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(184,164,232,0.25), transparent 70%)',
            filter: 'blur(6px)',
          }}
        />
        {/* Trail */}
        <div
          data-trail=""
          className="absolute bottom-full left-1/2 -translate-x-1/2 w-[2px]"
          style={{
            height: 6,
            opacity: 0,
            background: 'linear-gradient(to top, rgba(212,196,255,0.6), rgba(184,164,232,0.15), transparent)',
            filter: 'blur(1px)',
          }}
        />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Impact Flash — expanding ring at drop impact point                       */
/* ═══════════════════════════════════════════════════════════════════════════ */

function ImpactFlash({ x, y, onDone }: { x: number; y: number; onDone: () => void }) {
  const ringRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ringRef.current?.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0)', opacity: '0.7' },
        { transform: 'translate(-50%,-50%) scale(4)', opacity: '0' },
      ],
      { duration: 800, fill: 'forwards', easing: 'cubic-bezier(0.0, 0.0, 0.2, 1)' },
    );
    flashRef.current?.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0)', opacity: '1' },
        { transform: 'translate(-50%,-50%) scale(2.5)', opacity: '0' },
      ],
      { duration: 450, fill: 'forwards', easing: 'ease-out' },
    );
    const t = setTimeout(onDone, 850);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-[35] pointer-events-none">
      <div
        ref={ringRef}
        className="absolute"
        style={{
          left: x, top: y, width: 60, height: 60, borderRadius: '50%',
          border: '1.5px solid rgba(212,196,255,0.5)',
          boxShadow: '0 0 20px rgba(184,164,232,0.3), inset 0 0 20px rgba(184,164,232,0.08)',
        }}
      />
      <div
        ref={flashRef}
        className="absolute"
        style={{
          left: x, top: y, width: 24, height: 24, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,250,240,0.8), rgba(212,196,255,0.4), transparent)',
          filter: 'blur(3px)',
        }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  OrbMistCanvas — inner life for each orb                                  */
/* ═══════════════════════════════════════════════════════════════════════════ */

function OrbMistCanvas({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const particles = useRef<
    { x: number; y: number; vx: number; vy: number; r: number; a: number; phase: number }[]
  >([]);
  const t0 = useRef(performance.now());

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const size = 400;
    canvas.width = size;
    canvas.height = size;
    const cx = size / 2, cy = size / 2, radius = size / 2 - 4;

    if (!particles.current.length) {
      particles.current = Array.from({ length: active ? 16 : 5 }, () => {
        const ang = Math.random() * Math.PI * 2;
        const dist = Math.random() * radius * 0.65;
        return {
          x: cx + Math.cos(ang) * dist,
          y: cy + Math.sin(ang) * dist,
          vx: (Math.random() - 0.5) * 0.12,
          vy: (Math.random() - 0.5) * 0.10,
          r: 8 + Math.random() * 22,
          a: 0.02 + Math.random() * 0.035,
          phase: Math.random() * Math.PI * 2,
        };
      });
    }

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const t = (performance.now() - t0.current) / 1000;

      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalCompositeOperation = 'screen';

      for (const p of particles.current) {
        p.x += p.vx + Math.sin(t * 0.3 + p.phase) * 0.06;
        p.y += p.vy + Math.cos(t * 0.25 + p.phase) * 0.05;
        const dx = p.x - cx, dy = p.y - cy;
        if (Math.sqrt(dx * dx + dy * dy) > radius * 0.72) {
          p.vx -= dx * 0.0008;
          p.vy -= dy * 0.0008;
        }
        const pulse = (Math.sin(t * 0.5 + p.phase) * 0.5 + 0.5) * 0.5 + 0.5;
        const alpha = p.a * pulse;
        const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        gr.addColorStop(0, `rgba(200,180,240,${alpha})`);
        gr.addColorStop(0.5, `rgba(230,170,195,${alpha * 0.5})`);
        gr.addColorStop(1, 'rgba(89,190,173,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }

      if (active) {
        for (let i = 0; i < 6; i++) {
          const ang = t * 0.18 * (i % 2 === 0 ? 1 : -1) + (i / 6) * Math.PI * 2;
          const orb = 35 + i * 18 + Math.sin(t * 0.35 + i) * 12;
          const sx = cx + Math.cos(ang) * orb;
          const sy = cy + Math.sin(ang) * orb;
          const spark = (Math.sin(t * 0.7 + i * 1.7) * 0.5 + 0.5) ** 2;
          if (spark < 0.08) continue;
          ctx.beginPath();
          ctx.arc(sx, sy, 1, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,248,240,${spark * 0.22})`;
          ctx.fill();
          const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 3.5);
          sg.addColorStop(0, `rgba(200,180,240,${spark * 0.12})`);
          sg.addColorStop(1, 'rgba(200,180,240,0)');
          ctx.fillStyle = sg;
          ctx.fillRect(sx - 3.5, sy - 3.5, 7, 7);
        }
      }

      ctx.restore();
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active]);

  return (
    <canvas
      ref={ref}
      className="absolute inset-0 w-full h-full rounded-full pointer-events-none"
      style={{ opacity: active ? 0.65 : 0.25 }}
    />
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Progress Indicator                                                       */
/* ═══════════════════════════════════════════════════════════════════════════ */

function ProgressIndicator({ total, reviewed }: { total: number; reviewed: number }) {
  return (
    <div className="flex items-center gap-3 mt-6 mb-1">
      <div className="flex items-center gap-2">
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            className="transition-all duration-500"
            style={{
              width: i < reviewed ? 20 : 6,
              height: 3,
              borderRadius: 2,
              background: i < reviewed
                ? 'linear-gradient(to right, rgba(184,164,232,0.5), rgba(212,196,255,0.4))'
                : 'rgba(255,255,255,0.08)',
              boxShadow: i < reviewed ? '0 0 8px rgba(184,164,232,0.15)' : 'none',
            }}
          />
        ))}
      </div>
      <span className="text-[9px] tracking-[0.1em] text-white/15">{reviewed}/{total}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Ethereal Memory Orb                                                      */
/* ═══════════════════════════════════════════════════════════════════════════ */

interface OrbProps {
  text: string;
  category?: string;
  position: 'left' | 'center' | 'right';
  isExiting?: boolean;
  exitType?: 'keep' | 'discard' | null;
  onKeep?: () => void;
  onDiscard?: () => void;
  onEdit?: () => void;
  onClick?: () => void;
  disabled?: boolean;
  confidence?: number;
  reason?: string;
  orbRef?: React.RefObject<HTMLDivElement | null>;
}

function MemoryOrb({
  text, category, position, isExiting, exitType,
  onKeep, onDiscard, onEdit, onClick, disabled,
  confidence, reason, orbRef,
}: OrbProps) {
  const isCenter = position === 'center';
  const cat = getCat(category);
  const [showReason, setShowReason] = useState(false);

  const posClasses = useMemo(() => {
    if (isExiting && exitType === 'keep') return 'translate-y-[-80px] scale-75 opacity-0';
    if (isExiting && exitType === 'discard') return 'scale-[0.85] opacity-0 blur-md';
    switch (position) {
      case 'left': return '-translate-x-[95%] translate-y-[8px] scale-[0.38]';
      case 'right': return 'translate-x-[95%] translate-y-[8px] scale-[0.38]';
      default: return 'translate-x-0 scale-100';
    }
  }, [position, isExiting, exitType]);

  return (
    <div
      className={cn(
        'absolute transition-all ease-out',
        isCenter ? 'duration-600 z-20' : 'duration-700 z-10',
        posClasses,
        !isCenter && 'opacity-[0.08] blur-[8px]',
        !isCenter && !disabled && 'cursor-pointer hover:opacity-[0.15] hover:blur-[4px]',
      )}
      onClick={!isCenter ? onClick : undefined}
      role={isCenter ? 'article' : 'button'}
      aria-label={isCenter ? `Memory: ${text}` : 'Navigate to memory'}
      tabIndex={isCenter ? 0 : -1}
    >
      {/* Outer ambient glow */}
      {isCenter && !isExiting && (
        <>
          <div
            className="absolute -z-30 rounded-full"
            style={{
              inset: '-55%',
              background: 'radial-gradient(circle, rgba(184,164,232,0.04) 0%, rgba(89,190,173,0.015) 35%, transparent 55%)',
              filter: 'blur(70px)',
            }}
          />
          <div
            className="absolute inset-[-3px] -z-10 rounded-full"
            style={{
              boxShadow: `
                0 0 40px 2px rgba(184,164,232,0.06),
                0 0 75px 4px rgba(212,196,255,0.025),
                inset 0 0 28px 2px rgba(184,164,232,0.035)
              `,
            }}
          />
          {/* Downward glow onto pool */}
          <div
            className="absolute left-1/2 -translate-x-1/2 rounded-full -z-20"
            style={{
              top: '70%',
              width: '60%',
              height: '120%',
              background: 'radial-gradient(ellipse 100% 70%, rgba(184,164,232,0.03) 0%, transparent 60%)',
              filter: 'blur(40px)',
            }}
          />
        </>
      )}

      {/* Keep exit flash */}
      {isExiting && exitType === 'keep' && (
        <div
          className="absolute inset-0 -z-10 rounded-full animate-pulse"
          style={{
            transform: 'scale(1.8)',
            background: 'radial-gradient(circle, rgba(212,196,255,0.30) 0%, transparent 50%)',
            filter: 'blur(40px)',
          }}
        />
      )}

      {/* Confidence ring */}
      {isCenter && !isExiting && confidence != null && (
        <svg
          className="absolute inset-[-6px] w-[calc(100%+12px)] h-[calc(100%+12px)] -z-[5] pointer-events-none"
          viewBox="0 0 100 100"
          style={{ transform: 'rotate(-90deg)' }}
        >
          <circle cx="50" cy="50" r="49" fill="none" stroke="rgba(255,255,255,0.02)" strokeWidth="0.3" />
          <circle
            cx="50" cy="50" r="49" fill="none" stroke="url(#confGrad)" strokeWidth="0.5"
            strokeDasharray={`${confidence * 308} 308`} strokeLinecap="round"
            className="transition-all duration-1000 ease-out"
          />
          <defs>
            <linearGradient id="confGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="rgba(184,164,232,0.4)" />
              <stop offset="100%" stopColor="rgba(89,190,173,0.2)" />
            </linearGradient>
          </defs>
        </svg>
      )}

      {/* Orb body */}
      <div
        ref={isCenter ? orbRef : undefined}
        className={cn(
          'relative rounded-full overflow-hidden',
          isCenter
            ? 'w-[260px] h-[260px] sm:w-[310px] sm:h-[310px] md:w-[350px] md:h-[350px]'
            : 'w-[260px] h-[260px] sm:w-[310px] sm:h-[310px]',
        )}
        style={{
          background: isCenter
            ? `radial-gradient(ellipse 120% 100% at 50% 100%, rgba(184,164,232,0.07) 0%, transparent 40%),
               radial-gradient(ellipse 100% 120% at 50% 0%, rgba(89,190,173,0.03) 0%, transparent 35%),
               radial-gradient(circle at 50% 50%, rgba(10,10,18,0.88), rgba(3,3,8,0.95))`
            : 'radial-gradient(circle at 50% 55%, rgba(10,10,18,0.7), rgba(3,3,8,0.85) 85%)',
          boxShadow: isCenter
            ? `inset 0 -28px 65px -28px rgba(184,164,232,0.10),
               inset 0 28px 45px -28px rgba(89,190,173,0.04),
               inset 0 0 0 1px rgba(255,255,255,0.05),
               0 0 55px -15px rgba(184,164,232,0.05),
               0 14px 45px -25px rgba(0,0,0,0.5)`
            : 'inset 0 -15px 30px -15px rgba(184,164,232,0.05), inset 0 0 0 1px rgba(255,255,255,0.03)',
          backdropFilter: isCenter ? 'blur(2px)' : undefined,
        }}
      >
        <OrbMistCanvas active={isCenter} />

        {/* Specular crescent */}
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            top: '4%', left: '12%', width: '42%', height: '18%',
            background: 'radial-gradient(ellipse at 40% 40%, rgba(255,252,245,0.10), rgba(255,252,245,0.02) 40%, transparent 70%)',
            filter: 'blur(5px)',
          }}
        />
        {isCenter && (
          <div
            className="absolute rounded-full pointer-events-none"
            style={{
              top: '14%', right: '5%', width: '16%', height: '46%',
              background: 'radial-gradient(ellipse at 80% 50%, rgba(89,190,173,0.05), transparent 70%)',
              filter: 'blur(10px)',
            }}
          />
        )}

        {/* Inner fresnel */}
        {isCenter && (
          <div
            className="absolute inset-[1px] rounded-full pointer-events-none"
            style={{
              background: 'linear-gradient(175deg, rgba(255,252,245,0.05) 0%, transparent 20%, transparent 80%, rgba(184,164,232,0.03) 100%)',
            }}
          />
        )}

        {/* Bottom ambient */}
        {isCenter && (
          <div
            className="absolute bottom-0 left-[10%] right-[10%] pointer-events-none"
            style={{
              height: '32%',
              background: 'radial-gradient(ellipse 100% 70% at 50% 100%, rgba(184,164,232,0.05), transparent 70%)',
              filter: 'blur(12px)',
            }}
          />
        )}

        {/* Glass depth */}
        <div
          className="absolute inset-[1px] rounded-full pointer-events-none"
          style={{
            boxShadow: isCenter
              ? 'inset 0 3px 35px rgba(0,0,0,0.35), inset 0 -3px 22px rgba(184,164,232,0.025)'
              : 'inset 0 2px 18px rgba(0,0,0,0.25)',
          }}
        />

        {/* Content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center px-8 sm:px-11 z-10">
          {isCenter && (
            <span className="text-[10px] tracking-[0.14em] uppercase mb-4" style={{ color: 'rgba(184,164,232,0.4)' }}>
              {cat.icon} {cat.label}
            </span>
          )}
          <p className={cn(
            'font-cormorant text-center leading-relaxed',
            isCenter ? 'text-[16px] sm:text-[19px] text-white/80' : 'text-[14px] text-white/25',
          )}>
            {text}
          </p>

          {isCenter && !isExiting && reason && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowReason(!showReason); }}
              className="mt-3 text-[9px] tracking-[0.1em] uppercase transition-colors"
              style={{ color: showReason ? 'rgba(184,164,232,0.4)' : 'rgba(255,255,255,0.10)' }}
            >
              {showReason ? 'hide' : 'why this?'}
            </button>
          )}
          {showReason && isCenter && (
            <p className="mt-2 text-[11px] text-center max-w-[200px] motion-safe:animate-fadeIn" style={{ color: 'rgba(184,164,232,0.3)' }}>
              {reason}
            </p>
          )}

          {/* Actions */}
          {isCenter && !isExiting && (
            <div className="flex items-center gap-3 mt-5 motion-safe:animate-fadeIn" style={{ animationDelay: '200ms' }}>
              <button
                onClick={(e) => { e.stopPropagation(); onKeep?.(); }}
                disabled={disabled}
                className={cn(
                  'group flex items-center gap-2 px-5 py-2 rounded-full transition-all duration-300',
                  'bg-white/[0.04] border text-white/40',
                  'hover:bg-white/[0.08] hover:text-white/75',
                  'disabled:opacity-30 disabled:cursor-not-allowed',
                )}
                style={{ borderColor: 'rgba(184,164,232,0.08)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(184,164,232,0.22)';
                  e.currentTarget.style.boxShadow = '0 0 25px rgba(184,164,232,0.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(184,164,232,0.08)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <Check className="w-3.5 h-3.5 transition-transform group-hover:scale-110" />
                <span className="text-[10px] tracking-[0.08em] uppercase">Keep this</span>
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); onEdit?.(); }}
                disabled={disabled}
                className="p-2 rounded-full transition-all bg-white/[0.03] border border-white/[0.05] text-white/20 hover:bg-white/[0.06] hover:text-white/45 disabled:opacity-30"
                aria-label="Edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={(e) => { e.stopPropagation(); onDiscard?.(); }}
                disabled={disabled}
                className={cn(
                  'group flex items-center gap-2 px-5 py-2 rounded-full transition-all duration-300',
                  'bg-white/[0.04] border border-white/[0.05] text-white/25',
                  'hover:bg-red-500/[0.06] hover:text-red-300/45 hover:border-red-400/[0.10]',
                  'disabled:opacity-30 disabled:cursor-not-allowed',
                )}
              >
                <X className="w-3.5 h-3.5 transition-transform group-hover:scale-110" />
                <span className="text-[10px] tracking-[0.08em] uppercase">Let it go</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Main Page                                                                */
/* ═══════════════════════════════════════════════════════════════════════════ */

export default function PrototypeA() {
  // Core state
  const [decisions, setDecisions] = useState<Record<string, { decision: Decision }>>({});
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [exitType, setExitType] = useState<'keep' | 'discard' | null>(null);
  const [showEntrance, setShowEntrance] = useState(false);
  const [showPool, setShowPool] = useState(false);

  // Pool state
  const [ripples, setRipples] = useState<PoolRipple[]>([]);
  const [settledMemories, setSettledMemories] = useState<SettledGlow[]>([]);
  const [activeDrop, setActiveDrop] = useState<ActiveDrop | null>(null);
  const [impactFlash, setImpactFlash] = useState<{ x: number; y: number } | null>(null);

  // Refs
  const mountTime = useRef(performance.now());
  const orbRef = useRef<HTMLDivElement>(null);

  // Entrance choreography
  useEffect(() => {
    const t1 = setTimeout(() => setShowPool(true), 200);
    const t2 = setTimeout(() => setShowEntrance(true), 400);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const activeCandidates = useMemo(
    () => MOCK_CANDIDATES.filter((c) => !decisions[c.id] || decisions[c.id].decision === 'idle'),
    [decisions],
  );
  const reviewedCount = MOCK_CANDIDATES.length - activeCandidates.length;

  const makeDecision = useCallback(
    (id: string, decision: Decision) => {
      // Trigger drop for "keep"
      if (decision === 'approved' && orbRef.current) {
        const rect = orbRef.current.getBoundingClientRect();
        setActiveDrop({
          id,
          startX: rect.left + rect.width / 2,
          startY: rect.top + rect.height / 2,
        });
      }

      setExitingId(id);
      setExitType(decision === 'approved' ? 'keep' : 'discard');

      setTimeout(() => {
        setDecisions((prev) => ({ ...prev, [id]: { decision } }));
        setExitingId(null);
        setExitType(null);
        setFocusedIndex((prev) => Math.min(prev, activeCandidates.length - 2));
      }, decision === 'approved' ? 900 : 650);
    },
    [activeCandidates.length],
  );

  const handleDropImpact = useCallback(() => {
    const now = (performance.now() - mountTime.current) / 1000;

    // Pool ripple — near edge, horizontally centered
    // Near edge = uv.y ≈ 0.85 (top of canvas in WebGL = uv.y close to 1)
    const poolX = 0.5 + (Math.random() - 0.5) * 0.06;
    const poolY = 0.82 + Math.random() * 0.06;
    setRipples((prev) => [...prev.slice(-6), { x: poolX, y: poolY, time: now, intensity: 1.0 }]);

    // Settled glow — spread across pool
    const glowIdx = settledMemories.length;
    const offset = glowIdx * 0.15 - 0.22;
    setSettledMemories((prev) => [
      ...prev,
      { x: 0.5 + offset, y: 0.65 + Math.random() * 0.12 },
    ]);

    // Screen-space flash
    const flashX = activeDrop?.startX ?? window.innerWidth / 2;
    const flashY = window.innerHeight * 0.56;
    setImpactFlash({ x: flashX, y: flashY });

    setActiveDrop(null);
  }, [activeDrop, settledMemories.length]);

  const clearFlash = useCallback(() => setImpactFlash(null), []);

  // Navigation
  const goPrev = useCallback(() => {
    if (focusedIndex > 0) setFocusedIndex((i) => i - 1);
  }, [focusedIndex]);
  const goNext = useCallback(() => {
    if (focusedIndex < activeCandidates.length - 1) setFocusedIndex((i) => i + 1);
  }, [focusedIndex, activeCandidates.length]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [goPrev, goNext]);

  const safeFocused = Math.max(0, Math.min(focusedIndex, activeCandidates.length - 1));
  const visible = useMemo(() => {
    const items: { candidate: (typeof MOCK_CANDIDATES)[0]; position: 'left' | 'center' | 'right' }[] = [];
    if (safeFocused > 0) items.push({ candidate: activeCandidates[safeFocused - 1], position: 'left' });
    if (activeCandidates[safeFocused]) items.push({ candidate: activeCandidates[safeFocused], position: 'center' });
    if (safeFocused < activeCandidates.length - 1)
      items.push({ candidate: activeCandidates[safeFocused + 1], position: 'right' });
    return items;
  }, [activeCandidates, safeFocused]);

  const allDone = activeCandidates.length === 0 && reviewedCount > 0;

  return (
    <div className="relative min-h-screen bg-[#030308]">
      {/* Layer 0: Aurora + stars */}
      <AuroraBackground />

      {/* Layer 2: Cosmic pool */}
      <CosmicPool
        ripples={ripples}
        settledMemories={settledMemories}
        timeOrigin={mountTime.current}
        visible={showPool}
      />

      {/* Layer 3: Pool fog */}
      <PoolFog intensity={Math.min(settledMemories.length / 4, 1)} />

      {/* Layer 4: Pool upward glow — intensifies with settled memories */}
      <div
        className="fixed left-0 right-0 z-[4] pointer-events-none transition-opacity duration-[2000ms]"
        style={{
          bottom: '44%',
          height: 100,
          opacity: settledMemories.length > 0 ? 0.5 : 0.15,
          background: `linear-gradient(to top,
            rgba(184,164,232,${0.015 + settledMemories.length * 0.008}),
            transparent
          )`,
          filter: 'blur(40px)',
        }}
      />

      {/* Active drop */}
      {activeDrop && (
        <MemoryDrop
          startX={activeDrop.startX}
          startY={activeDrop.startY}
          onImpact={handleDropImpact}
        />
      )}

      {/* Impact flash */}
      {impactFlash && (
        <ImpactFlash x={impactFlash.x} y={impactFlash.y} onDone={clearFlash} />
      )}

      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 px-4 py-4">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <button className="p-2.5 rounded-xl bg-white/[0.04] backdrop-blur-md border border-white/[0.06] hover:bg-white/[0.08] transition-colors">
            <ArrowLeft className="w-5 h-5 text-white/35" />
          </button>
          <span
            className={cn(
              'font-cormorant text-[13px] tracking-[0.08em] text-white/18 transition-opacity duration-1000',
              showEntrance ? 'opacity-100' : 'opacity-0',
            )}
          >
            session recap
          </span>
          <button className="p-2.5 rounded-xl bg-white/[0.04] backdrop-blur-md border border-white/[0.06] hover:bg-white/[0.08] transition-colors">
            <Home className="w-5 h-5 text-white/35" />
          </button>
        </div>
      </header>

      {/* Main content — positioned above pool */}
      <main className="relative z-10 flex flex-col items-center pt-20 pb-24 px-4" style={{ minHeight: '60vh' }}>
        {/* Key Takeaway */}
        <div
          className={cn(
            'flex flex-col items-center text-center transition-all duration-[1200ms] ease-out',
            showEntrance ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5',
          )}
        >
          <span className="text-[10px] tracking-[0.14em] uppercase mb-4" style={{ color: 'rgba(184,164,232,0.3)' }}>
            key takeaway
          </span>
          <div className="relative max-w-2xl">
            <div
              className="absolute inset-0 -z-10"
              style={{
                background: 'radial-gradient(ellipse 80% 60% at 50% 50%, rgba(184,164,232,0.05), rgba(89,190,173,0.02) 40%, transparent 65%)',
                filter: 'blur(45px)',
                transform: 'scale(2) translateY(10%)',
              }}
            />
            <h1 className="font-cormorant text-[26px] sm:text-[32px] md:text-[38px] font-light text-white/[0.88] leading-snug">
              {MOCK_TAKEAWAY}
            </h1>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-0 mt-6" aria-hidden="true">
            <div className="w-16 sm:w-24 h-px" style={{ background: 'linear-gradient(to right, transparent, rgba(184,164,232,0.2))' }} />
            <div className="relative mx-0">
              <div className="w-[5px] h-[5px] rounded-full" style={{ background: 'rgba(184,164,232,0.5)' }} />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full"
                style={{ background: 'radial-gradient(circle, rgba(184,164,232,0.35), transparent 70%)' }} />
            </div>
            <div className="w-16 sm:w-24 h-px" style={{ background: 'linear-gradient(to left, transparent, rgba(184,164,232,0.2))' }} />
          </div>

          <ProgressIndicator total={MOCK_CANDIDATES.length} reviewed={reviewedCount} />
        </div>

        {/* Orb orbit */}
        {!allDone && (
          <div
            className={cn(
              'relative w-full flex items-center justify-center transition-all duration-[1200ms] ease-out',
              showEntrance ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8',
            )}
            style={{ minHeight: 400, transitionDelay: '300ms' }}
          >
            {safeFocused > 0 && (
              <button
                onClick={goPrev}
                className="absolute left-2 sm:left-8 z-30 p-2.5 rounded-full bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.08] transition-all backdrop-blur-sm"
                aria-label="Previous"
              >
                <ChevronLeft className="w-5 h-5 text-white/20" />
              </button>
            )}
            {safeFocused < activeCandidates.length - 1 && (
              <button
                onClick={goNext}
                className="absolute right-2 sm:right-8 z-30 p-2.5 rounded-full bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.08] transition-all backdrop-blur-sm"
                aria-label="Next"
              >
                <ChevronRight className="w-5 h-5 text-white/20" />
              </button>
            )}

            <div className="relative w-full h-[360px] sm:h-[420px] flex items-center justify-center">
              {visible.map(({ candidate, position }) => (
                <MemoryOrb
                  key={`${candidate.id}-${position}`}
                  text={candidate.text}
                  category={candidate.category}
                  position={position}
                  confidence={candidate.confidence}
                  reason={candidate.reason}
                  isExiting={candidate.id === exitingId}
                  exitType={candidate.id === exitingId ? exitType : null}
                  onKeep={() => makeDecision(candidate.id, 'approved')}
                  onDiscard={() => makeDecision(candidate.id, 'discarded')}
                  onEdit={() => makeDecision(candidate.id, 'edited')}
                  onClick={() => {
                    const idx = activeCandidates.findIndex((c) => c.id === candidate.id);
                    if (idx >= 0) setFocusedIndex(idx);
                  }}
                  disabled={!!exitingId}
                  orbRef={position === 'center' ? orbRef : undefined}
                />
              ))}
            </div>
          </div>
        )}

        {/* Completed state */}
        {allDone && (
          <div className="flex flex-col items-center mt-6 motion-safe:animate-fadeIn">
            <div
              className="w-[280px] h-[280px] rounded-full flex flex-col items-center justify-center relative overflow-hidden"
              style={{
                background: `radial-gradient(ellipse 120% 100% at 50% 100%, rgba(184,164,232,0.08), transparent 40%),
                             radial-gradient(circle at 50% 50%, rgba(10,10,18,0.9), rgba(3,3,8,0.95))`,
                boxShadow: `inset 0 -28px 65px -28px rgba(184,164,232,0.12),
                            inset 0 28px 45px -28px rgba(89,190,173,0.03),
                            inset 0 0 0 1px rgba(255,255,255,0.05),
                            0 0 55px -15px rgba(184,164,232,0.05)`,
              }}
            >
              <OrbMistCanvas active />
              <div className="relative z-10 flex flex-col items-center">
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
                  style={{ background: 'rgba(184,164,232,0.06)', border: '1px solid rgba(184,164,232,0.1)' }}
                >
                  <Check className="w-6 h-6" style={{ color: 'rgba(184,164,232,0.45)' }} />
                </div>
                <p className="font-cormorant text-[17px] text-white/60">all memories reviewed</p>
                <p className="text-[11px] tracking-[0.06em] text-white/22 mt-1">
                  {reviewedCount} {reviewedCount === 1 ? 'memory' : 'memories'} in the pool
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Reflection card */}
        <div
          className={cn(
            'flex flex-col items-center text-center mt-8 max-w-xl transition-all duration-[1200ms] ease-out',
            showEntrance ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6',
          )}
          style={{ transitionDelay: '700ms' }}
        >
          <div
            className="relative w-full rounded-2xl backdrop-blur-xl px-6 py-5 overflow-hidden"
            style={{
              background: 'rgba(10,8,16,0.50)',
              border: '1px solid rgba(184,164,232,0.06)',
              boxShadow: '0 0 35px rgba(0,0,0,0.3), inset 0 0 25px rgba(184,164,232,0.015)',
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="text-base">💭</span>
              <p className="font-cormorant italic text-[14px] tracking-[0.04em]" style={{ color: 'rgba(184,164,232,0.35)' }}>
                Something to reflect on
              </p>
            </div>
            <p className="font-cormorant text-[17px] leading-relaxed text-white/50 text-left">
              {MOCK_REFLECTION.prompt}
            </p>
            <button
              className="mt-4 px-4 py-1.5 rounded-full transition-all duration-300 text-[10px] tracking-[0.08em] uppercase text-white/22"
              style={{ background: 'rgba(184,164,232,0.04)', border: '1px solid rgba(184,164,232,0.07)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(184,164,232,0.08)';
                e.currentTarget.style.color = 'rgba(255,255,255,0.45)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(184,164,232,0.04)';
                e.currentTarget.style.color = 'rgba(255,255,255,0.22)';
              }}
            >
              Sit with this for a moment →
            </button>
          </div>
        </div>
      </main>

      {/* Bottom bar */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 backdrop-blur-[20px] border-t"
        style={{ background: 'rgba(3,3,8,0.6)', borderColor: 'rgba(184,164,232,0.04)' }}
      >
        <div className="px-4 py-4 max-w-2xl mx-auto flex items-center justify-between">
          <button className="px-4 py-2 rounded-full text-[11px] tracking-[0.08em] uppercase text-white/25 hover:text-white/45 hover:bg-white/[0.04] transition-colors">
            Return home
          </button>
          <button
            className={cn(
              'px-5 py-2 rounded-full text-[11px] tracking-[0.08em] uppercase transition-all',
              allDone ? 'text-white/60 hover:text-white/80' : 'text-white/18 cursor-default',
            )}
            style={{
              background: allDone ? 'rgba(184,164,232,0.08)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${allDone ? 'rgba(184,164,232,0.15)' : 'rgba(255,255,255,0.04)'}`,
              boxShadow: allDone ? '0 0 22px rgba(184,164,232,0.08)' : 'none',
            }}
          >
            {allDone ? 'complete' : 'review all memories'}
          </button>
        </div>
      </div>
    </div>
  );
}
