/**
 * AppError carries an HTTP status and a stable machine-readable code so the
 * HTTP layer can map domain failures (duplicate booking, class full, ...)
 * to responses without string matching.
 */
export class AppError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(what: string, id: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${what} '${id}' not found`, { id });
}
