// _pilot/logger.ts — structured, PII-aware logging.
//
// One JSON line per event. Hard rules (inherited from the consumer functions'
// logging discipline, S-verified):
//   * NEVER log an API key, an API-key hash, the encoder token, the Groq key
//     or the service key. Not even truncated.
//   * NEVER log request or response BODIES (they can contain tenant catalog
//     text, customer data, or — in a bug — key material).
//   * NEVER log free-form upstream error bodies: log status codes and a short
//     sanitized excerpt at most.
//   * The request_id ties every line together; tenant_id is logged once
//     resolved (it is an internal uuid, not PII).

type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(msg: string, fields: Record<string, unknown> = {}): void {
  emit("info", msg, fields);
}
export function logWarn(msg: string, fields: Record<string, unknown> = {}): void {
  emit("warn", msg, fields);
}
/** For exceptions: pass error name + message only; add `stack` deliberately
 * (server-side logs are the right place for stacks — never responses). */
export function logError(msg: string, fields: Record<string, unknown> = {}): void {
  emit("error", msg, fields);
}
