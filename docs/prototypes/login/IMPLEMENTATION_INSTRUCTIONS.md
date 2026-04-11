# Midnight Atelier Login — Implementation Instructions

> **Source prototype:** `docs/prototypes/login/01-midnight-atelier-v4.html`
> **Target:** Replace the existing `AuthGate` component (`frontend/src/app/components/AuthGate.tsx`) with this design, or create a dedicated login page.
> **Goal:** Pixel-perfect 1:1 reproduction of the prototype in React/Next.js/TypeScript.

---

## Architecture Overview

The prototype consists of **3 rendering layers** stacked via `position:fixed`:

| Layer | z-index | Technology | Purpose |
|---|---|---|---|
| `#sky` canvas | 0 | **WebGL (GLSL fragment shader)** | Full-screen night sky: gradient, terrain, Milky Way, stars, aurora, mist, post-processing |
| `#stars` canvas | 1 | **Canvas 2D** | Shooting stars, satellite passes, bat/bird silhouettes, dust motes, wind |
| `.page` div | 10 | **HTML/CSS** | Login UI: two-column layout with hero text + sign-in card |

### Critical: NO mouse interaction
The scene is purely time-driven. No mouse listeners, no parallax, no cursor effects. Everything animates autonomously.

---

## React Component Structure

```
<SophiaLogin>               (or replace AuthGate)
  ├── <SkyCanvas />          WebGL shader — useRef + useEffect
  ├── <StarsCanvas />        Canvas 2D — useRef + useEffect  
  └── <LoginLayout>          HTML/CSS UI
       ├── <LeftPanel>
       │    ├── <Logo />
       │    ├── <Hero />
       │    └── <Capabilities />
       └── <RightPanel>
            └── <SignInCard />
```

---

## LAYER 1: WebGL Shader (`SkyCanvas`)

### Setup
- Get a `<canvas>` ref, create WebGL context with `{alpha:false, antialias:false}`
- DPR cap: `Math.min(devicePixelRatio, 2)`
- Fullscreen: `width = innerWidth * dpr`, `height = innerHeight * dpr`
- Listen to `resize` events
- Two uniforms only: `uTime` (float, seconds since mount), `uRes` (vec2, canvas pixel dimensions)
- Vertex shader is trivial: fullscreen quad from 4 vertices `[-1,-1], [1,-1], [-1,1], [1,1]` drawn as `TRIANGLE_STRIP`

### Fragment Shader — Complete GLSL

The shader must be reproduced **exactly**. Here is the full logical breakdown with every constant and formula:

#### Noise Toolkit (top of shader)
```glsl
precision highp float;
uniform float uTime;
uniform vec2 uRes;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float hash2(vec2 p){return fract(sin(dot(p,vec2(269.5,183.3)))*43758.5453);}
vec2 hash2v(vec2 p){return vec2(hash(p),hash2(p));}

// Quintic Hermite interpolation noise
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
             mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}

// FBM variants: 6-octave, 4-octave, 8-octave
float fbm(vec2 p) {float v=0.,a=0.5;for(int i=0;i<6;i++){v+=a*noise(p);p*=2.03;a*=0.47;}return v;}
float fbm4(vec2 p){float v=0.,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.1; a*=0.45;}return v;}
float fbm8(vec2 p){float v=0.,a=0.5;for(int i=0;i<8;i++){v+=a*noise(p);p*=2.01;a*=0.48;}return v;}
```

#### Coordinate System
```glsl
vec2 uv = gl_FragCoord.xy / uRes;                           // 0-1 screen UV
float asp = uRes.x / uRes.y;
vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);  // centered, aspect-correct
float t = uTime;
```

#### Slow Sky Drift
```glsl
float drift = t * 0.0004;  // full rotation every ~4.4 hours
float cdrift = cos(drift), sdrift = sin(drift);
```
Applied to Milky Way and star coordinates as 2D rotation.

#### Horizon System
- **Horizon Y:** `-0.25` (bottom quarter of screen)
- `aboveHorizon = smoothstep(horizonY-0.02, horizonY+0.02, p.y)` — soft transition
- `belowHorizon = 1.0 - aboveHorizon`
- `distFromHorizon = abs(p.y - horizonY)`

#### Sky Gradient
Three-colour vertical gradient:
```glsl
skyTop     = vec3(0.012, 0.014, 0.035)   // deep indigo
skyMid     = vec3(0.025, 0.022, 0.055)   // dark purple
skyHorizon = vec3(0.06,  0.04,  0.08)    // warm purple
```
Mixed with `smoothstep(horizonY, 0.9, p.y)`.

#### Horizon Glow (breathing)
Two Gaussian curves (tight + wide):
```glsl
horizGlow     = exp(-distFromHorizon² * 8.0)   // tight
horizGlowWide = exp(-distFromHorizon² * 2.0)   // wide
horizBreath   = 0.85 + 0.15 * sin(t * 0.06 + 1.0)  // ~105s cycle
```
Colors added:
- `vec3(0.12, 0.06, 0.04) * horizGlow * 0.7 * horizBreath` — amber-rose, modulated
- `vec3(0.06, 0.03, 0.06) * horizGlow * 0.4` — pink
- `vec3(0.04, 0.02, 0.07) * horizGlowWide * 0.5` — purple wash
- Noise-modulated variation: `fbm4(vec2(p.x*3.0+0.5, t*0.02))` drives warm/cool shift along x

#### Terrain Silhouette
Rolling hills computed from layered noise on `p.x`:
```glsl
terrain  = horizonY
         + fbm4(vec2(p.x*2.0+10.0, 0.5)) * 0.04
         + noise(vec2(p.x*5.0+3.0, 1.2)) * 0.015
         + noise(vec2(p.x*12.0+7.0, 2.5)) * 0.006
```

Mountain range (taller, behind terrain):
```glsl
mtns = horizonY + 0.02
     + fbm4(vec2(p.x*1.2+20.0, 3.0)) * 0.08
     + noise(vec2(p.x*3.5+15.0, 4.2)) * 0.025
```

Masks:
- `isTerrain  = smoothstep(terrain+0.003, terrain-0.003, p.y)` — crisp ~6-unit edge
- `isMountain = smoothstep(mtns+0.004, mtns-0.002, p.y) * (1.0-isTerrain)` — behind terrain

Mountain color: `vec3(0.025, 0.018, 0.04)` with rim lighting:
```glsl
mtnEdge = smoothstep(mtns-0.008, mtns+0.001, p.y) * smoothstep(mtns+0.015, mtns+0.001, p.y)
mtnCol += vec3(0.06, 0.03, 0.08) * mtnEdge * 2.0
```

Ground: `vec3(0.012, 0.010, 0.018)` with noise texture and atmospheric fog near horizon.

#### Milky Way Band

**Coordinate transform:**
```glsl
vec2 pMW = vec2(cdrift*p.x - sdrift*p.y, sdrift*p.x + cdrift*p.y);  // drift rotation
```

**Band geometry:**
- Slope: `0.48` (diagonal lower-left → upper-right)
- Center: `mwCenterY = 0.48 * pMW.x + 0.20 + sin(pMW.x * 1.5) * 0.025` — gentle sine wobble
- Distance: perpendicular to line, divided by `1/sqrt(1 + slope²)`
- Core position: `coreX = 0.12`, proximity: `exp(-(pMW.x - 0.12)² * 2.8)`
- Band half-width: `0.13 + coreProx * 0.08` (wider at core)
- `bandMask = smoothstep(bandHW*2.5, bandHW*0.1, mwDist) * aboveHorizon`
- `coreMask = exp(-mwDist²/(bandHW²*0.10)) * coreProx * aboveHorizon`

**Noise rotation:** Coordinates rotated by `atan(0.48)` to align noise along the band axis.

**Domain warping:**
```glsl
warp = vec2(fbm4(mwUV*2.0 + vec2(1.7,9.2)), fbm4(mwUV*2.0 + vec2(8.3,2.8)))
wUV = mwUV + warp * 0.12
```

**Nebula layers (4 octaves):**
```glsl
cL = fbm(wUV*3.0  + vec2(0.0,3.0))   // large   — 6-octave fbm
cM = fbm(wUV*6.5  + vec2(5.0,1.0))   // medium  — 6-octave fbm
cF = fbm8(wUV*13.0 + vec2(2.0,7.0))  // fine    — 8-octave fbm
cU = fbm4(wUV*25.0 + vec2(8.0,4.0))  // granular — 4-octave fbm

nebula = cL*0.38 + cM*0.30 + cF*0.22 + cU*0.10
nebula = smoothstep(0.22, 0.72, nebula)
```

**Great Rift (dark dust lanes):**
4 absorption layers from broad to ultra-fine:
```glsl
absorp = smoothstep(0.44,0.62,rift)*0.45      // broad rift
       + smoothstep(0.47,0.60,rift2)*0.22     // secondary
       + smoothstep(0.50,0.60,dFine)*0.12     // fine filaments
       + smoothstep(0.52,0.58,dUltra)*0.06    // ultra-fine
// clamped to max 0.65
transmission = 1.0 - absorp * smoothstep(bandHW*1.3, 0.0, mwDist)
```

**Color palette:**
| Name | RGB |
|---|---|
| coreWarm (salmon) | `0.95, 0.52, 0.30` |
| coreHot (gold) | `1.00, 0.78, 0.38` |
| corePink | `0.88, 0.42, 0.52` |
| midLav (lavender) | `0.58, 0.50, 0.80` |
| outerBlue | `0.35, 0.38, 0.65` |

Blending: edge distance drives lavender→blue, core proximity adds salmon/gold/pink.

**Core breathing:**
```glsl
coreBreath = 0.88 + 0.12 * sin(t * 0.045)  // ~140s cycle
```

**Application to sky:**
```glsl
sky += mwCol * nebula * bandMask * 0.72
sky += coreHot * coreMask * nebula * 0.30 * coreBreath
sky += vec3(0.022, 0.018, 0.042) * haloMask * (0.5 + cL * 0.5)  // outer halo
```

#### Airglow
Faint green-yellow wash near horizon, right side:
```glsl
agZone = smoothstep(horizonY+0.28, horizonY+0.02, p.y) * smoothstep(-0.7, 0.25, p.x)
sky += vec3(0.012, 0.022, 0.010) * agZone * fbm4(...) * 0.35
```

#### Subtle Aurora
Faint green/lavender curtain in y range 0.30–0.75:
```glsl
auroraY = smoothstep(0.30, 0.55, p.y) * smoothstep(0.75, 0.50, p.y)
aWave1 = sin(p.x*6.0 + t*0.08 + fbm4(vec2(p.x*2.0+t*0.03, 5.0))*3.0)
aWave2 = sin(p.x*10.0 - t*0.05 + 2.8)
aCurtain = smoothstep(0.2, 0.95, aWave1*0.5+0.5) * (0.6 + 0.4*aWave2)
aFlicker = 0.6 + 0.4 * sin(t*0.12 + p.x*3.0)
```
Color: green `(0.02,0.06,0.03)` → lavender `(0.04,0.02,0.06)` based on height.
Applied at `* 0.35` — **very subtle**, not a full northern lights.

#### Pulsing Nebula Hotspots
3 independent Gaussian blobs within the MW band, each pulsing at different frequencies:
```glsl
hs1 at pMW(0.05,0.22): exp(-dist*8.0) * (0.7 + 0.3*sin(t*0.07+1.0))
hs2 at pMW(0.20,0.30): exp(-dist*10.0) * (0.7+0.3*sin(t*0.09+3.5))
hs3 at pMW(-0.15,0.14): exp(-dist*9.0) * (0.7+0.3*sin(t*0.055+5.2))
```
Each adds a different purple/indigo tint, masked by `bandMask`.

#### Starfield (7 layers)
Applied to drift-rotated coordinates (`pStar`):
```glsl
vec2 pStar = vec2(cdrift*p.x - sdrift*p.y, sdrift*p.x + cdrift*p.y);
```

For each of 7 layers (L=0..6):
- Cell scale: `250 + L*140` (250 → 1090)
- Star position: hash-jittered within cell (range 0.12–0.88)
- Brightness: `pow(hash, 28 + L*5)` — very steep, most stars invisible
- **Gaussian falloff:** `sigma = 0.12 + br*0.06`, then `exp(-d²/(2*sigma²))`
- **Scintillation:** Slow twinkle (`0.5 + hash*2.5 Hz`) + rapid shimmer (`3 + hash*8 Hz`), shimmer only visible on brighter stars via `smoothstep(0.001, 0.02, br)`
- **MW density boost:** `1.0 + bandMask * 2.5 * (1.0 - L/7.0)` — more stars in the MW, especially in foreground layers
- **Color:** 84% neutral `(0.91,0.89,0.95)`, 5% blue `(0.62,0.68,1.0)`, 5% warm `(1.0,0.86,0.62)`, 6% lavender `(0.78,0.74,1.0)`
- Final: `sky += starSum * 0.55`

#### 5 Prominent Stars
Hash-positioned across the sky. Each has:
- Tight core: `exp(-d²*10000)` at 0.45
- Glow: `exp(-d²*1000)` at 0.10
- 4-point diffraction spikes (horizontal + vertical, different scales)
- Slow brightness oscillation: `0.90 + 0.10*sin(t*0.3 + i*2.8)`
- Colors: first 2 blue-white, middle warm, last 2 blue

#### High-Altitude Cloud Wisps
Two layers of thin FBM clouds in y range 0.05–0.55:
```glsl
cwY = smoothstep(horizonY+0.05, 0.55, p.y) * smoothstep(0.75, 0.40, p.y)
cw1 = fbm4(vec2(p.x*1.8 + t*0.006, p.y*3.5+2.0))  // drifts right
cw2 = fbm4(vec2(p.x*2.5 - t*0.004+4.0, p.y*4.0+8.0))  // drifts left
```
Very faint: `vec3(0.025,0.020,0.040) * cwMask (max 0.08)`.

#### Horizon Mist
Two-layer FBM fog near horizon (y < horizonY+0.12):
- Wispy breakup: `smoothstep(0.25, 0.50, mistN1)`
- Color: mixed dark purple to rose-purple
- Applied at `mist * 0.35` opacity

#### Post-Processing Compose
```glsl
col = sky;
col = mix(col, mtnCol, isMountain);
col = mix(col, groundCol, isTerrain);
col = mix(col, mistCol, mist * 0.35);

// Vignette
float vig = 1.0 - dot(uv-0.5, uv-0.5) * 1.6;
col *= smoothstep(-0.1, 0.55, vig);

// ACES-like tonemap
col = col / (col + 0.40);
col = pow(col, vec3(0.92));

// Film grain
float grain = hash(uv*uRes + vec2(t*173.1, t*291.7));
col += vec3((grain - 0.5) * 0.014);
```

---

## LAYER 2: Canvas 2D (`StarsCanvas`)

A separate `<canvas>` overlays the WebGL canvas. Uses `getContext('2d')`.
DPR cap: 2. Uses `ctx.setTransform(dpr,0,0,dpr,0,0)`.

### Shooting Stars (6 instances)
Class `ShootingStar`:
- **Angle:** `0.45 ± 0.175` radians (upper-left → lower-right)
- **Start position:** random in upper 80% x, upper 35% y
- **Two classes:** 85% faint/fast (speed 900-1700 px/s, life 0.15-0.4s, width 0.4-0.9, alpha 0.15-0.35), 15% bright/slow (speed 400-700, life 0.6-1.1s, width 1.0-1.8, alpha 0.5-0.85)
- **Trail:** Array of `{x, y, age}` points. Max age: 0.45s bright, 0.18s faint.
- **Draw:** Segment-by-segment with quadratic alpha falloff: `alpha = (1-age/maxAge)² * lifeFade * peakAlpha`
- **Head glow:** Small radial gradient (radius = width*2.5), warm-white center
- **Delay between:** 2-6 seconds (staggered on init)
- **Colors:** 15% warm `[230,210,175]`, 10% lavender `[200,195,225]`, 75% white `[235,232,242]`

### Satellite (1 instance)
Class `Satellite`:
- Traverses full screen width at y 5-35%
- Speed: 35-60 px/s
- Brightness: 0.18-0.33 with tumbling flare (`1.0 + 0.6*max(0, sin(life*flareSpeed))`)
- Fade in/out over 2 seconds at edges
- Delay: 25-35 seconds between passes (initial 5-15s)
- Draw: Tiny 1.2px radial gradient dot, lavender tint `(235,232,245)`

### Night Flyers — Bat/Bird Silhouettes (2 instances)
Class `NightFlyer`:
- Crosses screen in gentle sine arc
- Speed: 60-100 px/s horizontal
- Wing flap: 6-10 Hz sine wave
- Size: 3-7px
- Drawn as quadratic Bézier curves forming a simple bat wing shape
- Very transparent: `globalAlpha = 0.25 * edgeFade`
- Color: `#0a0810` (near-black silhouette)
- **Very rare:** 30-90 seconds between appearances

### Wind Gusts
State variables: `windX`, `windTargetX`, `windTimer`
- Every 8-20 seconds, set new `windTargetX` = random ±0.00035
- Smooth approach: `windX += (target - windX) * dt * 0.4`
- Constant decay: `windTargetX *= 0.997`
- Applied to dust motes' x velocity each frame

### Dust Motes (80 particles)
Each particle:
- Position: normalized 0-1 (with -0.5 to 1.5 range for wraparound)
- Velocity: `vx = ±0.00008`, `vy = -0.00002 to -0.00007` (slow upward)
- Size: 0.4-1.6px
- Alpha: 0.05-0.20, modulated by `0.5 + 0.5*sin(t*speed + phase)`
- Colors: 40% warm gold `[218,197,160]`, 20% lavender `[184,164,232]`, 40% neutral `[200,198,210]`
- Draw: Radial gradient with 3 stops (full → 30% → 0), radius = size*3
- Wind: `d.x += d.vx + windX` each frame

### Render Loop
```js
!function loop(){
  const dt = min((now-prev)/1000, 0.05);  // capped at 50ms
  ctx.clearRect(0,0,W,H);
  // 1. Shooting stars
  // 2. Satellite
  // 3. Night flyers
  // 4. Wind update
  // 5. Dust motes
  requestAnimationFrame(loop);
}();
```

### Utility Functions
```js
function smoothPulse(x, duty){
  return smoothStep(0, duty*0.3, x) * (1 - smoothStep(duty*0.7, duty, x));
}
function smoothStep(edge0, edge1, x){
  const t = clamp((x-edge0)/(edge1-edge0), 0, 1);
  return t*t*(3-2*t);
}
```

---

## LAYER 3: HTML/CSS UI

### Layout
- **Two-column grid** on desktop: `grid-template-columns: 1fr 1fr`
- **Stacked** on mobile (<960px): single column

### CSS Variables
```css
--text:   #f0edf8
--text2:  rgba(240,237,248,0.55)
--text3:  rgba(240,237,248,0.32)
--warm:   #dac5a0
--purple: #b8a4e8
--border: rgba(255,255,255,0.06)
```

### Fonts
- **Headings:** `Cormorant Garamond` (300, 400, 500 weights, italic 300/400)
- **Body:** `Inter` (300, 400, 500 weights)
- Load via Google Fonts or next/font

### Left Panel
1. **Logo** (top-left, absolute positioned at top:42px, left:72px)
   - 36×36 rounded square with gradient bg `(warm/purple at 0.18 alpha)`
   - "S" letter inside, Cormorant Garamond 20px
   - "Sophia" text, Cormorant Garamond 18px, letter-spacing 0.04em
   - Text shadow: `0 1px 8px rgba(0,0,0,0.5)`
   - Fade-in animation: 0.8s ease, 0.3s delay

2. **Hero section** (vertically centered)
   - Label: "Your voice companion" — 11px uppercase, letter-spacing 0.18em, warm color, with 24px line before
   - Heading: `She remembers.<br>She <em>notices.</em>` — Cormorant Garamond, clamp(42px,5.5vw,72px), weight 300, line-height 1.05
   - `<em>` uses warm color (#dac5a0), italic
   - Body text: 15px Inter weight-300, line-height 1.8, 70% white, max-width 440px
   - Text shadows on heading and body
   - Fade-up animation: 1s ease, 0.5s delay

3. **Capability cards** (3 cards in a row, flex)
   - Each: 20px/18px padding, border-radius 16px
   - Background: `rgba(8,10,18,0.82)`
   - Border: `rgba(255,255,255,0.08)`
   - `backdrop-filter: blur(32px)`
   - `box-shadow: 0 4px 24px rgba(0,0,0,0.35)`
   - Hover: border brightens to 0.14, bg to 0.88, shadow deepens
   - Icon: 32×32 rounded, colored bg (purple/warm/teal)
   - Title: 13px weight-500, 92% white
   - Description: 12px weight-300, 50% white
   - Cards content:
     - 🎙 "Voice & text" / "Talk or type. Sophia adapts her tone and pace to you, every time."
     - 🧠 "Real memory" / "Not summaries. Genuine continuity that builds session over session."
     - 📓 "Journal & recaps" / "Your conversations distill into a living journal you can revisit."
   - Fade-up animation: 1s ease, 0.9s delay

### Right Panel (centered)
**Sign-in card:**
- Max width: 400px
- Padding: 40px 32px 32px
- Border-radius: 24px
- Background: `rgba(8,10,18,0.84)`
- Border: `rgba(255,255,255,0.09)`
- `backdrop-filter: blur(48px)`
- Box shadow: `0 40px 100px rgba(0,0,0,0.55), 0 2px 16px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06)`
- Top hairline: `linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)` via `::before`
- Fade-up animation: 1.1s ease, 0.7s delay

Card contents:
1. **Sophia mark**: 56×56 rounded-16 icon with gradient + "S" letter + breathing glow ring (`::after` with 5s breathe animation)
2. **"Welcome back"** — Cormorant Garamond 28px weight-400
3. **"Sign in to pick up where you left off."** — 13px, text2 color
4. **Divider** — gradient hairline
5. **Google button** — full-width, 14px Inter weight-500, 16px/20px padding, border-radius 14px, bg `rgba(255,255,255,0.06)`, border `rgba(255,255,255,0.10)`. Hover: bg 0.10, border 0.18, translateY(-1px). Contains the standard Google "G" SVG (4-color paths).
6. **Footer** — 11px, text3 color, links to Terms/Privacy with subtle underline

### Animations
```css
@keyframes fadeIn    { from{opacity:0} to{opacity:1} }
@keyframes fadeUp    { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
@keyframes breathe   { 0%,100%{opacity:0.4;transform:scale(1)} 50%{opacity:0.7;transform:scale(1.08)} }
```
Respect `prefers-reduced-motion: reduce` — disable all animations.

### Responsive Breakpoints
- **< 960px:** Single column, centered text, logo becomes static (not absolute), capabilities wrap
- **< 600px:** Tighter padding, capabilities stack vertically, card padding reduces

---

## Integration Notes

### Auth Logic
Keep the existing auth logic from `AuthGate.tsx`:
- `useAuth()` hook for user/loading state
- `authBypassEnabled` dev bypass
- `handleGoogleLogin` via `authClient.signIn.social({provider:"google", callbackURL:"/"})`
- 5-second timeout fallback to unauthenticated
- Three states: checking → spinner, unauthenticated → show login, authenticated → render children

### React Implementation Tips

1. **Shader string:** Store the GLSL fragment shader as a template literal constant. Copy it exactly from the prototype.

2. **WebGL lifecycle:**
   ```tsx
   const canvasRef = useRef<HTMLCanvasElement>(null);
   useEffect(() => {
     const gl = canvasRef.current.getContext('webgl', {alpha:false, antialias:false});
     // compile, link, setup quad, start rAF loop
     // return cleanup: cancel rAF, delete program
   }, []);
   ```

3. **Canvas 2D lifecycle:** Same pattern, separate canvas ref. All classes (ShootingStar, Satellite, NightFlyer) as plain JS classes inside the effect or in a separate module.

4. **Cleanup:** Both `useEffect`s must cancel their `requestAnimationFrame` on unmount and remove resize listeners.

5. **Performance:** The shader is the heavy part. The DPR cap at 2 is essential — without it, 4K displays will struggle. The Canvas 2D overlay is lightweight.

6. **Font loading:** Use `next/font/google` for Cormorant Garamond and Inter to avoid FOUT.

7. **The Google button SVG** has 4 paths with exact fill colors for the Google "G": `#4285F4`, `#34A853`, `#FBBC05`, `#EA4335`.

8. **z-index stacking:** WebGL canvas z-0, Canvas2D z-1, UI z-10. All canvases `position:fixed; inset:0`.

---

## Verification Checklist

- [ ] WebGL canvas fills viewport, resizes correctly, DPR capped at 2
- [ ] Milky Way band visible as diagonal arc with warm core and dust lanes
- [ ] Stars twinkle with atmospheric scintillation (rapid shimmer on bright ones)
- [ ] Sky drifts imperceptibly (~0.0004 rad/s rotation)
- [ ] Horizon glow breathes subtly (~105s cycle)
- [ ] MW core pulses gently (~140s cycle)
- [ ] Faint aurora curtain visible in upper sky
- [ ] Horizon mist drifts slowly
- [ ] High-altitude cloud wisps drift in opposite directions
- [ ] 3 nebula hotspots pulse independently
- [ ] Shooting stars appear every 2-6s, mostly faint with rare bright ones
- [ ] Satellite crosses sky every 25-35s with tumbling flare
- [ ] Bat/bird silhouettes cross rarely (30-90s intervals)
- [ ] Dust motes drift upward with periodic wind gusts
- [ ] No mouse interaction whatsoever
- [ ] UI cards are readable against the sky (0.82-0.84 opacity backgrounds)
- [ ] All text has appropriate text-shadow for legibility
- [ ] Google sign-in button triggers auth flow
- [ ] Responsive at 960px and 600px breakpoints
- [ ] `prefers-reduced-motion` disables animations
- [ ] rAF loops clean up on unmount
