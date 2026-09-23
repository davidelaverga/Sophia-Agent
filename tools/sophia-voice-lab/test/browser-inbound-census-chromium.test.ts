import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildVoiceLabInitScript } from "../src/browser-init.js";

/** Unmasked server-to-client WebSocket frame (payload < 64 KiB). */
function frame(opcode: 1 | 2, payload: Buffer): Buffer {
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

const INBOUND = [
  frame(1, Buffer.from(JSON.stringify({ setupComplete: {} }))),
  frame(2, Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: "TRANSCRIPT_SECRET" }, waitingForInput: true } }))),
  frame(1, Buffer.from(JSON.stringify({ sessionResumptionUpdate: { newHandle: "HANDLE_SECRET", resumable: true } }))),
  frame(1, Buffer.from(JSON.stringify({ sessionResumptionUpdate: { newHandle: "HANDLE_SECRET_2", resumable: true } }))),
];

describe("real Chromium inbound provider census", () => {
  let server: Server;
  let browser: Browser;
  let origin: string;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>inbound</title>"); });
    server.on("upgrade", (request, socket) => {
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") { socket.destroy(); return; }
      sockets.add(socket);
      // The only client frame is its close; answer it so the close event fires.
      socket.on("data", () => { socket.end(Buffer.from([0x88, 0x00])); });
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")}\r\n\r\n`);
      for (const bytes of INBOUND) socket.write(bytes);
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
    browser = await chromium.launch({ executablePath, headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }, 30_000);

  it("observes native text and binary frames passively and accounts for each on close", async () => {
    const wsOrigin = origin.replace("http://", "ws://");
    const context = await browser.newContext();
    await context.addInitScript({ content: buildVoiceLabInitScript({ pageOrigin: origin, websocketOrigins: [wsOrigin], maxAudioBytes: 1_000, testRunId: "00000000-0000-4000-8000-000000000021", cleanupObligationId: "00000000-0000-4000-8000-000000000022" }) });
    const page = await context.newPage();
    await page.goto(origin);
    const product = await page.evaluate(async (wsUrl) => {
      const socket = new WebSocket(wsUrl);
      const seen: string[] = [];
      // Chained like the product's messageHandlingChain, so Blob reads keep order.
      let chain = Promise.resolve();
      socket.onmessage = (event) => { chain = chain.then(async () => { seen.push(typeof event.data === "string" ? event.data : await (event.data as Blob).text()); }); };
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("frames not delivered")), 5_000);
        const poll = setInterval(() => { if (seen.length === 4) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 20);
      });
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return seen;
    }, wsOrigin);
    const events = await page.evaluate(() => (window as any).__sophiaVoiceLab.drain(0).events as Array<{ kind: string; payload: Record<string, any> }>);
    await context.close();
    // The product's own handler saw every frame, byte-identical and in order.
    expect(product).toEqual(INBOUND.map((bytes) => bytes.subarray(bytes[1]! < 126 ? 2 : 4).toString()));
    const census = events.filter((event) => event.kind.startsWith("harness.provider_frame_received"));
    expect(census.filter((event) => event.kind === "harness.provider_frame_received").map((event) => event.payload.frame_kind))
      .toEqual(["setupComplete", "serverContent", "sessionResumptionUpdate"]);
    expect(census.find((event) => event.payload.frame_kind === "serverContent")?.payload.server_content)
      .toMatchObject({ waiting_for_input: "true", input_transcription_utf8_bytes: "TRANSCRIPT_SECRET".length });
    expect(census.at(-1)).toMatchObject({ kind: "harness.provider_frame_received_summary",
      payload: { received_count: 4, emitted_count: 3, suppressed_count: 1, pending_repeat_count: 1 } });
    expect(JSON.stringify(events)).not.toMatch(/SECRET/);
  }, 30_000);
});
