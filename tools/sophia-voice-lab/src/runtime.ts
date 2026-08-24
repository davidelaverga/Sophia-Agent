import { AudioResolver } from "./audio.js";
import type { VoiceLabConfig } from "./config.js";
import { MemoryVoiceLabLedger } from "./memory-ledger.js";
import { PostgresVoiceLabLedger } from "./postgres-ledger.js";
import type { VoiceLabLedger } from "./ledger.js";

export function createLedger(config: VoiceLabConfig): VoiceLabLedger {
  if (config.nodeEnv === "test" && process.env.SOPHIA_VOICE_LAB_LEDGER === "memory") return new MemoryVoiceLabLedger("test", config.callerPartitionKeys);
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required for the production ledger.");
  return new PostgresVoiceLabLedger(config.databaseUrl, 10, config.recoveryInternalSecret, config.callerPartitionKeys);
}

export async function createAudioResolver(config: VoiceLabConfig): Promise<AudioResolver> {
  const audio = new AudioResolver(config);
  await audio.initialize();
  return audio;
}
