/**
 * Minimal dependency-free structured logger. Emits one JSON line per event to
 * stdout (info/debug) or stderr (warn/error), so logs are machine-parseable in
 * any aggregator without pulling in a logging framework. Level is set once from
 * LOG_LEVEL (default 'info').
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function thresholdFromEnv(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return ORDER[raw as LogLevel] ?? ORDER.info;
}
// Read once at startup; a redeploy picks up a changed level.
const threshold = thresholdFromEnv();

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that stamps `base` fields onto every line (e.g. a component tag). */
  child(base: LogFields): Logger;
}

function emit(level: LogLevel, base: LogFields, msg: string, fields?: LogFields): void {
  if (ORDER[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...base,
    ...fields,
  });
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export function createLogger(base: LogFields = {}): Logger {
  return {
    debug: (m, f) => emit('debug', base, m, f),
    info: (m, f) => emit('info', base, m, f),
    warn: (m, f) => emit('warn', base, m, f),
    error: (m, f) => emit('error', base, m, f),
    child: (extra) => createLogger({ ...base, ...extra }),
  };
}

/** Process-wide default logger. */
export const log = createLogger();
