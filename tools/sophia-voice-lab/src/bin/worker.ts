import { PlaywrightVoiceDriver, type VoiceBrowserDriver } from "../browser-driver.js";
import { loadConfig } from "../config.js";
import { probeEffectiveTarget } from "../http-server.js";
import { createAudioResolver, createLedger } from "../runtime.js";
import { CapabilityCodec } from "../security.js";
import { VoiceLabWorker } from "../worker.js";
import { resolveWorkerIdentity } from "../worker-identity.js";
import { STUDIO_G7_TARGET_KIND } from "../studio-g7/contract.js";
import { StudioG7Driver } from "../studio-g7/studio-driver.js";

// The evaluator worker is deliberately incapable of authenticating to the
// external-attestation ingestion route. It loads verification keys only and
// rejects any accidental transport-secret mount at startup.
const config = loadConfig(process.env, "worker");
const workerId = resolveWorkerIdentity(config.nodeEnv, process.env);
const ledger = createLedger(config);
await ledger.initialize();
const audio = await createAudioResolver(config);
// The target kind selects the driver; the legacy Gemini-browser driver stays
// the default. The evaluator is selected per run by its scenario catalogue.
const driver: VoiceBrowserDriver = config.targetKind === STUDIO_G7_TARGET_KIND && config.studioG7
  ? new StudioG7Driver(config, config.studioG7)
  : new PlaywrightVoiceDriver(config);
const worker = new VoiceLabWorker(
  workerId,
  ledger,
  config,
  audio,
  driver,
  new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds),
  undefined,
  fetch,
  async () => config.readinessTarget ? probeEffectiveTarget(config) : ({ ok: false, status: "target_configuration_missing" }),
);
let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    worker.stop();
    await worker.close();
    await ledger.close();
  })();
  return shutdownPromise;
}
function currentShutdown(): Promise<void> | null { return shutdownPromise; }
function requestShutdown(signal: NodeJS.Signals): void {
  void shutdown().catch((error) => {
    // Armed D02 cleanup ambiguity deliberately leaves the browser/ledger live
    // for exact retry until the platform's hard deadline. It must never be
    // reported as a successful graceful exit or fall through to generic close.
    process.exitCode = 1;
    worker.logger.error({ signal, error }, "worker shutdown failed closed");
  });
}
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
process.once("SIGINT", () => requestShutdown("SIGINT"));
await worker.run();
await currentShutdown()?.catch(() => undefined);
