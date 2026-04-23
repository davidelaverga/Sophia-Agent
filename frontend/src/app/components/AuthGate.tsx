"use client"

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react"

import { authBypassEnabled } from "@/app/lib/auth/dev-bypass"
import {
  getAuthGateVisualProfile,
  shouldSkipTierFrame,
} from "@/app/lib/visual-tier-profiles"
import { authClient } from "@/server/better-auth/client"

import { useCopy, useTranslation } from "../copy"
import { useVisualTier } from "../hooks/useVisualTier"
import { useAuth } from "../providers"

type AuthState = "checking" | "unauthenticated" | "authenticated"

type TrailPoint = {
  age: number
  x: number
  y: number
}

type DustMote = {
  alpha: number
  color: [number, number, number]
  phase: number
  size: number
  speed: number
  vx: number
  vy: number
  x: number
  y: number
}

const AUTH_TIMEOUT_MS = 5000

const SKY_VERTEX_SHADER = `attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}`

const SKY_FRAGMENT_SHADER = String.raw`
precision highp float;
uniform float uTime;
uniform vec2 uRes;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float hash2(vec2 p){return fract(sin(dot(p,vec2(269.5,183.3)))*43758.5453);}
vec2 hash2v(vec2 p){return vec2(hash(p),hash2(p));}

float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<6;i++){v+=a*noise(p);p*=2.03;a*=0.47;}return v;}
float fbm4(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.1;a*=0.45;}return v;}
float fbm8(vec2 p){float v=0.0,a=0.5;for(int i=0;i<8;i++){v+=a*noise(p);p*=2.01;a*=0.48;}return v;}

void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  float asp=uRes.x/uRes.y;
  vec2 p=(gl_FragCoord.xy-0.5*uRes)/min(uRes.x,uRes.y);
  float t=uTime;

  float drift = t * 0.0004;
  float cdrift = cos(drift), sdrift = sin(drift);

  float horizonY=-0.25;
  float aboveHorizon=smoothstep(horizonY-0.02,horizonY+0.02,p.y);
  float belowHorizon=1.0-aboveHorizon;
  float distFromHorizon=abs(p.y-horizonY);

  vec3 skyTop=vec3(0.012,0.014,0.035);
  vec3 skyMid=vec3(0.025,0.022,0.055);
  vec3 skyHorizon=vec3(0.06,0.04,0.08);
  float skyT=smoothstep(horizonY,0.9,p.y);
  vec3 sky=mix(skyHorizon,mix(skyMid,skyTop,smoothstep(0.0,1.0,skyT)),skyT);

  float horizGlow=exp(-distFromHorizon*distFromHorizon*8.0);
  float horizGlowWide=exp(-distFromHorizon*distFromHorizon*2.0);
  float horizBreath = 0.85 + 0.15 * sin(t * 0.06 + 1.0);

  sky+=vec3(0.12,0.06,0.04)*horizGlow*0.7*horizBreath;
  sky+=vec3(0.06,0.03,0.06)*horizGlow*0.4;
  sky+=vec3(0.04,0.02,0.07)*horizGlowWide*0.5;

  float horizNoise=fbm4(vec2(p.x*3.0+0.5,t*0.02))*0.5+0.5;
  sky+=vec3(0.08,0.04,0.02)*horizGlow*horizNoise*0.5;
  sky+=vec3(0.02,0.02,0.06)*horizGlow*(1.0-horizNoise)*0.3;

  float terrain=horizonY;
  terrain+=fbm4(vec2(p.x*2.0+10.0,0.5))*0.04;
  terrain+=noise(vec2(p.x*5.0+3.0,1.2))*0.015;
  terrain+=noise(vec2(p.x*12.0+7.0,2.5))*0.006;

  float mtns=horizonY+0.02;
  mtns+=fbm4(vec2(p.x*1.2+20.0,3.0))*0.08;
  mtns+=noise(vec2(p.x*3.5+15.0,4.2))*0.025;

  float isTerrain=smoothstep(terrain+0.003,terrain-0.003,p.y);
  float isMountain=smoothstep(mtns+0.004,mtns-0.002,p.y)*(1.0-isTerrain);

  vec3 mtnCol=vec3(0.025,0.018,0.04);
  float mtnEdge=smoothstep(mtns-0.008,mtns+0.001,p.y)*smoothstep(mtns+0.015,mtns+0.001,p.y);
  mtnCol+=vec3(0.06,0.03,0.08)*mtnEdge*2.0;

  vec3 groundCol=vec3(0.012,0.010,0.018);
  float groundNoise=fbm4(vec2(p.x*8.0,p.y*8.0+5.0))*0.5+0.5;
  groundCol+=vec3(0.008,0.005,0.012)*groundNoise;
  float groundFog=exp(-(p.y-horizonY)*(p.y-horizonY)*80.0)*belowHorizon;
  groundCol=mix(groundCol,vec3(0.04,0.025,0.05),groundFog*0.5);

  vec2 pMW = vec2(cdrift * p.x - sdrift * p.y, sdrift * p.x + cdrift * p.y);

  float mwSlope = 0.48;
  float mwCenterY = mwSlope * pMW.x + 0.20 + sin(pMW.x * 1.5) * 0.025;

  float mwNormFactor = 1.0 / sqrt(1.0 + mwSlope * mwSlope);
  float mwDist = abs(pMW.y - mwCenterY) * mwNormFactor;

  float coreX = 0.12;
  float coreProx = exp(-(pMW.x - coreX) * (pMW.x - coreX) * 2.8);

  float bandHW = 0.13 + coreProx * 0.08;
  float bandMask = smoothstep(bandHW * 2.5, bandHW * 0.1, mwDist) * aboveHorizon;
  float coreMask = exp(-mwDist * mwDist / (bandHW * bandHW * 0.10)) * coreProx * aboveHorizon;

  float mwAng = atan(mwSlope);
  float cs2 = cos(mwAng), sn2 = sin(mwAng);
  vec2 mwUV = vec2(cs2 * pMW.x + sn2 * pMW.y, -sn2 * pMW.x + cs2 * pMW.y);

  vec2 warp = vec2(
    fbm4(mwUV * 2.0 + vec2(1.7, 9.2)),
    fbm4(mwUV * 2.0 + vec2(8.3, 2.8))
  );
  vec2 wUV = mwUV + warp * 0.12;

  float cL = fbm(wUV * 3.0 + vec2(0.0, 3.0));
  float cM = fbm(wUV * 6.5 + vec2(5.0, 1.0));
  float cF = fbm8(wUV * 13.0 + vec2(2.0, 7.0));
  float cU = fbm4(wUV * 25.0 + vec2(8.0, 4.0));

  float nebula = cL * 0.38 + cM * 0.30 + cF * 0.22 + cU * 0.10;
  nebula = smoothstep(0.22, 0.72, nebula);

  float rift   = fbm(wUV * 4.5 + vec2(3.0, 0.5));
  float rift2  = fbm4(wUV * 9.0 + vec2(0.5, 5.5));
  float dFine  = fbm4(wUV * 18.0 + vec2(7.0, 3.0));
  float dUltra = noise(wUV * 32.0 + vec2(1.0, 9.0));

  float absorp = 0.0;
  absorp += smoothstep(0.44, 0.62, rift)  * 0.45;
  absorp += smoothstep(0.47, 0.60, rift2) * 0.22;
  absorp += smoothstep(0.50, 0.60, dFine) * 0.12;
  absorp += smoothstep(0.52, 0.58, dUltra)* 0.06;
  absorp = clamp(absorp, 0.0, 0.65);

  float dustConc = smoothstep(bandHW * 1.3, 0.0, mwDist);
  float transmission = 1.0 - absorp * dustConc;
  nebula *= transmission;

  vec3 coreWarm  = vec3(0.95, 0.52, 0.30);
  vec3 coreHot   = vec3(1.00, 0.78, 0.38);
  vec3 corePink  = vec3(0.88, 0.42, 0.52);
  vec3 midLav    = vec3(0.58, 0.50, 0.80);
  vec3 outerBlue = vec3(0.35, 0.38, 0.65);

  float edgeT = clamp(mwDist / (bandHW * 1.5), 0.0, 1.0);
  vec3 mwCol = mix(midLav, outerBlue, edgeT);

  float coreBlend = coreProx * (1.0 - edgeT);
  mwCol = mix(mwCol, coreWarm, coreBlend * 0.55);
  mwCol = mix(mwCol, coreHot,  coreBlend * coreMask * 0.45);

  float pinkN = fbm4(wUV * 5.0 + vec2(4.0, 6.0));
  mwCol = mix(mwCol, corePink, coreBlend * pinkN * 0.28);

  float coreBreath = 0.88 + 0.12 * sin(t * 0.045);

  sky += mwCol * nebula * bandMask * 0.72;
  sky += coreHot * coreMask * nebula * 0.30 * coreBreath;

  float haloMask = smoothstep(bandHW * 4.0, bandHW * 0.6, mwDist) * aboveHorizon;
  sky += vec3(0.022, 0.018, 0.042) * haloMask * (0.5 + cL * 0.5);

  float agZone = smoothstep(horizonY + 0.28, horizonY + 0.02, p.y) * smoothstep(-0.7, 0.25, p.x);
  float agN = fbm4(vec2(p.x * 2.0 + t * 0.01, p.y * 4.0 + 3.0));
  sky += vec3(0.012, 0.022, 0.010) * agZone * agN * 0.35;

  float auroraY = smoothstep(0.30, 0.55, p.y) * smoothstep(0.75, 0.50, p.y);
  float aWave1 = sin(p.x * 6.0 + t * 0.08 + fbm4(vec2(p.x * 2.0 + t * 0.03, 5.0)) * 3.0);
  float aWave2 = sin(p.x * 10.0 - t * 0.05 + 2.8);
  float aCurtain = smoothstep(0.2, 0.95, aWave1 * 0.5 + 0.5) * (0.6 + 0.4 * aWave2);
  float aFlicker = 0.6 + 0.4 * sin(t * 0.12 + p.x * 3.0);
  float aMask = auroraY * aCurtain * aFlicker;
  vec3 auroraCol = mix(vec3(0.02, 0.06, 0.03), vec3(0.04, 0.02, 0.06), smoothstep(0.40, 0.55, p.y));
  sky += auroraCol * aMask * 0.35;

  float hs1 = exp(-length(pMW - vec2(0.05, 0.22)) * 8.0) * (0.7 + 0.3 * sin(t * 0.07 + 1.0));
  float hs2 = exp(-length(pMW - vec2(0.20, 0.30)) * 10.0) * (0.7 + 0.3 * sin(t * 0.09 + 3.5));
  float hs3 = exp(-length(pMW - vec2(-0.15, 0.14)) * 9.0) * (0.7 + 0.3 * sin(t * 0.055 + 5.2));
  sky += vec3(0.03, 0.015, 0.04) * hs1 * bandMask;
  sky += vec3(0.02, 0.02, 0.04) * hs2 * bandMask;
  sky += vec3(0.025, 0.01, 0.035) * hs3 * bandMask;

  vec2 pStar = vec2(cdrift * p.x - sdrift * p.y, sdrift * p.x + cdrift * p.y);

  vec3 starSum = vec3(0.0);

  for(int L = 0; L < 7; L++){
    float fL = float(L);
    float scl = 250.0 + fL * 140.0;

    vec2 sd = vec2(fL * 7.3 + 1.0, fL * 3.1 + 2.0);
    vec2 cUV = pStar * scl + sd;
    vec2 cID = floor(cUV);
    vec2 cFr = fract(cUV);

    vec2 jit = hash2v(cID);
    vec2 sPos = vec2(0.12 + 0.76 * jit.x, 0.12 + 0.76 * jit.y);
    float d = length(cFr - sPos);

    float raw = hash(cID + vec2(5.0, 8.0));
    float pw = 28.0 + fL * 5.0;
    float br = pow(raw, pw);

    float twSpd = 0.5 + hash(cID + vec2(1.0, 2.0)) * 2.5;
    float twBase = 0.72 + 0.28 * sin(t * twSpd + hash(cID) * 62.83);
    float scintFreq = 3.0 + hash(cID + vec2(3.0, 7.0)) * 8.0;
    float scint = 0.85 + 0.15 * sin(t * scintFreq + hash(cID + vec2(6.0, 1.0)) * 31.4);
    float scintStrength = smoothstep(0.001, 0.02, br);
    float tw = twBase * mix(1.0, scint, scintStrength);

    float sigma = 0.12 + br * 0.06;
    float s = exp(-d * d / (2.0 * sigma * sigma));
    s *= br * tw * aboveHorizon;
    s *= 1.0 + bandMask * 2.5 * (1.0 - fL / 7.0);

    float hR = hash(cID + vec2(9.0, 4.0));
    vec3 sCol = hR < 0.05 ? vec3(0.62, 0.68, 1.0) :
                hR < 0.10 ? vec3(1.0, 0.86, 0.62) :
                hR < 0.16 ? vec3(0.78, 0.74, 1.0) :
                vec3(0.91, 0.89, 0.95);

    starSum += sCol * s;
  }

  sky += starSum * 0.55;

  for(int i = 0; i < 5; i++){
    float fi = float(i);
    vec2 sp = vec2(
      hash(vec2(fi * 13.7, fi * 7.3 + 100.0)) * 1.6 - 0.8,
      horizonY + 0.08 + hash(vec2(fi * 9.1, fi * 4.8 + 200.0)) * 0.60
    );
    float d = length(pStar - sp);
    float core = exp(-d * d * 10000.0) * 0.45;
    float glow = exp(-d * d * 1000.0) * 0.10;
    float sH = exp(-abs(pStar.y - sp.y) * 400.0) * exp(-abs(pStar.x - sp.x) * 18.0) * 0.03;
    float sV = exp(-abs(pStar.x - sp.x) * 400.0) * exp(-abs(pStar.y - sp.y) * 18.0) * 0.025;
    float twk = 0.90 + 0.10 * sin(t * 0.3 + fi * 2.8);
    vec3 sc = fi < 2.0 ? vec3(0.86, 0.84, 1.0) : fi < 3.5 ? vec3(1.0, 0.91, 0.76) : vec3(0.84, 0.87, 1.0);
    sky += (core + glow + sH + sV) * sc * twk * aboveHorizon;
  }

  float mistY = smoothstep(horizonY + 0.12, horizonY - 0.02, p.y);
  float mistN1 = fbm4(vec2(p.x * 2.0 + t * 0.012, p.y * 6.0 + 1.0));
  float mistN2 = fbm4(vec2(p.x * 3.5 - t * 0.008 + 5.0, p.y * 8.0 + 3.0));
  float mist = mistY * (mistN1 * 0.6 + mistN2 * 0.4);
  mist *= smoothstep(0.25, 0.50, mistN1);
  vec3 mistCol = mix(vec3(0.04, 0.03, 0.06), vec3(0.07, 0.04, 0.05), mistN2);

  vec3 col=sky;
  col=mix(col,mtnCol,isMountain);
  col=mix(col,groundCol,isTerrain);
  col = mix(col, mistCol, mist * 0.35);

  float vig=1.0-dot(uv-0.5,uv-0.5)*1.6;
  col*=smoothstep(-0.1,0.55,vig);
  col=col/(col+0.40);
  col=pow(col,vec3(0.92));

  float grain=hash(uv*uRes+vec2(t*173.1,t*291.7));
  col+=vec3((grain-0.5)*0.014);

  gl_FragColor=vec4(col,1.0);
}
`

function compileShader(gl: WebGLRenderingContext, source: string, type: number) {
  const shader = gl.createShader(type)
  if (!shader) {
    return null
  }

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }

  return shader
}

export function AuthGate({
  children,
  onAuthenticated,
}: {
  children: ReactNode
  onAuthenticated?: () => void
}) {
  const copy = useCopy()
  const { t } = useTranslation()
  const { reducedMotion: prefersReducedMotion, tier, dprCap } = useVisualTier()
  const renderProfile = useMemo(() => getAuthGateVisualProfile(tier), [tier])
  const skyCanvasRef = useRef<HTMLCanvasElement>(null)
  const starsCanvasRef = useRef<HTMLCanvasElement>(null)

  const { user, loading } = useAuth()
  const [authState, setAuthState] = useState<AuthState>(
    authBypassEnabled ? "authenticated" : "checking",
  )
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)
  const hasResolvedRef = useRef(authBypassEnabled)

  useEffect(() => {
    if (authBypassEnabled) {
      onAuthenticated?.()
    }
  }, [onAuthenticated])

  useEffect(() => {
    if (authBypassEnabled) {
      return
    }

    if (hasResolvedRef.current) {
      if (!loading) {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }

        if (user) {
          setAuthState("authenticated")
          onAuthenticated?.()
        } else {
          setAuthState("unauthenticated")
        }
      }

      return
    }

    if (!loading) {
      hasResolvedRef.current = true
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }

      if (user) {
        setAuthState("authenticated")
        onAuthenticated?.()
      } else {
        setAuthState("unauthenticated")
      }
      return
    }

    if (!timeoutRef.current) {
      timeoutRef.current = setTimeout(() => {
        if (!hasResolvedRef.current) {
          hasResolvedRef.current = true
          setAuthState("unauthenticated")
        }
      }, AUTH_TIMEOUT_MS)
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [loading, onAuthenticated, user])

  useEffect(() => {
    if (authState !== "unauthenticated") {
      return
    }

    const canvas = skyCanvasRef.current
    if (!canvas) {
      return
    }

    const gl = canvas.getContext("webgl", { alpha: false, antialias: false })
    if (!gl) {
      return
    }

    const vertexShader = compileShader(gl, SKY_VERTEX_SHADER, gl.VERTEX_SHADER)
    const fragmentShader = compileShader(gl, SKY_FRAGMENT_SHADER, gl.FRAGMENT_SHADER)
    if (!vertexShader || !fragmentShader) {
      return
    }

    const program = gl.createProgram()
    if (!program) {
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
      return
    }

    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
      return
    }

    gl.useProgram(program)

    const buffer = gl.createBuffer()
    if (!buffer) {
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
      return
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    const positionLocation = gl.getAttribLocation(program, "p")
    const timeLocation = gl.getUniformLocation(program, "uTime")
    const resolutionLocation = gl.getUniformLocation(program, "uRes")

    if (positionLocation < 0 || !timeLocation || !resolutionLocation) {
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
      return
    }

    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, dprCap)
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      gl.viewport(0, 0, canvas.width, canvas.height)
    }

    let animationFrameId = 0
    let startTime = 0
    let lastFrameTime = 0

    const stopLoop = () => {
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId)
        animationFrameId = 0
      }
      startTime = 0
      lastFrameTime = 0
    }

    const isDocumentHidden = () => document.visibilityState === "hidden"

    const render = (frameTime: number) => {
      if (
        renderProfile.animateSky &&
        !prefersReducedMotion &&
        shouldSkipTierFrame(frameTime, lastFrameTime, renderProfile.skyFrameIntervalMs)
      ) {
        animationFrameId = window.requestAnimationFrame(render)
        return
      }

      if (startTime === 0) {
        startTime = frameTime
      }
      lastFrameTime = frameTime

      const elapsed = prefersReducedMotion || !renderProfile.animateSky ? 0 : (frameTime - startTime) * 0.001
      gl.uniform1f(timeLocation, elapsed)
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

      if (!prefersReducedMotion && renderProfile.animateSky) {
        animationFrameId = window.requestAnimationFrame(render)
      }
    }

    const startLoop = () => {
      if (prefersReducedMotion || !renderProfile.animateSky || animationFrameId || isDocumentHidden()) {
        return
      }

      animationFrameId = window.requestAnimationFrame(render)
    }

    const handleVisibilityChange = () => {
      if (prefersReducedMotion || !renderProfile.animateSky) {
        return
      }

      if (isDocumentHidden()) {
        stopLoop()
        return
      }

      startLoop()
    }

    resize()
    window.addEventListener("resize", resize)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    if (prefersReducedMotion || !renderProfile.animateSky) {
      render(0)
    } else {
      startLoop()
    }

    return () => {
      stopLoop()
      window.removeEventListener("resize", resize)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
    }
  }, [authState, prefersReducedMotion, dprCap, renderProfile])

  useEffect(() => {
    if (authState !== "unauthenticated") {
      return
    }

    const canvas = starsCanvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) {
      return
    }

    let width = 0
    let height = 0
    let animationFrameId = 0

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, dprCap)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    class ShootingStar {
      active = false
      color: [number, number, number] = [235, 232, 242]
      delay = 0
      dx = 0
      dy = 0
      life = 0
      maxLife = 0
      peakAlpha = 0
      speed = 0
      trail: TrailPoint[] = []
      trailMaxAge = 0
      width = 0
      x = 0
      y = 0

      constructor() {
        this.reset(true)
      }

      reset(initial: boolean) {
        const baseAngle = 0.45 + (Math.random() - 0.5) * 0.35
        this.dx = Math.cos(baseAngle)
        this.dy = Math.sin(baseAngle)
        this.x = Math.random() * width * 0.8
        this.y = Math.random() * height * 0.35

        const isBright = Math.random() < 0.15
        this.speed = isBright ? 400 + Math.random() * 300 : 900 + Math.random() * 800
        this.maxLife = isBright ? 0.6 + Math.random() * 0.5 : 0.15 + Math.random() * 0.25
        this.width = isBright ? 1.0 + Math.random() * 0.8 : 0.4 + Math.random() * 0.5
        this.peakAlpha = isBright ? 0.5 + Math.random() * 0.35 : 0.15 + Math.random() * 0.2

        const tintRoll = Math.random()
        this.color = tintRoll < 0.15 ? [230, 210, 175] : tintRoll < 0.25 ? [200, 195, 225] : [235, 232, 242]
        this.delay = initial ? Math.random() * 5 : 2.0 + Math.random() * 6.0
        this.life = 0
        this.active = false
        this.trail = []
        this.trailMaxAge = isBright ? 0.45 : 0.18
      }

      update(dt: number) {
        if (this.delay > 0) {
          this.delay -= dt
          return
        }
        if (!this.active) {
          this.active = true
        }

        this.life += dt
        if (this.life > this.maxLife) {
          this.reset(false)
          return
        }

        const distance = this.speed * dt
        this.x += this.dx * distance
        this.y += this.dy * distance

        this.trail.push({ x: this.x, y: this.y, age: 0 })
        for (const point of this.trail) {
          point.age += dt
        }
        while (this.trail.length > 0 && this.trail[0].age > this.trailMaxAge) {
          this.trail.shift()
        }
      }

      draw(ctx: CanvasRenderingContext2D) {
        if (!this.active || this.trail.length < 2) {
          return
        }

        const [red, green, blue] = this.color
        const fadeIn = Math.min(this.life / 0.05, 1.0)
        const fadeOut = Math.max((this.maxLife - this.life) / (this.maxLife * 0.4), 0.0)
        const lifeFade = Math.min(fadeIn, fadeOut)

        ctx.save()
        ctx.lineCap = "round"
        ctx.lineJoin = "round"

        for (let index = 1; index < this.trail.length; index += 1) {
          const point = this.trail[index]
          const previousPoint = this.trail[index - 1]
          const trailT = 1.0 - point.age / this.trailMaxAge
          const alpha = trailT * trailT * lifeFade * this.peakAlpha
          if (alpha < 0.005) {
            continue
          }

          ctx.beginPath()
          ctx.moveTo(previousPoint.x, previousPoint.y)
          ctx.lineTo(point.x, point.y)
          ctx.strokeStyle = `rgba(${red},${green},${blue},${alpha})`
          ctx.lineWidth = this.width * trailT
          ctx.stroke()
        }

        if (this.trail.length > 0) {
          const head = this.trail[this.trail.length - 1]
          const headAlpha = lifeFade * this.peakAlpha
          const glowRadius = this.width * 2.5
          const gradient = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, glowRadius)
          gradient.addColorStop(0, `rgba(255,250,240,${headAlpha * 0.6})`)
          gradient.addColorStop(0.4, `rgba(${red},${green},${blue},${headAlpha * 0.15})`)
          gradient.addColorStop(1, `rgba(${red},${green},${blue},0)`)
          ctx.fillStyle = gradient
          ctx.fillRect(head.x - glowRadius, head.y - glowRadius, glowRadius * 2, glowRadius * 2)
        }

        ctx.restore()
      }
    }

    class Satellite {
      active = false
      brightness = 0
      delay = 0
      flarePhase = 0
      flareSpeed = 0
      life = 0
      maxLife = 0
      vx = 0
      vy = 0
      x = 0
      y = 0

      constructor() {
        this.reset(true)
      }

      reset(initial: boolean) {
        const fromLeft = Math.random() < 0.5
        this.x = fromLeft ? -20 : width + 20
        this.y = height * (0.05 + Math.random() * 0.3)
        const exitY = height * (0.05 + Math.random() * 0.3)
        const dx = fromLeft ? 1 : -1
        const distance = width + 40
        const dy = (exitY - this.y) / distance
        this.vx = dx * (35 + Math.random() * 25)
        this.vy = dy * Math.abs(this.vx)
        this.life = 0
        this.maxLife = distance / Math.abs(this.vx)
        this.brightness = 0.18 + Math.random() * 0.15
        this.flarePhase = Math.random() * Math.PI * 2
        this.flareSpeed = 1.5 + Math.random() * 3.0
        this.delay = initial ? 5 + Math.random() * 15 : 25 + Math.random() * 35
        this.active = false
      }

      update(dt: number) {
        if (this.delay > 0) {
          this.delay -= dt
          return
        }
        if (!this.active) {
          this.active = true
        }

        this.life += dt
        if (this.life > this.maxLife) {
          this.reset(false)
          return
        }
        this.x += this.vx * dt
        this.y += this.vy * dt
      }

      draw(ctx: CanvasRenderingContext2D) {
        if (!this.active) {
          return
        }

        const edgeFade = Math.min(this.life / 2.0, (this.maxLife - this.life) / 2.0, 1.0)
        const flare = 1.0 + 0.6 * Math.max(0, Math.sin(this.life * this.flareSpeed + this.flarePhase))
        const alpha = this.brightness * edgeFade * flare
        if (alpha < 0.01) {
          return
        }

        const radius = 1.2
        const gradient = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, radius * 3)
        gradient.addColorStop(0, `rgba(235,232,245,${alpha})`)
        gradient.addColorStop(0.35, `rgba(220,215,235,${alpha * 0.3})`)
        gradient.addColorStop(1, "rgba(200,195,220,0)")
        ctx.fillStyle = gradient
        ctx.fillRect(this.x - radius * 3, this.y - radius * 3, radius * 6, radius * 6)
      }
    }

    class NightFlyer {
      active = false
      arcAmp = 0
      delay = 0
      fromLeft = true
      life = 0
      maxLife = 0
      size = 0
      vx = 0
      wingPhase = 0
      wingSpeed = 0
      x = 0
      y = 0

      constructor() {
        this.reset(true)
      }

      reset(initial: boolean) {
        this.fromLeft = Math.random() < 0.5
        this.x = this.fromLeft ? -30 : width + 30
        this.y = height * (0.15 + Math.random() * 0.35)
        this.vx = (this.fromLeft ? 1 : -1) * (60 + Math.random() * 40)
        this.arcAmp = (Math.random() - 0.5) * 30
        this.wingPhase = Math.random() * Math.PI * 2
        this.wingSpeed = 6 + Math.random() * 4
        this.size = 3 + Math.random() * 4
        this.life = 0
        this.maxLife = (width + 60) / Math.abs(this.vx)
        this.delay = initial ? 10 + Math.random() * 30 : 30 + Math.random() * 60
        this.active = false
      }

      update(dt: number) {
        if (this.delay > 0) {
          this.delay -= dt
          return
        }
        if (!this.active) {
          this.active = true
        }

        this.life += dt
        if (this.life > this.maxLife) {
          this.reset(false)
          return
        }

        this.x += this.vx * dt
        const progress = this.life / this.maxLife
        this.y += this.arcAmp * Math.cos(progress * Math.PI) * dt * 0.3
      }

      draw(ctx: CanvasRenderingContext2D) {
        if (!this.active) {
          return
        }

        const progress = this.life / this.maxLife
        const fade = Math.min(progress * 8, (1 - progress) * 8, 1.0)
        if (fade < 0.01) {
          return
        }

        const wing = Math.sin(this.life * this.wingSpeed + this.wingPhase)
        const wingUp = wing * this.size * 0.7

        ctx.save()
        ctx.translate(this.x, this.y)
        ctx.scale(this.fromLeft ? 1 : -1, 1)
        ctx.globalAlpha = 0.25 * fade
        ctx.fillStyle = "#0a0810"
        ctx.beginPath()
        ctx.moveTo(0, 0)
        ctx.quadraticCurveTo(-this.size * 0.5, -wingUp * 0.8, -this.size * 1.2, -wingUp)
        ctx.quadraticCurveTo(-this.size * 0.8, -wingUp * 0.3, -this.size * 0.3, wingUp * 0.1)
        ctx.quadraticCurveTo(this.size * 0.5, -wingUp * 0.8, this.size * 1.2, -wingUp)
        ctx.quadraticCurveTo(this.size * 0.8, -wingUp * 0.3, this.size * 0.3, wingUp * 0.1)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }
    }

    const shootingStarCount = renderProfile.shootingStarCount
    const dustCount = renderProfile.dustCount
    const shootingStars = Array.from({ length: shootingStarCount }, () => new ShootingStar())
    const satellite = renderProfile.satelliteEnabled ? new Satellite() : null
    const dust: DustMote[] = Array.from({ length: dustCount }, () => ({
      x: Math.random() * 2 - 0.5,
      y: Math.random() * 2 - 0.5,
      vx: (Math.random() - 0.5) * 0.00008,
      vy: -0.00002 - Math.random() * 0.00005,
      size: 0.4 + Math.random() * 1.2,
      alpha: 0.05 + Math.random() * 0.15,
      phase: Math.random() * Math.PI * 2,
      speed: 0.3 + Math.random() * 1.0,
      color: Math.random() < 0.4 ? [218, 197, 160] : Math.random() < 0.6 ? [184, 164, 232] : [200, 198, 210],
    }))
    const nightFlyers = Array.from({ length: renderProfile.nightFlyerCount }, () => new NightFlyer())

    let windX = 0
    let windTargetX = 0
    let windTimer = 0
    let previousTime = 0
    let lastFrameTime = 0

    const stopLoop = () => {
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId)
        animationFrameId = 0
      }
      previousTime = 0
      lastFrameTime = 0
    }

    const isDocumentHidden = () => document.visibilityState === "hidden"

    const updateWind = (dt: number) => {
      windTimer -= dt
      if (windTimer <= 0) {
        windTargetX = (Math.random() - 0.5) * 0.00035
        windTimer = 8 + Math.random() * 12
      }

      windX += (windTargetX - windX) * dt * 0.4
      windTargetX *= 0.997
    }

    const drawFrame = (frameTime: number) => {
      if (
        !prefersReducedMotion &&
        shouldSkipTierFrame(frameTime, lastFrameTime, renderProfile.starsFrameIntervalMs)
      ) {
        animationFrameId = window.requestAnimationFrame(drawFrame)
        return
      }

      const dt = prefersReducedMotion ? 0 : Math.min((frameTime - previousTime) / 1000, 0.05)
      previousTime = frameTime
      lastFrameTime = frameTime
      const t = frameTime * 0.001

      context.clearRect(0, 0, width, height)

      for (const star of shootingStars) {
        star.update(dt)
        star.draw(context)
      }

      satellite?.update(dt)
      satellite?.draw(context)

      for (const flyer of nightFlyers) {
        flyer.update(dt)
        flyer.draw(context)
      }

      updateWind(dt)

      for (const mote of dust) {
        mote.x += mote.vx + windX
        mote.y += mote.vy
        if (mote.x < -0.5) mote.x = 1.5
        if (mote.x > 1.5) mote.x = -0.5
        if (mote.y < -0.5) mote.y = 1.5
        if (mote.y > 1.5) mote.y = -0.5

        const px = mote.x * width
        const py = mote.y * height
        const twinkle = 0.5 + 0.5 * Math.sin(t * mote.speed + mote.phase)
        const alpha = mote.alpha * twinkle
        const [red, green, blue] = mote.color

        const gradient = context.createRadialGradient(px, py, 0, px, py, mote.size * 3)
        gradient.addColorStop(0, `rgba(${red},${green},${blue},${alpha})`)
        gradient.addColorStop(0.5, `rgba(${red},${green},${blue},${alpha * 0.3})`)
        gradient.addColorStop(1, `rgba(${red},${green},${blue},0)`)
        context.fillStyle = gradient
        context.fillRect(px - mote.size * 3, py - mote.size * 3, mote.size * 6, mote.size * 6)
      }

      if (!prefersReducedMotion) {
        animationFrameId = window.requestAnimationFrame(drawFrame)
      }
    }

    const startLoop = () => {
      if (prefersReducedMotion || animationFrameId || isDocumentHidden()) {
        return
      }

      animationFrameId = window.requestAnimationFrame(drawFrame)
    }

    const handleVisibilityChange = () => {
      if (prefersReducedMotion) {
        return
      }

      if (isDocumentHidden()) {
        stopLoop()
        return
      }

      startLoop()
    }

    resize()
    window.addEventListener("resize", resize)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    if (prefersReducedMotion) {
      drawFrame(0)
    } else {
      startLoop()
    }

    return () => {
      stopLoop()
      window.removeEventListener("resize", resize)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [authState, prefersReducedMotion, dprCap, renderProfile])

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true)
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
      })
    } catch {
      setIsLoggingIn(false)
    }
  }

  const preventPlaceholderNavigation = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
  }

  if (authState === "checking") {
    return (
      <div className="midnightAtelierLoading">
        <div className="midnightAtelierSpinner" />
        <p>{t("auth.loading")}</p>
        <style jsx>{`
          .midnightAtelierLoading {
            position: fixed;
            inset: 0;
            z-index: 50;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 16px;
            background: var(--bg, #050508);
            color: rgba(240, 237, 248, 0.75);
            font-family: var(--font-inter), sans-serif;
          }

          .midnightAtelierSpinner {
            width: 32px;
            height: 32px;
            border: 2px solid rgba(240, 237, 248, 0.2);
            border-top-color: rgba(240, 237, 248, 0.85);
            border-radius: 999px;
            animation: spin 0.8s linear infinite;
          }

          p {
            margin: 0;
            font-size: 14px;
            line-height: 1.5;
          }

          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    )
  }

  if (authState === "authenticated") {
    return <>{children}</>
  }

  return (
    <div className="midnightAtelierGate" data-visual-tier={tier}>
      <canvas ref={skyCanvasRef} className="skyCanvas" aria-hidden="true" />
      <canvas ref={starsCanvasRef} className="starsCanvas" aria-hidden="true" />

      <div className="page">
        <div className="left">
          <div className="logo">
            <div className="logoMark">S</div>
            <span className="logoText">{copy.brand.name}</span>
          </div>

          <div className="hero">
            <div className="heroLabel">Your voice companion</div>
            <h1>
              She remembers.
              <br />
              She <em>notices.</em>
            </h1>
            <p className="heroBody">
              {copy.brand.name} is a companion who carries context across every conversation — your patterns,
              your progress, what you said last Tuesday. Voice or text, she picks up exactly where you left off.
            </p>

            <div className="capabilities">
              <div className="cap">
                <div className="capIcon">🎙</div>
                <div className="capTitle">Voice & text</div>
                <div className="capDesc">Talk or type. Sophia adapts her tone and pace to you, every time.</div>
              </div>

              <div className="cap">
                <div className="capIcon">🧠</div>
                <div className="capTitle">Real memory</div>
                <div className="capDesc">Not summaries. Genuine continuity that builds session over session.</div>
              </div>

              <div className="cap">
                <div className="capIcon">📓</div>
                <div className="capTitle">Journal & recaps</div>
                <div className="capDesc">Your conversations distill into a living journal you can revisit.</div>
              </div>
            </div>
          </div>
        </div>

        <div className="right">
          <div className="card">
            <div className="cardHeader">
              <div className="sophiaMark" />
              <h2>Welcome back</h2>
              <p>Sign in to pick up where you left off.</p>
            </div>

            <div className="divider" />

            <button className="googleButton" type="button" onClick={handleGoogleLogin} disabled={isLoggingIn}>
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Continue with Google
            </button>

            <div className="cardFooter">
              By continuing, you agree to {copy.brand.name}&apos;s
              <br />
              <a href="#" onClick={preventPlaceholderNavigation}>
                Terms of Service
              </a>{" "}
              and{" "}
              <a href="#" onClick={preventPlaceholderNavigation}>
                Privacy Policy
              </a>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        .midnightAtelierGate {
          --text: #f0edf8;
          --text2: rgba(240, 237, 248, 0.55);
          --text3: rgba(240, 237, 248, 0.32);
          --warm: #dac5a0;
          --purple: var(--sophia-purple, #b8a4e8);
          --border: rgba(255, 255, 255, 0.06);

          position: fixed;
          inset: 0;
          z-index: 50;
          min-height: 100vh;
          min-height: 100svh;
          background: var(--bg, #050508);
          color: var(--text);
          overflow-x: hidden;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          -webkit-font-smoothing: antialiased;
          font-family: var(--font-inter), system-ui, sans-serif;
        }

        .skyCanvas,
        .starsCanvas {
          position: fixed;
          inset: 0;
          display: block;
        }

        .skyCanvas {
          z-index: 0;
        }

        .starsCanvas {
          z-index: 1;
        }

        .page {
          position: relative;
          z-index: 10;
          display: grid;
          grid-template-columns: 1fr 1fr;
          min-height: 100vh;
          min-height: 100svh;
          padding-top: env(safe-area-inset-top, 0px);
          padding-bottom: env(safe-area-inset-bottom, 0px);
        }

        .left {
          position: relative;
          display: flex;
          flex-direction: column;
          justify-content: center;
          padding: 64px 48px 64px 72px;
          padding-left: max(72px, env(safe-area-inset-left, 72px));
        }

        .logo {
          position: absolute;
          top: 42px;
          left: 72px;
          display: flex;
          align-items: center;
          gap: 12px;
          opacity: 0;
          animation: fadeIn 0.8s ease 0.3s forwards;
        }

        .logoMark {
          display: grid;
          place-items: center;
          width: 36px;
          height: 36px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 11px;
          background: linear-gradient(135deg, rgba(218, 197, 160, 0.18), rgba(184, 164, 232, 0.18));
          color: var(--text);
          font-family: var(--font-cormorant), Georgia, serif;
          font-size: 20px;
        }

        .logoText {
          font-family: var(--font-cormorant), Georgia, serif;
          font-size: 18px;
          font-weight: 400;
          letter-spacing: 0.04em;
          text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
        }

        .hero {
          max-width: 520px;
          opacity: 0;
          animation: fadeUp 1s ease 0.5s forwards;
        }

        .heroLabel {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 28px;
          color: var(--warm);
          font-size: 11px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }

        .heroLabel::before {
          content: "";
          width: 24px;
          height: 1px;
          background: var(--warm);
          opacity: 0.5;
        }

        h1 {
          margin: 0;
          font-family: var(--font-cormorant), Georgia, serif;
          font-size: clamp(42px, 5.5vw, 72px);
          font-weight: 300;
          line-height: 1.05;
          letter-spacing: -0.025em;
          text-shadow: 0 2px 16px rgba(0, 0, 0, 0.6);
        }

        h1 em {
          color: var(--warm);
          font-style: italic;
        }

        .heroBody {
          max-width: 440px;
          margin-top: 24px;
          color: rgba(240, 237, 248, 0.7);
          font-size: 15px;
          font-weight: 300;
          line-height: 1.8;
          text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
        }

        .capabilities {
          display: flex;
          gap: 12px;
          margin-top: 48px;
          opacity: 0;
          animation: fadeUp 1s ease 0.9s forwards;
        }

        .cap {
          flex: 1;
          padding: 20px 18px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          background: rgba(8, 10, 18, 0.82);
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);
          backdrop-filter: blur(32px);
          -webkit-backdrop-filter: blur(32px);
          transition: border-color 0.3s, background 0.3s, box-shadow 0.3s;
        }

        .cap:hover {
          border-color: rgba(255, 255, 255, 0.14);
          background: rgba(12, 14, 24, 0.88);
          box-shadow: 0 6px 32px rgba(0, 0, 0, 0.45);
        }

        .capIcon {
          display: grid;
          place-items: center;
          width: 32px;
          height: 32px;
          margin-bottom: 14px;
          border-radius: 9px;
          font-size: 15px;
        }

        .cap:nth-child(1) .capIcon {
          background: rgba(184, 164, 232, 0.18);
          color: var(--purple);
        }

        .cap:nth-child(2) .capIcon {
          background: rgba(218, 197, 160, 0.15);
          color: var(--warm);
        }

        .cap:nth-child(3) .capIcon {
          background: rgba(89, 190, 173, 0.15);
          color: var(--cosmic-teal, #59bead);
        }

        .capTitle {
          margin-bottom: 5px;
          color: rgba(240, 237, 248, 0.92);
          font-size: 13px;
          font-weight: 500;
        }

        .capDesc {
          color: rgba(240, 237, 248, 0.5);
          font-size: 12px;
          font-weight: 300;
          line-height: 1.55;
        }

        .right {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 48px;
        }

        .card {
          position: relative;
          width: min(100%, 400px);
          padding: 40px 32px 32px;
          border: 1px solid rgba(255, 255, 255, 0.09);
          border-radius: 24px;
          background: rgba(8, 10, 18, 0.84);
          box-shadow:
            0 40px 100px rgba(0, 0, 0, 0.55),
            0 2px 16px rgba(0, 0, 0, 0.3),
            inset 0 1px 0 rgba(255, 255, 255, 0.06);
          backdrop-filter: blur(48px);
          -webkit-backdrop-filter: blur(48px);
          opacity: 0;
          animation: fadeUp 1.1s ease 0.7s forwards;
        }

        .card::before {
          content: "";
          position: absolute;
          top: 0;
          left: 32px;
          right: 32px;
          height: 1px;
          background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.08), transparent);
        }

        .cardHeader {
          margin-bottom: 32px;
          text-align: center;
        }

        .sophiaMark {
          position: relative;
          display: grid;
          place-items: center;
          width: 56px;
          height: 56px;
          margin: 0 auto 20px;
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 16px;
          background: linear-gradient(135deg, rgba(218, 197, 160, 0.14), rgba(184, 164, 232, 0.14));
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        }

        .sophiaMark::before {
          content: "S";
          color: var(--text);
          font-family: var(--font-cormorant), Georgia, serif;
          font-size: 28px;
          font-weight: 300;
        }

        .sophiaMark::after {
          content: "";
          position: absolute;
          inset: -10px;
          z-index: -1;
          border-radius: 22px;
          background: radial-gradient(circle, rgba(184, 164, 232, 0.1), transparent 70%);
          animation: breathe 5s ease-in-out infinite;
        }

        h2 {
          margin: 0;
          font-family: var(--font-cormorant), Georgia, serif;
          font-size: 28px;
          font-weight: 400;
          letter-spacing: -0.01em;
        }

        .cardHeader p {
          margin: 8px 0 0;
          color: var(--text2);
          font-size: 13px;
          font-weight: 300;
          line-height: 1.6;
        }

        .divider {
          height: 1px;
          margin: 0 -8px 28px;
          background: linear-gradient(90deg, transparent, var(--border), transparent);
        }

        .googleButton {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          width: 100%;
          padding: 16px 20px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.06);
          color: var(--text);
          cursor: pointer;
          font-family: var(--font-inter), system-ui, sans-serif;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.25s ease;
        }

        .googleButton:hover:not(:disabled) {
          border-color: rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.1);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
          transform: translateY(-1px);
        }

        .googleButton:active:not(:disabled) {
          transform: translateY(0);
        }

        .googleButton:disabled {
          cursor: wait;
          opacity: 0.78;
        }

        .googleButton svg {
          flex-shrink: 0;
          width: 18px;
          height: 18px;
        }

        .cardFooter {
          margin-top: 28px;
          color: var(--text3);
          font-size: 12px;
          line-height: 1.7;
          text-align: center;
        }

        .cardFooter a {
          display: inline-block;
          padding: 4px 2px;
          color: var(--text2);
          text-decoration: none;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }

        .cardFooter a:hover {
          border-color: rgba(255, 255, 255, 0.2);
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes fadeUp {
          from {
            opacity: 0;
            transform: translateY(16px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes breathe {
          0%, 100% {
            opacity: 0.4;
            transform: scale(1);
          }
          50% {
            opacity: 0.7;
            transform: scale(1.08);
          }
        }

        /* ── Visual tier adaptations ── */

        :global(.midnightAtelierGate[data-visual-tier="2"]) .card {
          backdrop-filter: blur(24px);
          -webkit-backdrop-filter: blur(24px);
        }

        :global(.midnightAtelierGate[data-visual-tier="2"]) .cap {
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
        }

        :global(.midnightAtelierGate[data-visual-tier="1"]) .card {
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          background: rgba(8, 10, 18, 0.96);
        }

        :global(.midnightAtelierGate[data-visual-tier="1"]) .cap {
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          background: rgba(8, 10, 18, 0.92);
        }

        @media (max-width: 960px) {
          .page {
            grid-template-columns: 1fr;
            grid-template-rows: auto auto;
            min-height: auto;
          }

          .left {
            align-items: center;
            padding: 48px 32px 24px;
            padding-left: max(32px, env(safe-area-inset-left, 32px));
            padding-right: max(32px, env(safe-area-inset-right, 32px));
            text-align: center;
          }

          .logo {
            position: static;
            margin-bottom: 32px;
          }

          .heroLabel {
            justify-content: center;
          }

          .heroLabel::before {
            display: none;
          }

          .heroBody {
            margin-left: auto;
            margin-right: auto;
          }

          .capabilities {
            flex-direction: column;
            align-items: center;
          }

          .cap {
            width: 100%;
            max-width: 320px;
          }

          .right {
            padding: 24px 24px 48px;
            padding-bottom: max(48px, env(safe-area-inset-bottom, 48px));
          }
        }

        @media (max-width: 600px) {
          .left {
            padding: 36px 20px 16px;
            padding-left: max(20px, env(safe-area-inset-left, 20px));
            padding-right: max(20px, env(safe-area-inset-right, 20px));
          }

          .cap {
            max-width: none;
          }

          .right {
            padding: 16px 16px 36px;
            padding-bottom: max(36px, env(safe-area-inset-bottom, 36px));
          }

          .card {
            padding: 32px 24px 24px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          * {
            animation: none !important;
            transition: none !important;
          }
        }
      `}</style>
    </div>
  )
}
