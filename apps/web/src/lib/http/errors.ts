/**
 * The error envelope every route handler returns.
 *
 * `code` is stable and safe to branch on. `message` is for humans and may be
 * reworded. `requestId` is echoed in the body and in the `x-request-id` header so
 * a user-reported screenshot can be traced to one log line and one Sentry event
 * without asking them for anything else.
 */
import { z } from "zod";

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "gone",
  "rate_limited",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, string[]> | undefined;
  /** Seconds advertised in `Retry-After` (item 24). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      status?: number;
      details?: Record<string, string[]>;
      retryAfterSeconds?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? defaultStatusFor(code);
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function defaultStatusFor(code: ErrorCode): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "gone":
      return 410;
    case "rate_limited":
      return 429;
    case "internal":
      return 500;
  }
}

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
