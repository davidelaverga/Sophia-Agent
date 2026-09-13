import type { VoiceLabConfig } from "./config.js";
import type { RetainedOwnerAuthorityConfig } from "./retained-owner-verifier.js";
import type { RetainedD02ProviderSettlement } from "./retained-d02-provider.js";
import type { RecoveryControlRecord } from "./recovery-control.js";

/** Trusted internal ledger inputs, never schemas for caller-supplied authority. */
export interface RetainedOwnerIngestion {
  runId: string; expectedVersion: number; receipt: unknown;
  publicConfig: RetainedOwnerAuthorityConfig;
  expectedWorkerServiceIdSha256: string;
}
export interface RetainedProviderIngestion {
  runId: string; expectedVersion: number; receipt: unknown;
  authority: VoiceLabConfig["d02GatewayReceiptAuthority"];
}
export interface RetainedIngestionResult<T> { replay: boolean; version: number; proof: T; }
export type RetainedOwnerIngestionResult = RetainedIngestionResult<NonNullable<RecoveryControlRecord["d02OwnerDeath"]>>;
export type RetainedProviderIngestionResult = RetainedIngestionResult<RetainedD02ProviderSettlement>;
