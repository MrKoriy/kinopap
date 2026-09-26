import { ZodError, type ZodType } from "zod";

/** HTTP-ошибка с кодом; error handler превращает её в { error: {...} }. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(400, code, message, details);
}

export function unauthorized(message = "Invalid or expired token"): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function notFound(message = "Not found"): HttpError {
  return new HttpError(404, "not_found", message);
}

export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

/** Валидация входа через zod; ошибки схемы → 400 с issues. */
export function parseOrThrow<T>(schema: ZodType<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest("validation_error", "Invalid request", err.issues);
    }
    throw err;
  }
}
