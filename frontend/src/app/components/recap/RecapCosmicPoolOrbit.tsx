'use client';

import { Check, ChevronLeft, ChevronRight, Pencil, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

import { haptic } from '../../hooks/useHaptics';
import { logger } from '../../lib/error-logger';
import {
  getRecapCategoryPresentation,
  TAG_LABELS,
  type MemoryCandidateV1,
  type MemoryDecision,
} from '../../lib/recap-types';
import { cn } from '../../lib/utils';
import { OnboardingTipGuard } from '../onboarding';

import {
  getOrbitCandidateBuckets,
  getSafeFocusedIndex,
  getVisibleOrbitCandidates,
  normalizeOrbitCandidates,
} from './RecapMemoryOrbitUtils';

interface RecapMemoryOrbitProps {
  takeaway?: string;
  candidates?: MemoryCandidateV1[];
  decisions: Record<string, { decision: MemoryDecision; editedText?: string }>;
  onDecisionChange: (candidateId: string, decision: MemoryDecision, editedText?: string) => void;
  reflectionPrompt?: string;
  reflectionTag?: string;
  onReflect?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  className?: string;
}

interface PoolRipple {
  x: number;
  y: number;
  time: number;
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

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  phase: number;
  speed: number;
  depth: number;
  hue: number;
}

interface FogWisp {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rx: number;
  ry: number;
  alpha: number;
  phase: number;
  speed: number;
  color: number;
  drift: number;
}

interface ApprovedMemoryRow {
  id: string;
  text: string;
  isEdited: boolean;
}

interface MemoryOrbProps {
  candidate: MemoryCandidateV1;
  position: 'left' | 'center' | 'right';
  isExiting: boolean;
  exitType: 'keep' | 'discard' | null;
  onKeep: () => void;
  onEdit: (editedText: string) => void;
  onDiscard: () => void;
  onClick?: () => void;
  disabled?: boolean;
  orbRef?: RefObject<HTMLDivElement | null>;
}

const KEEP_ANIMATION_MS = 700;
const DISCARD_ANIMATION_MS = 600;
const DROP_DURATION_MS = 420;
const IS_TEST_ENV = process.env.NODE_ENV === 'test';

const VERT = `attribute vec2 pos;void main(){gl_Position=vec4(pos,0,1);}`;

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

  vec3 col=vec3(0.012,0.012,0.024);
  col+=mix(c_purple,c_teal,0.5)*exp(-dot(p,p)*2.5)*0.06;

  float neb=fbm3(p*1.8+t*0.015);
  float neb2=fbm3(p*2.5+vec2(5.0)+t*0.01);
  col+=c_purple*neb*0.025;
  col+=c_teal*neb2*0.012;

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

float aurora(vec2 uv,float t,float spd,float freq,float off){
  float w=uv.x*freq+off;
  float n1=fbm(vec2(w*0.5,t*spd*0.3));
  float n2=fbm(vec2(w*0.8+5.0,t*spd*0.2+3.0));
  float c=sin(w+n1*4.0+t*spd)*0.5+0.5;
  c*=sin(w*0.7+n2*3.0-t*spd*0.5)*0.5+0.5;
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

  float depth=smoothstep(0.0,0.85,uv.y);

  float n1=noise(p*3.0+t*0.08);
  float n2=noise(p*5.0-t*0.06+vec2(7.0,3.0));
  float n3=noise(p*8.0+t*0.12+vec2(2.0,11.0));
  vec2 distort=vec2(
    (n1-0.5)*0.06+(n2-0.5)*0.03+(n3-0.5)*0.015,
    (n1-0.5)*0.04+(n2-0.5)*0.025
  );

  float tr=0.0;
  tr+=ripple(uv,u_r0);tr+=ripple(uv,u_r1);tr+=ripple(uv,u_r2);tr+=ripple(uv,u_r3);
  tr+=ripple(uv,u_r4);tr+=ripple(uv,u_r5);tr+=ripple(uv,u_r6);tr+=ripple(uv,u_r7);
  distort+=vec2(tr*0.04,tr*0.03);

  vec2 refUV=vec2(uv.x,1.0-uv.y)+distort;
  float a1=aurora(refUV,t,0.12,3.5,0.0);
  float a2=aurora(refUV,t,0.09,2.8,2.5);
  float a3=aurora(refUV,t,0.07,4.2,5.0);

  vec3 col=vec3(0.008,0.008,0.018);

  float reflStr=0.55*depth;
  col+=c_purple*a1*0.40*reflStr;
  col+=c_amber *a2*0.28*reflStr;
  col+=c_teal  *a3*0.22*reflStr;
  col+=c_glow*pow(max(a1,max(a2,a3)),3.0)*0.18*reflStr;

  float neb=fbm(p*2.0+t*0.02);
  col+=mix(c_purple,c_teal,neb)*0.015*depth;

  float fresnel=pow(depth,0.7);
  col*=0.6+fresnel*0.6;

  float sheen=pow(max(n1*n2,0.0),3.0)*0.08;
  col+=c_glow*sheen*depth;

  col+=mix(c_amber,c_glow,0.5)*tr*0.55;
  col+=vec3(1.0,0.98,0.95)*pow(tr,2.5)*0.30;

  float tg=0.0;
  if(u_gc>0.5)tg+=glow(uv,u_g0,0.0);
  if(u_gc>1.5)tg+=glow(uv,u_g1,1.0);
  if(u_gc>2.5)tg+=glow(uv,u_g2,2.0);
  if(u_gc>3.5)tg+=glow(uv,u_g3,3.0);
  col+=mix(c_purple,c_amber,0.3)*tg;

  col+=c_glow*smoothstep(0.1,0.0,1.0-uv.y)*0.035;
  float sh=smoothstep(0.015,0.0,1.0-uv.y)*smoothstep(0.0,0.004,1.0-uv.y);
  sh*=sin(uv.x*55.0+t*0.5)*0.5+0.5;
  col+=c_glow*sh*0.10;

  float vig=smoothstep(0.0,0.18,uv.x)*smoothstep(1.0,0.82,uv.x);
  vig*=smoothstep(0.0,0.12,uv.y)*smoothstep(1.0,0.7,uv.y);
  col*=vig;

  float alpha=smoothstep(0.0,0.12,uv.y)*smoothstep(1.0,0.72,uv.y);
  alpha*=smoothstep(0.0,0.15,uv.x)*smoothstep(1.0,0.85,uv.x);

  col=col/(col+0.5);col=pow(col,vec3(0.92));
  gl_FragColor=vec4(col,alpha);
}
`;

const MOTE_COLORS: [number, number, number][] = [
  [184, 164, 232],
  [242, 179, 107],
  [89, 190, 173],
];

const FOG_COLORS: [number, number, number][] = [
  [184, 164, 232],
  [89, 190, 173],
  [212, 196, 255],
  [160, 148, 205],
];

function getCandidateText(candidate: MemoryCandidateV1) {
  return (candidate.text ?? candidate.memory ?? '').trim();
}

function getSettledGlowSlot(index: number): SettledGlow {
  const offsets = [-0.22, -0.08, 0.08, 0.22];
  const lanes = [0.64, 0.72, 0.68, 0.76];
  return {
    x: 0.5 + offsets[index % offsets.length] + Math.floor(index / offsets.length) * 0.02,
    y: lanes[index % lanes.length],
  };
}

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

function createFogWisps(w: number, h: number): FogWisp[] {
  return Array.from({ length: 40 }, () => {
    const band = Math.random();
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

function compileShader(gl: WebGLRenderingContext, src: string, type: number) {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    logger.warn('Recap shader compilation failed', {
      component: 'RecapCosmicPoolOrbit',
      action: 'compile_shader',
      metadata: { info: gl.getShaderInfoLog(shader) ?? undefined },
    });
    return null;
  }
  return shader;
}

function buildProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string) {
  const program = gl.createProgram();
  if (!program) {
    return null;
  }
  const vertexShader = compileShader(gl, vertSrc, gl.VERTEX_SHADER);
  const fragmentShader = compileShader(gl, fragSrc, gl.FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) {
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    logger.warn('Recap shader linking failed', {
      component: 'RecapCosmicPoolOrbit',
      action: 'link_program',
      metadata: { info: gl.getProgramInfoLog(program) ?? undefined },
    });
    return null;
  }
  return program;
}

function setupQuad(gl: WebGLRenderingContext, program: WebGLProgram) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, 'pos');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
}

function AuroraBackground() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const moteRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    gl: WebGLRenderingContext;
    uniforms: Record<string, WebGLUniformLocation | null>;
  } | null>(null);
  const motesRef = useRef<Mote[]>([]);
  const mouseRef = useRef({ x: 0.5, y: 0.5 });
  const rafRef = useRef(0);
  const t0 = useRef(performance.now());

  useEffect(() => {
    if (IS_TEST_ENV) {
      return;
    }

    const glCanvas = glRef.current;
    const moteCanvas = moteRef.current;
    if (!glCanvas || !moteCanvas) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      glCanvas.width = Math.round(w * dpr);
      glCanvas.height = Math.round(h * dpr);
      glCanvas.style.width = `${w}px`;
      glCanvas.style.height = `${h}px`;
      moteCanvas.width = w;
      moteCanvas.height = h;
      if (!motesRef.current.length) {
        motesRef.current = createMotes(w, h);
      }
    };
    resize();
    window.addEventListener('resize', resize);

    const gl = glCanvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) {
      return () => window.removeEventListener('resize', resize);
    }

    const program = buildProgram(gl, VERT, BG_FRAG);
    if (!program) {
      return () => window.removeEventListener('resize', resize);
    }

    gl.useProgram(program);
    setupQuad(gl, program);
    stateRef.current = {
      gl,
      uniforms: {
        t: gl.getUniformLocation(program, 'u_time'),
        r: gl.getUniformLocation(program, 'u_res'),
        m: gl.getUniformLocation(program, 'u_mouse'),
      },
    };

    const onMove = (event: MouseEvent) => {
      mouseRef.current.x = event.clientX / window.innerWidth;
      mouseRef.current.y = event.clientY / window.innerHeight;
    };
    window.addEventListener('mousemove', onMove);

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const t = (performance.now() - t0.current) / 1000;
      const { x, y } = mouseRef.current;

      if (stateRef.current) {
        const { gl: g, uniforms } = stateRef.current;
        g.viewport(0, 0, g.canvas.width, g.canvas.height);
        g.uniform1f(uniforms.t, t);
        g.uniform2f(uniforms.r, g.canvas.width, g.canvas.height);
        g.uniform2f(uniforms.m, x, 1 - y);
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      }

      const ctx = moteCanvas.getContext('2d');
      if (!ctx) {
        return;
      }

      const w = moteCanvas.width;
      const h = moteCanvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'screen';
      for (const mote of motesRef.current) {
        mote.x += mote.vx + (x - 0.5) * 0.12 * (0.3 + mote.depth * 0.7);
        mote.y += mote.vy;
        if (mote.x < -10) mote.x = w + 10;
        if (mote.x > w + 10) mote.x = -10;
        if (mote.y < -10) {
          mote.y = h + 10;
          mote.x = Math.random() * w;
        }
        if (mote.y > h + 10) mote.y = -10;

        const twinkle = (Math.sin(t * mote.speed + mote.phase) * 0.5 + 0.5) ** 2;
        const alpha = mote.alpha * twinkle * 0.4;
        if (alpha < 0.006) {
          continue;
        }
        const color = MOTE_COLORS[mote.hue];
        const size = mote.size * (0.85 + twinkle * 0.3);
        const gradient = ctx.createRadialGradient(mote.x, mote.y, 0, mote.x, mote.y, size * 5);
        gradient.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${alpha * 0.5})`);
        gradient.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(mote.x - size * 5, mote.y - size * 5, size * 10, size * 10);
        ctx.beginPath();
        ctx.arc(mote.x, mote.y, size * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,250,245,${alpha * 0.8})`;
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
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
      <canvas ref={glRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={moteRef} className="absolute inset-0 h-full w-full mix-blend-screen" style={{ opacity: 0.6 }} />
    </div>
  );
}

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
    uniforms: Record<string, WebGLUniformLocation | null>;
  } | null>(null);
  const rafRef = useRef(0);
  const ripplesRef = useRef(ripples);
  const settledRef = useRef(settledMemories);
  ripplesRef.current = ripples;
  settledRef.current = settledMemories;

  useEffect(() => {
    if (IS_TEST_ENV) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio ?? 1, 1.5);
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) {
      return () => window.removeEventListener('resize', resize);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const program = buildProgram(gl, VERT, POOL_FRAG);
    if (!program) {
      return () => window.removeEventListener('resize', resize);
    }

    gl.useProgram(program);
    setupQuad(gl, program);
    const uniforms: Record<string, WebGLUniformLocation | null> = {
      t: gl.getUniformLocation(program, 'u_time'),
      r: gl.getUniformLocation(program, 'u_res'),
      gc: gl.getUniformLocation(program, 'u_gc'),
    };
    for (let index = 0; index < 8; index += 1) {
      uniforms[`r${index}`] = gl.getUniformLocation(program, `u_r${index}`);
    }
    for (let index = 0; index < 4; index += 1) {
      uniforms[`g${index}`] = gl.getUniformLocation(program, `u_g${index}`);
    }
    glState.current = { gl, uniforms };

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      const t = (performance.now() - timeOrigin) / 1000;
      const state = glState.current;
      if (!state) {
        return;
      }

      const { gl: g, uniforms: loc } = state;
      g.viewport(0, 0, g.canvas.width, g.canvas.height);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.uniform1f(loc.t, t);
      g.uniform2f(loc.r, g.canvas.width, g.canvas.height);

      const activeRipples = ripplesRef.current;
      for (let index = 0; index < 8; index += 1) {
        const ripple = activeRipples[index];
        g.uniform4f(loc[`r${index}`], ripple?.x ?? -1, ripple?.y ?? -1, ripple?.time ?? 0, ripple?.intensity ?? 0);
      }

      const settled = settledRef.current;
      for (let index = 0; index < 4; index += 1) {
        g.uniform2f(loc[`g${index}`], settled[index]?.x ?? -2, settled[index]?.y ?? -2);
      }
      g.uniform1f(loc.gc, Math.min(settled.length, 4));
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
        visible ? 'opacity-100' : 'opacity-0'
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
        className="h-full w-full"
        style={{
          transform: 'rotateX(62deg)',
          transformOrigin: '50% 0%',
          background: 'transparent',
        }}
      />
      <div
        className="pointer-events-none absolute left-[8%] right-[8%] top-0 h-[2px]"
        style={{
          background: 'linear-gradient(to right, transparent 0%, color-mix(in srgb, var(--sophia-purple) 12%, transparent) 30%, color-mix(in srgb, var(--sophia-glow) 18%, transparent) 50%, color-mix(in srgb, var(--sophia-purple) 12%, transparent) 70%, transparent 100%)',
          filter: 'blur(1px)',
          boxShadow: '0 0 12px color-mix(in srgb, var(--sophia-purple) 8%, transparent), 0 0 30px color-mix(in srgb, var(--sophia-purple) 4%, transparent)',
        }}
      />
    </div>
  );
}

function PoolFog({ intensity }: { intensity: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wispsRef = useRef<FogWisp[]>([]);
  const rafRef = useRef(0);
  const t0 = useRef(performance.now());
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  useEffect(() => {
    if (IS_TEST_ENV) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

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
      if (!ctx) {
        return;
      }

      const w = canvas.width;
      const h = canvas.height;
      const t = (performance.now() - t0.current) / 1000;
      const currentIntensity = intensityRef.current;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';

      for (const wisp of wispsRef.current) {
        wisp.x += wisp.vx + Math.sin(t * wisp.speed * 0.4 + wisp.phase) * 0.08;
        wisp.y += wisp.vy + Math.cos(t * wisp.speed * 0.3 + wisp.phase * 1.7) * 0.02;

        if (wisp.x < -wisp.rx * 2) wisp.x = w + wisp.rx;
        if (wisp.x > w + wisp.rx * 2) wisp.x = -wisp.rx;
        if (wisp.y < h * 0.05) wisp.vy += 0.003;
        if (wisp.y > h * 0.95) wisp.vy -= 0.003;
        wisp.vy *= 0.998;

        const pulse = Math.sin(t * wisp.speed + wisp.phase) * 0.5 + 0.5;
        const breathe = 0.6 + pulse * 0.4;
        const alpha = wisp.alpha * breathe * (0.7 + currentIntensity * 0.6);
        if (alpha < 0.001) {
          continue;
        }

        const driftX = Math.sin(t * wisp.speed * 0.25 + wisp.phase) * wisp.drift;
        const cx = wisp.x + driftX;
        const cy = wisp.y;
        const sizeBreath = 1.0 + Math.sin(t * wisp.speed * 0.5 + wisp.phase * 2.3) * 0.15;
        const rx = wisp.rx * sizeBreath;
        const ry = wisp.ry * sizeBreath;
        const color = FOG_COLORS[wisp.color];

        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, ry / rx);
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        gradient.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${alpha * 1.2})`);
        gradient.addColorStop(0.3, `rgba(${color[0]},${color[1]},${color[2]},${alpha * 0.7})`);
        gradient.addColorStop(0.65, `rgba(${color[0]},${color[1]},${color[2]},${alpha * 0.25})`);
        gradient.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
        ctx.restore();
      }

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
      <canvas ref={canvasRef} className="h-full w-full" style={{ opacity: 1 }} />
    </div>
  );
}

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
    if (!el) {
      return;
    }

    const targetY = window.innerHeight * 0.56;
    const start = performance.now();
    let raf = 0;

    const animate = () => {
      const elapsed = performance.now() - start;
      const progress = Math.min(elapsed / DROP_DURATION_MS, 1);
      const eased = progress * progress;
      const currentY = startY + (targetY - startY) * eased;
      const scale = 1 - progress * 0.6;
      const opacity = progress < 0.85 ? 0.9 : 0.9 * (1 - (progress - 0.85) / 0.15);
      const trailHeight = 6 + progress * 30;

      el.style.transform = `translate(${startX}px, ${currentY}px)`;
      el.style.opacity = String(opacity);

      const dropEl = el.firstElementChild as HTMLElement | null;
      if (dropEl) {
        dropEl.style.transform = `translate(-50%, -50%) scale(${scale})`;
      }

      const trail = el.querySelector('[data-trail]');
      if (trail instanceof HTMLElement) {
        trail.style.height = `${trailHeight}px`;
        trail.style.opacity = String(Math.min(progress * 2, 0.6));
      }

      if (progress < 1) {
        raf = requestAnimationFrame(animate);
        return;
      }

      if (!impactCalled.current) {
        impactCalled.current = true;
        onImpact();
      }
    };

    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [onImpact, startX, startY]);

  return (
    <div ref={ref} className="fixed pointer-events-none z-[40]" style={{ left: 0, top: 0, opacity: 0 }}>
      <div className="relative" style={{ transform: 'translate(-50%, -50%)' }}>
        <div
          className="h-4 w-4 rounded-full"
          style={{
            background: 'radial-gradient(circle at 35% 35%, color-mix(in srgb, white 95%, transparent), color-mix(in srgb, var(--sophia-glow) 70%, transparent) 45%, color-mix(in srgb, var(--sophia-purple) 30%, transparent) 75%, transparent)',
            boxShadow: '0 0 18px color-mix(in srgb, var(--sophia-glow) 50%, transparent), 0 0 40px color-mix(in srgb, var(--sophia-purple) 20%, transparent)',
          }}
        />
        <div
          className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 25%, transparent), transparent 70%)',
            filter: 'blur(6px)',
          }}
        />
        <div
          data-trail=""
          className="absolute bottom-full left-1/2 w-[2px] -translate-x-1/2"
          style={{
            height: 6,
            opacity: 0,
            background: 'linear-gradient(to top, color-mix(in srgb, var(--sophia-glow) 60%, transparent), color-mix(in srgb, var(--sophia-purple) 15%, transparent), transparent)',
            filter: 'blur(1px)',
          }}
        />
      </div>
    </div>
  );
}

function ImpactFlash({ x, y, onDone }: { x: number; y: number; onDone: () => void }) {
  const ringRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ringRef.current?.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0)', opacity: '0.7' },
        { transform: 'translate(-50%,-50%) scale(4)', opacity: '0' },
      ],
      { duration: 800, fill: 'forwards', easing: 'cubic-bezier(0.0, 0.0, 0.2, 1)' }
    );
    flashRef.current?.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0)', opacity: '1' },
        { transform: 'translate(-50%,-50%) scale(2.5)', opacity: '0' },
      ],
      { duration: 450, fill: 'forwards', easing: 'ease-out' }
    );
    const timeout = window.setTimeout(onDone, 850);
    return () => clearTimeout(timeout);
  }, [onDone]);

  return (
    <div className="fixed inset-0 pointer-events-none z-[35]">
      <div
        ref={ringRef}
        className="absolute"
        style={{
          left: x,
          top: y,
          width: 60,
          height: 60,
          borderRadius: '50%',
          border: '1.5px solid color-mix(in srgb, var(--sophia-glow) 50%, transparent)',
          boxShadow: '0 0 20px color-mix(in srgb, var(--sophia-purple) 30%, transparent), inset 0 0 20px color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
        }}
      />
      <div
        ref={flashRef}
        className="absolute"
        style={{
          left: x,
          top: y,
          width: 24,
          height: 24,
          borderRadius: '50%',
          background: 'radial-gradient(circle, color-mix(in srgb, white 80%, transparent), color-mix(in srgb, var(--sophia-glow) 40%, transparent), transparent)',
          filter: 'blur(3px)',
        }}
      />
    </div>
  );
}

function OrbMistCanvas({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const particles = useRef<Array<{ x: number; y: number; vx: number; vy: number; r: number; a: number; phase: number }>>([]);
  const t0 = useRef(performance.now());

  useEffect(() => {
    if (IS_TEST_ENV) {
      return;
    }

    const canvas = ref.current;
    if (!canvas) {
      return;
    }

    const size = 400;
    canvas.width = size;
    canvas.height = size;
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 4;

    if (!particles.current.length) {
      particles.current = Array.from({ length: active ? 16 : 5 }, () => {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * radius * 0.65;
        return {
          x: cx + Math.cos(angle) * distance,
          y: cy + Math.sin(angle) * distance,
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
      if (!ctx) {
        return;
      }

      const t = (performance.now() - t0.current) / 1000;
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalCompositeOperation = 'screen';

      for (const particle of particles.current) {
        particle.x += particle.vx + Math.sin(t * 0.3 + particle.phase) * 0.06;
        particle.y += particle.vy + Math.cos(t * 0.25 + particle.phase) * 0.05;
        const dx = particle.x - cx;
        const dy = particle.y - cy;
        if (Math.sqrt(dx * dx + dy * dy) > radius * 0.72) {
          particle.vx -= dx * 0.0008;
          particle.vy -= dy * 0.0008;
        }
        const pulse = (Math.sin(t * 0.5 + particle.phase) * 0.5 + 0.5) * 0.5 + 0.5;
        const alpha = particle.a * pulse;
        const gradient = ctx.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, particle.r);
        gradient.addColorStop(0, `rgba(200,180,240,${alpha})`);
        gradient.addColorStop(0.5, `rgba(230,170,195,${alpha * 0.5})`);
        gradient.addColorStop(1, 'rgba(89,190,173,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(particle.x - particle.r, particle.y - particle.r, particle.r * 2, particle.r * 2);
      }

      if (active) {
        for (let index = 0; index < 6; index += 1) {
          const angle = t * 0.18 * (index % 2 === 0 ? 1 : -1) + (index / 6) * Math.PI * 2;
          const orbit = 35 + index * 18 + Math.sin(t * 0.35 + index) * 12;
          const sx = cx + Math.cos(angle) * orbit;
          const sy = cy + Math.sin(angle) * orbit;
          const spark = (Math.sin(t * 0.7 + index * 1.7) * 0.5 + 0.5) ** 2;
          if (spark < 0.08) {
            continue;
          }
          ctx.beginPath();
          ctx.arc(sx, sy, 1, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,248,240,${spark * 0.22})`;
          ctx.fill();
          const sparkGradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, 3.5);
          sparkGradient.addColorStop(0, `rgba(200,180,240,${spark * 0.12})`);
          sparkGradient.addColorStop(1, 'rgba(200,180,240,0)');
          ctx.fillStyle = sparkGradient;
          ctx.fillRect(sx - 3.5, sy - 3.5, 7, 7);
        }
      }

      ctx.restore();
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full rounded-full" style={{ opacity: active ? 0.65 : 0.25 }} />;
}

function ProgressIndicator({ total, reviewed }: { total: number; reviewed: number }) {
  return (
    <div className="mb-1 mt-6 flex items-center gap-3">
      <div className="flex items-center gap-2">
        {Array.from({ length: total }, (_, index) => (
          <div
            key={index}
            className="transition-all duration-500"
            style={{
              width: index < reviewed ? 20 : 6,
              height: 3,
              borderRadius: 2,
              background: index < reviewed
                ? 'linear-gradient(to right, color-mix(in srgb, var(--sophia-purple) 50%, transparent), color-mix(in srgb, var(--sophia-glow) 40%, transparent))'
                : 'var(--cosmic-text-faint)',
              boxShadow: index < reviewed ? '0 0 8px color-mix(in srgb, var(--sophia-purple) 15%, transparent)' : 'none',
            }}
          />
        ))}
      </div>
      <span className="text-[9px] tracking-[0.1em]" style={{ color: 'var(--cosmic-text-faint)' }}>{reviewed}/{total}</span>
    </div>
  );
}

function MemoryOrb({
  candidate,
  position,
  isExiting,
  exitType,
  onKeep,
  onEdit,
  onDiscard,
  onClick,
  disabled,
  orbRef,
}: MemoryOrbProps) {
  const isCenter = position === 'center';
  const [showReason, setShowReason] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(getCandidateText(candidate));
  const category = getRecapCategoryPresentation(candidate.category);
  const displayText = getCandidateText(candidate);
  const confidence = candidate.confidence;

  useEffect(() => {
    if (!isEditing) {
      setEditValue(displayText);
    }
  }, [displayText, isEditing]);

  const canSaveEdit = editValue.trim().length > 0 && !disabled;

  const positionClasses = useMemo(() => {
    if (isExiting && exitType === 'keep') return 'translate-y-[-80px] scale-75 opacity-0';
    if (isExiting && exitType === 'discard') return 'scale-[0.85] opacity-0 blur-md';
    switch (position) {
      case 'left':
        return '-translate-x-[95%] translate-y-[8px] scale-[0.38]';
      case 'right':
        return 'translate-x-[95%] translate-y-[8px] scale-[0.38]';
      default:
        return 'translate-x-0 scale-100';
    }
  }, [exitType, isExiting, position]);

  return (
    <div
      className={cn(
        'absolute transition-all ease-out',
        isCenter ? 'z-20 duration-600' : 'z-10 duration-700',
        positionClasses,
        !isCenter && 'opacity-[0.08] blur-[8px]',
        !isCenter && !disabled && 'cursor-pointer hover:opacity-[0.15] hover:blur-[4px]'
      )}
      onClick={!isCenter ? onClick : undefined}
      role={isCenter ? 'article' : 'button'}
      aria-label={isCenter ? `Current memory: ${displayText}` : `Navigate to ${displayText}`}
      tabIndex={isCenter ? 0 : -1}
    >
      {isCenter && !isExiting && (
        <>
          <div
            className="absolute -z-30 rounded-full"
            style={{
              inset: '-55%',
              background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 4%, transparent) 0%, color-mix(in srgb, var(--cosmic-teal) 2%, transparent) 35%, transparent 55%)',
              filter: 'blur(70px)',
            }}
          />
          <div
            className="absolute inset-[-3px] -z-10 rounded-full"
            style={{
              boxShadow: '0 0 40px 2px color-mix(in srgb, var(--sophia-purple) 6%, transparent), 0 0 75px 4px color-mix(in srgb, var(--sophia-glow) 3%, transparent), inset 0 0 28px 2px color-mix(in srgb, var(--sophia-purple) 4%, transparent)',
            }}
          />
          <div
            className="absolute left-1/2 top-[70%] -z-20 h-[120%] w-[60%] -translate-x-1/2 rounded-full"
            style={{
              background: 'radial-gradient(ellipse 100% 70%, color-mix(in srgb, var(--sophia-purple) 3%, transparent) 0%, transparent 60%)',
              filter: 'blur(40px)',
            }}
          />
        </>
      )}

      {isExiting && exitType === 'keep' && (
        <div
          className="absolute inset-0 -z-10 rounded-full animate-pulse"
          style={{
            transform: 'scale(1.8)',
            background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-glow) 30%, transparent) 0%, transparent 50%)',
            filter: 'blur(40px)',
          }}
        />
      )}

      {isCenter && !isExiting && confidence != null && (
        <svg
          className="pointer-events-none absolute inset-[-6px] -z-[5] h-[calc(100%+12px)] w-[calc(100%+12px)]"
          viewBox="0 0 100 100"
          style={{ transform: 'rotate(-90deg)' }}
        >
          <circle cx="50" cy="50" r="49" fill="none" stroke="rgba(255,255,255,0.02)" strokeWidth="0.3" />
          <circle
            cx="50"
            cy="50"
            r="49"
            fill="none"
            stroke="url(#confGrad)"
            strokeWidth="0.5"
            strokeDasharray={`${confidence * 308} 308`}
            strokeLinecap="round"
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

      <div
        ref={isCenter ? orbRef : undefined}
        className={cn(
          'relative overflow-hidden rounded-full',
          isCenter
            ? 'h-[260px] w-[260px] sm:h-[310px] sm:w-[310px] md:h-[350px] md:w-[350px]'
            : 'h-[260px] w-[260px] sm:h-[310px] sm:w-[310px]'
        )}
        style={{
          background: isCenter
            ? 'radial-gradient(ellipse 120% 100% at 50% 100%, color-mix(in srgb, var(--sophia-purple) 7%, transparent) 0%, transparent 40%), radial-gradient(ellipse 100% 120% at 50% 0%, color-mix(in srgb, var(--cosmic-teal) 3%, transparent) 0%, transparent 35%), radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--card-bg) 92%, black 8%), color-mix(in srgb, var(--bg) 95%, black 5%))'
            : 'radial-gradient(circle at 50% 55%, color-mix(in srgb, var(--card-bg) 76%, black 24%), color-mix(in srgb, var(--bg) 85%, black 15%) 85%)',
          boxShadow: isCenter
            ? 'inset 0 -28px 65px -28px color-mix(in srgb, var(--sophia-purple) 10%, transparent), inset 0 28px 45px -28px color-mix(in srgb, var(--cosmic-teal) 4%, transparent), inset 0 0 0 1px var(--cosmic-border-soft), 0 0 55px -15px color-mix(in srgb, var(--sophia-purple) 5%, transparent), 0 14px 45px -25px color-mix(in srgb, var(--bg) 55%, transparent)'
            : 'inset 0 -15px 30px -15px color-mix(in srgb, var(--sophia-purple) 5%, transparent), inset 0 0 0 1px var(--cosmic-border-soft)',
          backdropFilter: isCenter ? 'blur(2px)' : undefined,
        }}
      >
        <OrbMistCanvas active={isCenter} />

        <div
          className="pointer-events-none absolute rounded-full"
          style={{
            top: '4%',
            left: '12%',
            width: '42%',
            height: '18%',
            background: 'radial-gradient(ellipse at 40% 40%, color-mix(in srgb, var(--cosmic-ivory) 10%, transparent), color-mix(in srgb, var(--cosmic-ivory) 2%, transparent) 40%, transparent 70%)',
            filter: 'blur(5px)',
          }}
        />

        {isCenter && (
          <div
            className="pointer-events-none absolute rounded-full"
            style={{
              top: '14%',
              right: '5%',
              width: '16%',
              height: '46%',
              background: 'radial-gradient(ellipse at 80% 50%, color-mix(in srgb, var(--cosmic-teal) 5%, transparent), transparent 70%)',
              filter: 'blur(10px)',
            }}
          />
        )}

        {isCenter && (
          <div
            className="pointer-events-none absolute inset-[1px] rounded-full"
            style={{
              background: 'linear-gradient(175deg, color-mix(in srgb, var(--cosmic-ivory) 5%, transparent) 0%, transparent 20%, transparent 80%, color-mix(in srgb, var(--sophia-purple) 3%, transparent) 100%)',
            }}
          />
        )}

        {isCenter && (
          <div
            className="pointer-events-none absolute bottom-0 left-[10%] right-[10%]"
            style={{
              height: '32%',
              background: 'radial-gradient(ellipse 100% 70% at 50% 100%, color-mix(in srgb, var(--sophia-purple) 5%, transparent), transparent 70%)',
              filter: 'blur(12px)',
            }}
          />
        )}

        <div
          className="pointer-events-none absolute inset-[1px] rounded-full"
          style={{
            boxShadow: isCenter
              ? 'inset 0 3px 35px color-mix(in srgb, var(--bg) 42%, transparent), inset 0 -3px 22px color-mix(in srgb, var(--sophia-purple) 2.5%, transparent)'
              : 'inset 0 2px 18px color-mix(in srgb, var(--bg) 28%, transparent)',
          }}
        />

        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center px-8 sm:px-11">
          {isCenter && (
            <span className="mb-4 text-[10px] uppercase tracking-[0.14em]" style={{ color: 'color-mix(in srgb, var(--sophia-purple) 40%, transparent)' }}>
              <span aria-hidden="true">{category.icon}</span>{' '}
              <span>{category.label}</span>
            </span>
          )}

          {isCenter && isEditing ? (
            <div className="w-full max-w-[220px] space-y-3 sm:max-w-[250px]">
              <textarea
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                rows={4}
                autoFocus
                className="cosmic-focus-ring w-full resize-none rounded-2xl px-4 py-3 text-sm leading-relaxed placeholder:text-[var(--cosmic-text-faint)] focus-visible:ring-1 focus-visible:ring-[var(--cosmic-border-strong)]"
                style={{
                  background: 'var(--cosmic-panel-soft)',
                  border: '1px solid var(--cosmic-border)',
                  color: 'var(--cosmic-text)',
                }}
                aria-label="Refine memory text"
                placeholder="Refine this memory"
              />
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!canSaveEdit) {
                      return;
                    }
                    onEdit(editValue.trim());
                    setIsEditing(false);
                  }}
                  disabled={!canSaveEdit}
                  aria-label="Save refinement"
                  className="cosmic-accent-pill cosmic-focus-ring rounded-full px-4 py-2 text-[11px] tracking-[0.06em] transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Save refinement
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditValue(displayText);
                    setIsEditing(false);
                  }}
                  aria-label="Cancel"
                  className="cosmic-ghost-pill cosmic-focus-ring rounded-full px-4 py-2 text-[11px] tracking-[0.06em] transition-all duration-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p
              className={cn('font-cormorant text-center leading-relaxed', isCenter ? 'text-[16px] sm:text-[19px]' : 'text-[14px]')}
              style={{ color: isCenter ? 'var(--cosmic-text-strong)' : 'var(--cosmic-text-whisper)' }}
            >
              {displayText}
            </p>
          )}

          {isCenter && !isExiting && !isEditing && candidate.reason && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                setShowReason((previous) => !previous);
              }}
              className="mt-3 text-[9px] uppercase tracking-[0.1em] transition-colors"
              style={{ color: showReason ? 'color-mix(in srgb, var(--sophia-purple) 40%, transparent)' : 'var(--cosmic-text-faint)' }}
            >
              {showReason ? 'Hide' : 'Why this?'}
            </button>
          )}

          {showReason && isCenter && !isEditing && (
            <p className="mt-2 max-w-[200px] text-center text-[11px] motion-safe:animate-fadeIn" style={{ color: 'color-mix(in srgb, var(--sophia-purple) 30%, transparent)' }}>
              {candidate.reason}
            </p>
          )}

          {isCenter && !isExiting && !isEditing && (
            <div className="mt-5 flex items-center gap-3 motion-safe:animate-fadeIn" style={{ animationDelay: '200ms' }}>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onKeep();
                }}
                disabled={disabled}
                data-onboarding="recap-memory-keep"
                aria-label="Keep this memory"
                className="cosmic-accent-pill cosmic-focus-ring group flex items-center gap-2 rounded-full px-5 py-2 transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Check className="h-3.5 w-3.5 transition-transform group-hover:scale-110" />
                <span className="text-[10px] uppercase tracking-[0.08em]">Keep this</span>
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  if (!disabled) {
                    setEditValue(displayText);
                    setIsEditing(true);
                  }
                }}
                disabled={disabled}
                aria-label="Refine this memory"
                className="cosmic-ghost-pill cosmic-focus-ring rounded-full p-2 transition-all disabled:opacity-30"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscard();
                }}
                disabled={disabled}
                data-onboarding="recap-memory-discard"
                aria-label="Let this memory go"
                className="cosmic-focus-ring group flex items-center gap-2 rounded-full border px-5 py-2 text-[var(--cosmic-text-whisper)] transition-all duration-300 hover:bg-[color-mix(in_srgb,var(--sophia-error)_10%,transparent)] hover:text-[color-mix(in_srgb,var(--sophia-error)_72%,white_10%)] disabled:cursor-not-allowed disabled:opacity-30"
                style={{ borderColor: 'var(--cosmic-border-soft)', background: 'var(--cosmic-panel-soft)' }}
              >
                <X className="h-3.5 w-3.5 transition-transform group-hover:scale-110" />
                <span className="text-[10px] uppercase tracking-[0.08em]">Let it go</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReflectionCard({
  prompt,
  tag,
  onReflect,
  visible,
}: {
  prompt?: string;
  tag?: string;
  onReflect?: () => void;
  visible: boolean;
}) {
  if (!prompt) {
    return null;
  }

  return (
    <div
      className={cn(
        'mt-8 flex max-w-xl flex-col items-center text-center transition-all duration-[1200ms] ease-out',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
      )}
      style={{ transitionDelay: '700ms' }}
    >
      <div
        className="relative w-full overflow-hidden rounded-2xl px-6 py-5 backdrop-blur-xl"
        style={{
          background: 'var(--cosmic-panel)',
          border: '1px solid var(--cosmic-border-soft)',
          boxShadow: 'var(--cosmic-shadow-lg)',
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-base">💭</span>
          <p className="font-cormorant italic text-[14px] tracking-[0.04em]" style={{ color: 'color-mix(in srgb, var(--sophia-purple) 35%, transparent)' }}>
            {tag ? TAG_LABELS[tag] ?? 'Something to reflect on' : 'Something to reflect on'}
          </p>
        </div>
        <p className="text-left font-cormorant text-[17px] leading-relaxed" style={{ color: 'var(--cosmic-text)' }}>{prompt}</p>
        {onReflect && (
          <button
            onClick={onReflect}
            className="cosmic-ghost-pill cosmic-focus-ring mt-4 rounded-full px-4 py-1.5 text-[10px] uppercase tracking-[0.08em] transition-all duration-300"
          >
            Sit with this for a moment →
          </button>
        )}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--bg)]">
      <AuroraBackground />
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <div
          className="relative h-[240px] w-[240px] rounded-full sm:h-[280px] sm:w-[280px]"
          style={{
            background: 'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--card-bg) 92%, black 8%), color-mix(in srgb, var(--bg) 95%, black 5%))',
            boxShadow: 'inset 0 -28px 65px -28px color-mix(in srgb, var(--sophia-purple) 10%, transparent), inset 0 28px 45px -28px color-mix(in srgb, var(--cosmic-teal) 4%, transparent), inset 0 0 0 1px var(--cosmic-border-soft), 0 0 55px -15px color-mix(in srgb, var(--sophia-purple) 5%, transparent)',
          }}
        >
          <div className="absolute inset-[22%] animate-pulse rounded-full border" style={{ borderColor: 'var(--cosmic-border-soft)', background: 'var(--cosmic-panel-soft)' }} />
        </div>
        <p className="mt-8 font-cormorant text-[20px]" style={{ color: 'var(--cosmic-text)' }}>Composing recap…</p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--bg)]">
      <AuroraBackground />
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <div
          className="w-full max-w-lg rounded-[28px] border px-8 py-10 backdrop-blur-xl"
          style={{
            background: 'var(--cosmic-panel)',
            borderColor: 'var(--cosmic-border)',
            boxShadow: 'var(--cosmic-shadow-lg)',
          }}
        >
          <div className="mx-auto mb-4 h-12 w-12 rounded-full" style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 12%, transparent), transparent 70%)' }} />
          <p className="font-cormorant text-[24px]" style={{ color: 'var(--cosmic-text-strong)' }}>No new memories from this session.</p>
          <p className="mt-3 text-sm" style={{ color: 'var(--cosmic-text-whisper)' }}>Sophia did not surface anything that felt worth carrying forward this time.</p>
        </div>
      </div>
    </div>
  );
}

function CompletedState({
  approvedCount,
  approvedMemories,
  reflectionPrompt,
  reflectionTag,
  onReflect,
  showEntrance,
}: {
  approvedCount: number;
  approvedMemories: ApprovedMemoryRow[];
  reflectionPrompt?: string;
  reflectionTag?: string;
  onReflect?: () => void;
  showEntrance: boolean;
}) {
  return (
    <>
      <div className="mt-6 flex flex-col items-center motion-safe:animate-fadeIn">
        <div
          className="relative flex h-[280px] w-[280px] flex-col items-center justify-center overflow-hidden rounded-full"
          style={{
            background: 'radial-gradient(ellipse 120% 100% at 50% 100%, color-mix(in srgb, var(--sophia-purple) 8%, transparent), transparent 40%), radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--card-bg) 92%, black 8%), color-mix(in srgb, var(--bg) 95%, black 5%))',
            boxShadow: 'inset 0 -28px 65px -28px color-mix(in srgb, var(--sophia-purple) 12%, transparent), inset 0 28px 45px -28px color-mix(in srgb, var(--cosmic-teal) 3%, transparent), inset 0 0 0 1px var(--cosmic-border-soft), 0 0 55px -15px color-mix(in srgb, var(--sophia-purple) 5%, transparent)',
          }}
        >
          <OrbMistCanvas active />
          <div className="relative z-10 flex flex-col items-center">
            <div
              className="mb-3 flex h-12 w-12 items-center justify-center rounded-full"
              style={{ background: 'color-mix(in srgb, var(--sophia-purple) 6%, transparent)', border: '1px solid var(--cosmic-border)' }}
            >
              <Check className="h-6 w-6" style={{ color: 'color-mix(in srgb, var(--sophia-purple) 45%, transparent)' }} />
            </div>
            <p className="font-cormorant text-[22px]" style={{ color: 'var(--cosmic-text-strong)' }}>All memories reviewed</p>
            <p className="mt-1 text-[11px] tracking-[0.06em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
              {approvedCount === 0
                ? 'Nothing was carried into memory this time'
                : `${approvedCount} ${approvedCount === 1 ? 'memory' : 'memories'} in the pool`}
            </p>
          </div>
        </div>
      </div>

      {approvedMemories.length > 0 && (
        <div className="mt-8 w-full max-w-2xl space-y-3">
          {approvedMemories.map((memory) => (
            <div
              key={memory.id}
              className="flex items-start justify-between gap-3 rounded-2xl px-4 py-3 backdrop-blur-xl"
              style={{
                background: 'var(--cosmic-panel)',
                border: '1px solid var(--cosmic-border-soft)',
                boxShadow: 'inset 0 0 20px color-mix(in srgb, var(--sophia-purple) 1.2%, transparent)',
              }}
            >
              <p className="font-cormorant text-[17px] leading-relaxed" style={{ color: 'var(--cosmic-text)' }}>{memory.text}</p>
              {memory.isEdited && (
                <span
                  className="shrink-0 rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.12em]"
                  style={{
                    background: 'color-mix(in srgb, var(--sophia-purple) 10%, transparent)',
                    border: '1px solid var(--cosmic-border)',
                    color: 'color-mix(in srgb, var(--sophia-glow) 75%, transparent)',
                  }}
                >
                  Refined
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <ReflectionCard
        prompt={reflectionPrompt}
        tag={reflectionTag}
        onReflect={onReflect}
        visible={showEntrance}
      />
    </>
  );
}

export function RecapCosmicPoolOrbit({
  takeaway,
  candidates,
  decisions,
  onDecisionChange,
  reflectionPrompt,
  reflectionTag,
  onReflect,
  isLoading,
  disabled,
  className,
}: RecapMemoryOrbitProps) {
  const normalizedCandidates = useMemo(() => normalizeOrbitCandidates(candidates), [candidates]);
  const approvedMemories = useMemo<ApprovedMemoryRow[]>(() => {
    return normalizedCandidates.flatMap((candidate) => {
      const record = decisions[candidate.id];
      if (!record || (record.decision !== 'approved' && record.decision !== 'edited')) {
        return [];
      }

      const originalText = getCandidateText(candidate);
      const refinedText = record.editedText?.trim();
      return [{
        id: candidate.id,
        text: record.decision === 'edited' && refinedText ? refinedText : originalText,
        isEdited: record.decision === 'edited',
      }];
    });
  }, [decisions, normalizedCandidates]);

  const { activeCandidates, processedCandidates, approvedCount } = useMemo(
    () => getOrbitCandidateBuckets(normalizedCandidates, decisions),
    [decisions, normalizedCandidates]
  );

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [exitType, setExitType] = useState<'keep' | 'discard' | null>(null);
  const [showEntrance, setShowEntrance] = useState(false);
  const [showPool, setShowPool] = useState(false);
  const [ripples, setRipples] = useState<PoolRipple[]>([]);
  const [settledMemories, setSettledMemories] = useState<SettledGlow[]>([]);
  const [activeDrop, setActiveDrop] = useState<ActiveDrop | null>(null);
  const [impactFlash, setImpactFlash] = useState<{ x: number; y: number } | null>(null);

  const mountTime = useRef(performance.now());
  const orbRef = useRef<HTMLDivElement>(null);
  const exitTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const poolTimeout = window.setTimeout(() => setShowPool(true), 200);
    const entranceTimeout = window.setTimeout(() => setShowEntrance(true), 400);
    return () => {
      window.clearTimeout(poolTimeout);
      window.clearTimeout(entranceTimeout);
    };
  }, []);

  useEffect(() => {
    if (focusedIndex >= activeCandidates.length && activeCandidates.length > 0) {
      setFocusedIndex(Math.max(0, activeCandidates.length - 1));
    }
  }, [activeCandidates.length, focusedIndex]);

  useEffect(() => {
    setSettledMemories((previous) => {
      if (approvedMemories.length <= previous.length) {
        return previous.slice(0, approvedMemories.length);
      }
      const next = [...previous];
      for (let index = previous.length; index < approvedMemories.length; index += 1) {
        next.push(getSettledGlowSlot(index));
      }
      return next;
    });
  }, [approvedMemories.length]);

  const clearExitTimeout = useCallback(() => {
    if (exitTimeoutRef.current !== null) {
      window.clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearExitTimeout, [clearExitTimeout]);

  const navigatePrev = useCallback(() => {
    if (activeCandidates.length <= 1 || exitingId) {
      return;
    }
    haptic('light');
    setFocusedIndex((previous) => (previous === 0 ? activeCandidates.length - 1 : previous - 1));
  }, [activeCandidates.length, exitingId]);

  const navigateNext = useCallback(() => {
    if (activeCandidates.length <= 1 || exitingId) {
      return;
    }
    haptic('light');
    setFocusedIndex((previous) => (previous === activeCandidates.length - 1 ? 0 : previous + 1));
  }, [activeCandidates.length, exitingId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (disabled || activeCandidates.length === 0 || exitingId) {
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigatePrev();
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeCandidates.length, disabled, exitingId, navigateNext, navigatePrev]);

  const triggerDropFromOrb = useCallback((candidateId: string) => {
    if (!orbRef.current) {
      return;
    }
    const rect = orbRef.current.getBoundingClientRect();
    setActiveDrop({
      id: candidateId,
      startX: rect.left + rect.width / 2,
      startY: rect.top + rect.height / 2,
    });
  }, []);

  const handleKeep = useCallback((candidateId: string) => {
    if (disabled || exitingId) {
      return;
    }
    haptic('medium');
    triggerDropFromOrb(candidateId);
    clearExitTimeout();
    setExitingId(candidateId);
    setExitType('keep');
    exitTimeoutRef.current = window.setTimeout(() => {
      onDecisionChange(candidateId, 'approved');
      setExitingId(null);
      setExitType(null);
      exitTimeoutRef.current = null;
    }, KEEP_ANIMATION_MS);
  }, [clearExitTimeout, disabled, exitingId, onDecisionChange, triggerDropFromOrb]);

  const handleEdit = useCallback((candidateId: string, editedText: string) => {
    if (disabled || exitingId) {
      return;
    }
    haptic('medium');
    triggerDropFromOrb(candidateId);
    clearExitTimeout();
    setExitingId(candidateId);
    setExitType('keep');
    exitTimeoutRef.current = window.setTimeout(() => {
      onDecisionChange(candidateId, 'edited', editedText);
      setExitingId(null);
      setExitType(null);
      exitTimeoutRef.current = null;
    }, KEEP_ANIMATION_MS);
  }, [clearExitTimeout, disabled, exitingId, onDecisionChange, triggerDropFromOrb]);

  const handleDiscard = useCallback((candidateId: string) => {
    if (disabled || exitingId) {
      return;
    }
    haptic('light');
    clearExitTimeout();
    setExitingId(candidateId);
    setExitType('discard');
    exitTimeoutRef.current = window.setTimeout(() => {
      onDecisionChange(candidateId, 'discarded');
      setExitingId(null);
      setExitType(null);
      exitTimeoutRef.current = null;
    }, DISCARD_ANIMATION_MS);
  }, [clearExitTimeout, disabled, exitingId, onDecisionChange]);

  const handleDropImpact = useCallback(() => {
    const now = (performance.now() - mountTime.current) / 1000;
    const poolX = 0.5 + (Math.random() - 0.5) * 0.06;
    const poolY = 0.82 + Math.random() * 0.06;
    setRipples((previous) => [...previous.slice(-6), { x: poolX, y: poolY, time: now, intensity: 1.0 }]);
    setSettledMemories((previous) => [...previous, getSettledGlowSlot(previous.length)]);
    setImpactFlash({ x: activeDrop?.startX ?? window.innerWidth / 2, y: window.innerHeight * 0.56 });
    setActiveDrop(null);
  }, [activeDrop]);

  const safeFocusedIndex = getSafeFocusedIndex(focusedIndex, activeCandidates.length);
  const visibleCandidates = useMemo(
    () => getVisibleOrbitCandidates(activeCandidates, safeFocusedIndex),
    [activeCandidates, safeFocusedIndex]
  );
  const reviewedCount = processedCandidates.length;

  if (isLoading) {
    return <LoadingState />;
  }

  if (normalizedCandidates.length === 0) {
    return <EmptyState />;
  }

  const allDone = activeCandidates.length === 0 && processedCandidates.length > 0;

  return (
    <div className={cn('relative min-h-screen overflow-hidden bg-[var(--bg)]', className)}>
      <OnboardingTipGuard tipId="tip-first-recap" isTriggered={Boolean(takeaway || reflectionPrompt || normalizedCandidates.length > 0)} />
      <OnboardingTipGuard tipId="tip-first-memory-candidate" isTriggered={normalizedCandidates.length > 0} />

      <AuroraBackground />
      <CosmicPool
        ripples={ripples}
        settledMemories={settledMemories}
        timeOrigin={mountTime.current}
        visible={showPool}
      />
      <PoolFog intensity={Math.min(settledMemories.length / 4, 1)} />

      <div
        className="pointer-events-none fixed left-0 right-0 z-[4] transition-opacity duration-[2000ms]"
        style={{
          bottom: '44%',
          height: 100,
          opacity: settledMemories.length > 0 ? 0.5 : 0.15,
          background: `linear-gradient(to top, color-mix(in srgb, var(--sophia-purple) ${1.5 + settledMemories.length * 0.8}%, transparent), transparent)`,
          filter: 'blur(40px)',
        }}
      />

      {activeDrop && (
        <MemoryDrop startX={activeDrop.startX} startY={activeDrop.startY} onImpact={handleDropImpact} />
      )}
      {impactFlash && <ImpactFlash x={impactFlash.x} y={impactFlash.y} onDone={() => setImpactFlash(null)} />}

      <div className="relative z-10 flex min-h-screen flex-col items-center px-4 pb-8 pt-20">
        <div
          className={cn(
            'flex flex-col items-center text-center transition-all duration-[1200ms] ease-out',
            showEntrance ? 'translate-y-0 opacity-100' : 'translate-y-5 opacity-0'
          )}
          data-onboarding="recap-summary"
        >
          <span className="mb-4 text-[10px] uppercase tracking-[0.14em]" style={{ color: 'color-mix(in srgb, var(--sophia-purple) 30%, transparent)' }}>
            key takeaway
          </span>
          <div className="relative max-w-2xl">
            <div
              className="absolute inset-0 -z-10"
              style={{
                background: 'radial-gradient(ellipse 80% 60% at 50% 50%, color-mix(in srgb, var(--sophia-purple) 5%, transparent), color-mix(in srgb, var(--cosmic-teal) 2%, transparent) 40%, transparent 65%)',
                filter: 'blur(45px)',
                transform: 'scale(2) translateY(10%)',
              }}
            />
            <h1 className="font-cormorant text-[26px] font-light leading-snug sm:text-[32px] md:text-[38px]" style={{ color: 'var(--cosmic-text-strong)' }}>
              {takeaway ?? 'A thread worth carrying forward'}
            </h1>
          </div>

          <div className="mt-6 flex items-center gap-0" aria-hidden="true">
            <div className="h-px w-16 sm:w-24" style={{ background: 'linear-gradient(to right, transparent, color-mix(in srgb, var(--sophia-purple) 20%, transparent))' }} />
            <div className="relative mx-0">
              <div className="h-[5px] w-[5px] rounded-full" style={{ background: 'color-mix(in srgb, var(--sophia-purple) 50%, transparent)' }} />
              <div
                className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 35%, transparent), transparent 70%)' }}
              />
            </div>
            <div className="h-px w-16 sm:w-24" style={{ background: 'linear-gradient(to left, transparent, color-mix(in srgb, var(--sophia-purple) 20%, transparent))' }} />
          </div>

          <ProgressIndicator total={normalizedCandidates.length} reviewed={reviewedCount} />
        </div>

        {!allDone ? (
          <div
            className={cn(
              'relative flex w-full items-center justify-center transition-all duration-[1200ms] ease-out',
              showEntrance ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
            )}
            style={{ minHeight: 400, transitionDelay: '300ms' }}
          >
            {safeFocusedIndex > 0 && (
              <button
                onClick={navigatePrev}
                className="cosmic-chrome-button absolute left-2 z-30 rounded-full p-2.5 transition-all sm:left-8"
                aria-label="Previous"
              >
                <ChevronLeft className="h-5 w-5" style={{ color: 'var(--cosmic-text-muted)' }} />
              </button>
            )}

            {safeFocusedIndex < activeCandidates.length - 1 && (
              <button
                onClick={navigateNext}
                className="cosmic-chrome-button absolute right-2 z-30 rounded-full p-2.5 transition-all sm:right-8"
                aria-label="Next"
              >
                <ChevronRight className="h-5 w-5" style={{ color: 'var(--cosmic-text-muted)' }} />
              </button>
            )}

            <div className="relative flex h-[360px] w-full items-center justify-center sm:h-[420px]">
              {visibleCandidates.map(({ candidate, position }) => (
                <MemoryOrb
                  key={`${candidate.id}-${position}`}
                  candidate={candidate}
                  position={position}
                  isExiting={candidate.id === exitingId}
                  exitType={candidate.id === exitingId ? exitType : null}
                  onKeep={() => handleKeep(candidate.id)}
                  onEdit={(editedText) => handleEdit(candidate.id, editedText)}
                  onDiscard={() => handleDiscard(candidate.id)}
                  onClick={() => {
                    const nextIndex = activeCandidates.findIndex((item) => item.id === candidate.id);
                    if (nextIndex >= 0) {
                      setFocusedIndex(nextIndex);
                    }
                  }}
                  disabled={disabled || Boolean(exitingId) || position !== 'center'}
                  orbRef={position === 'center' ? orbRef : undefined}
                />
              ))}
            </div>
          </div>
        ) : (
          <CompletedState
            approvedCount={approvedCount}
            approvedMemories={approvedMemories}
            reflectionPrompt={reflectionPrompt}
            reflectionTag={reflectionTag}
            onReflect={onReflect}
            showEntrance={showEntrance}
          />
        )}

        {!allDone && (
          <ReflectionCard
            prompt={reflectionPrompt}
            tag={reflectionTag}
            onReflect={onReflect}
            visible={showEntrance}
          />
        )}
      </div>
    </div>
  );
}

export default RecapCosmicPoolOrbit;