import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { chromium, type Browser } from "playwright";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AudioResolver } from "../src/audio.js";
import { buildVoiceLabInitScript } from "../src/browser-init.js";
import { testConfig } from "./helpers.js";
import { espeakLikeWav } from "./tts-silence-helper.js";

// The deployed product client, not a reimplementation: these declarations are
// extracted verbatim from the frontend source and only type-stripped.
const PRODUCT_SOURCE = path.resolve(process.cwd(), "../../frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts");
const PRODUCT_FUNCTIONS = ["startMicrophoneAudioPipeline", "pcm16Base64FromFloat32", "bytesToBase64", "base64ToBytes", "estimatePcm16ByteLength", "shouldEmitInputAudioFrameDiagnostic"];
const PRODUCT_CONSTANTS = ["INPUT_AUDIO_RATE_HZ", "WEBSOCKET_OPEN"];
const LIVE_CONTEXT_RATE = 44_100; // observed live: 4096-sample buffers -> 1486 samples -> 2972-byte frames

async function productPipelineScript(): Promise<string> {
  const file = ts.createSourceFile(PRODUCT_SOURCE, await readFile(PRODUCT_SOURCE, "utf8"), ts.ScriptTarget.ES2022, true);
  const found = new Map<string, string>();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && PRODUCT_FUNCTIONS.includes(statement.name.text)) found.set(statement.name.text, statement.getText(file));
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && PRODUCT_CONSTANTS.includes(declaration.name.text)) found.set(declaration.name.text, statement.getText(file));
    }
  }
  expect([...found.keys()].sort()).toEqual([...PRODUCT_FUNCTIONS, ...PRODUCT_CONSTANTS].sort());
  const source = [...found.values()].map((text) => text.replace(/^export\s+/, "")).join("\n");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return `window.__productPipeline = (() => { ${js}\n return { startMicrophoneAudioPipeline }; })();`;
}

describe("real Chromium product stream shape for a synthesized utterance", () => {
  let server: Server;
  let browser: Browser;
  let origin: string;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>tail</title>"); });
    server.on("upgrade", (request, socket) => {
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") { socket.destroy(); return; }
      sockets.add(socket);
      socket.on("data", () => undefined);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")}\r\n\r\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    origin = `http://127.0.0.1:${address.port}`;
    const preferred = chromium.executablePath();
    const revision = preferred.match(/chromium_headless_shell-(\d+)/)?.[1];
    const cacheRoot = path.dirname(path.dirname(path.dirname(preferred)));
    const executablePath = [preferred, ...(revision ? [
      path.join(cacheRoot, `chromium-${revision}`, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      path.join(cacheRoot, `chromium-${revision}`, "chrome-linux", "chrome"),
      path.join(cacheRoot, `chromium-${revision}`, "chrome-linux64", "chrome"),
    ] : [])].find(existsSync);
    if (!executablePath) throw new Error(`Pinned Chromium executable is unavailable (expected ${preferred}).`);
    browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }, 30_000);

  it("forwards at least 1.5 s of trailing silence before exactly one audioStreamEnd", async () => {
    // Resolve through the real Lab resolver; only espeak itself is replaced by
    // its observed live shape (speech, then ~186 ms of zero PCM).
    const resolver = new AudioResolver(testConfig({ SOPHIA_VOICE_LAB_ESPEAK_VERSION: "9.9" }), async () => espeakLikeWav(2_500, 186), async () => "9.9");
    await resolver.initialize();
    const audio = await resolver.resolve({ text: "governed synthetic utterance" });
    const wsOrigin = origin.replace("http://", "ws://");
    const context = await browser.newContext();
    await context.addInitScript({ content: buildVoiceLabInitScript({ pageOrigin: origin, websocketOrigins: [wsOrigin], maxAudioBytes: 2_000_000, testRunId: "00000000-0000-4000-8000-000000000011", cleanupObligationId: "00000000-0000-4000-8000-000000000012" }) });
    const page = await context.newPage();
    await page.goto(origin);
    await page.addScriptTag({ content: await productPipelineScript() });
    const contextRate = await page.evaluate(async ({ wsUrl, rate }) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const audioContext = new AudioContext({ sampleRate: rate });
      await audioContext.resume();
      const socket = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("open failed")), { once: true }); });
      // Phase-only adapter over the actual Lab boundary events. The product
      // pipeline gates forwarding on nothing but this binding's phase.
      let latest: Record<string, unknown> | null = null;
      addEventListener("sophia:voice-lab-input-operation", (event) => { latest = { ...(event as CustomEvent).detail }; });
      const syntheticInputEvidence = { currentBinding: () => latest, observePcmFrame: () => null };
      (window as any).__pipeline = (window as any).__productPipeline.startMicrophoneAudioPipeline({ localStream: stream, audioContext, websocketRef: { current: socket }, syntheticInputEvidence });
      return audioContext.sampleRate;
    }, { wsUrl: wsOrigin, rate: LIVE_CONTEXT_RATE });
    expect(contextRate).toBe(LIVE_CONTEXT_RATE);
    const operationId = "tail-op-1";
    await page.evaluate((request) => (window as any).__sophiaVoiceLab.schedule(request),
      { operationId, utteranceId: "tail-utt-1", audioBase64: audio.bytes.toString("base64"), sha256: audio.sha256, delayMs: 10 });
    await page.waitForFunction(() => (window as any).__sophiaVoiceLab.drain(0).events.some((event: any) => event.kind === "harness.provider_audio_stream_end_sent"), undefined, { timeout: 20_000 });
    await page.waitForTimeout(600);
    const events = await page.evaluate(() => (window as any).__sophiaVoiceLab.drain(0).events as Array<{ seq: number; kind: string; payload: Record<string, any> }>);
    await context.close();

    const frames = events.filter((event) => event.kind === "harness.input_frame_forwarded" && event.payload.operation_id === operationId)
      .sort((a, b) => a.payload.frame_seq - b.payload.frame_seq);
    expect(frames.length).toBeGreaterThan(20);
    expect(new Set(frames.map((frame) => frame.payload.byte_length))).toEqual(new Set([2_972]));
    let trailing = 0;
    for (const frame of [...frames].reverse()) {
      if (frame.payload.nonzero_byte_count > 0.05 * frame.payload.byte_length) break;
      trailing += 1;
    }
    // Ordered wire census: every audio frame precedes the one stream end.
    const wire = events.filter((event) => event.kind === "harness.provider_frame_sent").map((event) => event.payload.realtime_input_kind);
    const ends = events.filter((event) => event.kind === "harness.provider_audio_stream_end_sent");
    process.stdout.write(`[C034 stream] frames=${frames.length} trailing_near_zero=${trailing} (~${Math.round(trailing * 4_096 / LIVE_CONTEXT_RATE * 1_000)} ms) stream_ends=${ends.length} tail_ms=${audio.synthesis.trailing_silence_ms ?? "none"}\n`);
    expect(ends).toHaveLength(1);
    expect(wire.lastIndexOf("audio")).toBeLessThan(wire.indexOf("audioStreamEnd"));
    expect(wire.filter((kind) => kind === "audioStreamEnd")).toHaveLength(1);
    expect(wire.every((kind) => kind === "audio" || kind === "audioStreamEnd")).toBe(true);
    expect(trailing).toBeGreaterThanOrEqual(16);
  }, 45_000);
});
