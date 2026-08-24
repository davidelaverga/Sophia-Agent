import { sha256 } from "../../src/security.js";

const SECRET_KEY = /(?:authorization|bearer|token|secret|password|private[_-]?key|api[_-]?key|cookie|storage[_-]?state)/i;
const SECRET_VALUE = /(?:bearer\s+[A-Za-z0-9._~+\/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|rnd_[A-Za-z0-9_-]{20,})/i;

export function redactControllerValue(value: unknown, key = "root", seen = new WeakSet<object>()): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "[REDACTED]" : value;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactControllerValue(entry, key, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactControllerValue(child, childKey, seen)]));
}

export function safeError(error: unknown): { error: string; error_class: string } {
  const name = error instanceof Error ? error.name : "ControllerError";
  const message = error instanceof Error ? error.message : "External attestation controller failed.";
  return {
    error: SECRET_VALUE.test(message) || /(?:token|secret|private[_-]?key|authorization|cookie)/i.test(message) ? "External attestation controller failed without exposing secret detail." : message.slice(0, 500),
    error_class: /^[A-Za-z0-9_.:-]{1,128}$/.test(name) ? name : "ControllerError",
  };
}

export function secretFingerprintForOperatorComparison(secret: string): string {
  return sha256(secret);
}
