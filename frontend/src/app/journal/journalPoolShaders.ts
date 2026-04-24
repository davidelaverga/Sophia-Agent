export type JournalShaderTier = 1 | 2 | 3

export function getJournalShaderMemoryLimit(tier: JournalShaderTier): number {
  if (tier === 1) return 6
  if (tier === 2) return 10
  return 16
}

export function getJournalPoolFragmentShaderSource(tier: JournalShaderTier): string {
  const memoryCount = getJournalShaderMemoryLimit(tier)
  const enableAurora = tier === 3 ? 1 : 0

  return `#define SHADER_MEMORY_COUNT ${memoryCount}\n#define ENABLE_AURORA ${enableAurora}\n${JOURNAL_POOL_FRAGMENT_SHADER}`
}

export const JOURNAL_POOL_VERTEX_SHADER = String.raw`attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}`

export const JOURNAL_POOL_FRAGMENT_SHADER = String.raw`
precision highp float;
#ifndef SHADER_MEMORY_COUNT
#define SHADER_MEMORY_COUNT 16
#endif
#ifndef ENABLE_AURORA
#define ENABLE_AURORA 1
#endif
uniform float uTime;
uniform vec2 uRes;
uniform vec2 uMouse;
uniform vec3 uCam;
uniform vec3 uTgt;
uniform float uFov;
uniform vec4 uMem[SHADER_MEMORY_COUNT];
uniform vec3 uMemCol[SHADER_MEMORY_COUNT];
uniform vec4 uComet[4];

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float hash2(vec2 p){return fract(sin(dot(p,vec2(269.5,183.3)))*43758.5453);}
vec2 hash2v(vec2 p){return vec2(hash(p),hash2(p));}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float noise2(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(hash2(i),hash2(i+vec2(1,0)),f.x),mix(hash2(i+vec2(0,1)),hash2(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*noise(p);p*=2.03;a*=0.47;}return v;}
float fbm_b(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*noise2(p);p*=1.97;a*=0.48;}return v;}
float fbm3(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.1;a*=0.45;}return v;}
float fbm6(vec2 p){float v=0.0,a=0.5;
  p+=vec2(noise2(p*0.8+vec2(3.1,7.4)),noise2(p*0.8+vec2(6.2,1.9)))*0.3;
  for(int i=0;i<7;i++){v+=a*noise(p);p*=2.04;a*=0.46;}return v;
}

float waveH(vec2 p, float t){
  float h=0.0;

  float d=length(p);
  float decay=exp(-d*0.42);
  h+=0.018*sin(d*14.0-t*1.5)*decay;
  h+=0.010*sin(d*24.0-t*2.2+0.5)*decay*0.70;
  h+=0.005*sin(d*40.0-t*2.9+1.1)*decay*0.45;
  h+=0.002*sin(d*58.0-t*3.5+1.8)*decay*0.30;

  d=length(p-vec2(-0.70,-0.30));decay=exp(-d*0.55);
  h+=0.014*sin(d*14.0-t*1.5+1.8)*decay;
  h+=0.007*sin(d*24.0-t*2.2+2.3)*decay*0.70;

  d=length(p-vec2(0.80,-0.15));decay=exp(-d*0.55);
  h+=0.012*sin(d*14.0-t*1.5+3.5)*decay;

  d=length(p-vec2(-0.35,0.62));decay=exp(-d*0.62);
  h+=0.010*sin(d*14.0-t*1.5+0.7)*decay;

  d=length(p-vec2(0.55,0.50));decay=exp(-d*0.62);
  h+=0.009*sin(d*14.0-t*1.5+2.6)*decay;

  d=length(p-vec2(0.14,-0.72));decay=exp(-d*0.72);
  h+=0.008*sin(d*14.0-t*1.5+4.2)*decay;

  d=length(p-vec2(-0.15,1.2));decay=exp(-d*0.80);
  h+=0.006*sin(d*14.0-t*1.5+5.5)*decay;

  for(int i=0;i<SHADER_MEMORY_COUNT;i++){
    vec2 mp=uMem[i].xy;
    float str=uMem[i].z;
    float ph=uMem[i].w;
    float md=length(p-mp);
    float mDecay=exp(-md*3.5)*str;
    h+=0.007*sin(md*20.0-t*2.0+ph)*mDecay;
    h+=0.004*sin(md*34.0-t*2.8+ph+1.2)*mDecay*0.55;
  }

  h+=(fbm(p*12.0+t*0.06)-0.5)*0.0014;
  h+=(fbm3(p*22.0-t*0.03+5.0)-0.5)*0.0005;

  return h;
}

vec3 waveN(vec2 p, float t){
  float e=0.002;
  float c=waveH(p,t);
  float dx=waveH(p+vec2(e,0),t)-c;
  float dz=waveH(p+vec2(0,e),t)-c;
  vec3 N=normalize(vec3(-dx/e, 1.0, -dz/e));

  vec2 mt1=p*45.0+t*vec2(0.12,-0.08);
  float mn1=(noise(mt1)-0.5)*2.0;
  vec2 mt2=p*90.0+t*vec2(-0.06,0.14);
  float mn2=(noise(mt2)-0.5)*2.0;
  vec2 mt3=p*160.0+t*vec2(0.09,0.05);
  float mn3=(noise(mt3)-0.5)*2.0;

  float pD=length(p);
  float microFade=exp(-pD*0.25);
  float microStr=0.065*microFade;
  N.x+=mn1*microStr*0.6+mn2*microStr*0.3+mn3*microStr*0.15;
  N.z+=mn1*microStr*0.5+mn2*microStr*0.35+mn3*microStr*0.12;
  return normalize(N);
}

float caustic(vec2 p, float t){
  float tVar=t+sin(t*0.15)*1.5;
  float c1=pow(abs(sin(p.x*8.0+tVar*0.5)*sin(p.y*8.0+tVar*0.35)+
                    sin((p.x+p.y)*6.0-tVar*0.4)*0.5), 3.0);
  float c2=pow(abs(sin(p.x*14.0-tVar*0.3+2.0)*sin(p.y*12.0+tVar*0.45+1.0)), 4.0)*0.35;
  float c3=pow(abs(sin((p.x-p.y)*10.0+tVar*0.25)*sin(p.y*7.0-tVar*0.32)), 3.0)*0.18;
  float c4=pow(abs(sin(p.x*20.0+tVar*0.6+3.0)*sin(p.y*18.0-tVar*0.42+2.0)), 4.0)*0.22;
  return c1+c2+c3+c4;
}

vec3 volumetricGlow(vec3 ro, vec3 rd, float tMax, float time){
  vec3 acc=vec3(0.0);
  float dt=tMax/12.0;
  float breath=0.65+0.35*sin(time*0.20)+0.18*sin(time*0.13+1.5);
  for(int i=0;i<12;i++){
    float tt=dt*(float(i)+0.5);
    vec3 p=ro+rd*tt;
    float d2=p.x*p.x+p.z*p.z;
    float hDensity=exp(-max(p.y,0.0)*1.2)*0.8+0.2;
    float drift=noise(vec2(p.x*1.5+time*0.03, p.z*1.5-time*0.02))*0.6+0.4;
    float vertGlow=exp(-d2*0.80)*exp(-p.y*p.y*1.5)*0.038*hDensity*drift*breath;
    float w=exp(-d2*0.45);
    float vAng=atan(p.z,p.x);
    float zoneA=sin(vAng*1.0+time*0.04)*0.5+0.5;
    float zoneP=cos(vAng*1.5-time*0.03)*0.5+0.5;
    vec3 gcBlue=vec3(0.06,0.10,0.28);
    vec3 gcPurple=vec3(0.14,0.08,0.24);
    vec3 gcAmber=vec3(0.40,0.26,0.10);
    vec3 gc=mix(mix(gcBlue,gcPurple,zoneP),gcAmber,zoneA*w*w);
    gc+=vec3(0.06,0.03,0.06)*exp(-pow(length(p.xz)-0.8,2.0)*2.0);
    gc.r+=sin(time*0.12+p.x*2.0)*0.02;
    gc.b+=cos(time*0.09+p.z*2.0)*0.02;
    acc+=gc*vertGlow*dt;
  }
  return acc;
}

vec3 skyColor(vec3 dir, vec2 seed){
  float skyAng=atan(dir.z,dir.x);
  float skyZone=sin(skyAng*0.8)*0.5+0.5;
  vec3 c=mix(vec3(0.010,0.008,0.025),vec3(0.006,0.012,0.022),skyZone);
  vec2 skyUV=dir.xz/(abs(dir.y)+0.15)*0.4+0.5+seed;

  vec2 mwD=dir.xz;
  float mwLine=mwD.x*0.52+mwD.y*0.85;
  float mwPerp=mwD.x*0.85-mwD.y*0.52;
  float mwB=exp(-mwPerp*mwPerp*3.0);
  float mwStr=fbm3(vec2(mwLine*3.0+seed.x,mwPerp*6.0+seed.y))*0.5+0.5;
  float mwStr2=fbm(vec2(mwLine*1.5+4.0,mwPerp*2.5+3.0))*0.5+0.5;
  float mwDark=smoothstep(0.42,0.55,fbm3(vec2(mwLine*5.0+2.0,mwPerp*8.0)))*0.5;
  float mwFinal=mwB*(mwStr*0.6+mwStr2*0.4)*(1.0-mwDark);
  c+=vec3(0.12,0.09,0.07)*mwFinal*1.2;
  c+=vec3(0.05,0.03,0.10)*mwB*mwStr2*0.7;
  float mwRose=fbm3(vec2(mwLine*4.0+6.0,mwPerp*5.0+1.0))*0.5+0.5;
  c+=vec3(0.07,0.03,0.06)*mwRose*mwB*0.5;

  c+=vec3(0.60,0.55,0.75)*pow(hash(floor(skyUV*200.0)),16.0)*0.07;
  c+=vec3(0.50,0.42,0.60)*pow(hash(floor(skyUV*120.0+vec2(7.3,2.1))),14.0)*0.05;
  c+=vec3(0.55,0.45,0.35)*pow(hash(floor(skyUV*60.0+vec2(3.1,5.7))),12.0)*0.035;
  c+=vec3(0.40,0.38,0.50)*pow(hash(floor(skyUV*300.0+vec2(11.0,8.0))),18.0)*0.04;
  c+=vec3(0.65,0.60,0.70)*pow(hash(floor(skyUV*160.0+vec2(5.5,3.3))),11.0)*0.05*(mwB*0.6+0.2);

  float hMask=smoothstep(-0.3,0.4,dir.y);
  float neb=fbm3(skyUV*3.0+0.3)*0.5+0.5;
  c+=vec3(0.06,0.03,0.12)*neb*hMask;
  float neb2=fbm3(skyUV*2.0+vec2(1.7,0.5))*0.5+0.5;
  c+=vec3(0.04,0.03,0.08)*neb2*hMask*0.7;
  c+=vec3(0.05,0.02,0.06)*fbm3(skyUV*4.5+2.0)*hMask*0.6;
  float neb3=fbm3(skyUV*1.8+vec2(4.2,1.3))*0.5+0.5;
  c+=vec3(0.05,0.035,0.012)*neb3*hMask*0.55;
  float horizonGlow=exp(-dir.y*dir.y*8.0);
  c+=vec3(0.035,0.020,0.065)*horizonGlow*0.8;
  c+=vec3(0.030,0.018,0.006)*horizonGlow*0.5;
  float centerGlow=exp(-dot(dir.xz,dir.xz)*1.5);
  c+=vec3(0.025,0.015,0.045)*centerGlow*0.6;
  return c;
}

void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  uv.y=1.0-uv.y;
  float asp=uRes.x/uRes.y;

  vec3 cam=uCam;
  vec3 tgt=uTgt+vec3(
    (uMouse.x-0.5)*0.03,
    0.0,
    (uMouse.y-0.5)*0.02
  );
  vec3 fw=normalize(tgt-cam);
  vec3 rt=normalize(cross(vec3(0,1,0),fw));
  vec3 u=cross(rt,fw);

  vec2 sc=(uv-0.5)*vec2(asp,1.0);
  vec3 rd=normalize(fw+rt*sc.x*uFov+u*sc.y*uFov);

  vec3 col=vec3(0.003,0.003,0.010);

  vec2 mwUV=uv-0.5;
  float mwAng=0.55;
  float ca=cos(mwAng),sa=sin(mwAng);
  vec2 mwR=vec2(mwUV.x*ca-mwUV.y*sa, mwUV.x*sa+mwUV.y*ca);
  float mwAlong=mwR.x, mwPerp=mwR.y;

  float bandCore=exp(-mwPerp*mwPerp*28.0);
  float bandMid=exp(-mwPerp*mwPerp*10.0);
  float bandWide=exp(-mwPerp*mwPerp*4.0);
  float bandUltra=exp(-mwPerp*mwPerp*1.8);

  float grain1=fbm6(vec2(mwAlong*14.0+1.3,mwPerp*22.0+3.7)+uTime*0.004)*0.5+0.5;
  float grain2=fbm_b(vec2(mwAlong*24.0+5.1,mwPerp*40.0+8.2)-uTime*0.003)*0.5+0.5;
  float grain3=fbm(vec2(mwAlong*45.0+2.8,mwPerp*65.0+11.0)+uTime*0.002)*0.5+0.5;
  float grain4=noise2(vec2(mwAlong*80.0+6.5,mwPerp*120.0+15.0))*0.5+0.5;
  float grain5=noise(vec2(mwAlong*140.0+9.1,mwPerp*200.0+4.4))*0.5+0.5;
  float fineStruct=grain1*0.30+grain2*0.25+grain3*0.20+grain4*0.15+grain5*0.10;

  float cloud1=fbm6(vec2(mwAlong*5.0+0.5,mwPerp*9.0+1.7)+uTime*0.006)*0.5+0.5;
  float cloud2=fbm_b(vec2(mwAlong*3.0+4.2,mwPerp*5.0+6.1)-uTime*0.004)*0.5+0.5;
  float cloudStr=cloud1*0.6+cloud2*0.4;

  float rift1=fbm6(vec2(mwAlong*7.0+3.0,mwPerp*16.0+0.5)+uTime*0.003)*0.5+0.5;
  float riftMask1=smoothstep(0.36,0.56,rift1);
  float rift2=fbm_b(vec2(mwAlong*10.0+7.2,mwPerp*22.0+4.8)-uTime*0.002)*0.5+0.5;
  float riftMask2=smoothstep(0.40,0.55,rift2)*0.7;
  float rift3=fbm6(vec2(mwAlong*18.0+1.8,mwPerp*30.0+9.3))*0.5+0.5;
  float riftMask3=smoothstep(0.38,0.54,rift3)*0.45;
  float rift4=fbm_b(vec2(mwAlong*30.0+4.4,mwPerp*45.0+7.1))*0.5+0.5;
  float riftMask4=smoothstep(0.42,0.56,rift4)*0.25*bandCore;
  float absorption=1.0-(riftMask1+riftMask2+riftMask3+riftMask4)*bandMid*0.65;
  absorption=max(absorption, 0.08);

  float gcDist=length(mwR-vec2(-0.08,0.0));
  float gcBulge=exp(-gcDist*gcDist*12.0);
  float gcBright=gcBulge*(0.8+cloud1*0.2)*absorption;

  float starCloud=bandMid*cloudStr*fineStruct*absorption;
  vec3 mwLight=vec3(0.0);
  mwLight+=vec3(0.22,0.18,0.15)*starCloud*bandCore*2.8;
  mwLight+=vec3(0.14,0.12,0.16)*starCloud*bandMid*1.6;
  mwLight+=vec3(0.06,0.05,0.09)*cloudStr*bandWide*absorption*0.8;
  mwLight+=vec3(0.025,0.020,0.040)*bandUltra*cloud2*0.5;
  mwLight+=vec3(0.35,0.24,0.10)*gcBright*1.2;
  mwLight+=vec3(0.20,0.14,0.06)*gcBulge*bandCore*absorption*0.8;
  float hueShift=sin(uTime*0.035)*0.045;
  float hueShift2=cos(uTime*0.028)*0.035;
  mwLight.r+=hueShift*bandMid;
  mwLight.b+=hueShift2*bandMid;
  mwLight.g-=(hueShift+hueShift2)*0.25*bandMid;
  float emiss1=fbm_b(vec2(mwAlong*5.5+7.3,mwPerp*6.0+4.1)+uTime*0.005)*0.5+0.5;
  float emissMask=bandMid*emiss1*smoothstep(0.3,0.6,emiss1);
  mwLight+=vec3(0.12,0.04,0.08)*emissMask*absorption*0.7;
  float blueNeb=fbm_b(vec2(mwAlong*4.5+11.0,mwPerp*7.0+2.5))*0.5+0.5;
  mwLight+=vec3(0.04,0.06,0.14)*blueNeb*bandMid*absorption*smoothstep(0.5,0.7,blueNeb)*0.6;

  col+=mwLight;

  vec2 pxUV=uv*uRes;
  float starDensMod=bandWide*0.7+0.3;

  { vec2 c=floor(pxUV); vec2 f=fract(pxUV); vec2 sp=hash2v(c);
    float d=length(f-sp); float b=pow(hash(c+vec2(42.0,17.0)),8.0);
    col+=vec3(0.28,0.26,0.36)*b*smoothstep(0.50,0.0,d)*0.055*starDensMod; }
  { vec2 sc=pxUV+vec2(0.37,0.73); vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(13.0,7.0));
    float d=length(f-sp); float b=pow(hash2(c+vec2(55.0,23.0)),8.0);
    col+=vec3(0.24,0.22,0.30)*b*smoothstep(0.50,0.0,d)*0.042*starDensMod; }
  { vec2 sc=pxUV*0.8+vec2(3.1,7.2); vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(29.0,11.0));
    float d=length(f-sp); float b=pow(hash(c+vec2(37.0,5.0)),9.0);
    col+=vec3(0.32,0.28,0.22)*b*smoothstep(0.50,0.0,d)*0.045*starDensMod; }
  { vec2 sc=pxUV*0.7; vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(19.0,31.0));
    float d=length(f-sp); float b=pow(hash2(c+vec2(7.0,53.0)),14.0);
    float tw=0.7+0.3*sin(uTime*1.3+hash(c)*62.83);
    col+=vec3(0.55,0.52,0.75)*b*smoothstep(0.45,0.0,d)*0.14*tw; }
  { vec2 sc=pxUV*0.5+vec2(5.5,2.3); vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(41.0,67.0));
    float d=length(f-sp); float b=pow(hash(c+vec2(22.0,58.0)),16.0);
    float tw=0.75+0.25*sin(uTime*0.9+hash2(c)*62.83);
    col+=vec3(0.65,0.58,0.45)*b*smoothstep(0.45,0.0,d)*0.12*tw; }
  { vec2 sc=pxUV*0.55+vec2(11.0,4.7); vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(83.0,37.0));
    float d=length(f-sp); float b=pow(hash2(c+vec2(61.0,44.0)),15.0);
    col+=vec3(0.40,0.48,0.80)*b*smoothstep(0.45,0.0,d)*0.11*(0.7+0.3*sin(uTime*1.8+b*40.0)); }
  { vec2 sc=pxUV*0.4+vec2(8.3,13.1); vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(97.0,53.0));
    float d=length(f-sp); float b=pow(hash(c+vec2(33.0,71.0)),22.0);
    float tw=0.6+0.4*sin(uTime*0.7+hash2(c)*62.83);
    col+=vec3(0.80,0.78,0.95)*b*(smoothstep(0.40,0.0,d)+smoothstep(0.7,0.1,d)*0.15)*0.22*tw; }
  { vec2 sc=pxUV*0.3+vec2(17.3,4.8); vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(113.0,29.0));
    float d=length(f-sp); float b=pow(hash2(c+vec2(77.0,91.0)),30.0);
    float hueId=hash(c+vec2(17.3,4.9));
    vec3 sCol=hueId<0.3?vec3(0.70,0.75,1.0):hueId<0.6?vec3(1.0,0.92,0.70):vec3(1.0,0.80,0.75);
    float tw=0.5+0.5*sin(uTime*0.5+b*80.0);
    col+=sCol*b*(smoothstep(0.40,0.0,d)+smoothstep(0.8,0.1,d)*0.12)*0.38*tw; }
  { vec2 sc=pxUV+vec2(2.2,9.8); vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(131.0,47.0));
    float d=length(f-sp); float b=pow(hash(c+vec2(19.0,83.0)),7.0);
    col+=vec3(0.22,0.20,0.28)*b*smoothstep(0.50,0.0,d)*0.045*bandMid*absorption; }
  { vec2 sc=pxUV+vec2(6.6,3.3); vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(149.0,61.0));
    float d=length(f-sp); float b=pow(hash2(c+vec2(43.0,109.0)),6.0);
    col+=vec3(0.20,0.18,0.25)*b*smoothstep(0.50,0.0,d)*0.035*bandMid*absorption; }
  { vec2 sc=pxUV*1.3+vec2(14.1,2.7); vec2 c=floor(sc); vec2 f=fract(sc); vec2 sp=hash2v(c+vec2(167.0,73.0));
    float d=length(f-sp); float b=pow(hash(c+vec2(57.0,121.0)),7.0);
    col+=vec3(0.18,0.15,0.12)*b*smoothstep(0.50,0.0,d)*0.030*bandCore*absorption; }

  float neb1=fbm_b(uv*3.5+0.3+uTime*vec2(0.003,-0.002))*0.5+0.5;
  col+=vec3(0.025,0.012,0.055)*neb1*smoothstep(0.08,0.45,uv.y)*(1.0-bandMid*0.7);
  float neb4=fbm_b(uv*2.8+vec2(4.2,1.3)+uTime*vec2(0.002,-0.003))*0.5+0.5;
  float goldP=exp(-pow(length(uv-vec2(0.32,0.18)),2.0)*6.0);
  col+=vec3(0.04,0.028,0.008)*neb4*goldP*1.5;
  float neb5=fbm_b(uv*3.2+vec2(8.1,3.5)-uTime*vec2(0.004,0.002))*0.5+0.5;
  float blueP=exp(-pow(length(uv-vec2(0.74,0.14)),2.0)*5.0);
  col+=vec3(0.015,0.030,0.065)*neb5*blueP*1.3;

#if ENABLE_AURORA
  float auroraY=smoothstep(0.55,0.05,uv.y);
  if(auroraY>0.01){
    float curtain1=sin(uv.x*12.0+uTime*0.08+sin(uv.x*5.0+uTime*0.12)*1.5)*0.5+0.5;
    float curtain2=sin(uv.x*8.0-uTime*0.06+sin(uv.x*3.5-uTime*0.09)*2.0)*0.5+0.5;
    float fold=fbm_b(vec2(uv.x*6.0+uTime*0.04,uv.y*2.0+uTime*0.02))*0.5+0.5;
    float curtainH=pow(auroraY,1.2);
    float aStr1=curtain1*fold*curtainH*0.14;
    float aStr2=curtain2*(1.0-fold)*curtainH*0.08;
    float aBreath=0.6+0.4*sin(uTime*0.15+uv.x*2.0);
    col+=vec3(0.04,0.14,0.10)*aStr1*aBreath;
    col+=vec3(0.12,0.03,0.10)*aStr2*aBreath;
    float peak=pow(fold*curtain1,3.0)*curtainH*0.05*aBreath;
    col+=vec3(0.06,0.08,0.06)*peak;
  }
#endif

  float hGlow=exp(-pow(uv.y-0.38,2.0)*6.0);
  col+=vec3(0.025,0.015,0.04)*hGlow*0.6;
  col+=vec3(0.015,0.010,0.003)*hGlow*bandWide*0.4;

  vec3 bgCol=col;
  float tHitVal=100.0;

  if(rd.y<-0.0005){
    float tHit=-cam.y/rd.y;
    tHitVal=tHit;
    vec3 hit=cam+rd*tHit;
    vec2 pp=hit.xz;
    float pD=length(pp);

    if(pD<12.0){
      vec3 N=waveN(pp,uTime);
      vec3 Vi=-rd;
      float NdV=max(dot(N,Vi),0.001);

      vec3 Nglitter=N;
      vec2 gn1=pp*8.0+uTime*vec2(0.12,-0.08);
      vec2 gn2=pp*18.0+uTime*vec2(-0.06,0.09);
      float g1=(noise(gn1)-0.5)*2.0;
      float g2=(noise2(gn2)-0.5)*2.0;
      float glitterFade=exp(-pD*0.20);
      Nglitter.x+=(g1*0.04+g2*0.025)*glitterFade;
      Nglitter.z+=(g1*0.03+g2*0.020)*glitterFade;
      Nglitter=normalize(Nglitter);
      vec3 Nsparkle=N;
      vec2 sn1=pp*32.0+uTime*vec2(0.10,-0.07);
      vec2 sn2=pp*60.0+uTime*vec2(-0.05,0.08);
      float s1=(noise(sn1)-0.5)*2.0;
      float s2=(noise2(sn2)-0.5)*2.0;
      Nsparkle.x+=(s1*0.06+s2*0.03)*glitterFade;
      Nsparkle.z+=(s1*0.04+s2*0.025)*glitterFade;
      Nsparkle=normalize(Nsparkle);

      float F0=0.02;
      float fres=F0+(1.0-F0)*pow(1.0-NdV,5.0);
      fres=max(fres, 0.15);
      fres+=0.20*smoothstep(1.0,4.0,pD)*(1.0-fres);

      vec3 R=reflect(rd,N);
      vec2 viewDir2D=normalize(hit.xz-cam.xz);
      float rPar=dot(R.xz,viewDir2D);
      vec2 rPerp=R.xz-rPar*viewDir2D;
      float anisoStrength=1.45;
      float grazeStretch=1.0+0.3*(1.0-NdV);
      vec2 anisoR=rPar*viewDir2D*anisoStrength*grazeStretch+rPerp;
      vec3 Raniso=normalize(vec3(anisoR.x,R.y,anisoR.y));

      vec3 reflC=skyColor(Raniso, vec2(uTime*0.003));
      reflC*=1.4;
      vec3 reflC2=skyColor(Raniso+N*0.12, vec2(uTime*0.003+0.5));
      reflC=mix(reflC, reflC2, 0.25);
      reflC+=vec3(0.08,0.04,0.02)*exp(-pD*pD*0.8)*0.12;

      for(int i=0;i<4;i++){
        vec2 cp=uComet[i].xy;
        float cb=uComet[i].z;
        float cAng=uComet[i].w;
        if(cb<0.005) continue;
        vec2 cDir=vec2(cos(cAng),sin(cAng));
        vec2 cPerp=vec2(-cDir.y,cDir.x);
        vec2 toC=cp-pp;
        float along=dot(toC,cDir);
        float perp=dot(toC,cPerp);
        float headD=length(toC);
        float head=exp(-headD*headD*18.0)*cb;
        float trailMask=smoothstep(0.05,-3.0,along);
        float trailWidth=exp(-perp*perp*35.0);
        float trailFade=exp(along*0.6);
        float trail=trailMask*trailWidth*trailFade*cb*0.35;
        float cBright=(head+trail)*(0.85+N.x*0.25+N.z*0.15);
        if(cBright<0.002) continue;
        vec3 headCol=vec3(0.65,0.60,0.90)*head;
        vec3 trailCol=mix(vec3(0.50,0.40,0.70),vec3(0.45,0.30,0.15),trailMask*0.7)*trail;
        reflC+=(headCol+trailCol)*2.5;
      }

      vec3 subC=vec3(0.003,0.002,0.008);
      float depthNoise=fbm3(pp*2.5+vec2(0.3,0.7))*0.5+0.5;
      float depthVar=0.75+depthNoise*0.50;
      vec3 depthTint=mix(vec3(0.02,0.01,0.01),vec3(-0.01,0.0,0.02),depthNoise);

      vec2 cUV=pp+N.xz*0.55;
      float cst=caustic(cUV,uTime);
      float cW=exp(-pD*pD*0.35);
      vec3 cCol=mix(vec3(0.04,0.015,0.08),vec3(0.16,0.10,0.04),cW);
      float cAng=atan(pp.y,pp.x);
      float cZone=sin(cAng*1.2+uTime*0.05)*0.5+0.5;
      vec3 cColBlue=vec3(0.03,0.06,0.14);
      vec3 cColAmber=vec3(0.18,0.12,0.03);
      cCol=mix(cCol,mix(cColBlue,cColAmber,cZone),0.5);
      cCol+=vec3(0.06,0.03,0.01)*exp(-pow(pD-0.8,2.0)*0.8);
      cCol+=vec3(0.03,0.015,0.05)*exp(-pow(pD-1.5,2.0)*0.5);
      subC+=cCol*cst*0.18*exp(-pD*0.22)*(0.8+depthNoise*0.4);

      for(int i=0;i<SHADER_MEMORY_COUNT;i++){
        vec2 mp=uMem[i].xy;
        float str=uMem[i].z;
        if(str<0.01) continue;
        float md=length(pp-mp);
        float lightPool=exp(-md*md*6.0)*str;
        vec3 gemCol=uMemCol[i];
        vec3 gemLight=mix(gemCol*1.2, gemCol*0.5+vec3(0.08,0.05,0.12), smoothstep(0.0,0.6,md));
        subC+=gemLight*lightPool*0.35;
      }

      for(int i=0;i<SHADER_MEMORY_COUNT;i++){
        vec2 mp=uMem[i].xy;
        float str=uMem[i].z;
        if(str<0.01) continue;
        float ph=uMem[i].w;
        float md=length(pp-mp);
        float mDecay=exp(-md*0.85)*str;
        if(mDecay<0.003) continue;
        float r1=pow(abs(sin(md*7.0 -uTime*0.9+ph      )),14.0);
        float r2=pow(abs(sin(md*12.0-uTime*1.4+ph+1.0   )),16.0)*0.3;
        float ringBright=r1*0.50+r2*0.12;
        ringBright*=mix(1.0, 0.20, smoothstep(0.2, 2.5, md));
        vec3 gemCol=uMemCol[i];
        vec3 ringCol=mix(gemCol*1.0+vec3(0.1,0.08,0.15), vec3(0.35,0.25,0.50), smoothstep(0.3,1.8,md));
        subC+=ringCol*ringBright*mDecay;
      }

      float zAng=atan(pp.y,pp.x);
      float zoneBlue=pow(sin(zAng*1.0-0.5+uTime*0.03)*0.5+0.5, 1.5);
      float zoneAmber=pow(sin(zAng*1.0+2.1+uTime*0.025)*0.5+0.5, 1.5);
      float zonePurple=1.0-max(zoneBlue,zoneAmber)*0.6;
      vec3 outerCol=vec3(0.03,0.015,0.07)*zonePurple
                   +vec3(0.015,0.03,0.08)*zoneBlue
                   +vec3(0.06,0.035,0.015)*zoneAmber;
      subC+=outerCol*exp(-pD*pD*0.10)*0.28*depthVar;
      vec3 midOutCol=vec3(0.05,0.03,0.10)*zonePurple
                    +vec3(0.025,0.05,0.12)*zoneBlue
                    +vec3(0.10,0.06,0.02)*zoneAmber;
      subC+=midOutCol*exp(-pD*pD*0.22)*0.22*depthVar;
      vec3 midCol=vec3(0.10,0.06,0.14)*zonePurple
                 +vec3(0.04,0.08,0.16)*zoneBlue
                 +vec3(0.16,0.10,0.04)*zoneAmber;
      subC+=midCol*exp(-pD*pD*0.38)*0.20*depthVar;
      vec3 midInCol=vec3(0.16,0.09,0.12)*zonePurple
                   +vec3(0.06,0.10,0.14)*zoneBlue
                   +vec3(0.20,0.14,0.06)*zoneAmber;
      subC+=midInCol*exp(-pD*pD*0.55)*0.16*depthVar;
      vec3 innerCol=mix(vec3(0.20,0.13,0.06),vec3(0.22,0.15,0.08),zoneAmber);
      subC+=innerCol*exp(-pD*pD*0.90)*0.14*depthVar;
      subC+=vec3(0.24,0.16,0.08)*exp(-pD*pD*1.8)*0.10;
      subC+=vec3(0.28,0.20,0.10)*exp(-pD*pD*4.0)*0.06;
      subC+=vec3(0.30,0.22,0.12)*exp(-pD*pD*10.0)*0.03;
      subC+=depthTint*exp(-pD*0.3)*0.5;
      float ang=atan(pp.y,pp.x);
      subC+=vec3(0.02,0.04,0.10)*sin(ang*2.0+pD*1.5+uTime*0.10)*exp(-pD*pD*0.35)*0.18*zoneBlue;
      subC+=vec3(0.06,0.02,0.08)*sin(ang*2.0+pD*1.5+uTime*0.10)*exp(-pD*pD*0.35)*0.14*zonePurple;
      subC+=vec3(0.04,0.02,0.06)*cos(ang*3.0-pD*0.8)*exp(-pD*pD*0.30)*0.10;
      subC+=vec3(0.12,0.08,0.02)*sin(ang*1.5-uTime*0.06+1.0)*exp(-pD*pD*0.50)*0.18*zoneAmber;
      float bPocket=exp(-pow(ang+1.0,2.0)*1.5)*exp(-pow(pD-1.2,2.0)*0.8);
      subC+=vec3(0.03,0.06,0.14)*bPocket*0.25;
      float pocket=exp(-pow(ang-1.2,2.0)*2.0)*exp(-pow(pD-1.0,2.0)*1.0);
      subC+=vec3(0.14,0.09,0.03)*pocket*0.22;
      subC*=exp(-pD*0.15);

      float darkNoise=fbm3(pp*1.2+vec2(uTime*0.02, uTime*0.015));
      float darkPatch=smoothstep(0.35,0.55,darkNoise);
      float turbShadow=fbm3(pp*3.5+vec2(-uTime*0.03, uTime*0.025));
      float turbMask=smoothstep(0.30,0.58,turbShadow);
      float shadowFactor=mix(0.35, 1.0, darkPatch*0.6+turbMask*0.4);
      subC*=shadowFactor;

      float transparency=smoothstep(0.5,3.0,pD)*0.60;
      subC=mix(subC,vec3(0.004,0.003,0.012),transparency);

      col=mix(subC,reflC,fres);

      vec3 L1=normalize(vec3(0.0,5.0,0.2)-hit);
      vec3 H1=normalize(Vi+L1);
      float NdH_smooth=max(dot(N,H1),0.0);
      float sp_core  =pow(NdH_smooth,200.0)*0.55;
      float sp_bloom =pow(NdH_smooth,50.0)*0.12;
      float sp_wide  =pow(NdH_smooth,12.0)*0.025;
      float sp_atmo  =pow(NdH_smooth,4.0)*0.006;
      float NdH_glit=max(dot(Nglitter,H1),0.0);
      float sp_glit  =pow(NdH_glit,120.0)*0.18;
      float NdH_spark=max(dot(Nsparkle,H1),0.0);
      float sp_spark =pow(NdH_spark,350.0)*0.40;
      float specT=sp_core+sp_bloom+sp_wide+sp_atmo+sp_glit+sp_spark;

      float warmth=exp(-pD*pD*0.35);
      vec3 spC=mix(vec3(0.38,0.28,0.52),vec3(0.62,0.46,0.28),warmth);
      float mid=exp(-pow(pD-1.0,2.0)*0.6);
      spC=mix(spC,vec3(0.55,0.38,0.45),mid*0.30);
      col+=spC*specT;

      vec3 L2=normalize(vec3(0.5,4.5,-0.4)-hit);
      vec3 H2=normalize(Vi+L2);
      col+=spC*(pow(max(dot(N,H2),0.0),160.0)*0.10+pow(max(dot(Nglitter,H2),0.0),100.0)*0.06);

      vec3 L3=normalize(vec3(-0.4,4.5,0.3)-hit);
      vec3 H3=normalize(Vi+L3);
      col+=spC*(pow(max(dot(N,H3),0.0),160.0)*0.07+pow(max(dot(Nglitter,H3),0.0),100.0)*0.04);

      vec3 L4=normalize(vec3(0.0,1.2,4.0)-hit);
      vec3 H4=normalize(Vi+L4);
      float rimSpec=pow(max(dot(N,H4),0.0),80.0)*0.13*smoothstep(1.0,3.0,pD);
      vec3 rimCol=mix(vec3(0.25,0.18,0.38),vec3(0.45,0.32,0.18),smoothstep(1.5,3.0,pD));
      col+=rimCol*rimSpec;

      float mistStart=smoothstep(1.6,3.2,pD);
      float mistFalloff=exp(-pow(pD-4.5,2.0)*0.05);
      if(mistStart>0.01){
        float mist1=fbm_b(pp*0.5+vec2(uTime*0.03,-uTime*0.022))*0.5+0.5;
        float mist2=fbm(pp*1.2+vec2(-uTime*0.018,uTime*0.028))*0.5+0.5;
        float mist3=noise2(pp*2.5+vec2(uTime*0.04,uTime*0.015))*0.5+0.5;
        float mistDensity=mist1*0.5+mist2*0.3+mist3*0.2;
        float wisps=smoothstep(0.30,0.60,mistDensity);
        float mistH=smoothstep(0.005,-0.025,rd.y);
        float mistAlpha=wisps*mistStart*mistFalloff*mistH*0.70;
        mistAlpha=min(mistAlpha,0.40);
        float mAng=atan(pp.y,pp.x);
        float mzBlue=pow(sin(mAng*1.0-0.5+uTime*0.03)*0.5+0.5,1.5);
        float mzAmber=pow(sin(mAng*1.0+2.1+uTime*0.025)*0.5+0.5,1.5);
        float mzPurple=1.0-max(mzBlue,mzAmber)*0.5;
        vec3 mistCol=vec3(0.06,0.09,0.20)*mzBlue
                    +vec3(0.10,0.07,0.16)*mzPurple
                    +vec3(0.16,0.11,0.05)*mzAmber;
        float skyBounce=max(0.0,dot(N,vec3(0,1,0)))*0.4;
        mistCol+=vec3(0.04,0.04,0.05)*skyBounce;
        float edgeGlow=smoothstep(3.5,5.5,pD)*0.25;
        mistCol*=(1.0+edgeGlow);
        col=mix(col,mistCol,mistAlpha*0.60);
        col+=mistCol*mistAlpha*0.20;
      }

      float edgeFade=smoothstep(6.5,1.8,pD);
      float horizBlend=smoothstep(-0.003,-0.025,rd.y);
      edgeFade*=horizBlend;
      col=mix(bgCol,col,edgeFade);

      float fog=1.0-exp(-tHit*tHit*0.003);
      vec3 fogCol=mix(vec3(0.008,0.007,0.016),bgCol,smoothstep(1.5,5.0,pD));
      col=mix(col,fogCol,fog);

      float mist=exp(-pow(pD-1.8,2.0)*0.6)*0.045;
      col=mix(col,vec3(0.010,0.008,0.018),mist);
    }
  }

  col+=volumetricGlow(cam,rd,tHitVal<100.0?tHitVal:8.0,uTime);

  float hazeAng=atan(uv.y-0.52,uv.x-0.5);
  float hzBlue=pow(sin(hazeAng*1.0-0.3)*0.5+0.5,1.5);
  float hzAmber=pow(sin(hazeAng*1.0+2.3)*0.5+0.5,1.5);
  float hzPurple=1.0-max(hzBlue,hzAmber)*0.5;
  float haze1=exp(-length(uv-vec2(0.5,0.56))*1.3)*0.028;
  col+=vec3(0.04,0.06,0.16)*haze1*hzBlue;
  col+=vec3(0.08,0.05,0.14)*haze1*hzPurple;
  col+=vec3(0.14,0.08,0.04)*haze1*hzAmber;
  float haze2=exp(-length(uv-vec2(0.5,0.52))*2.0)*0.016;
  col+=vec3(0.05,0.08,0.15)*haze2*hzBlue;
  col+=vec3(0.10,0.07,0.10)*haze2*hzPurple;
  col+=vec3(0.16,0.10,0.05)*haze2*hzAmber;
  float fgHaze=exp(-pow(uv.y-0.72,2.0)*8.0)*0.010;
  col+=vec3(0.04,0.04,0.10)*fgHaze*hzBlue+vec3(0.06,0.04,0.08)*fgHaze*hzPurple+vec3(0.10,0.06,0.03)*fgHaze*hzAmber;
  float roseH=exp(-pow(uv.y-0.50,2.0)*30.0)*0.010;
  col+=vec3(0.10,0.08,0.22)*roseH*hzBlue+vec3(0.22,0.12,0.10)*roseH*hzPurple+vec3(0.28,0.18,0.06)*roseH*hzAmber;
  float warmH=exp(-length(uv-vec2(0.5,0.50))*3.2)*0.008;
  col+=vec3(0.30,0.20,0.12)*warmH;

  vec3 bloomCol=vec3(0.0);
  for(int i=0;i<6;i++){
    float fi=float(i);
    vec2 bOff=vec2(cos(fi*1.047)*0.015,sin(fi*1.047)*0.015);
    vec2 bUV=uv+bOff;
    float bDist=length(bUV-vec2(0.5,0.50));
    float bVal=exp(-bDist*bDist*4.0)*0.010;
    float bW=exp(-bDist*bDist*0.4);
    bloomCol+=mix(vec3(0.10,0.07,0.16),vec3(0.35,0.25,0.16),bW*bW)*bVal;
  }
  for(int i=0;i<5;i++){
    float fi=float(i);
    vec2 bOff=vec2(cos(fi*1.256+0.3)*0.040,sin(fi*1.256+0.3)*0.040);
    vec2 bUV=uv+bOff;
    float bDist=length(bUV-vec2(0.5,0.52));
    float bVal=exp(-bDist*bDist*1.8)*0.005;
    float bW=exp(-bDist*bDist*0.25);
    bloomCol+=mix(vec3(0.08,0.05,0.12),vec3(0.28,0.20,0.14),bW*bW)*bVal;
  }
  col+=bloomCol;

  vec2 vc=uv-0.5;
  col*=1.0-dot(vc,vc)*1.8;
  col=(col*(2.51*col+0.03))/(col*(2.43*col+0.59)+0.14);
  col=pow(max(col,vec3(0.0)),vec3(0.88,0.90,0.92));
  col+=(hash(uv*uRes+uTime*97.0)-0.5)*0.006;

  gl_FragColor=vec4(max(col,vec3(0.0)),1.0);
}
`