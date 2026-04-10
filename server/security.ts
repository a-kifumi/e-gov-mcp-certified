import type { Request, RequestHandler, Response } from "express";
import { timingSafeEqual } from "crypto";

type EnvSource = Record<string, string | undefined>;

type BasicAuthConfig = {
  enabled: boolean;
  realm: string;
  username?: string;
  password?: string;
};

export type SecurityConfig = {
  serverHost: string;
  allowedOrigins: string[];
  basicAuth: BasicAuthConfig;
  mcpHttpEnabled: boolean;
};

type RateLimitConfig = {
  windowMs: number;
  max: number;
  scope: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_ALLOWED_DEV_ORIGINS = [
  /^http:\/\/localhost:\d+$/i,
  /^http:\/\/127\.0\.0\.1:\d+$/i,
];
const SENSITIVE_KEY_PATTERN = /(authorization|api[_-]?key|token|secret|password|client_name|request_text|consultation_text|user_message|content|body|answer|subject|review_notes)/i;

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  return fallback;
}

function parseList(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, "");
}

function getOriginFromAppUrl(appUrl: string | undefined): string | undefined {
  if (!appUrl?.trim()) return undefined;

  try {
    const parsed = new URL(appUrl.trim());
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function safeEqual(left: string | undefined, right: string | undefined): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function buildAllowedOrigins(env: EnvSource, isProduction: boolean): string[] {
  const configuredOrigins = parseList(env.APP_ALLOWED_ORIGINS).map(normalizeOrigin);
  const appOrigin = getOriginFromAppUrl(env.APP_URL);
  const origins = new Set<string>(configuredOrigins);

  if (appOrigin) {
    origins.add(appOrigin);
  }

  if (!isProduction) {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }

  return [...origins];
}

export function getSecurityConfig(env: EnvSource = process.env): SecurityConfig {
  const isProduction = env.NODE_ENV === "production";
  const serverHost = env.SERVER_HOST?.trim() || "127.0.0.1";
  const publicBinding = !isLoopbackHost(serverHost);
  const basicAuthEnabled = parseBoolean(
    env.BASIC_AUTH_ENABLED,
    isProduction && publicBinding,
  );
  const basicAuth = {
    enabled: basicAuthEnabled,
    realm: env.BASIC_AUTH_REALM?.trim() || "Secure Area",
    username: env.BASIC_AUTH_USERNAME?.trim(),
    password: env.BASIC_AUTH_PASSWORD?.trim(),
  };

  if (basicAuth.enabled && (!basicAuth.username || !basicAuth.password)) {
    throw new Error("BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD must be configured when basic auth is enabled");
  }

  return {
    serverHost,
    allowedOrigins: buildAllowedOrigins(env, isProduction),
    basicAuth,
    mcpHttpEnabled: parseBoolean(env.MCP_HTTP_ENABLED, !isProduction),
  };
}

export function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return true;

  const normalizedOrigin = normalizeOrigin(origin);
  if (allowedOrigins.includes(normalizedOrigin)) {
    return true;
  }

  return DEFAULT_ALLOWED_DEV_ORIGINS.some((pattern) => pattern.test(normalizedOrigin))
    && allowedOrigins.some((allowedOrigin) => DEFAULT_ALLOWED_DEV_ORIGINS.some((pattern) => pattern.test(allowedOrigin)));
}

export function createCorsOptions(config: SecurityConfig) {
  return {
    origin(origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) {
      callback(null, isAllowedOrigin(origin, config.allowedOrigins));
    },
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  };
}

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    next();
  };
}

export function requireAllowedOrigin(config: SecurityConfig): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;

    if (isAllowedOrigin(origin, config.allowedOrigins)) {
      next();
      return;
    }

    res.status(403).json({ error: "Origin is not allowed" });
  };
}

function unauthorized(res: Response, realm: string) {
  res.setHeader("WWW-Authenticate", `Basic realm="${realm}", charset="UTF-8"`);
  res.status(401).json({ error: "Authentication required" });
}

export function requireBasicAuth(config: SecurityConfig): RequestHandler {
  return (req, res, next) => {
    if (!config.basicAuth.enabled || req.path === "/api/health") {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header?.startsWith("Basic ")) {
      unauthorized(res, config.basicAuth.realm);
      return;
    }

    const encoded = header.slice("Basic ".length).trim();
    let decoded = "";

    try {
      decoded = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      unauthorized(res, config.basicAuth.realm);
      return;
    }

    const separator = decoded.indexOf(":");
    const username = separator >= 0 ? decoded.slice(0, separator) : "";
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";

    if (
      !safeEqual(username, config.basicAuth.username)
      || !safeEqual(password, config.basicAuth.password)
    ) {
      unauthorized(res, config.basicAuth.realm);
      return;
    }

    next();
  };
}

export function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) {
    return value;
  }

  if (typeof value === "string") {
    if (value.length <= 12) {
      return "[redacted]";
    }

    return `[redacted:${value.length}]`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => redactSensitiveValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const redactedEntries = Object.entries(value as Record<string, unknown>).map(([key, itemValue]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        return [key, redactSensitiveValue(typeof itemValue === "string" ? itemValue : "[complex]", depth + 1)];
      }

      return [key, redactValue(itemValue, depth + 1)];
    });

    return Object.fromEntries(redactedEntries);
  }

  return String(value);
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 200 ? `${value.slice(0, 200)}... [truncated ${value.length - 200} chars]` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const redactedEntries = Object.entries(value as Record<string, unknown>).map(([key, itemValue]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        return [key, redactSensitiveValue(itemValue, depth + 1)];
      }

      return [key, redactValue(itemValue, depth + 1)];
    });

    return Object.fromEntries(redactedEntries);
  }

  return String(value);
}

function getClientAddress(req: Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || req.socket.remoteAddress || "unknown";
}

export function requestAuditLogger(): RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();
    const clientIp = getClientAddress(req);
    const origin = req.headers.origin;
    const userAgent = typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].slice(0, 180)
      : undefined;

    res.on("finish", () => {
      const payload = {
        level: "info",
        ts: new Date().toISOString(),
        scope: "http.request",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
        ip: clientIp,
        origin,
        user_agent: userAgent,
      };

      console.info("[server:audit]", JSON.stringify(payload));
    });

    next();
  };
}

export function createRateLimiter(config: RateLimitConfig): RequestHandler {
  const requests = new Map<string, { count: number; resetAt: number }>();

  return (req, res, next) => {
    const now = Date.now();
    const clientIp = getClientAddress(req);
    const key = `${config.scope}:${clientIp}`;
    const current = requests.get(key);

    if (!current || current.resetAt <= now) {
      requests.set(key, { count: 1, resetAt: now + config.windowMs });
      next();
      return;
    }

    current.count += 1;
    if (current.count > config.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Too many requests",
        retry_after_seconds: retryAfterSeconds,
      });
      return;
    }

    next();
  };
}
