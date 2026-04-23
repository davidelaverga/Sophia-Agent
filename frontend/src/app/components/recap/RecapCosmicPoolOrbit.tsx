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
import { useVisualTier } from '../../hooks/useVisualTier';
import { logger } from '../../lib/error-logger';
import {
  getRecapCategoryPresentation,
  type MemoryCandidateV1,
  type MemoryDecision,
} from '../../lib/recap-types';
import { cn } from '../../lib/utils';
import {
  getRecapOrbitProfile,
  shouldSkipTierFrame,
} from '../../lib/visual-tier-profiles';

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
  color: [number, number, number];
}

interface ActiveDrop {
  id: string;
  startX: number;
  startY: number;
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
  category?: string;
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
  pendingEditText?: string;
}

const KEEP_ANIMATION_MS = 700;
const DISCARD_ANIMATION_MS = 600;
const DROP_DURATION_MS = 420;
const IS_TEST_ENV = process.env.NODE_ENV === 'test';

function isDocumentHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function bindVisibilityAwareAnimation(params: {
  start: () => void;
  stop: () => void;
}) {
  const { start, stop } = params;

  if (typeof document === 'undefined') {
    start();
    return () => stop();
  }

  const handleVisibilityChange = () => {
    if (isDocumentHidden()) {
      stop();
      return;
    }

    start();
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  handleVisibilityChange();

  return () => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

const VERT = `attribute vec2 pos;void main(){gl_Position=vec4(pos,0,1);}`;

const BG_FRAG = `
precision highp float;
uniform float u_time;
uniform vec2  u_res;
uniform vec2  u_mouse;
uniform vec4  u_comet[3];

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

  float starY=smoothstep(0.05,0.30,uv.y);
  vec3 starCol=vec3(0.0);
  vec2 suv=uv*vec2(asp,1.0);
  for(int layer=0;layer<4;layer++){
    float fl=float(layer);
    float scale=fl<0.5?400.0:fl<1.5?200.0:fl<2.5?90.0:45.0;
    float thresh=fl<0.5?0.985:fl<1.5?0.988:fl<2.5?0.992:0.996;
    float bright=fl<0.5?0.08:fl<1.5?0.15:fl<2.5?0.3:0.55;
    float sharpness=fl<0.5?800.0:fl<1.5?400.0:fl<2.5?180.0:90.0;
    vec2 cell=floor(suv*scale);
    float rnd=hash(cell+fl*73.13);
    if(rnd>thresh){
      vec2 starPos=(cell+0.3+0.4*vec2(hash(cell+fl*11.0),hash(cell+fl*37.0)))/scale;
      float d=length(suv-starPos)*scale;
      float core=exp(-d*d*sharpness);
      float halo=fl>2.5?exp(-d*d*18.0)*0.06:0.0;
      float twinkle=0.7+0.3*sin(t*(0.3+fl*0.15)+rnd*80.0);
      float temp=hash(cell+fl*200.0);
      vec3 sc=temp<0.3?vec3(0.7,0.78,1.0):temp<0.6?vec3(1.0,0.93,0.82):vec3(0.88,0.85,1.0);
      starCol+=sc*(core+halo)*bright*twinkle;
    }
  }
  col+=starCol*starY;

  for(int i=0;i<3;i++){
    vec2 cp=u_comet[i].xy;
    float cb=u_comet[i].z;
    float cAng=u_comet[i].w;
    if(cb<0.005) continue;
    vec2 cDir=vec2(cos(cAng),sin(cAng));
    vec2 cPerp=vec2(-cDir.y,cDir.x);
    vec2 toP=uv-cp;
    float along=dot(toP,cDir);
    float perp=dot(toP,cPerp);
    float headD=length(toP);
    float headPinpoint=exp(-headD*headD*12000.0)*cb*3.5;
    float headCore=exp(-headD*headD*3000.0)*cb*2.0;
    float headGlow=exp(-headD*headD*500.0)*cb*0.7;
    float headHalo=exp(-headD*headD*60.0)*cb*0.15;
    float trailMask=smoothstep(0.0,0.5,-along);
    float trailHot=exp(-perp*perp*18000.0)*1.0;
    float trailCore=exp(-perp*perp*6000.0)*0.7;
    float trailMid=exp(-perp*perp*1500.0)*0.35;
    float trailWide=exp(-perp*perp*200.0)*0.06;
    float trailFade=exp(along*6.0)*trailMask;
    float trail=(trailHot+trailCore+trailMid+trailWide)*trailFade*cb;
    float scatter=0.0;
    for(int j=0;j<6;j++){
      float fj=float(j);
      float sOff=-0.015-fj*0.03;
      vec2 sp=cp+cDir*sOff;
      float sd=length(uv-sp+cPerp*(hash(sp+fj)*0.008-0.004));
      scatter+=exp(-sd*sd*6000.0)*cb*0.12*(1.0-fj*0.14);
    }
    vec3 headCol=vec3(1.0,0.98,1.0)*headPinpoint+vec3(0.95,0.93,1.0)*headCore+vec3(0.75,0.70,0.95)*headGlow+vec3(0.50,0.45,0.70)*headHalo;
    vec3 trailCol=mix(vec3(0.70,0.60,0.95),vec3(0.55,0.40,0.30),trailMask*0.7)*(trail+scatter);
    col+=(headCol+trailCol)*starY;
  }

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
uniform vec3  u_gcolor0,u_gcolor1,u_gcolor2,u_gcolor3;
uniform float u_gc;
uniform vec4  u_comet[3];

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

vec3 glowCol(vec2 uv,vec2 gp,float idx,vec3 mc){
  float d=length(uv-gp);
  float g=exp(-d*d*55.0);
  float pulse=sin(u_time*0.4+idx*1.5)*0.12+0.88;
  float core=exp(-d*d*180.0)*0.08;
  float surface=(g*0.14+core)*pulse;
  float rings=0.0;
  for(int i=0;i<3;i++){
    float fi=float(i);
    float phase=u_time*(0.12+fi*0.04)+idx*2.1+fi*1.4;
    float r=sin(d*(22.0+fi*7.0)-phase)*0.5+0.5;
    r*=exp(-d*d*(25.0+fi*8.0));
    rings+=r*(0.055-fi*0.012);
  }
  float caust=fbm(uv*7.0+vec2(u_time*0.05,-u_time*0.035));
  caust*=exp(-d*d*18.0)*0.05;
  float pool=exp(-d*d*10.0)*0.07*pulse;
  return mc*(surface+rings+caust+pool);
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

  vec3 tg=vec3(0.0);
  if(u_gc>0.5)tg+=glowCol(uv,u_g0,0.0,u_gcolor0);
  if(u_gc>1.5)tg+=glowCol(uv,u_g1,1.0,u_gcolor1);
  if(u_gc>2.5)tg+=glowCol(uv,u_g2,2.0,u_gcolor2);
  if(u_gc>3.5)tg+=glowCol(uv,u_g3,3.0,u_gcolor3);
  col+=tg;

  for(int i=0;i<3;i++){
    vec2 cp=u_comet[i].xy;
    float cb=u_comet[i].z;
    float cAng=u_comet[i].w;
    if(cb<0.005) continue;
    vec2 cDir=vec2(cos(cAng),-sin(cAng));
    vec2 cPerp=vec2(-cDir.y,cDir.x);
    vec2 rcp=vec2(cp.x,1.0-cp.y)+distort*0.5;
    vec2 toP=refUV-rcp;
    float along=dot(toP,cDir);
    float perp=dot(toP,cPerp);
    float headD=length(toP);
    float headBright=exp(-headD*headD*200.0)*cb*1.8;
    float headSoft=exp(-headD*headD*30.0)*cb*0.5;
    float headPool=exp(-headD*headD*8.0)*cb*0.15;
    float trailMask=smoothstep(0.0,0.4,-along);
    float trailW=exp(-perp*perp*600.0);
    float trailSoft=exp(-perp*perp*80.0)*0.25;
    float trailFade=exp(along*4.0)*trailMask;
    float trail=(trailW+trailSoft)*trailFade*cb*0.5;
    float horizFade=smoothstep(0.0,0.35,uv.y)*smoothstep(1.0,0.45,uv.y);
    float rBright=(headBright+headSoft+headPool+trail)*horizFade*1.0;
    vec3 rCol=mix(vec3(0.70,0.65,0.95),vec3(0.50,0.40,0.30),trailMask*0.5);
    col+=rCol*rBright*depth;
  }

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

/* ── Glass-sphere shader: Fresnel rim, internal caustics, specular highlights ── */
const ORB_FRAG = `
precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_active;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm4(vec2 p){
  float v=0.0,a=0.5;
  for(int i=0;i<4;i++){v+=a*noise(p);p*=2.1;p+=100.0;a*=0.5;}
  return v;
}

void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  vec2 p=(uv-0.5)*2.0;
  float t=u_time;
  float d=length(p);

  if(d>1.0){gl_FragColor=vec4(0.0);return;}

  float z=sqrt(1.0-d*d);
  vec3 N=normalize(vec3(p,z));
  vec3 V=vec3(0.0,0.0,1.0);
  float fresnel=pow(1.0-dot(N,V),3.0);

  vec3 cp=vec3(0.72,0.64,0.91);
  vec3 ct=vec3(0.35,0.75,0.68);
  vec3 cg=vec3(0.83,0.77,1.0);
  vec3 ca=vec3(0.95,0.70,0.42);

  vec3 col=vec3(0.012,0.012,0.025);

  vec2 sUV=N.xy*0.5+0.5;
  float c1=fbm4(sUV*3.0+t*0.06);
  float c2=fbm4(sUV*4.2-t*0.05+vec2(5.0,3.0));
  float c3=fbm4((sUV+vec2(sin(t*0.03),cos(t*0.04)))*2.5);
  float energy=pow(c1*c2,1.5)*2.5;

  float df=z*z;
  float act=mix(0.25,1.0,u_active);

  col+=cp*energy*0.22*df*act;
  col+=ct*c3*0.10*df*act;
  col+=ca*pow(c2,3.0)*0.06*df*act;

  float ang=atan(p.y,p.x)+t*0.05;
  float neb=fbm4(vec2(ang*0.8,d*3.0)+t*0.03);
  col+=mix(cp,ct,neb)*neb*0.045*df*act;

  float core=exp(-d*d*4.0);
  float pulse=sin(t*0.35)*0.15+0.85;
  col+=cg*core*0.04*pulse*act;

  float rAng=atan(p.y,p.x);
  vec3 rimC=mix(cp,ct,sin(rAng*2.0+t*0.25)*0.5+0.5);
  col+=rimC*fresnel*0.55*act;

  col.r+=fresnel*fresnel*0.06*sin(t*0.18+0.5);
  col.b+=fresnel*fresnel*0.05*sin(t*0.22+2.0);

  vec3 L1=normalize(vec3(-0.35,0.55,0.85));
  float sp1=pow(max(dot(reflect(-L1,N),V),0.0),38.0);
  col+=vec3(1.0,0.98,0.95)*sp1*0.38*act;

  vec3 L2=normalize(vec3(0.4,-0.3,0.7));
  float sp2=pow(max(dot(reflect(-L2,N),V),0.0),18.0);
  col+=ct*sp2*0.10*act;

  vec3 L3=normalize(vec3(0.0,0.6,0.5));
  float sp3=pow(max(dot(reflect(-L3,N),V),0.0),60.0);
  col+=cg*sp3*0.15*act;

  float edge=smoothstep(1.0,0.95,d);
  col=col/(col+0.50);
  col=pow(col,vec3(0.90));

  float alpha=mix(0.25,0.75,fresnel)*edge;
  alpha=mix(alpha*0.35,alpha,u_active);

  gl_FragColor=vec4(col,alpha);
}
`;

const FOG_COLORS: [number, number, number][] = [
  [184, 164, 232],
  [89, 190, 173],
  [212, 196, 255],
  [160, 148, 205],
];

function getCandidateText(candidate: MemoryCandidateV1) {
  return (candidate.text ?? candidate.memory ?? '').trim();
}

/* ── Category → glow color map (bridges Recap pool ↔ Journal pool palette) ── */
const CATEGORY_GLOW_COLORS: Record<string, [number, number, number]> = {
  identity_profile:       [0.35, 0.75, 0.82],
  relationship_context:   [0.83, 0.56, 0.69],
  goals_projects:         [0.83, 0.69, 0.53],
  emotional_patterns:     [0.72, 0.56, 0.79],
  regulation_tools:       [0.35, 0.75, 0.68],
  preferences_boundaries: [0.69, 0.63, 0.78],
  wins_pride:             [0.95, 0.73, 0.45],
  temporary_context:      [0.53, 0.67, 0.82],
  decision:     [0.35, 0.75, 0.68],
  pattern:      [0.55, 0.49, 0.78],
  lesson:       [0.83, 0.69, 0.53],
  feeling:      [0.83, 0.56, 0.69],
  relationship: [0.53, 0.67, 0.82],
  commitment:   [0.53, 0.82, 0.69],
  preference:   [0.69, 0.63, 0.78],
  fact:         [0.63, 0.71, 0.78],
  ritual_context: [0.69, 0.61, 0.75],
};
const DEFAULT_GLOW_COLOR: [number, number, number] = [0.72, 0.64, 0.91];

function getCategoryGlowColor(category?: string): [number, number, number] {
  if (!category) return DEFAULT_GLOW_COLOR;
  return CATEGORY_GLOW_COLORS[category] ?? DEFAULT_GLOW_COLOR;
}

function getSettledGlowSlot(index: number, color: [number, number, number] = DEFAULT_GLOW_COLOR): SettledGlow {
  const offsets = [-0.22, -0.08, 0.08, 0.22];
  const lanes = [0.64, 0.72, 0.68, 0.76];
  return {
    x: 0.5 + offsets[index % offsets.length] + Math.floor(index / offsets.length) * 0.02,
    y: lanes[index % lanes.length],
    color,
  };
}

function createFogWisps(w: number, h: number, count = 40): FogWisp[] {
  return Array.from({ length: count }, () => {
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

const MAX_COMETS = 3;
type CometState = { x: number; y: number; dx: number; dy: number; angle: number; life: number; maxLife: number; peak: number };

const sharedCometData = { comets: [] as CometState[], uniform: new Float32Array(MAX_COMETS * 4) };
const EMPTY_COMET_UNIFORM = new Float32Array(MAX_COMETS * 4);

function clearComets() {
  sharedCometData.comets.length = 0;
  sharedCometData.uniform.fill(0);
}

function spawnComet() {
  const side = Math.random();
  let x: number, y: number, angle: number;
  if (side < 0.5) {
    x = -0.08;
    y = 0.6 + Math.random() * 0.32;
    angle = -0.15 + Math.random() * 0.3;
  } else {
    x = 1.08;
    y = 0.6 + Math.random() * 0.32;
    angle = Math.PI - 0.15 + Math.random() * 0.3;
  }
  const speed = 0.08 + Math.random() * 0.12;
  sharedCometData.comets.push({
    x, y, dx: Math.cos(angle) * speed, dy: Math.sin(angle) * speed,
    angle, life: 0, maxLife: 3.0 + Math.random() * 3.0, peak: 0.6 + Math.random() * 0.4,
  });
  while (sharedCometData.comets.length > MAX_COMETS) sharedCometData.comets.shift();
}

function updateComets(dt: number) {
  const { comets, uniform } = sharedCometData;
  for (let i = comets.length - 1; i >= 0; i--) {
    const c = comets[i];
    c.life += dt;
    c.x += c.dx * dt;
    c.y += c.dy * dt;
    if (c.life > c.maxLife) comets.splice(i, 1);
  }
  uniform.fill(0);
  for (let i = 0; i < Math.min(comets.length, MAX_COMETS); i++) {
    const c = comets[i];
    const phase = c.life / c.maxLife;
    const envelope = phase < 0.08 ? phase / 0.08 : Math.pow(1 - phase, 2.2);
    uniform[i * 4] = c.x;
    uniform[i * 4 + 1] = c.y;
    uniform[i * 4 + 2] = envelope * c.peak;
    uniform[i * 4 + 3] = c.angle;
  }
}

function AuroraBackground() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    gl: WebGLRenderingContext;
    uniforms: Record<string, WebGLUniformLocation | null>;
  } | null>(null);
  const mouseRef = useRef({ x: 0.5, y: 0.5 });
  const rafRef = useRef(0);
  const t0 = useRef(performance.now());
  const lastFrameRef = useRef(0);
  const nextCometRef = useRef(8 + Math.random() * 10);
  const { tier, dprCap, reducedMotion } = useVisualTier();
  const renderProfile = useMemo(() => getRecapOrbitProfile(tier), [tier]);

  useEffect(() => {
    if (IS_TEST_ENV) {
      return;
    }

    const glCanvas = glRef.current;
    if (!glCanvas) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio ?? 1, dprCap);
    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      glCanvas.width = Math.round(w * dpr);
      glCanvas.height = Math.round(h * dpr);
      glCanvas.style.width = `${w}px`;
      glCanvas.style.height = `${h}px`;
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
        comet: gl.getUniformLocation(program, 'u_comet[0]'),
      },
    };

    const onMove = (event: MouseEvent) => {
      mouseRef.current.x = event.clientX / window.innerWidth;
      mouseRef.current.y = event.clientY / window.innerHeight;
    };
    window.addEventListener('mousemove', onMove);
    lastFrameRef.current = 0;
    let lastRenderTime = 0;

    const stopLoop = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      lastRenderTime = 0;
      lastFrameRef.current = 0;
    };

    const draw = (now: number) => {
      if (!reducedMotion && shouldSkipTierFrame(now, lastRenderTime, renderProfile.auroraFrameIntervalMs)) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      lastRenderTime = now;
      const t = (now - t0.current) / 1000;
      const dt = Math.min(0.05, lastFrameRef.current > 0 ? (now - lastFrameRef.current) * 0.001 : 0.016);
      lastFrameRef.current = now;
      const { x, y } = mouseRef.current;

      if (renderProfile.allowComets && !reducedMotion) {
        nextCometRef.current -= dt;
        if (nextCometRef.current <= 0) {
          spawnComet();
          nextCometRef.current = 12 + Math.random() * 18;
        }
        updateComets(dt);
      } else {
        clearComets();
      }

      if (stateRef.current) {
        const { gl: g, uniforms } = stateRef.current;
        g.viewport(0, 0, g.canvas.width, g.canvas.height);
        g.uniform1f(uniforms.t, t);
        g.uniform2f(uniforms.r, g.canvas.width, g.canvas.height);
        g.uniform2f(uniforms.m, x, 1 - y);
        if (uniforms.comet) g.uniform4fv(uniforms.comet, sharedCometData.uniform);
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      }

      if (!reducedMotion) {
        rafRef.current = requestAnimationFrame(draw);
      }
    };

    const startLoop = () => {
      if (reducedMotion || rafRef.current || isDocumentHidden()) {
        return;
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    let cleanupVisibility = () => {};

    if (reducedMotion) {
      draw(performance.now());
    } else {
      cleanupVisibility = bindVisibilityAwareAnimation({
        start: startLoop,
        stop: stopLoop,
      });
    }

    return () => {
      cleanupVisibility();
      stopLoop();
      clearComets();
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
    };
  }, [dprCap, reducedMotion, renderProfile]);

  return (
    <div className="fixed inset-0 z-0" aria-hidden="true">
      <canvas ref={glRef} className="absolute inset-0 h-full w-full" />
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
  const { tier, dprCap, reducedMotion } = useVisualTier();
  const renderProfile = useMemo(() => getRecapOrbitProfile(tier), [tier]);

  useEffect(() => {
    if (IS_TEST_ENV) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio ?? 1, dprCap);
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
    for (let index = 0; index < 4; index += 1) {
      uniforms[`gc${index}`] = gl.getUniformLocation(program, `u_gcolor${index}`);
    }
    uniforms.comet = gl.getUniformLocation(program, 'u_comet[0]');
    glState.current = { gl, uniforms };
    let lastFrameTime = 0;

    const stopLoop = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      lastFrameTime = 0;
    };

    const draw = (now: number) => {
      if (!reducedMotion && shouldSkipTierFrame(now, lastFrameTime, renderProfile.poolFrameIntervalMs)) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      lastFrameTime = now;
      const t = (now - timeOrigin) / 1000;
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
        const sc = settled[index]?.color ?? [0.72, 0.64, 0.91];
        g.uniform3f(loc[`gc${index}`], sc[0], sc[1], sc[2]);
      }
      g.uniform1f(loc.gc, Math.min(settled.length, 4));
      if (loc.comet) {
        g.uniform4fv(loc.comet, renderProfile.allowComets ? sharedCometData.uniform : EMPTY_COMET_UNIFORM);
      }
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);

      if (!reducedMotion) {
        rafRef.current = requestAnimationFrame(draw);
      }
    };

    const startLoop = () => {
      if (reducedMotion || rafRef.current || isDocumentHidden()) {
        return;
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    let cleanupVisibility = () => {};

    if (reducedMotion) {
      draw(performance.now());
    } else {
      cleanupVisibility = bindVisibilityAwareAnimation({
        start: startLoop,
        stop: stopLoop,
      });
    }
    return () => {
      cleanupVisibility();
      stopLoop();
      window.removeEventListener('resize', resize);
    };
  }, [timeOrigin, dprCap, reducedMotion, renderProfile]);

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
  const { tier, reducedMotion } = useVisualTier();
  const renderProfile = useMemo(() => getRecapOrbitProfile(tier), [tier]);

  useEffect(() => {
    if (IS_TEST_ENV || reducedMotion || !renderProfile.allowFog) {
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
        wispsRef.current = createFogWisps(rect.width, rect.height, renderProfile.fogWispCount);
      }
    };
    resize();
    window.addEventListener('resize', resize);
    let lastFrameTime = 0;

    const stopLoop = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      lastFrameTime = 0;
    };

    const loop = (now: number) => {
      if (shouldSkipTierFrame(now, lastFrameTime, renderProfile.fogFrameIntervalMs)) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      lastFrameTime = now;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }

      const w = canvas.width;
      const h = canvas.height;
      const t = (now - t0.current) / 1000;
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

      rafRef.current = requestAnimationFrame(loop);
    };

    const startLoop = () => {
      if (rafRef.current || isDocumentHidden()) {
        return;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    const cleanupVisibility = bindVisibilityAwareAnimation({
      start: startLoop,
      stop: stopLoop,
    });

    return () => {
      cleanupVisibility();
      stopLoop();
      window.removeEventListener('resize', resize);
    };
  }, [reducedMotion, renderProfile]);

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
  const { tier } = useVisualTier();
  const renderProfile = useMemo(() => getRecapOrbitProfile(tier), [tier]);

  useEffect(() => {
    if (IS_TEST_ENV || tier === 1) {
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

    const baseCount = active ? 24 : 6;
    const count = tier === 2 ? Math.ceil(baseCount / 2) : baseCount;
    if (!particles.current.length) {
      particles.current = Array.from({ length: count }, () => {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * radius * 0.7;
        return {
          x: cx + Math.cos(angle) * distance,
          y: cy + Math.sin(angle) * distance,
          vx: (Math.random() - 0.5) * 0.14,
          vy: (Math.random() - 0.5) * 0.12,
          r: 6 + Math.random() * 25,
          a: 0.025 + Math.random() * 0.04,
          phase: Math.random() * Math.PI * 2,
        };
      });
    }
    let lastFrameTime = 0;

    const stopLoop = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      lastFrameTime = 0;
    };

    const loop = (now: number) => {
      if (shouldSkipTierFrame(now, lastFrameTime, renderProfile.poolFrameIntervalMs)) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      lastFrameTime = now;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }

      const t = (now - t0.current) / 1000;
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalCompositeOperation = 'screen';

      const pts = particles.current;

      // Draw particles
      for (const particle of pts) {
        particle.x += particle.vx + Math.sin(t * 0.3 + particle.phase) * 0.07;
        particle.y += particle.vy + Math.cos(t * 0.25 + particle.phase) * 0.06;
        const dx = particle.x - cx;
        const dy = particle.y - cy;
        if (Math.sqrt(dx * dx + dy * dy) > radius * 0.72) {
          particle.vx -= dx * 0.001;
          particle.vy -= dy * 0.001;
        }
        const pulse = (Math.sin(t * 0.5 + particle.phase) * 0.5 + 0.5) * 0.5 + 0.5;
        const alpha = particle.a * pulse;
        const gradient = ctx.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, particle.r);
        gradient.addColorStop(0, `rgba(200,180,240,${alpha})`);
        gradient.addColorStop(0.4, `rgba(230,170,195,${alpha * 0.45})`);
        gradient.addColorStop(1, 'rgba(89,190,173,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(particle.x - particle.r, particle.y - particle.r, particle.r * 2, particle.r * 2);
      }

      // Energy tendrils between nearby particles
      if (active) {
        ctx.lineWidth = 0.6;
        for (let i = 0; i < pts.length; i += 1) {
          for (let j = i + 1; j < pts.length; j += 1) {
            const dx = pts[i].x - pts[j].x;
            const dy = pts[i].y - pts[j].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 90) {
              const strength = (1 - dist / 90) * 0.08;
              const midX = (pts[i].x + pts[j].x) / 2 + Math.sin(t * 0.4 + i) * 8;
              const midY = (pts[i].y + pts[j].y) / 2 + Math.cos(t * 0.35 + j) * 8;
              ctx.beginPath();
              ctx.moveTo(pts[i].x, pts[i].y);
              ctx.quadraticCurveTo(midX, midY, pts[j].x, pts[j].y);
              ctx.strokeStyle = `rgba(184,164,232,${strength})`;
              ctx.stroke();
            }
          }
        }
      }

      // Orbiting sparks with trails
      if (active) {
        const sparkCount = tier === 2 ? 4 : 8;
        for (let index = 0; index < sparkCount; index += 1) {
          const dir = index % 2 === 0 ? 1 : -1;
          const speed = 0.15 + (index % 3) * 0.04;
          const angle = t * speed * dir + (index / 8) * Math.PI * 2;
          const orbitR = 30 + index * 16 + Math.sin(t * 0.35 + index) * 14;
          const sx = cx + Math.cos(angle) * orbitR;
          const sy = cy + Math.sin(angle) * orbitR;
          const spark = (Math.sin(t * 0.7 + index * 1.7) * 0.5 + 0.5) ** 2;
          if (spark < 0.06) {
            continue;
          }

          // Spark trail (3 fading positions)
          for (let trail = 0; trail < 3; trail += 1) {
            const ta = angle - dir * trail * 0.12;
            const tx = cx + Math.cos(ta) * orbitR;
            const ty = cy + Math.sin(ta) * orbitR;
            const trailAlpha = spark * 0.06 * (1 - trail * 0.35);
            const tg = ctx.createRadialGradient(tx, ty, 0, tx, ty, 2.5);
            tg.addColorStop(0, `rgba(200,180,240,${trailAlpha})`);
            tg.addColorStop(1, 'rgba(200,180,240,0)');
            ctx.fillStyle = tg;
            ctx.fillRect(tx - 2.5, ty - 2.5, 5, 5);
          }

          // Bright spark core
          ctx.beginPath();
          ctx.arc(sx, sy, 1.2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,248,240,${spark * 0.28})`;
          ctx.fill();
          const sparkGradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, 4);
          sparkGradient.addColorStop(0, `rgba(200,180,240,${spark * 0.15})`);
          sparkGradient.addColorStop(1, 'rgba(200,180,240,0)');
          ctx.fillStyle = sparkGradient;
          ctx.fillRect(sx - 4, sy - 4, 8, 8);
        }

        // Rotating energy ring at 65% radius
        const ringR = radius * 0.65;
        const ringPulse = Math.sin(t * 0.25) * 0.3 + 0.7;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(184,164,232,${0.025 * ringPulse})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Second ring, counter-phase
        const ringR2 = radius * 0.45;
        const ringPulse2 = Math.sin(t * 0.3 + 1.5) * 0.3 + 0.7;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(89,190,173,${0.02 * ringPulse2})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.restore();

      rafRef.current = requestAnimationFrame(loop);
    };

    const startLoop = () => {
      if (rafRef.current || isDocumentHidden()) {
        return;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    const cleanupVisibility = bindVisibilityAwareAnimation({
      start: startLoop,
      stop: stopLoop,
    });

    return () => {
      cleanupVisibility();
      stopLoop();
    };
  }, [active, renderProfile, tier]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full rounded-full" style={{ opacity: active ? 0.75 : 0.25 }} />;
}

/* ── WebGL glass-sphere renderer: Fresnel rim, caustics, specular highlights ── */
function OrbGlassCanvas({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    gl: WebGLRenderingContext;
    uniforms: Record<string, WebGLUniformLocation | null>;
  } | null>(null);
  const rafRef = useRef(0);
  const t0 = useRef(performance.now());
  const activeRef = useRef(active);
  activeRef.current = active;
  const { tier, reducedMotion } = useVisualTier();
  const renderProfile = useMemo(() => getRecapOrbitProfile(tier), [tier]);

  useEffect(() => {
    if (IS_TEST_ENV || tier === 1) return;
    const canvas = ref.current;
    if (!canvas) return;

    const size = tier === 2 ? 256 : 512;
    canvas.width = size;
    canvas.height = size;

    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const program = buildProgram(gl, VERT, ORB_FRAG);
    if (!program) return;

    gl.useProgram(program);
    setupQuad(gl, program);
    stateRef.current = {
      gl,
      uniforms: {
        t: gl.getUniformLocation(program, 'u_time'),
        r: gl.getUniformLocation(program, 'u_res'),
        a: gl.getUniformLocation(program, 'u_active'),
      },
    };
    let lastFrameTime = 0;

    const stopLoop = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      lastFrameTime = 0;
    };

    const draw = (now: number) => {
      if (!reducedMotion && shouldSkipTierFrame(now, lastFrameTime, renderProfile.poolFrameIntervalMs)) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      lastFrameTime = now;
      const t = (now - t0.current) / 1000;
      const s = stateRef.current;
      if (!s) return;
      const { gl: g, uniforms } = s;
      g.viewport(0, 0, g.canvas.width, g.canvas.height);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.uniform1f(uniforms.t, t);
      g.uniform2f(uniforms.r, g.canvas.width, g.canvas.height);
      g.uniform1f(uniforms.a, activeRef.current ? 1.0 : 0.0);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);

      if (!reducedMotion) {
        rafRef.current = requestAnimationFrame(draw);
      }
    };

    const startLoop = () => {
      if (reducedMotion || rafRef.current || isDocumentHidden()) {
        return;
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    let cleanupVisibility = () => {};

    if (reducedMotion) {
      draw(performance.now());
    } else {
      cleanupVisibility = bindVisibilityAwareAnimation({
        start: startLoop,
        stop: stopLoop,
      });
    }
    return () => {
      cleanupVisibility();
      stopLoop();
    };
  }, [reducedMotion, renderProfile, tier]);

  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute inset-0 h-full w-full rounded-full"
    />
  );
}

/* ── Canvas particle burst for keep / discard exit FX ── */
function OrbExitFXCanvas({ type, active }: { type: 'keep' | 'discard'; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const particlesRef = useRef<Array<{
    x: number; y: number; vx: number; vy: number;
    r: number; a: number; life: number; maxLife: number;
    color: number;
  }>>([]);
  const startedRef = useRef(false);
  const { tier } = useVisualTier();

  useEffect(() => {
    if (!active || IS_TEST_ENV || tier === 1) return;
    const canvas = ref.current;
    if (!canvas) return;

    const size = tier === 2 ? 256 : 512;
    canvas.width = size;
    canvas.height = size;
    const cx = size / 2;
    const cy = size / 2;

    if (!startedRef.current) {
      startedRef.current = true;
      const baseCount = type === 'keep' ? 35 : 45;
      const count = tier === 2 ? Math.ceil(baseCount / 2) : baseCount;
      particlesRef.current = Array.from({ length: count }, () => {
        const angle = Math.random() * Math.PI * 2;
        const speed = type === 'keep'
          ? 0.3 + Math.random() * 0.6  // Keep: gentle inward then up
          : 1.8 + Math.random() * 3.5; // Discard: explosive outward
        const startDist = type === 'keep' ? 60 + Math.random() * 80 : Math.random() * 20;
        return {
          x: cx + Math.cos(angle) * startDist,
          y: cy + Math.sin(angle) * startDist,
          vx: type === 'keep'
            ? -Math.cos(angle) * speed
            : Math.cos(angle) * speed,
          vy: type === 'keep'
            ? -Math.sin(angle) * speed - 1.5
            : Math.sin(angle) * speed,
          r: 1.5 + Math.random() * 3,
          a: 0.4 + Math.random() * 0.5,
          life: 0,
          maxLife: type === 'keep' ? 40 + Math.random() * 25 : 25 + Math.random() * 20,
          color: Math.floor(Math.random() * 3),
        };
      });
    }

    const colors: [number, number, number][] = [
      [184, 164, 232], // purple
      [89, 190, 173],  // teal
      [212, 196, 255], // light purple
    ];

    const loop = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'screen';

      let alive = 0;
      for (const p of particlesRef.current) {
        p.life += 1;
        if (p.life > p.maxLife) continue;
        alive += 1;

        p.x += p.vx;
        p.y += p.vy;

        if (type === 'keep') {
          // Spiral inward then upward
          const dx = cx - p.x;
          const dy = cy - p.y;
          p.vx += dx * 0.002;
          p.vy += dy * 0.002 - 0.08;
        } else {
          // Decelerate and fade
          p.vx *= 0.96;
          p.vy *= 0.96;
        }

        const progress = p.life / p.maxLife;
        const alpha = p.a * (1 - progress * progress);
        const c = colors[p.color];
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3);
        gradient.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${alpha})`);
        gradient.addColorStop(0.4, `rgba(${c[0]},${c[1]},${c[2]},${alpha * 0.4})`);
        gradient.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(p.x - p.r * 3, p.y - p.r * 3, p.r * 6, p.r * 6);

        // Bright core
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,250,245,${alpha * 0.6})`;
        ctx.fill();
      }

      if (alive > 0) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      startedRef.current = false;
      particlesRef.current = [];
    };
  }, [active, type, tier]);

  if (!active) return null;

  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute inset-[-20%] z-[25] h-[140%] w-[140%] rounded-full"
    />
  );
}

function ProgressIndicator({ total, reviewed }: { total: number; reviewed: number }) {
  return (
    <div className="mb-2 mt-5 flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: total }, (_, index) => (
          <div
            key={index}
            className="transition-all duration-700 ease-out"
            style={{
              width: index < reviewed ? 22 : 6,
              height: 3,
              borderRadius: 2,
              background: index < reviewed
                ? 'linear-gradient(to right, color-mix(in srgb, var(--sophia-purple) 55%, transparent), color-mix(in srgb, var(--sophia-glow) 45%, transparent))'
                : 'color-mix(in srgb, var(--cosmic-text-faint) 60%, transparent)',
              boxShadow: index < reviewed ? '0 0 10px color-mix(in srgb, var(--sophia-purple) 18%, transparent)' : 'none',
            }}
          />
        ))}
      </div>
      <span className="text-[9px] tabular-nums tracking-[0.1em]" style={{ color: 'var(--cosmic-text-muted)' }}>{reviewed}/{total}</span>
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
  pendingEditText,
}: MemoryOrbProps) {
  const isCenter = position === 'center';
  const [showReason, setShowReason] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(pendingEditText || getCandidateText(candidate));
  const category = getRecapCategoryPresentation(candidate.category);
  const displayText = pendingEditText || getCandidateText(candidate);
  const isLongText = displayText.length > 150;
  const confidence = candidate.confidence;

  useEffect(() => {
    if (!isEditing) {
      setEditValue(pendingEditText || getCandidateText(candidate));
    }
  }, [candidate, isEditing, pendingEditText]);

  const canSaveEdit = editValue.trim().length > 0 && !disabled;

  const positionClasses = useMemo(() => {
    if (isExiting && exitType === 'keep') return 'translate-y-[-80px] scale-75 opacity-0';
    if (isExiting && exitType === 'discard') return 'scale-[0.3] opacity-0 blur-xl rotate-12 -translate-y-6';
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
        !isCenter && 'opacity-[0.18] blur-[4px]',
        !isCenter && !disabled && 'cursor-pointer hover:opacity-[0.30] hover:blur-[2px]'
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

      {isExiting && exitType === 'discard' && (
        <div
          className="absolute inset-0 z-30 rounded-full pointer-events-none animate-[discardFlash_600ms_ease-out_forwards]"
          style={{
            background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 15%, transparent) 0%, color-mix(in srgb, var(--cosmic-teal) 5%, transparent) 40%, transparent 70%)',
            filter: 'blur(20px)',
            transform: 'scale(2)',
          }}
        />
      )}

      {/* Canvas particle burst for keep / discard */}
      {isExiting && exitType && (
        <OrbExitFXCanvas type={exitType} active />
      )}

      {isCenter && !isExiting && confidence != null && (
        <svg
          className="pointer-events-none absolute inset-[-6px] -z-[5] h-[calc(100%+12px)] w-[calc(100%+12px)]"
          viewBox="0 0 100 100"
          style={{ transform: 'rotate(-90deg)' }}
        >
          <circle cx="50" cy="50" r="49" fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="0.8" />
          <circle
            cx="50"
            cy="50"
            r="49"
            fill="none"
            stroke="url(#confGrad)"
            strokeWidth="1.5"
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
            ? 'h-[310px] w-[310px] sm:h-[370px] sm:w-[370px] md:h-[420px] md:w-[420px]'
            : 'h-[260px] w-[260px] sm:h-[310px] sm:w-[310px]'
        )}
        style={{
          background: isCenter
            ? 'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--card-bg) 85%, black 15%), color-mix(in srgb, var(--bg) 90%, black 10%))'
            : 'radial-gradient(circle at 50% 55%, color-mix(in srgb, var(--card-bg) 76%, black 24%), color-mix(in srgb, var(--bg) 85%, black 15%) 85%)',
          boxShadow: isCenter
            ? 'inset 0 0 0 1px var(--cosmic-border-soft), 0 0 55px -15px color-mix(in srgb, var(--sophia-purple) 5%, transparent), 0 14px 45px -25px color-mix(in srgb, var(--bg) 55%, transparent)'
            : 'inset 0 -15px 30px -15px color-mix(in srgb, var(--sophia-purple) 5%, transparent), inset 0 0 0 1px var(--cosmic-border-soft)',
        }}
      >
        {/* WebGL glass sphere with Fresnel rim, caustics, specular */}
        <OrbGlassCanvas active={isCenter} />

        {/* Canvas 2D particle mist + orbiting sparks */}
        <OrbMistCanvas active={isCenter} />

        {/* Inset shadow for depth */}
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
            <span className="mb-2 shrink-0 text-[10px] uppercase tracking-[0.14em]" style={{ color: 'color-mix(in srgb, var(--sophia-purple) 55%, transparent)' }}>
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
            <div
              className={cn(
                'flex-1 min-h-0 flex items-center',
                isCenter && 'max-h-[140px] sm:max-h-[180px] md:max-h-[220px] overflow-y-auto scrollbar-thin'
              )}
              style={isCenter ? {
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
              } : undefined}
            >
              <p
                className={cn(
                  'font-cormorant text-center leading-relaxed w-full',
                  isCenter
                    ? isLongText
                      ? 'text-[14px] sm:text-[16px]'
                      : 'text-[16px] sm:text-[19px]'
                    : 'text-[14px]'
                )}
                style={{ color: isCenter ? 'var(--cosmic-text-strong)' : 'var(--cosmic-text-whisper)' }}
              >
                {displayText}
              </p>
            </div>
          )}

          {isCenter && !isExiting && !isEditing && candidate.reason && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                setShowReason((previous) => !previous);
              }}
              className="mt-3 flex items-center gap-1 text-[9px] uppercase tracking-[0.1em] transition-colors hover:underline"
              style={{ color: showReason ? 'color-mix(in srgb, var(--sophia-purple) 50%, transparent)' : 'var(--cosmic-text-muted)' }}
            >
              <span className="text-[8px]">?</span>
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
                className="cosmic-accent-pill cosmic-focus-ring group relative flex items-center gap-2 rounded-full px-5 py-2 transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {/* Hover glow aura */}
                <span
                  className="pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                  style={{
                    boxShadow: '0 0 18px 4px color-mix(in srgb, var(--sophia-purple) 25%, transparent), 0 0 40px 8px color-mix(in srgb, var(--sophia-glow) 12%, transparent)',
                  }}
                />
                <Check className="h-3.5 w-3.5 transition-transform duration-300 group-hover:scale-125" />
                <span className="text-[10px] uppercase tracking-[0.08em]">{pendingEditText ? 'Keep refined' : 'Keep this'}</span>
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
                className="cosmic-ghost-pill cosmic-focus-ring rounded-full p-2 transition-all duration-300 hover:shadow-[0_0_12px_color-mix(in_srgb,var(--sophia-purple)_20%,transparent)] disabled:opacity-30"
              >
                <Pencil className="h-3.5 w-3.5 transition-transform duration-300 hover:rotate-[-8deg]" />
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscard();
                }}
                disabled={disabled}
                data-onboarding="recap-memory-discard"
                aria-label="Let this memory go"
                className="cosmic-focus-ring group relative flex items-center gap-2 rounded-full border px-5 py-2 text-[var(--cosmic-text-whisper)] transition-all duration-300 hover:border-[color-mix(in_srgb,var(--sophia-error)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--sophia-error)_8%,transparent)] hover:text-[color-mix(in_srgb,var(--sophia-error)_72%,white_10%)] disabled:cursor-not-allowed disabled:opacity-30"
                style={{ borderColor: 'var(--cosmic-border-soft)', background: 'var(--cosmic-panel-soft)' }}
              >
                {/* Hover void pull */}
                <span
                  className="pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                  style={{
                    background: 'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--sophia-error) 6%, transparent) 0%, transparent 70%)',
                    boxShadow: 'inset 0 0 18px color-mix(in srgb, var(--sophia-error) 8%, transparent)',
                  }}
                />
                <X className="h-3.5 w-3.5 transition-transform duration-300 group-hover:scale-125 group-hover:rotate-90" />
                <span className="text-[10px] uppercase tracking-[0.08em]">Let it go</span>
              </button>
            </div>
          )}
        </div>
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
          className="relative h-[240px] w-[240px] overflow-hidden rounded-full sm:h-[280px] sm:w-[280px]"
          style={{
            background: 'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--card-bg) 85%, black 15%), color-mix(in srgb, var(--bg) 90%, black 10%))',
            boxShadow: 'inset 0 0 0 1px var(--cosmic-border-soft), 0 0 55px -15px color-mix(in srgb, var(--sophia-purple) 5%, transparent)',
          }}
        >
          <OrbGlassCanvas active={false} />
          <OrbMistCanvas active={false} />
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
  showEntrance,
}: {
  approvedCount: number;
  approvedMemories: ApprovedMemoryRow[];
  showEntrance: boolean;
}) {
  return (
    <>
      <div
        className={cn(
          'mt-10 flex flex-col items-center transition-all duration-[1800ms] ease-out',
          showEntrance ? 'translate-y-0 opacity-100 scale-100' : 'translate-y-8 opacity-0 scale-95'
        )}
        style={{ transitionDelay: '200ms' }}
      >
        {/* Ambient outer glow behind the sphere */}
        <div className="relative">
          <div
            className="pointer-events-none absolute -z-10 rounded-full motion-safe:animate-[breathe_6s_ease-in-out_infinite]"
            style={{
              inset: '-50%',
              background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 8%, transparent) 0%, color-mix(in srgb, var(--cosmic-teal) 3%, transparent) 35%, transparent 60%)',
              filter: 'blur(60px)',
            }}
          />
          <div
            className="relative flex h-[240px] w-[240px] flex-col items-center justify-center overflow-hidden rounded-full sm:h-[280px] sm:w-[280px]"
            style={{
              background: 'radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--card-bg) 80%, black 20%), color-mix(in srgb, var(--bg) 85%, black 15%))',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--sophia-purple) 12%, transparent), 0 0 60px -10px color-mix(in srgb, var(--sophia-purple) 10%, transparent), 0 0 120px -20px color-mix(in srgb, var(--cosmic-teal) 5%, transparent)',
            }}
          >
            <OrbGlassCanvas active />
            <OrbMistCanvas active />
            <div className="relative z-10 flex flex-col items-center">
              <div
                className="mb-3 flex h-14 w-14 items-center justify-center rounded-full animate-breathe-subtle"
                style={{
                  background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-purple) 12%, transparent), color-mix(in srgb, var(--sophia-purple) 4%, transparent))',
                  border: '1px solid color-mix(in srgb, var(--sophia-purple) 18%, transparent)',
                  boxShadow: '0 0 24px color-mix(in srgb, var(--sophia-purple) 10%, transparent), inset 0 0 12px color-mix(in srgb, var(--sophia-glow) 6%, transparent)',
                }}
              >
                <Check className="h-6 w-6" style={{ color: 'color-mix(in srgb, var(--sophia-purple) 60%, white 20%)' }} />
              </div>
              <p className="font-cormorant text-[20px] sm:text-[22px]" style={{ color: 'var(--cosmic-text-strong)' }}>All memories reviewed</p>
              <p className="mt-1.5 text-[11px] tracking-[0.06em]" style={{ color: 'var(--cosmic-text-whisper)' }}>
                {approvedCount === 0
                  ? 'Nothing carried forward this time'
                  : `${approvedCount} ${approvedCount === 1 ? 'memory' : 'memories'} in the pool`}
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function RecapCosmicPoolOrbit({
  takeaway,
  candidates,
  decisions,
  onDecisionChange,
  isLoading,
  disabled,
  className,
}: RecapMemoryOrbitProps) {
  const normalizedCandidates = useMemo(() => normalizeOrbitCandidates(candidates), [candidates]);
  const hasReviewedDecisions = useMemo(
    () => Object.values(decisions).some((record) => record.decision !== 'idle'),
    [decisions],
  );
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
        category: candidate.category,
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
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});

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
        next.push(getSettledGlowSlot(index, getCategoryGlowColor(approvedMemories[index]?.category)));
      }
      return next;
    });
  }, [approvedMemories]);

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
    const pendingText = pendingEdits[candidateId];
    exitTimeoutRef.current = window.setTimeout(() => {
      if (pendingText) {
        onDecisionChange(candidateId, 'edited', pendingText);
        setPendingEdits((prev) => { const next = { ...prev }; delete next[candidateId]; return next; });
      } else {
        onDecisionChange(candidateId, 'approved');
      }
      setExitingId(null);
      setExitType(null);
      exitTimeoutRef.current = null;
    }, KEEP_ANIMATION_MS);
  }, [clearExitTimeout, disabled, exitingId, onDecisionChange, pendingEdits, triggerDropFromOrb]);

  const handleEdit = useCallback((candidateId: string, editedText: string) => {
    if (disabled || exitingId) {
      return;
    }
    haptic('light');
    setPendingEdits((prev) => ({ ...prev, [candidateId]: editedText }));
  }, [disabled, exitingId]);

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
    const droppedCandidate = activeDrop ? normalizedCandidates.find(c => c.id === activeDrop.id) : undefined;
    const dropColor = getCategoryGlowColor(droppedCandidate?.category);
    const now = (performance.now() - mountTime.current) / 1000;
    const poolX = 0.5 + (Math.random() - 0.5) * 0.06;
    const poolY = 0.82 + Math.random() * 0.06;
    setRipples((previous) => [...previous.slice(-6), { x: poolX, y: poolY, time: now, intensity: 1.0 }]);
    setSettledMemories((previous) => [...previous, getSettledGlowSlot(previous.length, dropColor)]);
    setImpactFlash({ x: activeDrop?.startX ?? window.innerWidth / 2, y: window.innerHeight * 0.56 });
    setActiveDrop(null);
  }, [activeDrop, normalizedCandidates]);

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
    if (hasReviewedDecisions) {
      return (
        <div className={cn('relative min-h-screen overflow-hidden bg-[var(--bg)]', className)}>
          <AuroraBackground />
          <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 pb-8 pt-20">
            <CompletedState
              approvedCount={0}
              approvedMemories={[]}
              showEntrance={showEntrance}
            />
          </div>
        </div>
      );
    }

    return <EmptyState />;
  }

  const allDone = activeCandidates.length === 0 && processedCandidates.length > 0;

  return (
    <div className={cn('relative min-h-screen overflow-hidden bg-[var(--bg)]', className)}>
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
          <span className="mb-4 text-[10px] uppercase tracking-[0.14em]" style={{ color: 'color-mix(in srgb, var(--sophia-purple) 50%, transparent)' }}>
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
            style={{ minHeight: 420, transitionDelay: '300ms' }}
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

            <div className="relative flex h-[420px] w-full items-center justify-center sm:h-[480px]">
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
                  pendingEditText={pendingEdits[candidate.id]}
                />
              ))}
            </div>
          </div>
        ) : (
          <CompletedState
            approvedCount={approvedCount}
            approvedMemories={approvedMemories}
            showEntrance={showEntrance}
          />
        )}
      </div>
    </div>
  );
}

export default RecapCosmicPoolOrbit;