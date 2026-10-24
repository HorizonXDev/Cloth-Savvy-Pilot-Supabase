// _pilot/pgerror.ts — translate PostgREST/Postgres errors into safe API
// errors. NEVER pass a raw DB message to a client (it can contain SQL
// fragments, table names or partition names): the client gets a generic
// message; the codes and message go to server logs only.
//
// Mapping (mirrors the migration's error-code choices, 0007 header):
//   22xxx (invalid parameter / null not allowed)  -> invalid_request (400)
//   23xxx (check/unique/FK violations)            -> invalid_request (400)
//   PGRST202 (not in schema cache)                -> internal (500) — means a
//     migration was not applied; ops problem, not client's fault.
//   anything else                                 -> internal (500)

import { PilotError } from "./errors.ts";
import { logError } from "./logger.ts";

export interface PgLikeError {
  code?: string;
  message?: string;
  details?: string;
}

export function mapDbError(err: PgLikeError | null | undefined, requestId: string, what: string): PilotError {
  const code = err?.code ?? "unknown";
  const message = err?.message ?? "no message";
  logError("db: operation failed", { request_id: requestId, what, pg_code: code, detail: message });

  if (code === "PGRST202") {
    return new PilotError("internal", "database function unavailable — a migration may not be applied");
  }
  if (/^2[23]\d{3}$/.test(code)) {
    return new PilotError("invalid_request", "request could not be satisfied with the given arguments");
  }
  return new PilotError("internal", "internal error — quote the request_id when reporting this");
}
