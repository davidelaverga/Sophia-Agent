export type SendFingerprint = {
  text: string;
  at: number;
};

export function shouldBlockSubmitDuplicate(
  previous: SendFingerprint | null,
  text: string,
  now: number,
  windowMs = 1200,
): boolean {
  if (!previous) return false;
  return previous.text === text && now - previous.at < windowMs;
}

export function shouldBlockOutboundDuplicate(
  previous: SendFingerprint | null,
  text: string,
  now: number,
  streamActive: boolean,
  windowMs = 8000,
): boolean {
  if (!previous || !streamActive) return false;
  return previous.text === text && now - previous.at < windowMs;
}
