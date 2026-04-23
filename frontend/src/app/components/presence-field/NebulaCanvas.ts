"use client"

import { useRef, useCallback } from "react"

import type { ExpressionParams, Palette } from "../../hooks/useExpression"

// ─── Shader source ───────────────────────────────────────────────────────────

const VERT = `attribute vec2 pos; void main(){ gl_Position=vec4(pos,0,1); }`

function makeFrag(octaves: number) {
  return `
precision highp float;
#define FBM_OCTAVES ${octaves}
uniform float u_time;
uniform vec2 u_res;
uniform vec2 u_mouse;
uniform vec3 u_c1, u_c2, u_c3;
uniform float u_coreIntensity;
uniform float u_flowEnergy;
uniform float u_breathRate;

vec3 hash3(vec3 p){
  p = vec3(dot(p,vec3(127.1,311.7,74.7)),
           dot(p,vec3(269.5,183.3,246.1)),
           dot(p,vec3(113.5,271.9,124.6)));
  return -1.0+2.0*fract(sin(p)*43758.5453123);
}

float gnoise(vec3 p){
  vec3 i=floor(p), f=fract(p);
  vec3 u=f*f*(3.0-2.0*f);
  return mix(mix(mix(dot(hash3(i+vec3(0,0,0)),f-vec3(0,0,0)),
                     dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x),
                 mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)),
                     dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
             mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)),
                     dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x),
                 mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)),
                     dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z);
}

float fbm(vec3 p){
  float v=0.0, a=0.5;
  vec3 shift=vec3(100.0);
  for(int i=0;i<FBM_OCTAVES;i++){
    v+=a*gnoise(p);
    p=p*2.0+shift;
    a*=0.5;
  }
  return v;
}

float warpedFbm(vec3 p, float t){
  vec3 q = vec3(fbm(p + vec3(0.0,0.0,t*0.035)),
                fbm(p + vec3(5.2,1.3,t*0.03)),
                fbm(p + vec3(2.1,3.7,t*0.025)));
  vec3 r = vec3(fbm(p + 2.0*q + vec3(1.7,9.2,t*0.04)),
                fbm(p + 2.0*q + vec3(8.3,2.8,t*0.035)),
                0.0);
  return fbm(p + 1.8*r);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5*u_res) / min(u_res.x, u_res.y);
  float t = u_time;

  // Mouse influence — gentle displacement
  vec2 mp = u_mouse - 0.5;
  vec2 mouseWorld = (u_mouse * u_res - 0.5 * u_res) / min(u_res.x, u_res.y);
  vec2 toMouse = p - mouseWorld;
  float mouseDist = length(toMouse);
  float pushStrength = exp(-mouseDist * mouseDist * 20.0) * 0.04;
  vec2 pushDir = mouseDist > 0.001 ? normalize(toMouse) : vec2(0.0);
  p += pushDir * pushStrength;

  // Core nebula noise
  float n1 = warpedFbm(vec3(p * 1.8, t * 0.025), t);
  float n2 = warpedFbm(vec3(p * 1.2 + 3.0, t * 0.018), t * 0.5);
  float n3 = fbm(vec3(p * 2.5, t * 0.035));

  // Energy flow bands
  float flow1 = sin(p.y * 3.0 + n1 * 2.0 + t * 0.055) * 0.5 + 0.5;
  flow1 = pow(flow1, 5.0) * 0.5;
  float flow2 = sin(p.y * 2.5 - p.x * 1.5 + n2 * 3.0 + t * 0.045) * 0.5 + 0.5;
  flow2 = pow(flow2, 6.0) * 0.35;
  float flow3 = sin(p.x * 2.5 + p.y * 1.0 + n3 * 2.0 - t * 0.035) * 0.5 + 0.5;
  flow3 = pow(flow3, 7.0) * 0.25;

  // Nebula atmosphere — stable room at constant 0.7
  vec3 col = vec3(0.008, 0.008, 0.018);
  float nebulaBase = 0.7;
  float nebulaMask = smoothstep(-0.1, 0.7, n1) * nebulaBase;
  col += u_c1 * nebulaMask * 0.35;
  col += u_c2 * smoothstep(0.0, 0.6, n2) * 0.2 * nebulaBase;

  // Energy flow bands — driven by flowEnergy
  col += u_c3 * flow1 * 0.7 * u_flowEnergy;
  col += u_c1 * flow2 * 0.45 * u_flowEnergy;
  col += u_c2 * flow3 * 0.3 * u_flowEnergy;

  float flowPeak = max(flow1, max(flow2, flow3));
  col += vec3(1.0, 0.95, 0.88) * pow(flowPeak, 3.0) * 0.2 * u_flowEnergy;

  // Sophia core — state-driven expression
  float breath = 0.82 + sin(t * u_breathRate) * 0.18;
  float breathSlow = 0.9 + sin(t * u_breathRate * 0.25) * 0.1;
  vec2 coreCenter = -mp * 0.05;
  float coreDist = length(p - coreCenter);

  float coreNoise = fbm(vec3(p * 2.5, t * 0.015)) * 0.25;
  float coreDetail = fbm(vec3(p * 4.0 + 10.0, t * 0.01)) * 0.15;

  float innerGlow = exp(-coreDist * coreDist * 18.0) * breath;
  float outerHalo = exp(-coreDist * coreDist * 3.5) * breathSlow * 0.55;
  float midRegion = exp(-coreDist * coreDist * 8.0) * (1.0 + coreNoise) * breath * 0.45;
  float rim = smoothstep(0.28, 0.20, coreDist) * smoothstep(0.10, 0.16, coreDist) * breath * 0.3;

  vec3 warmCore = mix(u_c1, u_c3, 0.3 + coreNoise);
  vec3 haloTint = mix(u_c2, u_c1, 0.4 + coreDetail);

  col += warmCore * innerGlow * 0.7 * u_coreIntensity;
  col += haloTint * outerHalo * u_coreIntensity;
  col += warmCore * midRegion * u_coreIntensity;
  col += vec3(1.0, 0.97, 0.93) * rim * u_coreIntensity;
  col += vec3(1.0, 0.98, 0.95) * exp(-coreDist * coreDist * 60.0) * breath * 0.35 * u_coreIntensity;

  // Sparkle highlights
  float sparkle = pow(max(0.0, gnoise(vec3(p * 25.0, t * 0.25))), 12.0);
  col += vec3(1.0, 0.92, 0.85) * sparkle * 0.25 * u_coreIntensity;

  // Vignette
  float vig = 1.0 - dot(uv - 0.5, uv - 0.5) * 2.2;
  col *= smoothstep(0.0, 0.5, vig);

  // Tone mapping
  col = col / (col + 0.45);
  col = pow(col, vec3(0.88));

  gl_FragColor = vec4(col, 1.0);
}
`
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface NebulaCanvasProps {
  className?: string
}

interface WebGLHandles {
  gl: WebGLRenderingContext
  uTime: WebGLUniformLocation | null
  uRes: WebGLUniformLocation | null
  uMouse: WebGLUniformLocation | null
  uC1: WebGLUniformLocation | null
  uC2: WebGLUniformLocation | null
  uC3: WebGLUniformLocation | null
  uCoreIntensity: WebGLUniformLocation | null
  uFlowEnergy: WebGLUniformLocation | null
  uBreathRate: WebGLUniformLocation | null
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Full-screen WebGL nebula layer. Does NOT own its own rAF loop.
 * Call `render(time, params, palette, mouseX, mouseY)` from the parent
 * composite component's shared loop.
 */
export function useNebulaCanvas({ octaves = 6 }: { octaves?: number } = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handlesRef = useRef<WebGLHandles | null>(null)

  const init = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return false

    const gl = canvas.getContext("webgl", { alpha: false, antialias: false })
    if (!gl) {
      console.warn("No WebGL support")
      return false
    }

    const FRAG = makeFrag(octaves)

    function compile(src: string, type: number): WebGLShader | null {
      const s = gl.createShader(type)
      if (!s) return null
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s))
        return null
      }
      return s
    }

    const prog = gl.createProgram()
    if (!prog) return false

    const vs = compile(VERT, gl.VERTEX_SHADER)
    const fs = compile(FRAG, gl.FRAGMENT_SHADER)
    if (!vs || !fs) return false

    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.useProgram(prog)

    // Full-screen quad
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    )
    const posLoc = gl.getAttribLocation(prog, "pos")
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    handlesRef.current = {
      gl,
      uTime: gl.getUniformLocation(prog, "u_time"),
      uRes: gl.getUniformLocation(prog, "u_res"),
      uMouse: gl.getUniformLocation(prog, "u_mouse"),
      uC1: gl.getUniformLocation(prog, "u_c1"),
      uC2: gl.getUniformLocation(prog, "u_c2"),
      uC3: gl.getUniformLocation(prog, "u_c3"),
      uCoreIntensity: gl.getUniformLocation(prog, "u_coreIntensity"),
      uFlowEnergy: gl.getUniformLocation(prog, "u_flowEnergy"),
      uBreathRate: gl.getUniformLocation(prog, "u_breathRate"),
    }
    return true
  }, [octaves])

  const resize = useCallback((w: number, h: number, dprCap = 2) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio ?? 1, dprCap)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }, [])

  const render = useCallback(
    (
      time: number,
      params: ExpressionParams,
      palette: Palette,
      mouseX: number,
      mouseY: number
    ) => {
      const h = handlesRef.current
      if (!h) return
      const { gl } = h
      const w = gl.canvas.width
      const ht = gl.canvas.height

      gl.viewport(0, 0, w, ht)
      gl.uniform1f(h.uTime, time)
      gl.uniform2f(h.uRes, w, ht)
      gl.uniform2f(h.uMouse, mouseX, 1.0 - mouseY)
      gl.uniform3f(h.uC1, palette[0][0], palette[0][1], palette[0][2])
      gl.uniform3f(h.uC2, palette[1][0], palette[1][1], palette[1][2])
      gl.uniform3f(h.uC3, palette[2][0], palette[2][1], palette[2][2])
      gl.uniform1f(h.uCoreIntensity, params.coreIntensity)
      gl.uniform1f(h.uFlowEnergy, params.flowEnergy)
      gl.uniform1f(h.uBreathRate, params.breathRate)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    []
  )

  return { canvasRef, init, resize, render }
}

/**
 * Thin DOM wrapper for the nebula canvas element.
 * The actual rendering is driven by the parent via the hook.
 */
export function NebulaCanvas({ className: _className }: NebulaCanvasProps) {
  // This is just the mount-point. PresenceField uses useNebulaCanvas
  // and attaches the ref to this canvas.
  return null
}
