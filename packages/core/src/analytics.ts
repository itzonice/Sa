/**
 * Structured logging for API routes.
 *
 * Newline-delimited JSON so a log shipper can parse it without a regex. The
 * web layer's richer request/response logger lives in
 * apps/web/src/lib/http/respond.ts; this is the dependency-free core version
 * for code that cannot import from the app.
 */

export type LogFields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    ...fields,
    level,
    msg: message,
    time: new Date().toISOString(),
  });

  if (level === "error") console.error(line);
  else console.warn(line);
}

export const log = {
  info: (message: string, fields: LogFields = {}) => emit("info", message, fields),
  warn: (message: string, fields: LogFields = {}) => emit("warn", message, fields),
  error: (message: string, fields: LogFields = {}) => emit("error", message, fields),

  /** Returns a logger with fields bound (request id, route name, ...). */
  child(bindings: LogFields) {
    return {
      info: (message: string, fields: LogFields = {}) => emit("info", message, { ...bindings, ...fields }),
      warn: (message: string, fields: LogFields = {}) => emit("warn", message, { ...bindings, ...fields }),
      error: (message: string, fields: LogFields = {}) => emit("error", message, { ...bindings, ...fields }),
    };
  },
};
