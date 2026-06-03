export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, new.target);
  }
}

export class NotFoundError extends AppError {
  public constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  public constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  public constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class ValidationError extends AppError {
  public constructor(message = 'Validation failed') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class ConflictError extends AppError {
  public constructor(message = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}

export class ExternalServiceError extends AppError {
  public constructor(message = 'External service error') {
    super(message, 502, 'EXTERNAL_SERVICE_ERROR');
  }
}

export class PlanLimitError extends AppError {
  public constructor(message = 'Plan limit exceeded') {
    super(message, 402, 'PLAN_LIMIT_EXCEEDED');
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
