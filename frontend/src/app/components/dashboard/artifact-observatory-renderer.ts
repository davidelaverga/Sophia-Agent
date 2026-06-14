'use client';

const VERT = "#version 300 es\nin vec2 a_position;\nout vec2 v_uv;\nvoid main() {\n  v_uv = a_position * 0.5 + 0.5;\n  gl_Position = vec4(a_position, 0.0, 1.0);\n}";

const SCENE = "#version 300 es\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\n\nuniform vec2 u_resolution;\nuniform float u_time;\nuniform vec2 u_mouse;\nuniform vec2 u_target;\nuniform vec3 u_accent;\n\nfloat hash12(vec2 p) {\n  vec3 p3 = fract(vec3(p.xyx) * 0.1031);\n  p3 += dot(p3, p3.yzx + 33.33);\n  return fract((p3.x + p3.y) * p3.z);\n}\n\nvec2 hash22(vec2 p) {\n  float n = hash12(p);\n  return vec2(n, hash12(p + n + 19.19));\n}\n\nfloat noise(vec2 p) {\n  vec2 i = floor(p);\n  vec2 f = fract(p);\n  vec2 u = f * f * (3.0 - 2.0 * f);\n  float a = hash12(i);\n  float b = hash12(i + vec2(1.0, 0.0));\n  float c = hash12(i + vec2(0.0, 1.0));\n  float d = hash12(i + vec2(1.0, 1.0));\n  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);\n}\n\nfloat fbm(vec2 p) {\n  float v = 0.0;\n  float a = 0.5;\n  mat2 m = mat2(1.62, -1.18, 1.18, 1.62);\n  for (int i = 0; i < 4; i++) {\n    v += a * noise(p);\n    p = m * p + 17.7;\n    a *= 0.52;\n  }\n  return v;\n}\n\nfloat sdCapsule(vec2 p, vec2 a, vec2 b, float r) {\n  vec2 pa = p - a;\n  vec2 ba = b - a;\n  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);\n  return length(pa - ba * h) - r;\n}\n\nfloat sdEllipse(vec2 p, vec2 c, vec2 r) {\n  vec2 q = (p - c) / r;\n  return length(q) - 1.0;\n}\n\nfloat sdBox(vec2 p, vec2 c, vec2 b) {\n  vec2 q = abs(p - c) - b;\n  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);\n}\n\nfloat lineDist(vec2 p, vec2 a, vec2 b) {\n  vec2 pa = p - a;\n  vec2 ba = b - a;\n  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);\n  return length(pa - ba * h);\n}\n\nfloat lineAlong(vec2 p, vec2 a, vec2 b) {\n  vec2 pa = p - a;\n  vec2 ba = b - a;\n  return clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);\n}\n\nvoid over(inout vec3 col, vec3 paint, float alpha) {\n  col = mix(col, paint, clamp(alpha, 0.0, 1.0));\n}\n\nvec2 rotate2(vec2 p, float a) {\n  float c = cos(a);\n  float s = sin(a);\n  return mat2(c, -s, s, c) * p;\n}\n\nvec3 starCells(vec2 uv, float scale, float cutoff, float sizeMul, float speed) {\n  vec2 gv = uv * scale;\n  vec2 id = floor(gv);\n  vec2 f = fract(gv);\n  vec2 rnd = hash22(id);\n  vec2 pos = 0.5 + (rnd - 0.5) * 0.78;\n  float d = length(f - pos);\n  float seed = hash12(id + 4.73);\n  float presence = smoothstep(cutoff, 1.0, seed);\n  float size = mix(0.012, 0.050, pow(hash12(id + 8.4), 4.0)) * sizeMul;\n  float core = (1.0 - smoothstep(0.0, size, d)) * presence;\n  float halo = (1.0 - smoothstep(size * 2.0, size * 8.0, d)) * presence * 0.22;\n  float blink = 0.76 + 0.24 * sin(u_time * speed + seed * 60.0);\n  vec3 tint = mix(vec3(0.60, 0.74, 1.0), vec3(1.0, 0.78, 0.55), hash12(id + 11.0));\n  return tint * (core * 3.5 + halo) * blink;\n}\n\nvec3 pinStarField(vec2 uv, float scale, float cutoff, float sharpness, float gain) {\n  vec2 gv = uv * scale;\n  vec2 id = floor(gv);\n  vec2 f = fract(gv);\n  vec2 pos = hash22(id);\n  float seed = hash12(id + 41.3);\n  float presence = smoothstep(cutoff, 1.0, seed);\n  float d = length(f - pos);\n  float size = mix(0.0026, 0.012, pow(hash12(id + 17.0), 5.6));\n  float core = exp(-pow(d / max(size, 0.0006), sharpness)) * presence;\n  float glintX = exp(-abs(f.x - pos.x) * 360.0) * exp(-abs(f.y - pos.y) * 36.0);\n  float glintY = exp(-abs(f.y - pos.y) * 360.0) * exp(-abs(f.x - pos.x) * 36.0);\n  vec3 cold = vec3(0.68, 0.78, 1.0);\n  vec3 warm = vec3(1.0, 0.82, 0.58);\n  vec3 tint = mix(cold, warm, hash12(id + 9.2));\n  return tint * (core * gain + (glintX + glintY) * presence * gain * 0.020);\n}\n\nfloat mountainProfile(float x) {\n  float base = -0.945;\n  float broad = exp(-pow((x - 0.02) / 0.43, 2.0)) * 0.330;\n  float crown = exp(-pow((x - 0.02) / 0.18, 2.0)) * 0.055;\n  float left = exp(-pow((x + 0.54) / 0.28, 2.0)) * 0.050;\n  float right = exp(-pow((x - 0.56) / 0.34, 2.0)) * 0.056;\n  float noiseA = fbm(vec2(x * 1.4 + 20.0, 3.0)) * 0.036;\n  float noiseB = noise(vec2(x * 7.0 + 11.0, 2.4)) * 0.016;\n  float fine = noise(vec2(x * 18.0 + 9.0, 7.0)) * 0.006;\n  return base + broad + crown + left + right + noiseA + noiseB + fine;\n}\n\nfloat groundProfile(float x) {\n  return -1.08 + fbm(vec2(x * 2.0 + 8.0, 0.5)) * 0.045 + noise(vec2(x * 9.0, 4.0)) * 0.012;\n}\n\nfloat waterProfile(float x) {\n  float longWave = sin(x * 2.3 + u_time * 0.09) * 0.010;\n  float crossWave = sin(x * 7.2 - u_time * 0.16) * 0.004;\n  return -0.745 + longWave + crossWave + fbm(vec2(x * 1.8 + 12.0, u_time * 0.018)) * 0.010;\n}\n\nfloat islandMask(vec2 p) {\n  float water = waterProfile(p.x);\n  float depth = clamp((water + 0.08 - p.y) / 0.25, 0.0, 1.0);\n  float width = mix(0.22, 0.66, depth);\n  float coastNoise = (noise(vec2(p.y * 13.0 + 4.0, p.x * 4.5)) - 0.5) * 0.042;\n  return 1.0 - smoothstep(width - 0.06 + coastNoise, width + 0.10 + coastNoise, abs(p.x));\n}\n\nfloat waterCaustic(vec2 q) {\n  float c = 0.0;\n  c += pow(abs(sin(q.x * 18.0 + sin(q.y * 7.0 + u_time * 0.34) * 1.7)), 18.0);\n  c += pow(abs(sin(q.y * 23.0 - q.x * 5.0 + u_time * 0.44)), 22.0) * 0.72;\n  c += pow(abs(sin((q.x + q.y) * 16.0 + u_time * 0.30)), 20.0) * 0.52;\n  return c / 2.24;\n}\n\nfloat cometShape(vec2 uv, vec2 head, vec2 dir, float lengthScale, float widthScale, float phase) {\n  dir = normalize(dir);\n  vec2 n = vec2(-dir.y, dir.x);\n  vec2 q = uv - head;\n  float along = dot(q, dir);\n  float across = abs(dot(q, n));\n  float trail = clamp(-along / lengthScale, 0.0, 1.0);\n  float gate = smoothstep(0.0, 0.018, -along) * (1.0 - smoothstep(lengthScale * 0.78, lengthScale, -along));\n  float width = widthScale * (0.46 + trail * 4.8);\n  float turbulentWidth = 1.0 + fbm(vec2(trail * 18.0 + phase * 3.7, across * 95.0 - u_time * 0.22)) * 0.62;\n  float tail = exp(-pow(across / max(width * turbulentWidth, 0.0008), 1.42)) * exp(-trail * 2.55) * gate;\n  float core = exp(-length(q / vec2(widthScale * 1.05, widthScale * 0.82)) * 20.0);\n  float shock = exp(-length(q / vec2(widthScale * 4.6, widthScale * 2.6)) * 4.3);\n  float sparks = smoothstep(0.982, 1.0, noise(vec2(uv.x * 420.0 + phase * 17.0 - u_time * 0.7, uv.y * 260.0 + trail * 19.0))) * tail;\n  return tail * 0.76 + core * 1.7 + shock * 0.22 + sparks * 0.20;\n}\n\nvec3 renderComets(vec2 uv, float intensity) {\n  float passA = fract(u_time * 0.074 + 0.18);\n  float passB = fract(u_time * 0.058 + 0.53);\n  float passC = fract(u_time * 0.045 + 0.82);\n\n  vec2 headA = vec2(-0.24 + passA * 1.52, 0.84 - passA * 0.24 + sin(passA * 6.283) * 0.020);\n  vec2 dirA = normalize(vec2(1.0, -0.18));\n  float fadeA = smoothstep(0.05, 0.20, passA) * (1.0 - smoothstep(0.78, 0.96, passA));\n  vec3 cometA = mix(vec3(0.65, 0.92, 0.95), vec3(0.92, 0.83, 1.0), 0.55) * cometShape(uv, headA, dirA, 0.46, 0.0066, passA) * fadeA;\n\n  vec2 headB = vec2(-0.18 + passB * 1.44, 0.72 - passB * 0.20 + sin(passB * 9.0) * 0.014);\n  vec2 dirB = normalize(vec2(1.0, -0.14));\n  float fadeB = smoothstep(0.08, 0.24, passB) * (1.0 - smoothstep(0.72, 0.94, passB));\n  vec3 cometB = mix(vec3(0.92, 0.56, 0.30), vec3(0.72, 0.74, 1.0), 0.42) * cometShape(uv, headB, dirB, 0.36, 0.0048, passB + 1.7) * fadeB * 0.72;\n\n  vec2 headC = vec2(-0.20 + passC * 1.34, 0.50 - passC * 0.12 + sin(passC * 7.0) * 0.018);\n  vec2 dirC = normalize(vec2(1.0, -0.09));\n  float fadeC = smoothstep(0.04, 0.22, passC) * (1.0 - smoothstep(0.76, 0.98, passC));\n  vec3 cometC = mix(vec3(0.42, 0.70, 0.78), vec3(0.88, 0.70, 1.0), 0.35) * cometShape(uv, headC, dirC, 0.30, 0.0038, passC + 3.2) * fadeC * 0.38;\n\n  return (cometA + cometB + cometC) * intensity;\n}\n\nvec2 telescopeBase() {\n  float x = 0.02;\n  return vec2(x, mountainProfile(x) + 0.040);\n}\n\nvec3 renderSky(vec2 uv, vec2 p) {\n  vec3 col = vec3(0.00065, 0.00070, 0.0032);\n  float top = smoothstep(0.02, 1.0, uv.y);\n  float horizon = smoothstep(0.18, 0.42, uv.y) * smoothstep(0.80, 0.42, uv.y);\n  col += vec3(0.003, 0.004, 0.012) * pow(top, 1.7);\n  col += vec3(0.018, 0.011, 0.028) * horizon * 0.38;\n\n  vec2 galaxyOrigin = vec2(0.57, 0.64);\n  vec2 galaxyUv = rotate2(uv - galaxyOrigin, -0.18 + sin(u_time * 0.010) * 0.022) + galaxyOrigin;\n  vec2 driftUv = galaxyUv + vec2(u_time * 0.0014, -u_time * 0.00055);\n  vec2 counterDriftUv = galaxyUv + vec2(-u_time * 0.00082, u_time * 0.00036);\n  float gravityWell = exp(-length((uv - vec2(0.55, 0.61)) / vec2(0.22, 0.16)) * 2.4);\n  float bandCenter = 1.00 - galaxyUv.x * 0.43 + 0.040 * sin(galaxyUv.x * 6.0 + u_time * 0.038) + gravityWell * 0.045;\n  float bandDist = abs(uv.y - bandCenter);\n  float band = smoothstep(0.50, 0.018, bandDist) * smoothstep(0.20, 0.42, uv.y);\n  float core = smoothstep(0.155, 0.000, bandDist) * exp(-pow((galaxyUv.x - 0.58) / 0.34, 2.0));\n  float dust = fbm(driftUv * 5.8 + vec2(1.7, 9.2));\n  float dustFine = fbm(counterDriftUv * 15.0 + vec2(8.0, 2.0));\n  float dustUltra = noise(driftUv * 58.0 + vec2(4.0, 9.0));\n  float dustNeedle = noise(counterDriftUv * 124.0 + vec2(11.0, 1.0));\n  float rift = fbm(counterDriftUv * 8.6 + vec2(4.5, 1.5));\n  float rift2 = fbm(driftUv * 22.0 + vec2(1.0, 5.2));\n  float riftNeedle = smoothstep(0.56, 0.82, noise(driftUv * 86.0 + vec2(6.0, 13.0)));\n  float absorption = smoothstep(0.48, 0.72, rift) * 0.54 + smoothstep(0.52, 0.72, rift2) * 0.31 + riftNeedle * 0.16;\n  vec3 mwOuter = vec3(0.018, 0.025, 0.074);\n  vec3 mwMid = vec3(0.082, 0.060, 0.145);\n  vec3 mwWarm = vec3(0.190, 0.105, 0.060);\n  vec3 mwRose = vec3(0.145, 0.048, 0.112);\n  vec3 mw = mix(mwOuter, mwMid, smoothstep(0.22, 0.0, bandDist));\n  mw = mix(mw, mwWarm, core * 0.52);\n  mw = mix(mw, mwRose, core * dustFine * 0.34);\n  float cloudDensity = band * (pow(dust, 1.42) * 0.64 + pow(dustFine, 1.90) * 0.34 + dustUltra * 0.055);\n  col += mw * cloudDensity * (2.14 - absorption * 0.70);\n  col += vec3(0.030, 0.036, 0.092) * band * pow(dustFine, 2.15) * 0.54;\n  float stellarKnots = band * smoothstep(0.70, 0.95, dustFine) * smoothstep(0.52, 0.90, dustUltra);\n  float emberKnots = core * smoothstep(0.66, 0.96, dustNeedle) * smoothstep(0.50, 0.92, dustFine);\n  float darkFilaments = band * (smoothstep(0.54, 0.86, rift2) + riftNeedle * 0.62) * smoothstep(0.31, 0.016, bandDist);\n  col += vec3(0.34, 0.23, 0.14) * stellarKnots * 0.125;\n  col += vec3(0.50, 0.24, 0.16) * emberKnots * 0.095;\n  col *= 1.0 - darkFilaments * 0.112;\n  col *= 1.0 - band * absorption * 0.22;\n  col += vec3(0.25, 0.18, 0.12) * core * pow(dust, 1.65) * 0.25;\n  col += vec3(0.08, 0.07, 0.16) * gravityWell * band * (0.12 + dustFine * 0.18);\n\n  float auroraY = smoothstep(0.42, 0.62, uv.y) * smoothstep(0.84, 0.58, uv.y);\n  float wave = sin(p.x * 5.4 + fbm(vec2(p.x * 2.0 + u_time * 0.025, 5.0)) * 3.0 + u_time * 0.045);\n  float curtain = auroraY * smoothstep(0.42, 0.94, wave * 0.5 + 0.5);\n  col += vec3(0.008, 0.030, 0.020) * curtain * 0.18;\n  col += vec3(0.022, 0.010, 0.032) * curtain * smoothstep(0.54, 0.70, uv.y) * 0.12;\n\n  col += starCells(uv, 42.0, 0.976, 1.14, 1.2) * (0.78 + band * 0.46);\n  col += starCells(uv + vec2(0.0, 0.02), 112.0, 0.988, 0.72, 1.7) * (0.62 + band * 0.28);\n  col += starCells(uv - vec2(0.02, 0.01), 205.0, 0.993, 0.42, 2.4) * (0.42 + band * 0.18);\n  col += pinStarField(uv + vec2(0.012, 0.003), 310.0, 0.9950, 2.6, 0.72) * (0.34 + band * 0.38);\n  col += pinStarField(uv - vec2(0.031, 0.018), 560.0, 0.9980, 2.5, 0.48) * (0.22 + band * 0.24);\n\n  float heroA = exp(-length(p - vec2(-0.72, 0.36)) * 64.0);\n  float heroB = exp(-length(p - vec2(0.84, 0.62)) * 76.0);\n  float crossA = exp(-abs(p.y - 0.36) * 520.0) * exp(-abs(p.x + 0.72) * 32.0);\n  float crossB = exp(-abs(p.x - 0.84) * 520.0) * exp(-abs(p.y - 0.62) * 34.0);\n  col += vec3(0.82, 0.80, 1.0) * heroA * 0.16 + vec3(1.0, 0.84, 0.62) * heroB * 0.13;\n  col += vec3(0.82, 0.80, 1.0) * crossA * 0.032 + vec3(1.0, 0.84, 0.62) * crossB * 0.030;\n  col += renderComets(uv, 0.95);\n\n  float empty = smoothstep(0.08, 0.82, length(p - vec2(-0.06, 0.04)));\n  col *= mix(0.78, 1.0, empty);\n  return col;\n}\n\nvoid drawVolumetrics(inout vec3 col, vec2 p, vec2 target, vec2 source) {\n  vec2 beam = target - source;\n  vec2 dir = normalize(beam);\n  vec2 normal = vec2(-dir.y, dir.x);\n  float d = lineDist(p, source, target);\n  float along = lineAlong(p, source, target);\n  float mountain = mountainProfile(p.x);\n  float skyMask = smoothstep(mountain + 0.003, mountain + 0.054, p.y);\n  float lift = smoothstep(0.0, 0.10, along) * smoothstep(1.0, 0.08, along);\n  float width = mix(0.010, 0.082, pow(along, 0.72));\n  float tightWidth = mix(0.0045, 0.015, pow(along, 0.82));\n  float fog = fbm(p * 6.2 + vec2(u_time * 0.024, -u_time * 0.014));\n  float fineFog = fbm(p * 18.0 + dir * u_time * 0.085 + vec2(3.0, 9.0));\n  float beamCurrent = fbm(vec2(along * 18.0 - u_time * 0.62, d * 34.0 + fineFog * 2.2));\n  float ribbing = 0.58 + 0.42 * sin(dot(p - source, normal) * 118.0 + along * 52.0 + u_time * 1.35 + beamCurrent * 2.4);\n  float pulse = 0.78 + 0.22 * sin(u_time * 1.12 + along * 10.0 + fog * 4.0);\n  float filament = mix(0.50, 1.22, smoothstep(0.28, 0.86, beamCurrent)) * ribbing * pulse;\n  float brokenAir = mix(fog, fineFog, 0.42) * filament;\n  float body = exp(-pow(d / max(width, 0.0001), 1.72)) * lift * skyMask;\n  float core = exp(-pow(d / max(tightWidth, 0.0001), 2.20)) * lift * skyMask;\n  float outer = exp(-pow(d / max(width * 3.6, 0.0001), 1.18)) * lift * skyMask;\n  float sourceFalloff = exp(-length((p - source) / vec2(0.30, 0.18)) * 3.3);\n  float targetGlow = exp(-length(p - target) * 16.0) * smoothstep(0.64, 1.0, along);\n  float sourceGlow = exp(-length(p - source) * 18.0);\n  float travelingWave = smoothstep(0.58, 0.98, sin(along * 34.0 - u_time * 2.55 + beamCurrent * 4.0) * 0.5 + 0.5);\n  float turbulentVeil = smoothstep(0.48, 0.92, fbm(vec2(along * 10.0 - u_time * 0.44, dot(p, normal) * 20.0 + 7.0)));\n  vec3 tint = mix(u_accent, vec3(0.82, 0.88, 1.0), 0.20);\n  vec3 warmAir = vec3(0.028, 0.022, 0.040);\n\n  col += warmAir * outer * (0.14 + fog * 0.20 + turbulentVeil * 0.08);\n  col += tint * body * (0.030 + brokenAir * 0.120 + sourceFalloff * 0.18 + travelingWave * 0.030);\n  col += tint * core * (0.085 + fineFog * 0.082 + travelingWave * 0.055);\n  col += tint * sourceGlow * skyMask * (0.22 + pulse * 0.08);\n  col += tint * targetGlow * (0.07 + fog * 0.09 + travelingWave * 0.04);\n\n  float horizonMist = smoothstep(-0.58, -0.22, p.y) * smoothstep(0.25, -0.20, p.y);\n  float mist = fbm(vec2(p.x * 2.0 + u_time * 0.010, p.y * 5.0 + 3.0));\n  float beamMist = exp(-pow(d / max(width * 5.0, 0.001), 1.12)) * lift;\n  col += vec3(0.026, 0.020, 0.038) * horizonMist * smoothstep(0.40, 0.80, mist) * 0.42;\n  col += tint * horizonMist * beamMist * skyMask * (0.030 + mist * 0.055);\n\n  float moteField = smoothstep(-0.72, 0.72, p.y) * smoothstep(1.30, 0.20, length(p));\n  vec2 beamSpace = vec2(along * 64.0 - u_time * 2.4, dot(p - source, normal) * 44.0 + u_time * 0.28);\n  vec2 motes = mix(p * 44.0 + vec2(u_time * 0.28, -u_time * 0.12), beamSpace, clamp(body * 1.4, 0.0, 1.0));\n  vec2 id = floor(motes);\n  vec2 f = fract(motes);\n  vec2 pos = hash22(id);\n  float mote = 1.0 - smoothstep(0.0, 0.042, length(f - pos));\n  mote *= smoothstep(0.977, 1.0, hash12(id + 6.2));\n  float beamSpark = smoothstep(0.86, 1.0, beamCurrent) * body + core * 0.55;\n  float streak = exp(-abs(f.y - pos.y) * 44.0) * exp(-abs(f.x - pos.x) * 5.0) * smoothstep(0.986, 1.0, hash12(id + 13.7));\n  col += tint * mote * moteField * (0.030 + body * 0.30 + travelingWave * core * 0.12);\n  col += mix(tint, vec3(1.0, 0.95, 0.82), 0.36) * streak * moteField * beamSpark * 0.11;\n}\n\nvoid drawLandscape(inout vec3 col, vec2 p, vec2 source, vec2 target) {\n  float mountain = mountainProfile(p.x);\n  float terrain = groundProfile(p.x);\n  float water = waterProfile(p.x);\n  float island = islandMask(p);\n  float isMountain = smoothstep(mountain + 0.006, mountain - 0.004, p.y);\n  float isGround = smoothstep(terrain + 0.006, terrain - 0.006, p.y);\n  float landAboveWater = smoothstep(water - 0.052, water + 0.018, p.y);\n  float islandSolid = isMountain * island * landAboveWater;\n  float islandGround = isGround * island * landAboveWater;\n  float edge = smoothstep(mountain - 0.006, mountain + 0.004, p.y) * smoothstep(mountain + 0.026, mountain + 0.004, p.y) * island * landAboveWater;\n  float beamDistance = lineDist(p, source, target);\n  float beamAlong = lineAlong(p, source, target);\n  float beamWidth = mix(0.016, 0.090, pow(beamAlong, 0.72));\n  float beamPaint = exp(-pow(beamDistance / max(beamWidth * 1.45, 0.001), 1.35)) * smoothstep(0.0, 0.26, beamAlong) * smoothstep(1.0, 0.10, beamAlong);\n  float ridgePool = exp(-length((p - source) / vec2(0.24, 0.11)) * 5.0);\n  float eps = 0.010;\n  float slope = (mountainProfile(p.x + eps) - mountainProfile(p.x - eps)) / (eps * 2.0);\n  vec2 ridgeNormal = normalize(vec2(-slope, 1.0));\n  float ridgeLight = max(dot(ridgeNormal, normalize(source - p + vec2(0.0, 0.025))), 0.0);\n  float wetRock = pow(fbm(vec2(p.x * 18.0 + 2.0, p.y * 24.0 + 7.0)), 3.2);\n  float mica = smoothstep(0.82, 1.0, noise(vec2(p.x * 88.0 + 3.0, p.y * 42.0 + 9.0)));\n  float starSheen = smoothstep(0.74, 1.0, fbm(vec2(p.x * 34.0 - u_time * 0.020, p.y * 11.0 + 4.0)));\n  float grazing = smoothstep(0.0, 0.82, ridgeLight) * edge;\n  float islandRise = clamp((p.y - water) / max(mountain - water, 0.035), 0.0, 1.0);\n  float cliffFace = islandSolid * smoothstep(0.02, 0.95, islandRise) * (1.0 - smoothstep(0.86, 1.0, islandRise));\n  float cliffStrata = smoothstep(0.50, 0.96, noise(vec2(p.x * 34.0 + 1.0, p.y * 88.0 - u_time * 0.025)));\n  float cliffCuts = smoothstep(0.58, 0.94, fbm(vec2(p.x * 16.0 + 8.0, p.y * 42.0)));\n  vec2 obsBase = telescopeBase();\n  float summitPad = exp(-length((p - (obsBase - vec2(0.0, 0.020))) / vec2(0.145, 0.040)) * 4.2) * islandSolid;\n  float anchorShadow = exp(-length((p - (obsBase - vec2(0.0, 0.034))) / vec2(0.170, 0.030)) * 5.0) * islandSolid;\n\n  vec3 mtn = vec3(0.004, 0.004, 0.010);\n  mtn += vec3(0.030, 0.019, 0.042) * edge;\n  mtn += vec3(0.010, 0.007, 0.017) * fbm(vec2(p.x * 8.0, p.y * 5.0 + 4.0)) * islandSolid;\n  mtn += vec3(0.026, 0.020, 0.034) * cliffFace;\n  mtn += vec3(0.070, 0.058, 0.088) * cliffFace * cliffStrata * 0.16;\n  mtn -= vec3(0.010, 0.008, 0.014) * cliffFace * cliffCuts * 0.24;\n  mtn += u_accent * (beamPaint * 0.18 + ridgePool * 0.12) * edge * (0.55 + ridgeLight * 0.90);\n  mtn += vec3(0.070, 0.062, 0.090) * ridgePool * edge * 0.18;\n  mtn += mix(u_accent, vec3(0.80, 0.84, 1.0), 0.35) * wetRock * grazing * ridgePool * 0.18;\n  mtn += vec3(0.20, 0.17, 0.30) * wetRock * starSheen * grazing * 0.030;\n  mtn += mix(u_accent, vec3(0.88, 0.92, 1.0), 0.50) * mica * grazing * (0.018 + beamPaint * 0.035);\n  mtn += vec3(0.030, 0.028, 0.045) * summitPad * 0.55;\n  mtn -= vec3(0.018, 0.016, 0.028) * anchorShadow * 0.46;\n  vec3 ground = vec3(0.0015, 0.0015, 0.0040);\n  ground += vec3(0.008, 0.006, 0.012) * fbm(vec2(p.x * 6.0, p.y * 9.0 + 2.0));\n  ground += u_accent * ridgePool * islandGround * smoothstep(terrain + 0.045, terrain - 0.005, p.y) * 0.025;\n  float groundMirror = exp(-pow((p.y - terrain + 0.034) * 23.0, 2.0)) * islandGround;\n  float mirrorBreakup = smoothstep(0.42, 0.96, fbm(vec2(p.x * 14.0 + u_time * 0.030, p.y * 55.0)));\n  ground += mix(u_accent, vec3(0.72, 0.78, 1.0), 0.38) * groundMirror * mirrorBreakup * (0.018 + ridgePool * 0.050 + beamPaint * 0.065);\n  col = mix(col, mtn, islandSolid * 0.98);\n  col = mix(col, ground, islandGround * 0.96);\n\n  float ridgeMist = exp(-pow((p.y - mountain) * 14.0, 2.0)) * smoothstep(-0.72, -0.12, p.y);\n  col += vec3(0.020, 0.016, 0.032) * ridgeMist * 0.22;\n  col += u_accent * ridgeMist * (beamPaint * 0.16 + ridgePool * 0.08);\n  float shore = exp(-pow((p.y - water) * 82.0, 2.0)) * island * smoothstep(mountain - 0.120, water + 0.050, p.y);\n  float coastSpark = smoothstep(0.52, 0.96, noise(vec2(p.x * 90.0 - u_time * 0.80, p.y * 38.0)));\n  float wetRockLine = exp(-pow((p.y - water + 0.020) * 36.0, 2.0)) * island * landAboveWater;\n  float shoreShadow = exp(-pow((p.y - water - 0.028) * 38.0, 2.0)) * island * landAboveWater;\n  col += vec3(0.11, 0.10, 0.16) * shore * 0.26;\n  col += mix(u_accent, vec3(0.82, 0.92, 1.0), 0.58) * shore * coastSpark * 0.155;\n  col += vec3(0.025, 0.022, 0.035) * wetRockLine * 0.44;\n  col -= vec3(0.006, 0.005, 0.010) * shoreShadow * 0.55;\n}\n\nvoid drawForegroundReflection(inout vec3 col, vec2 p, vec2 uv, vec2 source, vec2 target) {\n  float water = waterProfile(p.x);\n  float mountain = mountainProfile(p.x);\n  float island = islandMask(p);\n  float landAboveWater = smoothstep(water - 0.052, water + 0.018, p.y);\n  float islandSolid = smoothstep(mountain + 0.006, mountain - 0.004, p.y) * island * landAboveWater;\n  float waterBody = 1.0 - smoothstep(water - 0.010, water + 0.024, p.y);\n  float openWater = waterBody * (1.0 - islandSolid * 0.98);\n  float depthFade = clamp((water - p.y) / 0.42, 0.0, 1.0);\n  float edgeFade = 1.0 - smoothstep(1.26, 1.62, abs(p.x));\n  float perspective = clamp((water - p.y) / 0.42, 0.0, 1.0);\n  vec2 rippleUv = vec2(p.x * 6.2 + u_time * 0.080, p.y * 30.0 - u_time * 0.135);\n  float ripple = fbm(rippleUv);\n  float longRipple = fbm(vec2(p.x * 2.0 - u_time * 0.030, p.y * 8.0 + 7.0));\n  float microRipple = noise(vec2(p.x * 84.0 + u_time * 0.42, p.y * 160.0 + longRipple * 3.4));\n  vec2 reflectedUv = vec2(\n    uv.x + (ripple - 0.5) * 0.052 + (microRipple - 0.5) * 0.007,\n    0.48 + perspective * 0.64 + (ripple - 0.5) * 0.040\n  );\n  reflectedUv = clamp(reflectedUv, vec2(0.0), vec2(1.0));\n  vec3 skyReflection = renderSky(reflectedUv, vec2(p.x, -p.y));\n  vec3 cometReflection = renderComets(reflectedUv + vec2((microRipple - 0.5) * 0.009, (ripple - 0.5) * 0.016), 0.90);\n  float mirrorBand = smoothstep(0.12, 0.82, skyReflection.b + skyReflection.r * 0.62);\n  float waterSheen = openWater * edgeFade * (0.62 + depthFade * 0.48);\n  float waterline = exp(-pow((p.y - water) * 90.0, 2.0)) * edgeFade;\n  vec3 waterBase = vec3(0.0016, 0.0040, 0.0135);\n  waterBase += vec3(0.004, 0.018, 0.026) * longRipple * 0.34;\n  waterBase += vec3(0.020, 0.015, 0.037) * smoothstep(0.30, 0.95, ripple) * 0.12;\n  col = mix(col, waterBase, waterSheen * 0.92);\n\n  vec2 sourceR = vec2(source.x, water * 2.0 - source.y);\n  vec2 targetR = vec2(target.x, water * 2.0 - target.y);\n  float beamReflDist = lineDist(p, sourceR, targetR);\n  float beamReflAlong = lineAlong(p, sourceR, targetR);\n  float beamReflection = exp(-beamReflDist * 15.0) * smoothstep(0.0, 0.18, beamReflAlong) * smoothstep(1.0, 0.06, beamReflAlong);\n  float domeColumn = exp(-abs(p.x - source.x) * 13.0) * exp(-(water - p.y) * 2.25) * smoothstep(0.0, 0.54, perspective);\n  float domeBroken = smoothstep(0.36, 0.96, fbm(vec2(p.x * 18.0 + u_time * 0.10, p.y * 58.0)));\n  float pool = exp(-length((p - vec2(source.x, water - 0.025)) / vec2(0.54, 0.090)) * 3.4);\n  float shimmer = smoothstep(0.58, 0.99, noise(vec2(p.x * 128.0 - u_time * 1.05, p.y * 32.0 + ripple * 3.4)));\n  float waveLines = exp(-abs(fract((water - p.y) * 46.0 + ripple * 1.8 - u_time * 0.42) - 0.5) * 18.0);\n  float waveGrid = smoothstep(0.88, 1.0, noise(vec2(p.x * 48.0 + u_time * 0.22, p.y * 92.0 - u_time * 0.52)));\n  float causticA = waterCaustic(vec2(p.x * 1.35 + ripple * 0.6, (water - p.y) * 2.8 + longRipple * 0.4));\n  float causticB = waterCaustic(vec2(p.x * 2.2 - u_time * 0.06, (water - p.y) * 4.8 + u_time * 0.04));\n  float caustic = (causticA * 0.62 + causticB * 0.38) * waterSheen * smoothstep(0.04, 0.95, perspective);\n\n  float journalCurrent = exp(-abs(sin(p.x * 3.4 + p.y * 7.0 + u_time * 0.55 + ripple * 2.2)) * 8.0);\n  float recapCurrent = exp(-abs(sin(p.x * 4.8 - p.y * 5.5 - u_time * 0.48 + longRipple * 2.0)) * 8.5);\n  journalCurrent *= smoothstep(0.14, 0.82, perspective) * smoothstep(0.20, 0.95, ripple);\n  recapCurrent *= smoothstep(0.05, 0.78, perspective) * smoothstep(0.18, 0.96, microRipple);\n\n  vec2 memoryA = p - vec2(-0.44, water - 0.115);\n  vec2 memoryB = p - vec2(0.38, water - 0.165);\n  vec2 memoryC = p - vec2(0.04, water - 0.235);\n  float ringA = exp(-pow((length(memoryA / vec2(1.0, 0.42)) - (0.14 + 0.018 * sin(u_time * 0.50))) * 22.0, 2.0));\n  float ringB = exp(-pow((length(memoryB / vec2(1.0, 0.44)) - (0.19 + 0.020 * sin(u_time * 0.42 + 1.7))) * 18.0, 2.0));\n  float ringC = exp(-pow((length(memoryC / vec2(1.0, 0.46)) - (0.25 + 0.018 * sin(u_time * 0.38 + 3.1))) * 17.0, 2.0));\n  float memoryRings = (ringA + ringB * 0.85 + ringC * 0.70) * waterSheen * smoothstep(0.10, 0.92, perspective);\n  float settledGlow =\n    exp(-dot(memoryA / vec2(0.17, 0.07), memoryA / vec2(0.17, 0.07))) +\n    exp(-dot(memoryB / vec2(0.19, 0.08), memoryB / vec2(0.19, 0.08))) * 0.86 +\n    exp(-dot(memoryC / vec2(0.24, 0.09), memoryC / vec2(0.24, 0.09))) * 0.78;\n  settledGlow *= waterSheen;\n\n  float shoreGlow = exp(-pow((p.y - water) * 88.0, 2.0)) * island * (1.0 - islandSolid);\n  float shoreFoam = shoreGlow * smoothstep(0.50, 1.0, noise(vec2(p.x * 120.0 - u_time * 0.9, p.y * 20.0)));\n  float cometEnergy = max(max(cometReflection.r, cometReflection.g), cometReflection.b);\n\n  col += skyReflection * waterSheen * (0.125 + mirrorBand * 0.215);\n  col += cometReflection * waterSheen * (0.210 + shimmer * 0.090 + waveLines * 0.038);\n  col += vec3(0.83, 0.77, 1.0) * waterline * waterSheen * 0.132;\n  col += mix(vec3(0.35, 0.75, 0.68), vec3(0.83, 0.77, 1.0), 0.38) * caustic * (0.180 + cometEnergy * 0.18);\n  col += u_accent * waterSheen * (beamReflection * (0.135 + shimmer * 0.105) + pool * 0.145 + domeColumn * (0.090 + domeBroken * 0.055));\n  col += mix(u_accent, vec3(0.72, 0.84, 1.0), 0.40) * waterSheen * waveLines * (0.024 + pool * 0.044 + beamReflection * 0.060);\n  col += vec3(0.30, 0.78, 0.74) * waterSheen * journalCurrent * (0.030 + waveGrid * 0.048);\n  col += vec3(0.62, 0.43, 0.92) * waterSheen * recapCurrent * (0.028 + shimmer * 0.048);\n  col += mix(vec3(0.72, 0.64, 0.91), vec3(0.95, 0.70, 0.42), 0.30) * memoryRings * 0.090;\n  col += mix(vec3(0.72, 0.64, 0.91), vec3(0.35, 0.75, 0.68), 0.45) * settledGlow * 0.105;\n  col += mix(u_accent, vec3(0.86, 0.96, 1.0), 0.60) * shoreFoam * 0.112;\n  col += mix(vec3(0.35, 0.75, 0.68), vec3(0.92, 0.84, 1.0), 0.58) * cometEnergy * caustic * 0.130;\n  col += vec3(0.82, 0.84, 1.0) * cometEnergy * waterline * waterSheen * 0.070;\n}\n\nvoid drawWaterFog(inout vec3 col, vec2 p, vec2 source, vec2 target) {\n  float water = waterProfile(p.x);\n  float mountain = mountainProfile(p.x);\n  float island = islandMask(p);\n  float islandSolid = smoothstep(mountain + 0.006, mountain - 0.004, p.y) * island;\n  float aboveWater = smoothstep(water - 0.035, water + 0.026, p.y) * (1.0 - smoothstep(water + 0.035, water + 0.330, p.y));\n  float waterShelf = exp(-pow((p.y - water - 0.046) * 6.8, 2.0));\n  float lateral = 1.0 - smoothstep(1.22, 1.70, abs(p.x));\n  float openAir = aboveWater * waterShelf * lateral * (1.0 - islandSolid * 0.72);\n  vec2 q = vec2(p.x * 1.55 + u_time * 0.012, (p.y - water) * 6.5 - u_time * 0.026);\n  float rollingFog = fbm(q + vec2(fbm(q * 1.7), 0.0));\n  float filamentFog = smoothstep(0.44, 0.86, fbm(vec2(p.x * 4.2 - u_time * 0.038, (p.y - water) * 17.0 + 8.0)));\n  float lowVeil = openAir * (0.22 + rollingFog * 0.42 + filamentFog * 0.38);\n  float beamDist = lineDist(p, source, target);\n  float beamAlong = lineAlong(p, source, target);\n  float beamWidth = mix(0.030, 0.140, pow(clamp(beamAlong, 0.0, 1.0), 0.72));\n  float beamFog = exp(-pow(beamDist / max(beamWidth * 2.8, 0.001), 1.22)) * smoothstep(0.0, 0.24, beamAlong) * smoothstep(1.0, 0.04, beamAlong);\n  float shoreBreath = exp(-pow((p.y - water) * 22.0, 2.0)) * island * lateral;\n  float driftSpark = smoothstep(0.965, 1.0, noise(vec2(p.x * 160.0 + u_time * 0.40, p.y * 94.0 - u_time * 0.26))) * lowVeil;\n\n  col += vec3(0.024, 0.024, 0.044) * lowVeil * 0.58;\n  col += vec3(0.10, 0.09, 0.16) * lowVeil * rollingFog * 0.075;\n  col += u_accent * lowVeil * (beamFog * 0.125 + shoreBreath * 0.045);\n  col += mix(u_accent, vec3(0.84, 0.88, 1.0), 0.46) * driftSpark * 0.082;\n}\n\nvoid drawLensScattering(inout vec3 col, vec2 p, vec2 target, vec2 source) {\n  vec2 dir = normalize(target - source);\n  vec2 normal = vec2(-dir.y, dir.x);\n  vec2 q = p - source;\n  float along = dot(q, dir);\n  float across = abs(dot(q, normal));\n  float aperture = exp(-length(q) * 26.0);\n  float axial = exp(-across * 82.0) * smoothstep(-0.040, 0.035, along) * smoothstep(0.44, 0.0, along);\n  float sideGlow = exp(-length(q / vec2(0.20, 0.10)) * 5.5);\n  float irisRing = abs(length(q) - 0.052);\n  float ring = exp(-irisRing * 90.0) * exp(-abs(along) * 3.8);\n  float mountain = mountainProfile(p.x);\n  float occlusion = smoothstep(mountain - 0.010, mountain + 0.038, p.y);\n  vec3 tint = mix(u_accent, vec3(0.86, 0.90, 1.0), 0.22);\n  col += tint * occlusion * (aperture * 0.34 + axial * 0.16 + sideGlow * 0.08 + ring * 0.055);\n  col += vec3(1.0, 0.94, 0.82) * aperture * occlusion * 0.055;\n}\n\nvoid drawDistantObservatory(inout vec3 col, vec2 p, vec2 target) {\n  vec2 base = telescopeBase();\n  float s = 0.58;\n  vec2 domeCenter = base + vec2(0.0, 0.052);\n  vec2 dir = normalize(target - domeCenter + vec2(0.0, 0.008));\n  vec2 n = vec2(-dir.y, dir.x);\n  vec2 aperture = domeCenter + dir * (0.088 * s);\n\n  float plinth = 1.0 - smoothstep(0.0, 0.0042, sdBox(p, base - vec2(0.0, 0.022 * s), vec2(0.098, 0.034) * s));\n  float retainingWall = 1.0 - smoothstep(0.0, 0.0038, sdBox(p, base - vec2(0.0, 0.050 * s), vec2(0.122, 0.018) * s));\n  float contactShadow = 1.0 - smoothstep(0.0, 0.0060, sdEllipse(p, base - vec2(0.0, 0.066 * s), vec2(0.150, 0.028) * s));\n  float ledge = 1.0 - smoothstep(0.0, 0.0035, sdCapsule(p, base + vec2(-0.092 * s, -0.003 * s), base + vec2(0.092 * s, -0.003 * s), 0.0045 * s));\n  float foundation = 1.0 - smoothstep(0.0, 0.0045, sdBox(p, base + vec2(0.0, 0.006 * s), vec2(0.112, 0.026) * s));\n  float lowerDeck = 1.0 - smoothstep(0.0, 0.0038, sdBox(p, base + vec2(0.0, -0.018 * s), vec2(0.126, 0.014) * s));\n  float domeEllipse = 1.0 - smoothstep(0.0, 0.0045, sdEllipse(p, domeCenter, vec2(0.104, 0.066) * s));\n  float domeMask = domeEllipse * smoothstep(domeCenter.y - 0.026 * s, domeCenter.y - 0.004 * s, p.y);\n  float domeRim = exp(-abs(sdEllipse(p, domeCenter, vec2(0.104, 0.066) * s)) * 140.0) * domeMask;\n  float horizonRim = exp(-abs(p.y - (domeCenter.y - 0.022 * s)) * 230.0) * smoothstep(0.106 * s, 0.070 * s, abs(p.x - domeCenter.x));\n\n  float slit = 1.0 - smoothstep(0.0, 0.0045, sdCapsule(p, domeCenter - dir * (0.024 * s), domeCenter + dir * (0.096 * s), 0.017 * s));\n  float slitInside = slit * domeMask;\n  float shutterA = 1.0 - smoothstep(0.0, 0.0034, sdCapsule(p, domeCenter - dir * (0.016 * s) + n * (0.020 * s), aperture + n * (0.020 * s), 0.0035 * s));\n  float shutterB = 1.0 - smoothstep(0.0, 0.0034, sdCapsule(p, domeCenter - dir * (0.016 * s) - n * (0.020 * s), aperture - n * (0.020 * s), 0.0035 * s));\n  float telescopeInside = 1.0 - smoothstep(0.0, 0.0040, sdCapsule(p, domeCenter + dir * (0.004 * s), aperture + dir * (0.018 * s), 0.010 * s));\n  float glass = exp(-length((p - aperture) / (vec2(0.024, 0.018) * s)) * 34.0);\n  float glassRim = exp(-abs(length(p - aperture) - 0.020 * s) * 180.0);\n\n  float panelNoise = fbm(vec2(p.x * 42.0 + 2.0, p.y * 28.0 + 4.0));\n  float panels = 0.0;\n  panels += exp(-abs(p.x - (base.x - 0.070 * s)) * 190.0);\n  panels += exp(-abs(p.x - (base.x - 0.034 * s)) * 210.0);\n  panels += exp(-abs(p.x - (base.x + 0.034 * s)) * 210.0);\n  panels += exp(-abs(p.x - (base.x + 0.070 * s)) * 190.0);\n  panels *= foundation * smoothstep(base.y - 0.010 * s, base.y + 0.038 * s, p.y);\n\n  float domeSheen = smoothstep(0.62, 1.0, panelNoise) * domeMask * smoothstep(domeCenter.x - 0.11 * s, domeCenter.x + 0.04 * s, p.x);\n  float beamFacing = max(dot(normalize(aperture - p + vec2(0.0, 0.010)), normalize(dir + vec2(0.0, 0.14))), 0.0);\n\n  vec3 silhouette = vec3(0.001, 0.001, 0.003);\n  vec3 concrete = vec3(0.006, 0.006, 0.012);\n  vec3 domeSkin = vec3(0.007, 0.008, 0.016);\n  over(col, silhouette, contactShadow * 0.46);\n  over(col, vec3(0.004, 0.004, 0.009), retainingWall * 0.92);\n  over(col, vec3(0.007, 0.007, 0.014), plinth * 0.90);\n  col += vec3(0.044, 0.039, 0.060) * retainingWall * 0.10;\n  col += mix(u_accent, vec3(0.78, 0.84, 1.0), 0.55) * ledge * 0.065;\n  over(col, silhouette, lowerDeck * 0.98);\n  over(col, concrete, foundation * 0.94);\n  over(col, domeSkin, domeMask * 0.96);\n  over(col, vec3(0.0006, 0.0007, 0.002), slitInside * 0.96);\n  over(col, silhouette, telescopeInside * slitInside * 0.80);\n  col += vec3(0.052, 0.047, 0.078) * panels * 0.14;\n  col += vec3(0.080, 0.076, 0.120) * domeRim * 0.055;\n  col += vec3(0.075, 0.066, 0.105) * horizonRim * 0.045;\n  col += mix(u_accent, vec3(0.86, 0.90, 1.0), 0.40) * domeSheen * 0.035;\n  col += mix(u_accent, vec3(0.90, 0.95, 1.0), 0.38) * (shutterA + shutterB) * (0.034 + beamFacing * 0.040);\n  col += u_accent * glass * 0.78;\n  col += vec3(0.78, 0.83, 1.0) * glass * 0.18;\n  col += mix(u_accent, vec3(0.92, 0.96, 1.0), 0.52) * glassRim * 0.050;\n}\n\nvoid main() {\n  vec2 uv = v_uv;\n  float aspect = u_resolution.x / max(u_resolution.y, 1.0);\n  vec2 p = (uv * 2.0 - 1.0) * vec2(aspect, 1.0);\n  vec2 skyUv = uv;\n\n  vec2 target = vec2((u_target.x * 2.0 - 1.0) * aspect, (1.0 - u_target.y) * 2.0 - 1.0);\n  vec2 base = telescopeBase();\n  float observatoryScale = 0.58;\n  vec2 domeCenter = base + vec2(0.0, 0.052);\n  vec2 dir = normalize(target - domeCenter + vec2(0.0, 0.008));\n  vec2 source = domeCenter + dir * (0.088 * observatoryScale);\n\n  vec3 col = renderSky(skyUv, p);\n  float targetGlow = exp(-length(p - target) * 20.0);\n  col += u_accent * targetGlow * 0.24;\n  drawVolumetrics(col, p, target, source);\n  drawLandscape(col, p, source, target);\n  drawForegroundReflection(col, p, uv, source, target);\n  drawWaterFog(col, p, source, target);\n  drawDistantObservatory(col, p, target);\n  drawLensScattering(col, p, target, source);\n\n  float vignette = smoothstep(1.22, 0.20, length((uv - 0.5) * vec2(1.05, 1.0)));\n  col *= mix(0.38, 1.0, vignette);\n  float iris = 1.0 - smoothstep(0.36, 1.08, length((uv - 0.5) * vec2(0.78, 1.0)));\n  col += vec3(0.010, 0.009, 0.018) * iris;\n\n  fragColor = vec4(max(col, 0.0), 1.0);\n}";

const LOGIN_SKY_UTILS = `
float authHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float authHash2(vec2 p) {
  return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453);
}

vec2 authHash2v(vec2 p) {
  return vec2(authHash(p), authHash2(p));
}

float authNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(authHash(i), authHash(i + vec2(1.0, 0.0)), f.x),
    mix(authHash(i + vec2(0.0, 1.0)), authHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float authFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 6; i++) {
    v += a * authNoise(p);
    p *= 2.03;
    a *= 0.47;
  }
  return v;
}

float authFbm4(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * authNoise(p);
    p *= 2.1;
    a *= 0.45;
  }
  return v;
}

float authFbm8(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 8; i++) {
    v += a * authNoise(p);
    p *= 2.01;
    a *= 0.48;
  }
  return v;
}
`;

const LOGIN_STYLE_SKY = `
vec3 renderSky(vec2 uv, vec2 p) {
  vec2 q = p * 0.52;
  float t = u_time;

  float drift = t * 0.0004;
  float cdrift = cos(drift);
  float sdrift = sin(drift);

  float horizonY = -0.25;
  float aboveHorizon = smoothstep(horizonY - 0.02, horizonY + 0.02, q.y);
  float distFromHorizon = abs(q.y - horizonY);

  vec3 skyTop = vec3(0.012, 0.014, 0.035);
  vec3 skyMid = vec3(0.025, 0.022, 0.055);
  vec3 skyHorizon = vec3(0.060, 0.040, 0.080);
  float skyT = smoothstep(horizonY, 0.90, q.y);
  vec3 sky = mix(skyHorizon, mix(skyMid, skyTop, smoothstep(0.0, 1.0, skyT)), skyT);

  float horizGlow = exp(-distFromHorizon * distFromHorizon * 8.0);
  float horizGlowWide = exp(-distFromHorizon * distFromHorizon * 2.0);
  float horizBreath = 0.85 + 0.15 * sin(t * 0.06 + 1.0);
  sky += vec3(0.12, 0.06, 0.04) * horizGlow * 0.44 * horizBreath;
  sky += vec3(0.06, 0.03, 0.06) * horizGlow * 0.24;
  sky += vec3(0.04, 0.02, 0.07) * horizGlowWide * 0.32;

  float horizNoise = authFbm4(vec2(q.x * 3.0 + 0.5, t * 0.02)) * 0.5 + 0.5;
  sky += vec3(0.08, 0.04, 0.02) * horizGlow * horizNoise * 0.30;
  sky += vec3(0.02, 0.02, 0.06) * horizGlow * (1.0 - horizNoise) * 0.20;

  vec2 pMW = vec2(cdrift * q.x - sdrift * q.y, sdrift * q.x + cdrift * q.y);
  float mwSlope = 0.48;
  float mwCenterY = mwSlope * pMW.x + 0.20 + sin(pMW.x * 1.5) * 0.025;
  float mwNormFactor = 1.0 / sqrt(1.0 + mwSlope * mwSlope);
  float mwDist = abs(pMW.y - mwCenterY) * mwNormFactor;

  float coreX = 0.12;
  float coreProx = exp(-(pMW.x - coreX) * (pMW.x - coreX) * 2.8);
  float bandHW = 0.13 + coreProx * 0.08;
  float bandMask = smoothstep(bandHW * 2.5, bandHW * 0.1, mwDist) * aboveHorizon;
  float coreMask = exp(-mwDist * mwDist / (bandHW * bandHW * 0.10)) * coreProx * aboveHorizon;
  coreMask *= 0.58;

  float mwAng = atan(mwSlope);
  float cs2 = cos(mwAng);
  float sn2 = sin(mwAng);
  vec2 mwUV = vec2(cs2 * pMW.x + sn2 * pMW.y, -sn2 * pMW.x + cs2 * pMW.y);

  vec2 warp = vec2(
    authFbm4(mwUV * 2.0 + vec2(1.7, 9.2)),
    authFbm4(mwUV * 2.0 + vec2(8.3, 2.8))
  );
  vec2 wUV = mwUV + warp * 0.12;

  float cL = authFbm(wUV * 3.0 + vec2(0.0, 3.0));
  float cM = authFbm(wUV * 6.5 + vec2(5.0, 1.0));
  float cF = authFbm8(wUV * 13.0 + vec2(2.0, 7.0));
  float cU = authFbm4(wUV * 25.0 + vec2(8.0, 4.0));

  float nebula = cL * 0.38 + cM * 0.30 + cF * 0.22 + cU * 0.10;
  nebula = smoothstep(0.28, 0.82, nebula);

  float rift = authFbm(wUV * 4.5 + vec2(3.0, 0.5));
  float rift2 = authFbm4(wUV * 9.0 + vec2(0.5, 5.5));
  float dFine = authFbm4(wUV * 18.0 + vec2(7.0, 3.0));
  float dUltra = authNoise(wUV * 32.0 + vec2(1.0, 9.0));

  float absorp = 0.0;
  absorp += smoothstep(0.44, 0.62, rift) * 0.45;
  absorp += smoothstep(0.47, 0.60, rift2) * 0.22;
  absorp += smoothstep(0.50, 0.60, dFine) * 0.12;
  absorp += smoothstep(0.52, 0.58, dUltra) * 0.06;
  absorp = clamp(absorp, 0.0, 0.65);

  float dustConc = smoothstep(bandHW * 1.3, 0.0, mwDist);
  float transmission = 1.0 - absorp * dustConc;
  nebula *= transmission;

  vec3 coreWarm = vec3(0.95, 0.52, 0.30);
  vec3 coreHot = vec3(1.00, 0.78, 0.38);
  vec3 corePink = vec3(0.88, 0.42, 0.52);
  vec3 midLav = vec3(0.58, 0.50, 0.80);
  vec3 outerBlue = vec3(0.35, 0.38, 0.65);

  float edgeT = clamp(mwDist / (bandHW * 1.5), 0.0, 1.0);
  vec3 mwCol = mix(midLav, outerBlue, edgeT);
  float coreBlend = coreProx * (1.0 - edgeT);
  mwCol = mix(mwCol, coreWarm, coreBlend * 0.55);
  mwCol = mix(mwCol, coreHot, coreBlend * coreMask * 0.45);
  float pinkN = authFbm4(wUV * 5.0 + vec2(4.0, 6.0));
  mwCol = mix(mwCol, corePink, coreBlend * pinkN * 0.28);

  float coreBreath = 0.88 + 0.12 * sin(t * 0.045);
  sky += mwCol * nebula * bandMask * 0.64;
  sky += coreHot * coreMask * nebula * 0.13 * coreBreath;

  float haloMask = smoothstep(bandHW * 4.0, bandHW * 0.6, mwDist) * aboveHorizon;
  sky += vec3(0.028, 0.023, 0.052) * haloMask * (0.42 + cL * 0.46);

  float agZone = smoothstep(horizonY + 0.28, horizonY + 0.02, q.y) * smoothstep(-0.7, 0.25, q.x);
  float agN = authFbm4(vec2(q.x * 2.0 + t * 0.01, q.y * 4.0 + 3.0));
  sky += vec3(0.012, 0.022, 0.010) * agZone * agN * 0.35;

  float auroraY = smoothstep(0.30, 0.55, q.y) * smoothstep(0.75, 0.50, q.y);
  float aWave1 = sin(q.x * 6.0 + t * 0.08 + authFbm4(vec2(q.x * 2.0 + t * 0.03, 5.0)) * 3.0);
  float aWave2 = sin(q.x * 10.0 - t * 0.05 + 2.8);
  float aCurtain = smoothstep(0.2, 0.95, aWave1 * 0.5 + 0.5) * (0.6 + 0.4 * aWave2);
  float aFlicker = 0.6 + 0.4 * sin(t * 0.12 + q.x * 3.0);
  float aMask = auroraY * aCurtain * aFlicker;
  vec3 auroraCol = mix(vec3(0.02, 0.06, 0.03), vec3(0.04, 0.02, 0.06), smoothstep(0.40, 0.55, q.y));
  sky += auroraCol * aMask * 0.35;

  float hs1 = exp(-length(pMW - vec2(0.05, 0.22)) * 8.0) * (0.7 + 0.3 * sin(t * 0.07 + 1.0));
  float hs2 = exp(-length(pMW - vec2(0.20, 0.30)) * 10.0) * (0.7 + 0.3 * sin(t * 0.09 + 3.5));
  float hs3 = exp(-length(pMW - vec2(-0.15, 0.14)) * 9.0) * (0.7 + 0.3 * sin(t * 0.055 + 5.2));
  sky += vec3(0.03, 0.015, 0.04) * hs1 * bandMask;
  sky += vec3(0.02, 0.02, 0.04) * hs2 * bandMask;
  sky += vec3(0.025, 0.01, 0.035) * hs3 * bandMask;

  vec2 pStar = vec2(cdrift * q.x - sdrift * q.y, sdrift * q.x + cdrift * q.y);
  vec3 starSum = vec3(0.0);
  for (int L = 0; L < 7; L++) {
    float fL = float(L);
    float scl = 250.0 + fL * 140.0;
    vec2 sd = vec2(fL * 7.3 + 1.0, fL * 3.1 + 2.0);
    vec2 cUV = pStar * scl + sd;
    vec2 cID = floor(cUV);
    vec2 cFr = fract(cUV);
    vec2 jit = authHash2v(cID);
    vec2 sPos = vec2(0.12 + 0.76 * jit.x, 0.12 + 0.76 * jit.y);
    float d = length(cFr - sPos);
    float raw = authHash(cID + vec2(5.0, 8.0));
    float pw = 28.0 + fL * 5.0;
    float br = pow(raw, pw);
    float twSpd = 0.5 + authHash(cID + vec2(1.0, 2.0)) * 2.5;
    float twBase = 0.72 + 0.28 * sin(t * twSpd + authHash(cID) * 62.83);
    float scintFreq = 3.0 + authHash(cID + vec2(3.0, 7.0)) * 8.0;
    float scint = 0.85 + 0.15 * sin(t * scintFreq + authHash(cID + vec2(6.0, 1.0)) * 31.4);
    float scintStrength = smoothstep(0.001, 0.02, br);
    float tw = twBase * mix(1.0, scint, scintStrength);
    float sigma = 0.12 + br * 0.06;
    float s = exp(-d * d / (2.0 * sigma * sigma));
    s *= br * tw * aboveHorizon;
    s *= 1.0 + bandMask * 2.5 * (1.0 - fL / 7.0);
    float hR = authHash(cID + vec2(9.0, 4.0));
    vec3 sCol = hR < 0.05 ? vec3(0.62, 0.68, 1.0) :
      hR < 0.10 ? vec3(1.0, 0.86, 0.62) :
      hR < 0.16 ? vec3(0.78, 0.74, 1.0) :
      vec3(0.91, 0.89, 0.95);
    starSum += sCol * s;
  }
  sky += starSum * 0.36;

  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 sp = vec2(
      authHash(vec2(fi * 13.7, fi * 7.3 + 100.0)) * 1.6 - 0.8,
      horizonY + 0.08 + authHash(vec2(fi * 9.1, fi * 4.8 + 200.0)) * 0.60
    );
    float d = length(pStar - sp);
    float core = exp(-d * d * 10000.0) * 0.28;
    float glow = exp(-d * d * 1000.0) * 0.055;
    float sH = exp(-abs(pStar.y - sp.y) * 400.0) * exp(-abs(pStar.x - sp.x) * 18.0) * 0.016;
    float sV = exp(-abs(pStar.x - sp.x) * 400.0) * exp(-abs(pStar.y - sp.y) * 18.0) * 0.014;
    float twk = 0.90 + 0.10 * sin(t * 0.3 + fi * 2.8);
    vec3 sc = fi < 2.0 ? vec3(0.86, 0.84, 1.0) : fi < 3.5 ? vec3(1.0, 0.91, 0.76) : vec3(0.84, 0.87, 1.0);
    sky += (core + glow + sH + sV) * sc * twk * aboveHorizon;
  }

  vec3 passingComets = renderComets(uv, 1.08);
  sky += passingComets * aboveHorizon;

  float mistY = smoothstep(horizonY + 0.12, horizonY - 0.02, q.y);
  float mistN1 = authFbm4(vec2(q.x * 2.0 + t * 0.012, q.y * 6.0 + 1.0));
  float mistN2 = authFbm4(vec2(q.x * 3.5 - t * 0.008 + 5.0, q.y * 8.0 + 3.0));
  float mist = mistY * (mistN1 * 0.6 + mistN2 * 0.4);
  mist *= smoothstep(0.25, 0.50, mistN1);
  vec3 mistCol = mix(vec3(0.04, 0.03, 0.06), vec3(0.07, 0.04, 0.05), mistN2);
  sky = mix(sky, mistCol, mist * 0.18);

  float vig = 1.0 - dot(uv - 0.5, uv - 0.5) * 1.05;
  sky *= smoothstep(-0.10, 0.55, vig);

  float peak = max(max(sky.r, sky.g), sky.b);
  vec3 compressedSky = sky / (1.0 + peak * 0.70);
  sky = mix(sky, compressedSky, smoothstep(0.42, 1.30, peak));

  return sky * 1.10;
}
`;

const REFINED_COMETS = `
float cometShape(vec2 uv, vec2 head, vec2 dir, float lengthScale, float widthScale, float phase) {
  dir = normalize(dir);
  vec2 n = vec2(-dir.y, dir.x);
  vec2 q = uv - head;
  float along = dot(q, dir);
  float acrossSigned = dot(q, n);
  float across = abs(acrossSigned);
  float trail = clamp(-along / lengthScale, 0.0, 1.0);
  float gate = smoothstep(0.0, 0.014, -along) * (1.0 - smoothstep(lengthScale * 0.70, lengthScale, -along));
  float air = fbm(vec2(trail * 12.0 + phase * 2.1 - u_time * 0.055, across * 66.0 + phase * 1.3));
  float ribbonWave = sin(trail * 38.0 + phase * 7.2 + air * 2.8) * 0.5 + 0.5;
  float tailWidth = widthScale * (0.52 + trail * 5.4) * (0.82 + air * 0.28);
  float body = exp(-pow(across / max(tailWidth, 0.0007), 1.78)) * exp(-trail * 2.72) * gate;
  float inner = exp(-pow(across / max(widthScale * (0.62 + trail * 1.55), 0.0007), 2.28)) * exp(-trail * 4.10) * gate;
  float ribbonOffset = (ribbonWave - 0.5) * tailWidth * 0.62;
  float ribbon = exp(-pow(abs(acrossSigned - ribbonOffset) / max(tailWidth * 0.28, 0.0006), 2.0)) * exp(-trail * 3.35) * gate;
  float headCore = exp(-dot(q / vec2(widthScale * 1.12, widthScale * 0.86), q / vec2(widthScale * 1.12, widthScale * 0.86)) * 24.0);
  float coma = exp(-dot(q / vec2(widthScale * 5.6, widthScale * 3.4), q / vec2(widthScale * 5.6, widthScale * 3.4)) * 4.2);
  float bow = exp(-pow(length((q + dir * widthScale * 0.95) / vec2(widthScale * 4.8, widthScale * 1.7)), 1.32) * 4.4);
  float ember = smoothstep(0.991, 1.0, noise(vec2(uv.x * 520.0 + phase * 19.0 - u_time * 0.42, uv.y * 300.0 + trail * 23.0))) * body * (1.0 - trail * 0.55);
  return body * 0.46 + inner * 0.48 + ribbon * 0.26 + headCore * 2.12 + coma * 0.36 + bow * 0.16 + ember * 0.12;
}

vec3 renderComets(vec2 uv, float intensity) {
  float pass = fract(u_time * 0.020 + 0.18);
  vec2 head = vec2(-0.26 + pass * 1.56, 0.83 - pass * 0.25 + sin(pass * 6.283) * 0.010);
  vec2 dir = normalize(vec2(1.0, -0.17));
  float fade = smoothstep(0.11, 0.22, pass) * (1.0 - smoothstep(0.58, 0.74, pass));
  vec3 tint = mix(vec3(0.55, 0.85, 0.94), vec3(0.88, 0.82, 1.0), 0.64);
  vec3 comet = tint * cometShape(uv, head, dir, 0.56, 0.0056, pass) * fade;

  return comet * intensity;
}
`;

function insertShaderSection(source: string, marker: string, insertion: string): string {
  const index = source.indexOf(marker);
  if (index < 0 || source.includes(insertion.trim())) {
    return source;
  }
  return source.slice(0, index) + insertion + '\n' + source.slice(index);
}

function replaceShaderSection(source: string, startMarker: string, endMarker: string, replacement: string): string {
  const start = source.indexOf(startMarker);
  const end = start >= 0 ? source.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) {
    return source;
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

const SCENE_PUNCH = replaceShaderSection(
  replaceShaderSection(
    insertShaderSection(SCENE, 'float sdCapsule', LOGIN_SKY_UTILS),
    'float cometShape(vec2 uv, vec2 head, vec2 dir, float lengthScale, float widthScale, float phase) {',
    'vec2 telescopeBase',
    REFINED_COMETS,
  ),
  'vec3 renderSky(vec2 uv, vec2 p) {',
  'void drawVolumetrics',
  LOGIN_STYLE_SKY,
)
  .replace('float s = 0.58;', 'float s = 0.78;')
  .replace('float observatoryScale = 0.58;', 'float observatoryScale = 0.78;')
  .replace(
    `float domeSheen = smoothstep(0.62, 1.0, panelNoise) * domeMask * smoothstep(domeCenter.x - 0.11 * s, domeCenter.x + 0.04 * s, p.x);
  float beamFacing = max(dot(normalize(aperture - p + vec2(0.0, 0.010)), normalize(dir + vec2(0.0, 0.14))), 0.0);`,
    `float domeSheen = smoothstep(0.62, 1.0, panelNoise) * domeMask * smoothstep(domeCenter.x - 0.11 * s, domeCenter.x + 0.04 * s, p.x);
  float domeMeridian = exp(-abs(p.x - domeCenter.x) * 260.0) * domeMask * smoothstep(domeCenter.y - 0.030 * s, domeCenter.y + 0.050 * s, p.y);
  float domeLatitude = exp(-abs(p.y - (domeCenter.y + 0.004 * s)) * 190.0) * domeMask;
  float domeLatitudeUpper = exp(-abs(p.y - (domeCenter.y + 0.028 * s)) * 210.0) * domeMask * smoothstep(0.104 * s, 0.030 * s, abs(p.x - domeCenter.x));
  float domePanelLeft = exp(-abs((p.x - domeCenter.x) + 0.044 * s + sin((p.y - domeCenter.y) * 28.0) * 0.003) * 210.0) * domeMask;
  float domePanelRight = exp(-abs((p.x - domeCenter.x) - 0.044 * s + sin((p.y - domeCenter.y) * 26.0 + 1.4) * 0.003) * 210.0) * domeMask;
  float rotatorRing = exp(-abs(p.y - (domeCenter.y - 0.030 * s)) * 260.0) * smoothstep(0.122 * s, 0.064 * s, abs(p.x - domeCenter.x));
  float domeDrum = 1.0 - smoothstep(0.0, 0.0038, sdBox(p, base + vec2(0.0, 0.045 * s), vec2(0.104, 0.027) * s));
  float domeSkirt = 1.0 - smoothstep(0.0, 0.0040, sdCapsule(p, base + vec2(-0.112 * s, 0.066 * s), base + vec2(0.112 * s, 0.066 * s), 0.010 * s));
  float drumPanels = (exp(-abs(p.x - (base.x - 0.058 * s)) * 230.0) + exp(-abs(p.x - base.x) * 250.0) + exp(-abs(p.x - (base.x + 0.058 * s)) * 230.0)) * domeDrum;
  float catwalk = 1.0 - smoothstep(0.0, 0.0028, sdCapsule(p, base + vec2(-0.136 * s, -0.002 * s), base + vec2(0.136 * s, -0.002 * s), 0.0032 * s));
  float apertureBloom = exp(-length((p - aperture) / (vec2(0.054, 0.030) * s)) * 13.0) * slitInside;
  float serviceLight = exp(-length((p - (base + vec2(-0.054 * s, 0.004 * s))) / (vec2(0.010, 0.006) * s)) * 38.0);
  float serviceLightB = exp(-length((p - (base + vec2(0.066 * s, -0.006 * s))) / (vec2(0.009, 0.005) * s)) * 42.0);
  float weathering = smoothstep(0.52, 0.92, fbm(vec2(p.x * 88.0 + 6.0, p.y * 44.0 + 3.0))) * (foundation + domeMask);
  float beamFacing = max(dot(normalize(aperture - p + vec2(0.0, 0.010)), normalize(dir + vec2(0.0, 0.14))), 0.0);`,
  )
  .replace(
    `vec3 concrete = vec3(0.006, 0.006, 0.012);
  vec3 domeSkin = vec3(0.007, 0.008, 0.016);`,
    `vec3 concrete = vec3(0.004, 0.004, 0.010);
  vec3 domeSkin = vec3(0.0045, 0.0055, 0.0130);`,
  )
  .replace(
    `over(col, silhouette, lowerDeck * 0.98);
  over(col, concrete, foundation * 0.94);
  over(col, domeSkin, domeMask * 0.96);`,
    `over(col, silhouette, lowerDeck * 0.98);
  over(col, concrete, foundation * 0.94);
  over(col, vec3(0.0035, 0.0040, 0.0095), domeDrum * 0.98);
  over(col, vec3(0.0020, 0.0024, 0.0060), domeSkirt * 0.92);
  over(col, domeSkin, domeMask * 0.96);`,
  )
  .replace(
    `col += vec3(0.052, 0.047, 0.078) * panels * 0.14;
  col += vec3(0.080, 0.076, 0.120) * domeRim * 0.055;
  col += vec3(0.075, 0.066, 0.105) * horizonRim * 0.045;
  col += mix(u_accent, vec3(0.86, 0.90, 1.0), 0.40) * domeSheen * 0.035;`,
    `col += vec3(0.064, 0.060, 0.090) * panels * 0.15;
  col += vec3(0.150, 0.142, 0.190) * domeRim * 0.120;
  col += vec3(0.075, 0.068, 0.100) * horizonRim * 0.035;
  col += vec3(0.110, 0.104, 0.148) * (domeMeridian + domeLatitude + domeLatitudeUpper + domePanelLeft + domePanelRight) * 0.125;
  col += vec3(0.090, 0.082, 0.120) * rotatorRing * 0.045;
  col += vec3(0.072, 0.066, 0.100) * drumPanels * 0.090;
  col += mix(u_accent, vec3(0.84, 0.92, 1.0), 0.42) * catwalk * 0.070;
  col -= vec3(0.012, 0.011, 0.018) * weathering * 0.045;
  col += mix(u_accent, vec3(0.92, 0.96, 1.0), 0.52) * apertureBloom * 0.310;
  col += vec3(0.95, 0.72, 0.42) * (serviceLight + serviceLightB * 0.82) * 0.360;
  col += mix(u_accent, vec3(0.86, 0.90, 1.0), 0.36) * domeSheen * 0.105;`,
  )
  .replace(
    `float summitPad = exp(-length((p - (obsBase - vec2(0.0, 0.020))) / vec2(0.145, 0.040)) * 4.2) * islandSolid;
  float anchorShadow = exp(-length((p - (obsBase - vec2(0.0, 0.034))) / vec2(0.170, 0.030)) * 5.0) * islandSolid;`,
    `float summitPad = exp(-length((p - (obsBase - vec2(0.0, 0.020))) / vec2(0.145, 0.040)) * 4.2) * islandSolid;
  float anchorShadow = exp(-length((p - (obsBase - vec2(0.0, 0.034))) / vec2(0.170, 0.030)) * 5.0) * islandSolid;
  float terrace = exp(-abs(p.y - (obsBase.y - 0.040)) * 48.0) * smoothstep(0.260, 0.034, abs(p.x - obsBase.x)) * islandSolid;
  float lowerTerrace = exp(-abs(p.y - (obsBase.y - 0.090)) * 38.0) * smoothstep(0.420, 0.105, abs(p.x - obsBase.x)) * cliffFace;
  float accessPath = exp(-abs(p.x - (obsBase.x - 0.040 * sin((p.y - water) * 9.0))) * 20.0) * cliffFace * smoothstep(0.02, 0.76, islandRise);
  float basaltRibs = exp(-abs(fract((p.x - obsBase.x) * 13.0 + fbm(vec2(p.y * 8.0, 4.0)) * 0.8) - 0.5) * 9.0) * cliffFace;
  float fractureLines = smoothstep(0.70, 0.98, fbm(vec2(p.x * 38.0 + 2.0, p.y * 72.0 + 8.0))) * cliffFace;
  float obsidianFacets = smoothstep(0.58, 0.94, fbm(vec2(p.x * 21.0 - 5.0, p.y * 33.0 + 12.0))) * cliffFace * smoothstep(0.0, 0.74, ridgeLight);
  float scaleLightA = exp(-length((p - (obsBase + vec2(-0.120, -0.058))) / vec2(0.008, 0.005)) * 38.0) * islandSolid;
  float scaleLightB = exp(-length((p - (obsBase + vec2(0.138, -0.076))) / vec2(0.008, 0.005)) * 38.0) * islandSolid;
  float scaleLightC = exp(-length((p - (obsBase + vec2(-0.030, -0.112))) / vec2(0.007, 0.004)) * 42.0) * islandSolid;`,
  )
  .replace(
    `mtn += vec3(0.026, 0.020, 0.034) * cliffFace;
  mtn += vec3(0.070, 0.058, 0.088) * cliffFace * cliffStrata * 0.16;
  mtn -= vec3(0.010, 0.008, 0.014) * cliffFace * cliffCuts * 0.24;`,
    `mtn += vec3(0.026, 0.020, 0.034) * cliffFace;
  mtn += vec3(0.085, 0.072, 0.110) * cliffFace * cliffStrata * 0.34;
  mtn += vec3(0.095, 0.086, 0.130) * basaltRibs * 0.095;
  mtn += vec3(0.120, 0.104, 0.150) * obsidianFacets * 0.120;
  mtn -= vec3(0.010, 0.008, 0.014) * cliffFace * cliffCuts * 0.24;
  mtn -= vec3(0.012, 0.010, 0.018) * fractureLines * 0.070;`,
  )
  .replace(
    `mtn += vec3(0.030, 0.028, 0.045) * summitPad * 0.55;
  mtn -= vec3(0.018, 0.016, 0.028) * anchorShadow * 0.46;`,
    `mtn += vec3(0.030, 0.028, 0.045) * summitPad * 0.55;
  mtn += vec3(0.118, 0.102, 0.150) * terrace * 0.250;
  mtn += vec3(0.082, 0.074, 0.112) * lowerTerrace * 0.180;
  mtn += mix(u_accent, vec3(0.82, 0.90, 1.0), 0.42) * accessPath * 0.105;
  mtn += vec3(0.95, 0.72, 0.42) * (scaleLightA + scaleLightB * 0.90 + scaleLightC * 0.72) * 0.220;
  mtn -= vec3(0.018, 0.016, 0.028) * anchorShadow * 0.46;`,
  )
  .replace(
    `float longWave = sin(x * 2.3 + u_time * 0.09) * 0.010;
  float crossWave = sin(x * 7.2 - u_time * 0.16) * 0.004;
  return -0.745 + longWave + crossWave + fbm(vec2(x * 1.8 + 12.0, u_time * 0.018)) * 0.010;`,
    `float longWave = sin(x * 2.3 + u_time * 0.09) * 0.014;
  float crossWave = sin(x * 7.2 - u_time * 0.16) * 0.006;
  return -0.660 + longWave + crossWave + fbm(vec2(x * 1.8 + 12.0, u_time * 0.018)) * 0.013;`,
  )
  .replace(
    `float waterBody = 1.0 - smoothstep(water - 0.010, water + 0.024, p.y);
  float openWater = waterBody * (1.0 - islandSolid * 0.98);
  float depthFade = clamp((water - p.y) / 0.42, 0.0, 1.0);
  float edgeFade = 1.0 - smoothstep(1.26, 1.62, abs(p.x));
  float perspective = clamp((water - p.y) / 0.42, 0.0, 1.0);
  vec2 rippleUv = vec2(p.x * 6.2 + u_time * 0.080, p.y * 30.0 - u_time * 0.135);
  float ripple = fbm(rippleUv);
  float longRipple = fbm(vec2(p.x * 2.0 - u_time * 0.030, p.y * 8.0 + 7.0));
  float microRipple = noise(vec2(p.x * 84.0 + u_time * 0.42, p.y * 160.0 + longRipple * 3.4));`,
    `float waterBody = 1.0 - smoothstep(water - 0.014, water + 0.034, p.y);
  float openWater = waterBody * (1.0 - islandSolid * 0.98);
  float depthFade = clamp((water - p.y) / 0.50, 0.0, 1.0);
  float edgeFade = 1.0 - smoothstep(1.28, 1.68, abs(p.x));
  float perspective = clamp((water - p.y) / 0.50, 0.0, 1.0);
  vec2 rippleUv = vec2(p.x * 5.2 + u_time * 0.075, p.y * 24.0 - u_time * 0.125);
  float ripple = fbm(rippleUv);
  float longRipple = fbm(vec2(p.x * 1.6 - u_time * 0.028, p.y * 6.5 + 7.0));
  float crossCurrent = fbm(vec2(p.x * 4.6 + u_time * 0.052, p.y * 15.0 - u_time * 0.090));
  float microRipple = noise(vec2(p.x * 74.0 + u_time * 0.34, p.y * 138.0 + longRipple * 3.4 + crossCurrent));`,
  )
  .replace(
    `vec2 reflectedUv = vec2(
    uv.x + (ripple - 0.5) * 0.052 + (microRipple - 0.5) * 0.007,
    0.48 + perspective * 0.64 + (ripple - 0.5) * 0.040
  );`,
    `vec2 reflectedUv = vec2(
    uv.x + (ripple - 0.5) * 0.070 + (microRipple - 0.5) * 0.010 + (crossCurrent - 0.5) * 0.018,
    0.38 + pow(perspective, 0.82) * 0.70 + (ripple - 0.5) * 0.052
  );`,
  )
  .replace(
    `float mirrorBand = smoothstep(0.12, 0.82, skyReflection.b + skyReflection.r * 0.62);
  float waterSheen = openWater * edgeFade * (0.62 + depthFade * 0.48);
  float waterline = exp(-pow((p.y - water) * 90.0, 2.0)) * edgeFade;
  vec3 waterBase = vec3(0.0016, 0.0040, 0.0135);
  waterBase += vec3(0.004, 0.018, 0.026) * longRipple * 0.34;
  waterBase += vec3(0.020, 0.015, 0.037) * smoothstep(0.30, 0.95, ripple) * 0.12;
  col = mix(col, waterBase, waterSheen * 0.92);`,
    `float skyEnergy = max(max(skyReflection.r, skyReflection.g), skyReflection.b);
  float mirrorBand = smoothstep(0.055, 0.34, skyEnergy);
  float waterSheen = openWater * edgeFade * (0.92 + depthFade * 0.74);
  float waterline = exp(-pow((p.y - water) * 70.0, 2.0)) * edgeFade;
  float horizonMirror = exp(-pow((p.y - water + 0.046) * 11.0, 2.0)) * edgeFade;
  vec3 waterBase = vec3(0.0026, 0.0100, 0.0260);
  waterBase += vec3(0.010, 0.036, 0.054) * longRipple * 0.50;
  waterBase += vec3(0.045, 0.032, 0.074) * smoothstep(0.20, 0.94, ripple) * 0.23;
  waterBase += vec3(0.018, 0.040, 0.062) * crossCurrent * 0.23;
  col = mix(col, waterBase, clamp(waterSheen, 0.0, 1.0));
  col += skyReflection * horizonMirror * openWater * (0.30 + mirrorBand * 0.34);`,
  )
  .replace(
    `float shimmer = smoothstep(0.58, 0.99, noise(vec2(p.x * 128.0 - u_time * 1.05, p.y * 32.0 + ripple * 3.4)));
  float waveLines = exp(-abs(fract((water - p.y) * 46.0 + ripple * 1.8 - u_time * 0.42) - 0.5) * 18.0);
  float waveGrid = smoothstep(0.88, 1.0, noise(vec2(p.x * 48.0 + u_time * 0.22, p.y * 92.0 - u_time * 0.52)));`,
    `float shimmer = smoothstep(0.52, 0.98, noise(vec2(p.x * 128.0 - u_time * 1.05, p.y * 32.0 + ripple * 3.4)));
  float waveLines = exp(-abs(fract((water - p.y) * 42.0 + ripple * 1.8 + crossCurrent * 0.7 - u_time * 0.42) - 0.5) * 14.0);
  float mirrorLines = exp(-abs(fract((water - p.y) * 31.0 + longRipple * 2.2 - u_time * 0.20) - 0.5) * 10.0);
  float waveGrid = smoothstep(0.84, 1.0, noise(vec2(p.x * 48.0 + u_time * 0.22, p.y * 92.0 - u_time * 0.52)));`,
  )
  .replace(
    `float cometEnergy = max(max(cometReflection.r, cometReflection.g), cometReflection.b);

  col += skyReflection * waterSheen * (0.125 + mirrorBand * 0.215);
  col += cometReflection * waterSheen * (0.210 + shimmer * 0.090 + waveLines * 0.038);
  col += vec3(0.83, 0.77, 1.0) * waterline * waterSheen * 0.132;
  col += mix(vec3(0.35, 0.75, 0.68), vec3(0.83, 0.77, 1.0), 0.38) * caustic * (0.180 + cometEnergy * 0.18);
  col += u_accent * waterSheen * (beamReflection * (0.135 + shimmer * 0.105) + pool * 0.145 + domeColumn * (0.090 + domeBroken * 0.055));
  col += mix(u_accent, vec3(0.72, 0.84, 1.0), 0.40) * waterSheen * waveLines * (0.024 + pool * 0.044 + beamReflection * 0.060);`,
    `float cometEnergy = max(max(cometReflection.r, cometReflection.g), cometReflection.b);
  float galaxyWake = mirrorBand * waterSheen * smoothstep(0.08, 0.88, perspective);
  float reflectedDust = smoothstep(0.18, 0.72, fbm(vec2(reflectedUv.x * 9.0 + u_time * 0.010, reflectedUv.y * 5.5)));
  float starGlints = smoothstep(0.975, 1.0, noise(vec2(p.x * 220.0 + u_time * 0.30, p.y * 118.0 + ripple * 8.0))) * galaxyWake;
  vec3 milkyMirror = mix(vec3(0.26, 0.38, 0.58), vec3(0.72, 0.52, 0.86), smoothstep(0.08, 0.55, skyReflection.r + skyReflection.b));

  col += skyReflection * waterSheen * (0.340 + mirrorBand * 0.520);
  col += milkyMirror * galaxyWake * mirrorLines * (0.095 + reflectedDust * 0.145);
  col += cometReflection * waterSheen * (0.260 + shimmer * 0.105 + waveLines * 0.070 + mirrorLines * 0.044);
  col += vec3(0.83, 0.77, 1.0) * waterline * waterSheen * 0.230;
  col += mix(vec3(0.35, 0.75, 0.68), vec3(0.83, 0.77, 1.0), 0.38) * caustic * (0.310 + cometEnergy * 0.18 + mirrorBand * 0.18);
  col += u_accent * waterSheen * (beamReflection * (0.170 + shimmer * 0.150) + pool * 0.195 + domeColumn * (0.130 + domeBroken * 0.090));
  col += mix(u_accent, vec3(0.72, 0.84, 1.0), 0.40) * waterSheen * waveLines * (0.052 + pool * 0.066 + beamReflection * 0.092);
  col += mix(vec3(0.82, 0.86, 1.0), milkyMirror, 0.46) * starGlints * (0.086 + mirrorLines * 0.084);`,
  )
  .replace(
    `vec3 cometReflection = renderComets(reflectedUv + vec2((microRipple - 0.5) * 0.009, (ripple - 0.5) * 0.016), 0.90);`,
    `vec3 cometReflection = renderComets(reflectedUv + vec2((microRipple - 0.5) * 0.012, (ripple - 0.5) * 0.020), 0.95);`,
  );

const BRIGHT = "#version 300 es\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\nuniform sampler2D u_tex;\nvoid main() {\n  vec3 c = texture(u_tex, v_uv).rgb;\n  float l = max(max(c.r, c.g), c.b);\n  float m = smoothstep(0.12, 0.58, l);\n  fragColor = vec4(c * m, 1.0);\n}";

const BRIGHT_PUNCH = BRIGHT.replace('float m = smoothstep(0.12, 0.58, l);', 'float m = smoothstep(0.34, 1.08, l);');

const BLUR = "#version 300 es\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\nuniform sampler2D u_tex;\nuniform vec2 u_texel;\nuniform vec2 u_dir;\nvoid main() {\n  vec2 o = u_texel * u_dir;\n  vec3 c = texture(u_tex, v_uv).rgb * 0.227027;\n  c += texture(u_tex, v_uv + o * 1.384615).rgb * 0.316216;\n  c += texture(u_tex, v_uv - o * 1.384615).rgb * 0.316216;\n  c += texture(u_tex, v_uv + o * 3.230769).rgb * 0.070270;\n  c += texture(u_tex, v_uv - o * 3.230769).rgb * 0.070270;\n  fragColor = vec4(c, 1.0);\n}";

const DOWN = "#version 300 es\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\nuniform sampler2D u_tex;\nuniform vec2 u_texel;\nvoid main() {\n  vec3 c = texture(u_tex, v_uv).rgb * 0.36;\n  c += texture(u_tex, v_uv + u_texel * vec2( 1.0,  0.0)).rgb * 0.13;\n  c += texture(u_tex, v_uv + u_texel * vec2(-1.0,  0.0)).rgb * 0.13;\n  c += texture(u_tex, v_uv + u_texel * vec2( 0.0,  1.0)).rgb * 0.13;\n  c += texture(u_tex, v_uv + u_texel * vec2( 0.0, -1.0)).rgb * 0.13;\n  c += texture(u_tex, v_uv + u_texel * vec2( 1.0,  1.0)).rgb * 0.055;\n  c += texture(u_tex, v_uv + u_texel * vec2(-1.0,  1.0)).rgb * 0.055;\n  c += texture(u_tex, v_uv + u_texel * vec2( 1.0, -1.0)).rgb * 0.055;\n  c += texture(u_tex, v_uv + u_texel * vec2(-1.0, -1.0)).rgb * 0.055;\n  fragColor = vec4(c, 1.0);\n}";

const COMP = "#version 300 es\nprecision highp float;\nin vec2 v_uv;\nout vec4 fragColor;\nuniform sampler2D u_scene;\nuniform sampler2D u_bloom0;\nuniform sampler2D u_bloom1;\nuniform sampler2D u_bloom2;\nuniform sampler2D u_bloom3;\nuniform vec2 u_resolution;\nuniform float u_time;\n\nfloat hash12(vec2 p) {\n  vec3 p3 = fract(vec3(p.xyx) * 0.1031);\n  p3 += dot(p3, p3.yzx + 33.33);\n  return fract((p3.x + p3.y) * p3.z);\n}\n\nvoid main() {\n  vec2 uv = v_uv;\n  vec2 c = uv - 0.5;\n  vec2 ca = c * 0.0010;\n  vec3 scene;\n  scene.r = texture(u_scene, uv + ca).r;\n  scene.g = texture(u_scene, uv).g;\n  scene.b = texture(u_scene, uv - ca).b;\n  vec2 px = 1.0 / u_resolution;\n  vec3 neighbor = (\n    texture(u_scene, uv + vec2( px.x, 0.0)).rgb +\n    texture(u_scene, uv + vec2(-px.x, 0.0)).rgb +\n    texture(u_scene, uv + vec2(0.0,  px.y)).rgb +\n    texture(u_scene, uv + vec2(0.0, -px.y)).rgb\n  ) * 0.25;\n  scene = max(scene + (scene - neighbor) * 0.115, vec3(0.0));\n  vec3 bloom =\n    texture(u_bloom0, uv).rgb * 0.84 +\n    texture(u_bloom1, uv).rgb * 0.66 +\n    texture(u_bloom2, uv).rgb * 0.52 +\n    texture(u_bloom3, uv).rgb * 0.42;\n  vec3 hdr = scene + bloom * 1.66;\n  vec3 mapped = vec3(1.0) - exp(-hdr * 1.48);\n  mapped = pow(mapped, vec3(0.92));\n  float vignette = smoothstep(0.92, 0.22, length(c * vec2(1.16, 1.0)));\n  mapped *= mix(0.50, 1.05, vignette);\n  fragColor = vec4(clamp(mapped, 0.0, 1.0), 1.0);\n}";

const COMP_PUNCH = COMP
  .replace('scene = max(scene + (scene - neighbor) * 0.115, vec3(0.0));', 'scene = max(scene + (scene - neighbor) * 0.085, vec3(0.0));')
  .replace(
    `vec3 bloom =
    texture(u_bloom0, uv).rgb * 0.84 +
    texture(u_bloom1, uv).rgb * 0.66 +
    texture(u_bloom2, uv).rgb * 0.52 +
    texture(u_bloom3, uv).rgb * 0.42;`,
    `vec3 bloom =
    texture(u_bloom0, uv).rgb * 0.42 +
    texture(u_bloom1, uv).rgb * 0.30 +
    texture(u_bloom2, uv).rgb * 0.20 +
    texture(u_bloom3, uv).rgb * 0.12;`,
  )
  .replace(
    `vec3 hdr = scene + bloom * 1.66;
  vec3 mapped = vec3(1.0) - exp(-hdr * 1.48);
  mapped = pow(mapped, vec3(0.92));`,
    `vec3 hdr = scene + bloom * 0.74;
  vec3 mapped = vec3(1.0) - exp(-hdr * 1.18);
  mapped = pow(mapped, vec3(0.98));
  mapped = smoothstep(vec3(0.010), vec3(1.0), mapped);`,
  )
  .replace('mapped *= mix(0.50, 1.05, vignette);', 'mapped *= mix(0.58, 1.08, vignette);');

export type ArtifactObservatoryRenderTarget = {
  x: number;
  y: number;
  accent: string;
};

export type ArtifactObservatoryRenderer = {
  update(target: ArtifactObservatoryRenderTarget): void;
  dispose(): void;
};

type RenderTarget = {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
};

type Rgb = { r: number; g: number; b: number };

const RENDER_SUPERSAMPLE = 1.35;
const MAX_RENDER_DPR = 3.25;
const BLOOM_LEVELS = 4;
const TARGET_FRAME_MS = 1000 / 45;

export function createArtifactObservatoryRenderer(
  canvas: HTMLCanvasElement,
  initialTarget: ArtifactObservatoryRenderTarget,
): ArtifactObservatoryRenderer | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });

  if (!gl) {
    return null;
  }

  let width = 1;
  let height = 1;
  let targets: RenderTarget[] = [];
  let bloomA: RenderTarget[] = [];
  let bloomB: RenderTarget[] = [];
  let animationFrame = 0;
  let lastNow = 0;
  let lastFrameMs = 0;
  let disposed = false;
  let mouse = { x: 0.5, y: 0.5 };
  const currentTarget = { x: initialTarget.x, y: initialTarget.y };
  let desiredTarget = { x: initialTarget.x, y: initialTarget.y };
  const currentAccent = hexToRgb(initialTarget.accent);
  let desiredAccent = hexToRgb(initialTarget.accent);

  const hdrSupported = Boolean(gl.getExtension('EXT_color_buffer_float'));
  const programInfo = makePrograms(gl);
  if (!programInfo) {
    return null;
  }

  const { progScene, progBright, progBlur, progDown, progComp, vao } = programInfo;

  const resize = () => {
    const deviceDpr = window.devicePixelRatio || 1;
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number || 8192;
    const maxWidthScale = maxTextureSize / Math.max(window.innerWidth, 1);
    const maxHeightScale = maxTextureSize / Math.max(window.innerHeight, 1);
    const textureSafeDpr = Math.max(1, Math.min(maxWidthScale, maxHeightScale) * 0.96);
    const dpr = Math.min(deviceDpr * RENDER_SUPERSAMPLE, MAX_RENDER_DPR, textureSafeDpr);
    width = Math.max(1, Math.floor(window.innerWidth * dpr));
    height = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    targets.forEach((target) => destroyTarget(gl, target));
    bloomA.forEach((target) => destroyTarget(gl, target));
    bloomB.forEach((target) => destroyTarget(gl, target));
    targets = [makeTarget(gl, width, height, hdrSupported)];
    bloomA = [];
    bloomB = [];
    let w = Math.max(2, Math.floor(width / 2));
    let h = Math.max(2, Math.floor(height / 2));
    for (let index = 0; index < BLOOM_LEVELS; index += 1) {
      bloomA.push(makeTarget(gl, w, h, hdrSupported));
      bloomB.push(makeTarget(gl, w, h, hdrSupported));
      w = Math.max(2, Math.floor(w / 2));
      h = Math.max(2, Math.floor(h / 2));
    }
  };

  const drawTo = (prog: WebGLProgram, target: RenderTarget | null) => {
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const bindTexture = (unit: number, texture: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  };

  const render = (now: number) => {
    if (disposed) return;
    if (now - lastFrameMs < TARGET_FRAME_MS) {
      animationFrame = window.requestAnimationFrame(render);
      return;
    }
    lastFrameMs = now;
    const t = now * 0.001;
    const dt = Math.min(0.06, Math.max(0.0, t - lastNow));
    lastNow = t;
    const follow = 1.0 - Math.pow(0.018, dt);
    currentTarget.x += (desiredTarget.x - currentTarget.x) * follow;
    currentTarget.y += (desiredTarget.y - currentTarget.y) * follow;
    currentAccent.r += (desiredAccent.r - currentAccent.r) * follow;
    currentAccent.g += (desiredAccent.g - currentAccent.g) * follow;
    currentAccent.b += (desiredAccent.b - currentAccent.b) * follow;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.useProgram(progScene);
    gl.uniform2f(gl.getUniformLocation(progScene, 'u_resolution'), width, height);
    gl.uniform1f(gl.getUniformLocation(progScene, 'u_time'), t);
    gl.uniform2f(gl.getUniformLocation(progScene, 'u_mouse'), mouse.x, mouse.y);
    gl.uniform2f(gl.getUniformLocation(progScene, 'u_target'), currentTarget.x, currentTarget.y);
    gl.uniform3f(gl.getUniformLocation(progScene, 'u_accent'), currentAccent.r, currentAccent.g, currentAccent.b);
    drawTo(progScene, targets[0]);

    gl.useProgram(progBright);
    bindTexture(0, targets[0].tex);
    gl.uniform1i(gl.getUniformLocation(progBright, 'u_tex'), 0);
    drawTo(progBright, bloomA[0]);

    for (let index = 0; index < bloomA.length; index += 1) {
      if (index > 0) {
        gl.useProgram(progDown);
        bindTexture(0, bloomA[index - 1].tex);
        gl.uniform1i(gl.getUniformLocation(progDown, 'u_tex'), 0);
        gl.uniform2f(gl.getUniformLocation(progDown, 'u_texel'), 1 / bloomA[index - 1].w, 1 / bloomA[index - 1].h);
        drawTo(progDown, bloomA[index]);
      }
      gl.useProgram(progBlur);
      bindTexture(0, bloomA[index].tex);
      gl.uniform1i(gl.getUniformLocation(progBlur, 'u_tex'), 0);
      gl.uniform2f(gl.getUniformLocation(progBlur, 'u_texel'), 1 / bloomA[index].w, 1 / bloomA[index].h);
      gl.uniform2f(gl.getUniformLocation(progBlur, 'u_dir'), 1, 0);
      drawTo(progBlur, bloomB[index]);

      gl.useProgram(progBlur);
      bindTexture(0, bloomB[index].tex);
      gl.uniform1i(gl.getUniformLocation(progBlur, 'u_tex'), 0);
      gl.uniform2f(gl.getUniformLocation(progBlur, 'u_texel'), 1 / bloomB[index].w, 1 / bloomB[index].h);
      gl.uniform2f(gl.getUniformLocation(progBlur, 'u_dir'), 0, 1);
      drawTo(progBlur, bloomA[index]);
    }

    gl.useProgram(progComp);
    bindTexture(0, targets[0].tex);
    bindTexture(1, bloomA[0].tex);
    bindTexture(2, bloomA[1].tex);
    bindTexture(3, bloomA[2].tex);
    bindTexture(4, bloomA[3].tex);
    gl.uniform1i(gl.getUniformLocation(progComp, 'u_scene'), 0);
    gl.uniform1i(gl.getUniformLocation(progComp, 'u_bloom0'), 1);
    gl.uniform1i(gl.getUniformLocation(progComp, 'u_bloom1'), 2);
    gl.uniform1i(gl.getUniformLocation(progComp, 'u_bloom2'), 3);
    gl.uniform1i(gl.getUniformLocation(progComp, 'u_bloom3'), 4);
    gl.uniform2f(gl.getUniformLocation(progComp, 'u_resolution'), width, height);
    gl.uniform1f(gl.getUniformLocation(progComp, 'u_time'), t);
    drawTo(progComp, null);

    animationFrame = window.requestAnimationFrame(render);
  };

  const handleMouseMove = (event: MouseEvent) => {
    mouse = {
      x: event.clientX / Math.max(window.innerWidth, 1),
      y: event.clientY / Math.max(window.innerHeight, 1),
    };
  };

  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', handleMouseMove);
  resize();
  animationFrame = window.requestAnimationFrame(render);

  return {
    update(target: ArtifactObservatoryRenderTarget) {
      desiredTarget = { x: target.x, y: target.y };
      desiredAccent = hexToRgb(target.accent);
    },
    dispose() {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', handleMouseMove);
      targets.forEach((target) => destroyTarget(gl, target));
      bloomA.forEach((target) => destroyTarget(gl, target));
      bloomB.forEach((target) => destroyTarget(gl, target));
      gl.deleteVertexArray(vao);
      gl.deleteProgram(progScene);
      gl.deleteProgram(progBright);
      gl.deleteProgram(progBlur);
      gl.deleteProgram(progDown);
      gl.deleteProgram(progComp);
    },
  };
}

function makePrograms(gl: WebGL2RenderingContext) {
  try {
    const progScene = program(gl, VERT, SCENE_PUNCH);
    const progBright = program(gl, VERT, BRIGHT_PUNCH);
    const progBlur = program(gl, VERT, BLUR);
    const progDown = program(gl, VERT, DOWN);
    const progComp = program(gl, VERT, COMP_PUNCH);
    const vao = gl.createVertexArray();
    if (!vao) return null;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { progScene, progBright, progBlur, progDown, progComp, vao };
  } catch {
    return null;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Shader allocation failed');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || 'Shader compile failed');
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) {
    throw new Error('Program allocation failed');
  }
  const vertexShader = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(prog, vertexShader);
  gl.attachShader(prog, fragmentShader);
  gl.bindAttribLocation(prog, 0, 'a_position');
  gl.linkProgram(prog);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(log || 'Program link failed');
  }
  return prog;
}

function makeTarget(gl: WebGL2RenderingContext, w: number, h: number, hdr: boolean): RenderTarget {
  const tex = gl.createTexture();
  if (!tex) {
    throw new Error('Texture allocation failed');
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const internal = hdr ? gl.RGBA16F : gl.RGBA;
  const format = gl.RGBA;
  const type = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  if (!fbo) {
    throw new Error('Framebuffer allocation failed');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo, w, h };
}

function destroyTarget(gl: WebGL2RenderingContext, target: RenderTarget) {
  gl.deleteTexture(target.tex);
  gl.deleteFramebuffer(target.fbo);
}

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const value = Number.parseInt(clean, 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}
