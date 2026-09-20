// Minimaler Logger ohne Abhängigkeiten: stdout/stderr, wie es Docker (`docker compose logs`) erwartet.
// info/debug → stdout, warn/error → stderr.
//   LOG_LEVEL   debug | info (Standard) | warn | error
//   LOG_FORMAT  json | text — Standard: json bei NODE_ENV=production (Docker), sonst text

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
type Fields = Record<string, unknown>;

// Konfiguration lazy beim ersten Log lesen: server.ts/index.ts laden die .env erst nach den Imports.
let cfg: { threshold: number; asJson: boolean } | undefined;
function config() {
  return (cfg ??= {
    threshold: LEVELS[(process.env.LOG_LEVEL?.toLowerCase() as Level) ?? "info"] ?? LEVELS.info,
    asJson: (process.env.LOG_FORMAT ?? (process.env.NODE_ENV === "production" ? "json" : "text")) === "json",
  });
}

function normalize(level: Level, fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v instanceof Error) {
      out[k] = v.message;
      if (level === "error" || config().threshold <= LEVELS.debug) out[`${k}Stack`] = v.stack;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function write(level: Level, msg: string, fields: Fields = {}) {
  if (LEVELS[level] < config().threshold) return;
  const time = new Date().toISOString();
  const f = normalize(level, fields);
  let line: string;
  if (config().asJson) {
    line = JSON.stringify({ time, level, msg, ...f });
  } else {
    const kv = Object.entries(f)
      .map(([k, v]) => `${k}=${typeof v === "string" && /[\s"=]/.test(v) ? JSON.stringify(v) : v}`)
      .join(" ");
    line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${kv ? " " + kv : ""}`;
  }
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line + "\n");
}

export const logger = {
  debug: (msg: string, fields?: Fields) => write("debug", msg, fields),
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};
