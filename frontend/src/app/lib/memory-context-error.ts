/** A refusal signal, never permission to rotate/replay a saved context. */
export const MEMORY_CONTEXT_RECOVERY_REQUIRED = 'memory_context_rotation_required';

export function isMemoryContextRecoveryError(value: unknown): boolean {
  if (value === MEMORY_CONTEXT_RECOVERY_REQUIRED) return true;
  if (value instanceof Error) return value.message === MEMORY_CONTEXT_RECOVERY_REQUIRED;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Match fixed codes exactly; never reflect backend diagnostics.
  return record.message === MEMORY_CONTEXT_RECOVERY_REQUIRED
    || record.error === MEMORY_CONTEXT_RECOVERY_REQUIRED;
}
