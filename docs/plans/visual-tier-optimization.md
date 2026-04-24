# Visual-tier system — investigation and optimization plan

**Scope:** [`useVisualTier`](frontend/src/app/hooks/useVisualTier.ts) and its consumers. Fact-based; every claim cites file:line.
**Trigger:** User report — "Low is still too heavy for some devices. Auto detect is not as smart, and on Journal / Low the water completely stops moving, which breaks the UI / clickability of the orbs."

---

## Decision requested

1. Approve the Journal Tier-1 bug fix (P0 — user-visible regression): keep a **slow animated loop on Tier 1** instead of a single static frame, and move `drawOverlay` before `updateMemoryUniforms` so the first frame has populated positions.
2. Approve the auto-detect hardening (P1): add `saveData` / connection heuristics, make phone-pinning survive phones that honestly claim high specs, and let the budget monitor **promote back up** when frames are healthy.
3. Approve the Tier-1 weight reductions (P2): shave shader branches and DPR further under `data-visual-tier="1"`.

All three are local-reversible front-end changes. No backend or contract surface touched.

---

## 1. Current system — facts

### 1.1 How the tier is decided
Source: [useVisualTier.ts](frontend/src/app/hooks/useVisualTier.ts).

- Three tiers: `1` (low), `2` (medium), `3` (full). Type at [line 27](frontend/src/app/hooks/useVisualTier.ts#L27).
- Preference values: `'auto' | 'full' | 'balanced' | 'low'`. Stored in `localStorage` key `sophia-visual-tier-pref` ([line 56](frontend/src/app/hooks/useVisualTier.ts#L56)).
- Static signals collected once ([detectStatic](frontend/src/app/hooks/useVisualTier.ts#L127)):
  `navigator.hardwareConcurrency`, viewport width (`<768` = narrow), `prefers-reduced-motion`, `pointer: coarse`, `hover: none`, UA mobile regex, `navigator.deviceMemory`, WebGL `UNMASKED_RENDERER_WEBGL`, `devicePixelRatio`.
- Phone detection ([line 144–148](frontend/src/app/hooks/useVisualTier.ts#L144)): UA mobile **OR** ≥2 of (narrow, coarse pointer, no hover).
- Scoring ([computeTierFromSignals](frontend/src/app/hooks/useVisualTier.ts#L155)):
  - reduced-motion → **always tier 1**
  - phone → **always tier 1** in auto mode
  - `gpuTier === 'low'` (software raster, llvmpipe, swiftshader) → **tier 1**
  - Otherwise a weighted score: cores (+3/+1), GPU (+3/+1), narrow (−2), low memory (−2), unknown-GPU-on-narrow (−1). `≥5` → tier 3, `≥2` → tier 2, else tier 1.
- Runtime monitor ([useFrameBudgetMonitor](frontend/src/app/hooks/useVisualTier.ts#L244)):
  22 ms frame budget (~45 fps). Window = 90 frames desktop, 60 frames phone. Over-budget ratio ≥ 30% (22% phone) → degrade one step. Up to `MAX_DEGRADE_STEPS = 2` ([line 62](frontend/src/app/hooks/useVisualTier.ts#L62)).
- `dprCap` ([line 358](frontend/src/app/hooks/useVisualTier.ts#L358)):
  - tier 3: `min(dpr, 2)`
  - tier 2: `min(dpr, phone ? 1.25 : 1.5)`
  - tier 1: `phone && autoDegraded≥2 ? 0.75, else phone ? 1, else 1`
- Output: sets `html[data-visual-tier="1|2|3"]` via [VisualTierBootstrap](frontend/src/app/VisualTierBootstrap.tsx).

### 1.2 What consumes the tier
Global CSS adaptations for Tier 1/2 are in [globals.css](frontend/src/app/globals.css#L1787) (removes blur/glass effects, disables embrace-pulse/breathe animations under Tier 2, hard-nulls backdrops under Tier 1).
Journal has its own overrides at [journal.module.css L1826–1884](frontend/src/app/journal/journal.module.css#L1826).
Component-level: [JournalPageClient.tsx L541](frontend/src/app/journal/JournalPageClient.tsx#L541) reads the tier, caps constellation entries ([L557](frontend/src/app/journal/JournalPageClient.tsx#L557): 14 / 24 / 36), caps comets inside the animation loop ([L1733](frontend/src/app/journal/JournalPageClient.tsx#L1733): 0 / 2 / full).

### 1.3 Current Tier-1 behavior on the Journal (the "water stops" report)
[JournalPageClient.tsx L1723–1792](frontend/src/app/journal/JournalPageClient.tsx#L1723):

```ts
let staticMode = false
function renderFrame(now) { ... if (!staticMode) animationFrame = requestAnimationFrame(renderFrame) }
...
if (prefersReducedMotion || tierRef.current === 1) {
  staticMode = true
  staticSceneRenderRef.current = () => renderFrame(performance.now())
  renderFrame(performance.now())          // ← fires exactly once
} else {
  animationFrame = requestAnimationFrame(renderFrame)
}
```

The re-render driver ([L1794–1800](frontend/src/app/journal/JournalPageClient.tsx#L1794)) only re-runs `renderFrame` when `[constellationEntries, hoveredId, prefersReducedMotion, selectedId, showInteractiveScene, visualTier]` changes. **Pointer moves do NOT update it**, so the water shader uniforms (`uTime`, `uMouse`) are frozen at the single mount-time value — this is literally why the water doesn't move on Low. That part matches the report.

### 1.4 Why orbs feel "unclickable" on Tier-1 Journal — two concrete defects

**Defect A — one-frame lag writes empty uniforms on the only static frame.**
Inside `renderFrame` the call order is ([L1737–1757](frontend/src/app/journal/JournalPageClient.tsx#L1737)):

```
updateMemoryUniforms()   // reads positionsRef.current (filters by `.visible`)
…shader draw…            // uses memUniformData
drawOverlay(time)        // writes positionsRef.current at L1302
```

`positionsRef.current` is written at the **end** of `drawOverlay` ([L1302](frontend/src/app/journal/JournalPageClient.tsx#L1302)) but is **read at the start** of `updateMemoryUniforms` ([L1242](frontend/src/app/journal/JournalPageClient.tsx#L1242): `.filter((entry) => positionsRef.current[entry.id]?.visible)`). In the running rAF loop this is an invisible 16 ms lag; in static mode the very first frame reads an empty map, so the shader's memory-orb lighting is initialized to zero and never updated until a state change fires the re-render effect.

**Defect B — the static re-render misses pointer-induced events.**
The hit-canvas handlers ([L1803–1869](frontend/src/app/journal/JournalPageClient.tsx#L1803)) do hit-test against `positionsRef.current`, so a click itself can land. But when the user moves the pointer over an orb, the pool shader's `uMouse`-dependent caustics / interactive halo never updates, so the orb has no visual affordance (no hover glow under water, no cursor feedback beyond the CSS cursor change on the hit canvas). This reads as "orbs aren't clickable" even when clicks technically register. Combined with Defect A's dark-orb state on first paint, the UI is effectively dead on Low.

**Defect C — auto-degrade into Tier 1 does not enter static mode.**
The main WebGL `useEffect` depends on `[showInteractiveScene, prefersReducedMotion]` only ([L1792](frontend/src/app/journal/JournalPageClient.tsx#L1792)). If a user starts at Tier 3 and is auto-degraded to Tier 1 at runtime, the effect does NOT re-run, so the rAF loop keeps running at Tier 1 — opposite problem from the preference-set case: the heavy shader keeps burning a phone that just declared it can't keep up. Dropping `visualTier` from the deps was intentional (don't tear down the shader mid-session), but the downstream accounting is missing: the rAF path does not honor the auto-degrade signal the way the mount path honors `tierRef.current === 1`.

### 1.5 Auto-detect — concrete weaknesses

- **No network / data-saver signal.** `navigator.connection.saveData` and `effectiveType` are available on most target browsers. Currently ignored. A user on a metered connection or explicit data-saver almost certainly wants Tier 1.
- **No battery / power-mode signal.** iOS Low Power Mode is visible through `prefers-reduced-motion` only when the user has explicitly opted in, not from Low Power Mode alone on recent Safari. Android exposes it inconsistently.
- **Phones-are-always-Tier-1 is too blunt at the other end.** Modern iPhones (A17/A18) and Snapdragon 8 Gen 3+ devices can comfortably run Tier 2. The current guard locks them to Tier 1 forever in auto; the only escape is user preference. The frame-budget monitor runs *only* at tiers ≥ 2 until a degrade happens, so it can never *promote* a phone back up.
- **No upgrade path.** `autoDegradeSteps` is monotonic — once degraded, you stay degraded for the whole tab session. A brief GC pause can cost a 60-frame window permanently.
- **GPU regex is stale.** The mid-tier list (`intel.*hd|uhd|iris|mali-[gt]|adreno [1-5]\d\d`) miscategorizes modern Apple Silicon iGPU strings that render through ANGLE on Windows (regex doesn't match `ANGLE (Apple, ANGLE Metal Renderer: Apple M…)`). The `apple\s?m[1-9]` branch catches it anyway because it's checked first, but the Windows-ANGLE path around Intel Arc and AMD RX 7000-series iGPUs falls into the "mid" bucket.
- **Reduced-motion is irreversible.** `computeTierFromSignals` has an early-return for reduced-motion; if the user toggles it off mid-session, the listener re-runs [`detectStatic`](frontend/src/app/hooks/useVisualTier.ts#L388) which re-evaluates, so this one is actually OK — noted for completeness.

### 1.6 Tier-1 weight — where it still costs too much

- **Fragment shader is the same on all tiers.** [journalPoolShaders.ts](frontend/src/app/journal/journalPoolShaders.ts) has no `#ifdef` tier branches; Tier 1 runs the full water + caustics + memory-light code path, only driven with fewer uniforms and a lower DPR. On integrated mobile GPUs fragment cost, not fill rate, is the bottleneck.
- **DPR cap 1.0 is still too high for many phones.** Older iPhones SE / budget Androids at native DPR ≥ 3 render 1× the physical viewport, which at 1080p-equivalent means ~2 Mpx of expensive per-pixel work even at Tier 1. Under `autoDegraded≥2` the cap drops to 0.75, but that requires two full degrade cycles (~2 × 60 frames of sustained jank).
- **`html[data-visual-tier="1"]` has no rule for `will-change` / `transform` cleanup.** Elements that declare `will-change: transform, opacity` stay GPU-promoted even when animations are disabled at Tier 1, eating VRAM.
- **Journal constellation renders 14 entries on Tier 1** ([L557](frontend/src/app/journal/JournalPageClient.tsx#L557)) with the full-resolution fragment shader — each entry adds a `mem` uniform the shader samples in a loop.
- **`animate-embrace-*` and `animate-borderStreak` are killed on Tier 2 but not verified for every page at Tier 1.** [globals.css L1817–1830](frontend/src/app/globals.css#L1817) disables them under `data-visual-tier="2"` but the Tier-1 block at L1834 only removes glass fallbacks, not the pulse/breathe family — dead code on low-end devices.

---

## 2. Proposed changes

### 2.1 P0 — Fix Journal Tier-1 (user-visible)

**a. Reorder `renderFrame`.** Move `drawOverlay(time)` **before** `updateMemoryUniforms()` so `positionsRef.current` is populated before the shader uniforms are assembled. This is a one-line move with zero behavior change at Tier 2/3 (other than a 16 ms lag being eliminated, which is a bonus).
File: [JournalPageClient.tsx L1737–1757](frontend/src/app/journal/JournalPageClient.tsx#L1737).

**b. Replace Tier-1 static mode with a throttled loop.** Instead of rendering exactly once, run `renderFrame` at a target ~12 fps (83 ms interval) using rAF with a delta gate:

```ts
const TIER1_INTERVAL_MS = 83      // ≈ 12 fps
let lastTierOneRender = 0
function renderFrame(now) {
  if (tierRef.current === 1 && !prefersReducedMotion) {
    if (now - lastTierOneRender < TIER1_INTERVAL_MS) {
      animationFrame = requestAnimationFrame(renderFrame)
      return
    }
    lastTierOneRender = now
  }
  …existing body…
  if (!staticMode) animationFrame = requestAnimationFrame(renderFrame)
}
```

Keep `staticMode = true` only when `prefersReducedMotion === true` (accessibility intent), not when Tier === 1 (performance intent). Rationale: 12 fps is enough for the water to visibly flow and for `uMouse` caustics to track the pointer, while costing ~5× less GPU than 60 fps. 12 fps × reduced DPR × reduced orb count is cheaper than today's full 60-fps Tier-2 path.

**c. Make auto-degrade into Tier 1 follow the same path.** Add `visualTier` to the main effect's deps **but** short-circuit the teardown: store the previous tier in a ref and, if only the tier changed (not `showInteractiveScene` / `prefersReducedMotion`), skip the full resize/re-init and just update `tierRef.current` + set the throttled-loop flag. This keeps the context alive but respects the new budget.

**d. Draw a tier-1 fallback on the hit canvas.** Tiny (2 ms) canvas pass that paints a 2 px ring around each `positionsRef` orb with `stroke: rgba(255,255,255,0.25)` on pointer hover. Costs almost nothing and restores the "I can see it's clickable" affordance when the pool shader isn't animating.

### 2.2 P1 — Smarter auto-detect

**a. Add network heuristic.** In `detectStatic`:

```ts
const conn = (navigator as any).connection
const saveData = conn?.saveData === true
const slowNet = conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g' || conn?.effectiveType === '3g'
```
Add `-2` to score if `saveData`, `-1` if `slowNet`.

**b. Soft phone pin.** Replace the hard `isPhone → 1` return with a penalty: `isPhone` contributes `-2` to score. Give phones with ≥ 8 cores AND `gpuTier === 'high'` a chance at Tier 2. Keep the frame-budget monitor tight so a phone that lied about its specs degrades in ≤ 1 s.

**c. Bidirectional frame-budget monitor.** Extend the monitor to track *under-budget* frames too. After 3 × window-length of clean frames at the current tier below 3, promote +1 step. Reset `autoDegradeSteps` accordingly. Cap promotions at the static tier so we never exceed what the device was initially scored for. Add a 5-second cooldown between transitions to prevent thrash.

**d. Widen GPU regex.** Match `ANGLE` Windows strings explicitly:
- add `swiftshader|llvmpipe|google (swiftshader)` to 'low'
- add `intel\s?arc|adreno\s?[67]\d\d|mali-g[67]\d\d` to 'high'
- mid-tier list already covers older Adreno/Mali correctly.

**e. Persist runtime promotions/degrades across reloads** in a second storage key `sophia-visual-tier-runtime` with a 24 h TTL, so a device known to stutter doesn't re-test the full shader on every page load.

### 2.3 P2 — Tier-1 weight reduction

**a. Add a `#define LOW_TIER` path to the pool fragment shader.** Gate caustics, memory-light loop size (reduce `MAX_SHADER_MEMORIES` to 6 at Tier 1), and skip the secondary wave sum at [journalPoolShaders.ts L429](frontend/src/app/journal/journalPoolShaders.ts#L429). Provide the define via a shader-source prefix chosen at program-link time based on `tierRef.current`. (Note: this means re-linking if tier changes mid-session — fine; it only happens on auto-degrade into 1.)

**b. Cap Tier-1 DPR at 0.75 by default on phones** (not only after `autoDegradeSteps ≥ 2`). Quality loss is minor at phone pixel density; saving is linear in pixel count.

**c. Kill `will-change` on `html[data-visual-tier="1"]`.** One global rule:
```css
html[data-visual-tier="1"] * { will-change: auto !important; }
```
Frees VRAM on low-memory devices (we already score them down, so they are disproportionately likely to end up at Tier 1).

**d. Cap Journal constellation to 10 entries on Tier 1** (down from 14). The shader loop is the hottest path on mobile; fewer entries = fewer sampler reads per pixel.

**e. Extend Tier-2 `animate-embrace-*` disable to Tier 1.** Fold the Tier-2 rule at [globals.css L1817–1830](frontend/src/app/globals.css#L1817) into a combined `html[data-visual-tier="1"], html[data-visual-tier="2"]` selector so Tier-1 devices also stop the pulse animations (currently Tier 1 is a superset of Tier 2's *visual* constraints but the animation-kill rule isn't inherited).

---

## 3. Success signals

| Change | Signal | How to verify |
|---|---|---|
| P0a reorder | Orb lighting present on first Tier-1 frame | Visual check + no empty-uniform branch in one devtools frame capture |
| P0b throttled loop | Water visibly moves on Tier-1 Journal; pointer hover affects caustics | Visual check on pref=low |
| P0c auto-degrade path | Phone degraded from T3→T1 mid-session switches to throttled loop | Force-degrade via devtools CPU throttling; inspect `animationFrame` cadence |
| P0d hover ring | Hovered orb shows a 2 px ring even when shader is between throttled frames | Pointer test on pref=low |
| P1a network heuristic | `saveData=true` in devtools drops tier | Devtools Network → Throttling → custom `saveData` on; reload |
| P1b soft phone pin | 8-core phone with `apple m` or `adreno 7xx` GPU → Tier 2 in auto | UA spoof + GPU string override |
| P1c bidirectional monitor | Phone held at 60 fps 3 windows in a row promotes to Tier 2 | Console-log transitions in dev build |
| P2a shader gate | Tier-1 fragment shader compile output shorter than Tier-3 | Log `gl.getShaderSource(fs)` length |
| P2b DPR cap 0.75 | Phone at DPR 3 → canvas backing store sized to 0.75× CSS px | Inspect `poolCanvas.width` |
| P2e combined animate-disable | Tier-1 has no running `animate-embrace-*` | DevTools Animations panel |

---

## 4. Can be decided now vs. later

**Now (low risk, local, reversible):**
- P0a reorder (one-line move)
- P0d hover ring (new paint, pure-additive)
- P1a network heuristic (additive score input)
- P1d GPU regex widening (additive classification)
- P2c `will-change: auto` CSS
- P2e merge Tier-1 into the embrace-disable selector
- P2d cap constellation to 10 on Tier 1

**After a round of device testing (Davide or field testers):**
- P0b throttled loop (need to pick the fps target empirically — 12 fps is a starting guess)
- P0c auto-degrade-to-throttled path
- P1b soft phone pin (risk: regression on weaker phones)
- P1c bidirectional monitor (risk: thrash)
- P2a shader `#define` (compile-time risk, biggest payoff)
- P2b default-0.75 DPR on phones (visual quality trade-off)

---

## 5. Why this order

- P0 fixes a user-visible broken state before doing any tuning. No amount of better auto-detect matters while Low is visibly dead.
- P1 makes the system decide correctly *before* we make Low lighter. If we shave Tier 1 first, we shift the "wrong tier" cost rather than eliminating it.
- P2 reduces load only after (a) the Tier-1 behavior is animated (so visual shortcuts become visible and testable), and (b) we can measure the shave against a monitor that can also promote back up.

---

## 6. Confidence levels

| Claim | Confidence |
|---|---|
| Tier-1 Journal runs exactly one shader frame today | **High** — [L1773–1775](frontend/src/app/journal/JournalPageClient.tsx#L1773) |
| One-frame lag reads empty `positionsRef` on first static frame | **High** — [L1242](frontend/src/app/journal/JournalPageClient.tsx#L1242) vs [L1302](frontend/src/app/journal/JournalPageClient.tsx#L1302) |
| Auto-degrade into Tier 1 does not enter static mode | **High** — [L1792](frontend/src/app/journal/JournalPageClient.tsx#L1792) deps list |
| Click events technically fire on hit canvas even at Tier 1 | **High** — [L1803–1869](frontend/src/app/journal/JournalPageClient.tsx#L1803) |
| Users perceive Tier-1 Journal as "unclickable" | **Medium** — inferred from report + Defects A/B; a live repro is the only way to confirm which of the two dominates |
| 12 fps is the right throttle target | **Low** — starting guess; needs field measurement |
| Widened GPU regex correctly categorizes Windows ANGLE strings | **Medium** — based on reading known strings; some mobile OEMs ship odd renderer names |
| Bidirectional promotion won't thrash | **Medium** — depends on cooldown tuning |

---

## 7. Out of scope

- Voice / backend changes. This memo is front-end only.
- `DashboardWaterBed` ([file](frontend/src/app/components/dashboard/DashboardWaterBed.tsx)) — same family of concerns but separate component; a second pass should audit it after Journal is green.
- Service-worker-level asset gating by tier. Cleaner, but a separate project.
