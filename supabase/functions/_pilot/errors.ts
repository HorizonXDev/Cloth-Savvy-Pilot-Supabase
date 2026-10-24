// _pilot/errors.ts — one error envelope for every API response.
//
// Envelope: {"error": {"code": <stable_code>, "message": <human text>,
//                      "request_id": <same as X-Request-Id header>}}
//
// Stability contract: `code` values never change meaning; clients may switch
// on them. `message` is human text and may be reworded. No stack traces, SQL,
// key material or upstream response bodies ever reach a client — unknown
// exceptions map to a generic `internal` 500 and the detail is logged
// server-side only.

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "unsupported_occasion"
  | "upstream_llm"
  | "upstream_encoder"
  | "internal";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  unsupported_occasion: 422,
  rate_limited: 429,
  internal: 500,
  upstream_llm: 502,
  upstream_encoder: 503,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** An error whose message is safe to show the caller (still generic for
 * `internal`). Extra response headers (e.g. Retry-After) ride along. */
export class PilotError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, message: string, headers?: Record<string, string>) {
    super(message);
    this.name = "PilotError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.headers = headers ?? {};
  }
}

export function errorEnvelope(
  requestId: string,
  code: ErrorCode,
  message: string,
): { error: { code: ErrorCode; message: string; request_id: string } } {
  return { error: { code, message, request_id: requestId } };
}

/** 500 body used for unexpected exceptions — deliberately says nothing. */
export function internalMessage(): string {
  return "internal error — quote the request_id when reporting this";
}
