export const VOICE_LAB_PROVIDER_CLEANUP_HEADER =
  'X-Sophia-Voice-Lab-Provider-Cleanup';

const OPAQUE_PROVIDER_CLEANUP_TOKEN =
  /^[A-Za-z0-9_-]{16,6144}\.[A-Za-z0-9_-]{16,256}$/;

export function isOpaqueVoiceLabProviderCleanupToken(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string'
    && value.length <= 8192
    && OPAQUE_PROVIDER_CLEANUP_TOKEN.test(value);
}
