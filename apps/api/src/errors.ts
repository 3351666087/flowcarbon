import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";

/** An error with an HTTP status that is safe to show to the client (RFC 9457 problem details). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = "error",
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Sign in required.") => new HttpError(401, msg, "unauthorized");
export const forbidden = (msg = "You do not have permission for this action.") =>
  new HttpError(403, msg, "forbidden");
export const notFound = (what = "Resource") => new HttpError(404, `${what} not found.`, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
export const unprocessable = (msg: string, details?: unknown) =>
  new HttpError(422, msg, "unprocessable", details);

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

interface PgError {
  code?: string;
  constraint_name?: string;
  cause?: PgError;
}

function pgCode(err: unknown): PgError | undefined {
  let e = err as PgError | undefined;
  for (let i = 0; e && i < 3; i++, e = e.cause)
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e;
  return undefined;
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError & { problems?: string[]; details?: unknown }, req, reply) => {
    let status = 500;
    let message = "Something went wrong. The error has been logged.";
    let code = "internal";
    let details: unknown;

    if (hasZodFastifySchemaValidationErrors(err)) {
      status = 400;
      code = "validation";
      message = "The request is not valid.";
      details = err.validation.map((v) => ({
        in: err.validationContext ?? "body",
        path: v.instancePath,
        message: v.message,
      }));
    } else if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause?.issues }, "response does not match its schema");
    } else if (err instanceof HttpError) {
      status = err.statusCode;
      message = err.message;
      code = err.code;
      details = err.details;
    } else if (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) {
      // Fastify/plugin errors (payload too large, unsupported media type, rate limit) and domain errors
      // carrying a 4xx statusCode, e.g. NotFoundError, ConfigurationError, IngestValidationError
      status = err.statusCode;
      message = err.message;
      code = err.code ? String(err.code).toLowerCase() : "client_error";
      details = err.problems ?? err.details;
    } else {
      const pg = pgCode(err);
      if (pg?.code === "23505") {
        status = 409;
        code = "conflict";
        message = "A record with these values already exists.";
        details = pg.constraint_name ? { constraint: pg.constraint_name } : undefined;
      } else if (pg?.code === "23503") {
        status = 422;
        code = "reference";
        message = "A referenced record does not exist.";
      } else if (pg?.code === "42501") {
        // RLS or privilege violation: never reveal more than "not allowed"
        status = 403;
        code = "forbidden";
        message = "You do not have permission for this action.";
      }
    }
    if (status >= 500) req.log.error({ err }, "request failed");
    else req.log.info({ code, status }, message);
    reply
      .status(status)
      .type("application/problem+json")
      .send({
        type: `https://flowcarbon.dev/problems/${code}`,
        title: TITLES[status] ?? "Error",
        status,
        detail: message,
        code,
        details,
        requestId: req.id,
      });
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .status(404)
      .type("application/problem+json")
      .send({
        type: "https://flowcarbon.dev/problems/not_found",
        title: "Not Found",
        status: 404,
        detail: `No route for ${req.method} ${req.url.split("?")[0]}`,
        code: "not_found",
        requestId: req.id,
      });
  });
}
