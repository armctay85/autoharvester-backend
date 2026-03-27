import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env';

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
  type?: string;
}

// Custom error class for API errors
export class AppError extends Error implements ApiError {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number = 500, code: string = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Not found handler
export const notFoundHandler = (req: Request, res: Response, next: NextFunction): void => {
  const error = new AppError(`Route not found: ${req.method} ${req.path}`, 404, 'ROUTE_NOT_FOUND');
  next(error);
};

// Global error handler
export const errorHandler = (
  err: ApiError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  let code = err.code || 'INTERNAL_ERROR';
  const details: unknown = undefined;

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    statusCode = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    const errorDetails = err.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    }));

    res.status(statusCode).json({
      error: {
        code,
        message,
        details: errorDetails,
        ...(env.NODE_ENV === 'development' && { stack: err.stack }),
      },
    });
    return;
  }

  // Handle Stripe errors
  if (err.type?.startsWith('Stripe')) {
    statusCode = 400;
    code = 'PAYMENT_ERROR';
    message = err.message || 'Payment processing failed';
  }

  // Handle PostgreSQL errors
  if (err.code?.startsWith('23')) {
    // Integrity constraint violations
    statusCode = 409;
    code = 'CONFLICT';
    if (err.code === '23505') {
      message = 'A record with this information already exists';
    }
  }

  // Log error (in production, use proper logging service)
  if (statusCode >= 500) {
    console.error('Server Error:', {
      code,
      message,
      path: _req.path,
      method: _req.method,
      stack: err.stack,
    });
  }

  // Send response
  const response: Record<string, unknown> = {
    error: {
      code,
      message,
    },
  };

  if (env.NODE_ENV === 'development' && err.stack) {
    response.error = {
      ...response.error as object,
      stack: err.stack,
    };
  }

  res.status(statusCode).json(response);
};

// Async handler wrapper to catch errors in async routes
export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
