import { redactValue } from "./security.ts";

export function serializeError(error: unknown) {
  if (error instanceof Error) {
    const plain = error as Error & { code?: string; cause?: unknown };
    return {
      name: plain.name,
      message: plain.message,
      stack: plain.stack,
      code: plain.code,
      cause: plain.cause instanceof Error
        ? { name: plain.cause.name, message: plain.cause.message, stack: plain.cause.stack }
        : plain.cause,
    };
  }

  return {
    message: String(error),
  };
}

export function logServerError(scope: string, error: unknown, details?: Record<string, unknown>) {
  const serializedError = redactValue(serializeError(error));
  const payload = {
    level: "error",
    ts: new Date().toISOString(),
    scope,
    ...(serializedError && typeof serializedError === "object" && !Array.isArray(serializedError)
      ? serializedError
      : { error: serializedError }),
    ...(details ? { details: redactValue(details) } : {}),
  };

  console.error("[server:error]", JSON.stringify(payload, null, 2));
}

export function truncateForLog(value: unknown, maxLength = 1200): unknown {
  const redacted = redactValue(value);
  const serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  if (!serialized) return value;
  if (serialized.length <= maxLength) return redacted;
  return `${serialized.slice(0, maxLength)}... [truncated ${serialized.length - maxLength} chars]`;
}

export function isTimeoutLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|ETIMEDOUT|AbortError|deadline/i.test(message);
}

export function summarizeText(text: string | undefined, max = 220): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

export function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : fallback;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clampUnitInterval(value: unknown): number | undefined {
  const numeric = asNumber(value);
  if (numeric === undefined) return undefined;
  return Math.min(1, Math.max(0, numeric));
}

export function parseJsonWithRecovery(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]);
    }

    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }

    throw new Error("LLM response did not contain valid JSON");
  }
}
