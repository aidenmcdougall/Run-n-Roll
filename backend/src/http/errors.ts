import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

/** An error with an HTTP status and a stable, machine-readable code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  let status = 500;
  let body: ErrorBody = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } };

  if (error instanceof HttpError) {
    status = error.status;
    body = { error: { code: error.code, message: error.message, details: error.details } };
  } else if (error instanceof z.ZodError) {
    status = 400;
    body = { error: { code: 'VALIDATION_ERROR', message: 'Invalid request.', details: z.flattenError(error) } };
  } else if (error instanceof SyntaxError && 'body' in error) {
    status = 400; // malformed JSON from express.json()
    body = { error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } };
  }

  if (status >= 500) console.error(error);
  res.status(status).json(body);
};
