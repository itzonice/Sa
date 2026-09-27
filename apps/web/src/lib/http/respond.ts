import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError, type ErrorCode } from "./errors";

export const REQUEST_ID_HEADER = "x-request-id";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Honours an incoming id when it looks sane, so a request that crossed a proxy
 * or an edge function keeps one identity from end to end; otherwise mints a new
 * one.
 */
export function normalizeRequestId(value: string | null | undefined): string {
  if (value && REQUEST_ID_PATTERN.test(value)) return value;
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export function requestIdFrom(request: Request): string {
  return normalizeRequestId(request.headers.get(REQUEST_ID_HEADER));
}

export type LogFields = Record<string, unknown>;

/**
 * Newline-delimited JSON so a log shipper can parse it without a regex, and with
 * the request id on every line. `level: "info"` is deliberately routed to
 * `console.warn`: stdout is the only stream some hosts capture, and mixing the
 * two in one shape beats a split.
 */
export function log(
  level: "info" | "warn" | "error",
  message: string,
  fields: LogFields = {},
): void {
  const line = JSON.stringify({
    ...fields,
    level,
    msg: message,
    requestId: fields.requestId ?? null,
    time: new Date().toISOString(),
  });

  if (level === "error") console.error(line);
  else console.warn(line);
}

function withRequestId<T extends { headers: Headers }>(response: T, requestId: string): T {
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export function jsonOk<T>(data: T, requestId: string, status = 200): NextResponse {
  return withRequestId(NextResponse.json({ data, requestId }, { status }), requestId);
}

/**
 * Turns a thrown value into a response.
 *
 * Postgres and Zod failures are translated rather than forwarded: a raw
 * `check_violation` message can name tables and columns, and the client only
 * ever needs "that session already ended".
 */
export function toErrorResponse(error: unknown, requestId: string): NextResponse {
  if (error instanceof AppError) {
    log("warn", error.message, {
      requestId,
      code: error.code,
      status: error.status,
      details: error.details,
    });

    const headers = new Headers();
    if (error.retryAfterSeconds !== undefined) {
      headers.set("Retry-After", String(error.retryAfterSeconds));
    }

    return withRequestId(
      NextResponse.json(
        {
          error: {
            code: error.code,
            message: error.message,
            requestId,
            ...(error.details ? { details: error.details } : {}),
          },
        },
        { status: error.status, headers },
      ),
      requestId,
    );
  }

  if (error instanceof ZodError) {
    const details: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "_root";
      (details[key] ??= []).push(issue.message);
    }
    return toErrorResponse(
      new AppError("bad_request", "The request body is invalid.", { details }),
      requestId,
    );
  }

  // Anything unrecognised is our bug: log the real thing, tell the client nothing.
  log("error", "unhandled route error", {
    requestId,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  return withRequestId(
    NextResponse.json(
      { error: { code: "internal" as ErrorCode, message: "Something went wrong.", requestId } },
      { status: 500 },
    ),
    requestId,
  );
}

/** Wraps a handler so auth, validation and unexpected failures all funnel here. */
export function route<Args extends unknown[]>(
  name: string,
  handler: (request: Request, requestId: string, ...args: Args) => Promise<NextResponse>,
) {
  return async (request: Request, ...args: Args): Promise<NextResponse> => {
    const requestId = requestIdFrom(request);
    const startedAt = Date.now();

    try {
      const response = await handler(request, requestId, ...args);
      log("info", "request", {
        requestId,
        route: name,
        method: request.method,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      const response = toErrorResponse(error, requestId);
      log("warn", "request", {
        requestId,
        route: name,
        method: request.method,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return response;
    }
  };
}

export async function parseJsonBody<S extends ZodType>(
  request: Request,
  schema: S,
): Promise<S["_output"]> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new AppError("bad_request", "Expected a JSON body.");
  }
  return schema.parse(raw) as S["_output"];
}
