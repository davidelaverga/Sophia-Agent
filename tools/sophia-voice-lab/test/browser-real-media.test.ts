import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildVoiceLabInitScript } from "../src/browser-init.js";
import { PlaywrightVoiceDriver, resolveDashboardMicButton } from "../src/browser-driver.js";

function sineWav(durationMs = 600, sampleRate = 16_000): Buffer {
  const samples = Math.floor(sampleRate * durationMs / 1_000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 14_000), 44 + index * 2);
  return bytes;
}

describe("real Chromium dynamic media contract", () => {
  let server: Server;
  let browser: Browser;
  let origin: string;
  let executablePath: string;
  const upgradedSockets = new Set<Socket>();

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end("<!doctype html><meta charset=utf-8><title>voice-lab-media-contract</title>");
    });
    server.on("upgrade", (request, socket) => {
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") { socket.destroy(); return; }
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      upgradedSockets.add(socket);
      socket.once("close", () => upgradedSockets.delete(socket));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    origin = `http://127.0.0.1:${address.port}`;
    const preferred = chromium.executablePath();
    const revision = preferred.match(/chromium_headless_shell-(\d+)/)?.[1];
    const cacheRoot = path.dirname(path.dirname(path.dirname(preferred)));
    const candidates = [
      preferred,
      ...(revision ? [
        path.join(cacheRoot, `chromium-${revision}`, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        path.join(cacheRoot, `chromium-${revision}`, "chrome-linux", "chrome"),
        path.join(cacheRoot, `chromium-${revision}`, "chrome-linux64", "chrome"),
      ] : []),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
    executablePath = candidates.find(existsSync) ?? "";
    if (!executablePath) throw new Error(`Pinned Chromium executable is unavailable (expected ${preferred}).`);
    browser = await chromium.launch({ executablePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    for (const socket of upgradedSockets) socket.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }, 30_000);

  it("resolves the dashboard mic button from the onboarding anchor's sibling structure", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.setContent(`
      <div>
        <span data-onboarding="mic-cta" aria-hidden="true"></span>
        <button type="button" aria-label="Connecting to Sophia">microphone</button>
      </div>
    `);
    const button = await resolveDashboardMicButton(page, page.locator('[data-onboarding="mic-cta"]'));
    expect(await button.getAttribute("aria-label")).toBe("Connecting to Sophia");
    await context.close();
  });

  it("injects through a real MediaStream consumer with no native gUM and proves forwarded PCM", async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      (window as any).__nativeGumCalls = 0;
      const mediaDevices = navigator.mediaDevices;
      const native = mediaDevices.getUserMedia.bind(mediaDevices);
      Object.defineProperty(mediaDevices, "getUserMedia", { configurable: true, writable: true, value: (...args: Parameters<typeof native>) => { (window as any).__nativeGumCalls += 1; return native(...args); } });
    });
    await context.addInitScript({ content: buildVoiceLabInitScript({ pageOrigin: origin, websocketOrigins: [origin.replace("http://", "ws://")], maxAudioBytes: 1_000_000, testRunId: "00000000-0000-4000-8000-000000000001", cleanupObligationId: "00000000-0000-4000-8000-000000000002" }) });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(() => {
      const mediaDevices = navigator.mediaDevices;
      const synthetic = mediaDevices.getUserMedia.bind(mediaDevices);
      (window as any).__productMediaObserverCalls = 0;
      mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
        const stream = await synthetic(constraints);
        (window as any).__productMediaObserverCalls += 1;
        return stream;
      };
    });
    await page.evaluate(async (wsUrl) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const consumer = new AudioContext({ latencyHint: "interactive" });
      await consumer.resume();
      const source = consumer.createMediaStreamSource(stream);
      const analyser = consumer.createAnalyser();
      const processor = consumer.createScriptProcessor(1024, 1, 1);
      source.connect(analyser); analyser.connect(processor); processor.connect(consumer.destination);
      const socket = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true }); });
      (window as any).__realMedia = { consumer, source, analyser, processor, socket, nonzeroCallbacks: 0 };
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let peak = 0;
        for (const value of input) peak = Math.max(peak, Math.abs(value));
        if (peak < 0.001) return;
        (window as any).__realMedia.nonzeroCallbacks += 1;
        const pcm = new Int16Array(input.length);
        for (let index = 0; index < input.length; index += 1) pcm[index] = Math.max(-32768, Math.min(32767, Math.round(input[index]! * 32767)));
        const raw = new Uint8Array(pcm.buffer);
        let binary = "";
        for (const byte of raw) binary += String.fromCharCode(byte);
        socket.send(JSON.stringify({ realtimeInput: { audio: { data: btoa(binary), mimeType: "audio/pcm;rate=16000" } } }));
      };
    }, origin.replace("http://", "ws://"));

    const wav = sineWav();
    const digest = createHash("sha256").update(wav).digest("hex");
    const receipt = await page.evaluate(async ({ audioBase64, sha256 }) => (window as any).__sophiaVoiceLab.schedule({ operationId: "real-op-1", utteranceId: "real-utt-1", audioBase64, sha256, delayMs: 80 }), { audioBase64: wav.toString("base64"), sha256: digest });
    expect(receipt.kind).toBe("audio.input.scheduled");
    await page.waitForFunction(() => {
      const events = (window as any).__sophiaVoiceLab.drain(0).events;
      return events.some((event: any) => event.kind === "audio.input.completed") && events.some((event: any) => event.kind === "harness.input_frame_forwarded");
    }, undefined, { timeout: 15_000 });
    const result = await page.evaluate(() => ({ nativeCalls: (window as any).__nativeGumCalls, productMediaObserverCalls: (window as any).__productMediaObserverCalls, nonzeroCallbacks: (window as any).__realMedia.nonzeroCallbacks, events: (window as any).__sophiaVoiceLab.drain(0).events }));
    expect(result.nativeCalls).toBe(0);
    expect(result.productMediaObserverCalls).toBe(1);
    expect(result.nonzeroCallbacks).toBeGreaterThan(0);
    expect(result.events.filter((event: any) => event.kind === "harness.media_stream_issued")).toHaveLength(1);
    expect(result.events.filter((event: any) => event.kind === "audio.input.started")).toHaveLength(1);
    expect(result.events.filter((event: any) => event.kind === "audio.input.completed")).toHaveLength(1);
    expect(result.events.filter((event: any) => ["audio.input.interrupted", "audio.input.rejected"].includes(event.kind))).toHaveLength(0);
    const forwarded = result.events.filter((event: any) => event.kind === "harness.input_frame_forwarded");
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded.every((event: any) => event.payload.operation_id === "real-op-1" && event.payload.utterance_id === "real-utt-1" && /^[a-f0-9]{64}$/.test(event.payload.sha256) && !Object.hasOwn(event.payload, "data"))).toBe(true);
    const rotation = await page.evaluate(() => (window as any).__sophiaVoiceLab.rotate());
    expect(rotation.kind).toBe("harness.socket_rotation_requested");
    const cameraDenied = await page.evaluate(async () => {
      try { await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); return false; }
      catch (error) { return error instanceof DOMException && error.name === "NotAllowedError"; }
    });
    expect(cameraDenied).toBe(true);
    expect(await page.evaluate(() => (window as any).__nativeGumCalls)).toBe(0);

    const foreign = await context.newPage();
    const foreignOrigin = origin.replace("127.0.0.1", "localhost");
    await foreign.goto(foreignOrigin);
    const foreignProof = await foreign.evaluate(async () => {
      let rejected = false;
      try { await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch { rejected = true; }
      return { bridgeInstalled: typeof (window as any).__sophiaVoiceLab !== "undefined", nativeCalls: (window as any).__nativeGumCalls, rejected };
    });
    expect(foreignProof).toEqual({ bridgeInstalled: false, nativeCalls: 1, rejected: true });
    await context.close();
  }, 25_000);

  it("proves a cached worker Chromium launch/context/WebAudio readiness contract", async () => {
    let launches = 0;
    const driver = new PlaywrightVoiceDriver({} as any, fetch, async (options) => {
      launches += 1;
      return chromium.launch({ ...options, executablePath });
    }, async () => undefined);
    const first = await driver.readiness();
    const second = await driver.readiness();
    expect(first).toMatchObject({ ok: true, detail: "chromium-launch-context-webaudio-ready", engine: "chromium" });
    expect(first.version).toMatch(/^\d+\./);
    expect(second).toEqual(first);
    expect(launches).toBe(1);
    await driver.close();
  }, 20_000);
});
