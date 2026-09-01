const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api.?key/i;

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
} as const;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(nestedValue),
      ]),
    );
  }
  if (typeof value === "string") {
    return value
      .replace(/\b(Bearer|token|secret|password|client_secret|access_token|refresh_token|api[_-]?key)\s*[:=]?\s*[^\s&,]+/gi, "$1 [REDACTED]")
      .replace(/([?&](?:code|state|token|secret|access_token|refresh_token)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@");
  }
  return value;
}

export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

export type LogRecord = {
  level?: string;
  event?: string;
  timestamp?: string;
  [key: string]: unknown;
};

function displayValue(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  return JSON.stringify(value);
}

export function formatLogRecord(record: LogRecord, color = true): string {
  const level = String(record.level ?? "info").toUpperCase();
  const levelColor = record.level === "error" ? COLORS.red : record.level === "warn" ? COLORS.yellow : COLORS.green;
  const time = record.timestamp ? new Date(record.timestamp).toLocaleTimeString() : "--:--:--";
  const fields = Object.entries(record)
    .filter(([key]) => !["level", "event", "timestamp"].includes(key))
    .map(([key, value]) => `${key}=${displayValue(value)}`)
    .join("  ");
  const prefix = color ? `${COLORS.dim}${time}${COLORS.reset} ${levelColor}${level.padEnd(5)}${COLORS.reset}` : `${time} ${level.padEnd(5)}`;
  return `${prefix} ${record.event ?? "event"}${fields ? `  ${fields}` : ""}`;
}

export function formatLogLine(line: string, color = true): string {
  try {
    return formatLogRecord(JSON.parse(line) as LogRecord, color);
  } catch {
    return `${COLORS.yellow}${line}${COLORS.reset}`;
  }
}

export function createLogger(): Logger {
  function write(level: "info" | "error", event: string, fields: Record<string, unknown> = {}) {
    const safeFields = redact(fields) as Record<string, unknown>;
    const record = { level, event, ...safeFields, timestamp: new Date().toISOString() };
    if (Bun.env.LOG_FORMAT === "pretty") console.log(formatLogRecord(record, Boolean(process.stdout.isTTY)));
    else console.log(JSON.stringify(record));
  }

  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
