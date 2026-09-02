import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildVoiceLabInitScript } from "../src/browser-init.js";
import { classifySessionVoiceRoute, closeDisposableBrowserProcess, launchDisposableBrowserProcess, PlaywrightVoiceDriver } from "../src/browser-driver.js";
import { testRun } from "./helpers.js";

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

  it("projects only fixed structural states when the session voice control is unavailable", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/session`);
    await page.setContent(`
      <div role="tablist" aria-label="Interaction mode">
        <button role="tab" aria-selected="false">voice</button>
        <button role="tab" aria-selected="true">text</button>
      </div>
      <p>private user content that must not be projected</p>
    `);
    await expect(classifySessionVoiceRoute(page, origin, "Tap to speak")).resolves.toEqual({
      location: "expected_session",
      voice_tab: "available",
      voice_button: "absent",
      dashboard_mic_visible: false,
      dashboard_mic_button: "absent",
      consent_visible: false,
      auth_gate_visible: false,
      auth_checking_visible: false,
      session_store_loading_visible: false,
      voice_fallback_visible: false,
    });
    await context.close();
  });

  it("projects the ordinary dashboard microphone button state without exposing its label", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.setContent(`
      <div>
        <span data-onboarding="mic-cta" aria-hidden="true" style="display:block;width:88px;height:88px"></span>
        <button type="button" aria-label="Start open session" data-private="do-not-project"></button>
      </div>
    `);
    const diagnostic = await classifySessionVoiceRoute(page, origin, "Tap to speak");
    expect(diagnostic.location).toBe("dashboard");
    expect(diagnostic.dashboard_mic_visible).toBe(true);
    expect(diagnostic.dashboard_mic_button).toBe("available");
    expect(diagnostic.auth_checking_visible).toBe(false);
    expect(diagnostic.session_store_loading_visible).toBe(false);
    expect(JSON.stringify(diagnostic)).not.toContain("do-not-project");
    await context.close();
  });

  it("classifies a disabled ready mic without exposing its attributes", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/session`);
    await page.setContent(`
      <button role="tab" aria-selected="true">voice</button>
      <button aria-label="Tap to speak" data-private="do-not-project" disabled></button>
    `);
    const diagnostic = await classifySessionVoiceRoute(page, origin, "Tap to speak");
    expect(diagnostic.location).toBe("expected_session");
    expect(diagnostic.voice_tab).toBe("selected");
    expect(diagnostic.voice_button).toBe("disabled");
    expect(JSON.stringify(diagnostic)).not.toContain("do-not-project");
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

    const wav = sineWav(120);
    const digest = createHash("sha256").update(wav).digest("hex");
    for (let trial = 1; trial <= 20; trial += 1) {
      const operationId = `real-op-${trial}`;
      const utteranceId = `real-utt-${trial}`;
      const receipts = await page.evaluate(async ({ operationId, utteranceId, audioBase64, sha256 }) => {
        const request = { operationId, utteranceId, audioBase64, sha256, delayMs: 10 };
        return Promise.all([
          (window as any).__sophiaVoiceLab.schedule(request),
          (window as any).__sophiaVoiceLab.schedule(request),
        ]);
      }, { operationId, utteranceId, audioBase64: wav.toString("base64"), sha256: digest });
      expect(receipts[0]).toEqual(receipts[1]);
      expect(receipts[0].kind).toBe("audio.input.scheduled");
      await page.waitForFunction((expectedOperationId) => {
        const events = (window as any).__sophiaVoiceLab.drain(0).events;
        return events.some((event: any) => event.kind === "audio.input.completed" && event.payload.operation_id === expectedOperationId)
          && events.some((event: any) => event.kind === "harness.input_frame_forwarded" && event.payload.operation_id === expectedOperationId);
      }, operationId, { timeout: 15_000 });
    }
    const result = await page.evaluate(() => ({ nativeCalls: (window as any).__nativeGumCalls, productMediaObserverCalls: (window as any).__productMediaObserverCalls, nonzeroCallbacks: (window as any).__realMedia.nonzeroCallbacks, events: (window as any).__sophiaVoiceLab.drain(0).events }));
    expect(result.nativeCalls).toBe(0);
    expect(result.productMediaObserverCalls).toBe(1);
    expect(result.nonzeroCallbacks).toBeGreaterThan(0);
    expect(result.events.filter((event: any) => event.kind === "harness.media_stream_issued")).toHaveLength(1);
    expect(result.events.filter((event: any) => event.kind === "audio.input.scheduled")).toHaveLength(20);
    expect(result.events.filter((event: any) => event.kind === "audio.input.started")).toHaveLength(20);
    expect(result.events.filter((event: any) => event.kind === "audio.input.completed")).toHaveLength(20);
    expect(result.events.filter((event: any) => ["audio.input.interrupted", "audio.input.rejected"].includes(event.kind))).toHaveLength(0);
    const forwarded = result.events.filter((event: any) => event.kind === "harness.input_frame_forwarded");
    expect(forwarded.length).toBeGreaterThan(0);
    expect(new Set(forwarded.map((event: any) => event.payload.operation_id))).toEqual(new Set(Array.from({ length: 20 }, (_, index) => `real-op-${index + 1}`)));
    expect(forwarded.every((event: any) => /^real-op-\d+$/.test(event.payload.operation_id) && /^real-utt-\d+$/.test(event.payload.utterance_id) && /^[a-f0-9]{64}$/.test(event.payload.sha256) && !Object.hasOwn(event.payload, "data"))).toBe(true);
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
  }, 45_000);

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

  it("allocates distinct disposable Chromium processes and proves both exited", async () => {
    const run = testRun();
    const launch = (options: Parameters<typeof chromium.launchServer>[0]) => chromium.launchServer({ ...options, executablePath });
    const first = await launchDisposableBrowserProcess(run, launch);
    const second = await launchDisposableBrowserProcess({ ...run, id: `${run.id}-second` }, launch);
    expect(first.processId).not.toBe(second.processId);
    expect(first.processIdSha256).not.toBe(second.processIdSha256);
    expect(first.bootIdSha256).not.toBe(second.bootIdSha256);
    expect(first.executionEpochSha256).not.toBe(second.executionEpochSha256);
    expect(first.browser.isConnected()).toBe(true);
    expect(second.browser.isConnected()).toBe(true);
    await expect(closeDisposableBrowserProcess(first)).resolves.toEqual({ closed: true, errorClass: null });
    await expect(closeDisposableBrowserProcess(second)).resolves.toEqual({ closed: true, errorClass: null });
    expect(first.browser.isConnected()).toBe(false);
    expect(second.browser.isConnected()).toBe(false);
    expect(first.child.exitCode !== null || first.child.signalCode !== null).toBe(true);
    expect(second.child.exitCode !== null || second.child.signalCode !== null).toBe(true);
  }, 20_000);
});
