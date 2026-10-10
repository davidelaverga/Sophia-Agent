import { STUDIO_PAGE_RECEIPT_EVENT } from "./contract.js";

/**
 * Studio-only observation script, installed after the shared Voice Lab init
 * script. It is observation-only:
 *
 * - it forwards each `sophia:voice-qualification` CustomEvent detail to the
 *   worker over the private page-push binding (channel `studio`); the worker
 *   validates every receipt strictly and never trusts it before parsing;
 * - it keeps a bounded registry of RTCPeerConnections the page creates so the
 *   worker can read WebRTC `getStats()` for the published synthetic track. The
 *   wrapper constructs and returns the native connection unchanged. These
 *   stats are corroboration only and never satisfy a product receipt.
 *
 * Nothing here dispatches product events, clicks UI, or alters media.
 */
export function buildStudioObserverScript(input: { studioOrigin: string }): string {
  const encoded = JSON.stringify({ origin: new URL(input.studioOrigin).origin, event: STUDIO_PAGE_RECEIPT_EVENT }).replaceAll("<", "\\u003c");
  return `(() => {
    'use strict';
    const options = ${encoded};
    if (location.origin !== options.origin || window.top !== window) return;
    let pushOrdinal = 0;
    const push = (payload) => {
      try {
        const binding = window.__sophiaVoiceLabPushV1;
        if (typeof binding !== 'function') return;
        Promise.resolve(binding({ schema: 'sophia_voice_lab_page_push_v1', channel: 'studio', payload })).catch(() => undefined);
      } catch {}
    };
    addEventListener(options.event, (event) => {
      let detail = null;
      try { detail = event && 'detail' in event ? JSON.parse(JSON.stringify(event.detail)) : null; } catch { detail = null; }
      pushOrdinal += 1;
      push({ page_push_ordinal: pushOrdinal, observed_at_ms: Date.now(), detail });
    });
    const NativePeerConnection = window.RTCPeerConnection;
    const registry = [];
    if (typeof NativePeerConnection === 'function' && typeof WeakRef === 'function') {
      const ObservedPeerConnection = function RTCPeerConnection(...args) {
        const connection = new NativePeerConnection(...args);
        registry.push(new WeakRef(connection));
        if (registry.length > 16) registry.shift();
        return connection;
      };
      ObservedPeerConnection.prototype = NativePeerConnection.prototype;
      Object.setPrototypeOf(ObservedPeerConnection, NativePeerConnection);
      try { window.RTCPeerConnection = ObservedPeerConnection; } catch {}
    }
    const hashText = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const senderStats = async () => {
      const rows = [];
      for (const reference of registry) {
        const connection = reference.deref();
        if (!connection || connection.connectionState === 'closed') continue;
        let report;
        try { report = await connection.getStats(); } catch { continue; }
        const sources = new Map();
        report.forEach((stat) => { if (stat.type === 'media-source' && stat.kind === 'audio') sources.set(stat.id, stat); });
        const pending = [];
        report.forEach((stat) => {
          if (stat.type !== 'outbound-rtp' || stat.kind !== 'audio') return;
          const source = sources.get(stat.mediaSourceId);
          pending.push((async () => ({
            track_id_sha256: typeof source?.trackIdentifier === 'string' ? await hashText(source.trackIdentifier) : null,
            packets_sent: finite(stat.packetsSent),
            bytes_sent: finite(stat.bytesSent),
            audio_level: finite(source?.audioLevel),
            total_audio_energy: finite(source?.totalAudioEnergy),
            total_samples_duration: finite(source?.totalSamplesDuration),
          }))());
        });
        rows.push(...await Promise.all(pending));
        if (rows.length >= 16) break;
      }
      return rows.slice(0, 16);
    };
    Object.defineProperty(window, '__sophiaVoiceLabStudio', { configurable: false, enumerable: false, writable: false, value: Object.freeze({ senderStats }) });
  })();`;
}
