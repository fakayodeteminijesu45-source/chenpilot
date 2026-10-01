import { Request, Response, NextFunction } from "express";
import logger from "../../config/logger";
import { ApiErrorCode, isApiError } from "../../contracts/errorContract";

/**
 * Central error-rendering middleware.
 *
 * Renders *any* thrown error into the canonical JSON envelope:
 *
 *   { success:false, status:N, error:{ message, code, details? } }
 *
 * Priority order:
 *   1. `ApiError` (and any subclass) — exact envelope
 *   2. Postgres-style errors (`{ code }`) — translated to friendly code
 *   3. Bare `Error.message` — passed through
 *   4. Anything else — generic 500
 *
 * Mounted at the very end of the Express pipeline (`src/Gateway/api.ts`).
 *
 * Note: every legacy `ApplicationError` subclass now extends `ApiError`, so
 * a separate `instanceof ApplicationError` branch is `unreachable` — one
 * `isApiError` check covers both.
 */
import { isBudgetExhaustedError } from "../../utils/budget";

export async function ErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): Promise<void> {
  // Budget exhaustion (e.g. byte limits on inbound requests)
  if (isBudgetExhaustedError(err)) {
    logger.warn("Request budget exhausted", {
      resource: err.resource,
      path: req.originalUrl,
      message: err.message,
    });
    res.status(413).json({
      success: false,
      status: 413,
      error: {
        message: err.message,
        code: "BUDGET_EXHAUSTED",
        details: {
          resource: err.resource,
          budget: {
            path: err.budget.path,
            bytes: err.budget.bytes,
            consumedBytes: err.budget.consumedBytes,
          },
        },
      },
    });
    return;
  }

  // Body-parser entity.too.large (413 Payload Too Large)
  const anyErr = err as Record<string, unknown> | null;
  if (
    anyErr?.type === "entity.too.large" ||
    anyErr?.status === 413 ||
    anyErr?.statusCode === 413
  ) {
    logger.warn("Payload too large", {
      path: req.originalUrl,
      message: (anyErr?.message as string) || "Payload too large",
    });
    res.status(413).json({
      success: false,
      status: 413,
      error: {
        message: (anyErr?.message as string) || "Payload too large",
        code: "PAYLOAD_TOO_LARGE",
      },
    });
    return;
  }

  // 1) Platform contract — preferred path (covers legacy subclasses too)
  if (isApiError(err)) {
    const includeStack = process.env.NODE_ENV !== "production";
    logger.warn("Handled ApiError", {
      code: err.code,
      status: err.statusCode,
      method: req.method,
      url: req.originalUrl,
      message: err.message,
    });
    res.status(err.statusCode).json(err.toResponse(includeStack));
    return;
  }

  // 2) Postgres-style errors passed through ORMs
  const pgish = err as {
    message?: string;
    stack?: string;
    code?: string;
    column?: string;
  };
  let statusCode = 500;
  let message = "Internal server error";
  let errorCode: string = ApiErrorCode.INTERNAL_SERVER_ERROR;

  if (pgish && typeof pgish === "object" && pgish.code) {
    switch (pgish.code) {
      case "23502":
        message = pgish.column
          ? `Field '${pgish.column}' cannot be empty.`
          : "A required field is missing.";
        statusCode = 400;
        errorCode = ApiErrorCode.MISSING_FIELD;
        break;
      case "23505":
        message = "Duplicate entry. This record already exists.";
        statusCode = 409;
        errorCode = ApiErrorCode.DUPLICATE_ENTRY;
        break;
      case "23503":
        message = "Invalid reference. The related record does not exist.";
        statusCode = 400;
        errorCode = ApiErrorCode.INVALID_REFERENCE;
        break;
      case "22001":
        message = "Data is too long for the specified field.";
        statusCode = 400;
        errorCode = ApiErrorCode.VALUE_TOO_LONG;
        break;
      case "22007":
        message = "Invalid date/time format.";
        statusCode = 400;
        errorCode = ApiErrorCode.INVALID_DATE_FORMAT;
        break;
      case "22P02":
        message = "Invalid input format.";
        statusCode = 400;
        errorCode = ApiErrorCode.INVALID_INPUT_FORMAT;
        break;
      case "23514":
        message = "Field value does not meet required constraints.";
        statusCode = 400;
        errorCode = ApiErrorCode.CONSTRAINT_VIOLATION;
        break;
      default:
        if (pgish.message) message = pgish.message;
    }
  } else if (pgish && pgish.message) {
    message = pgish.message;
  }

  logger.error("Unhandled error", {
    message: pgish?.message || "No message provided",
    statusCode,
    errorCode,
    category: (pgish as any)?.category,
    method: req.method,
    url: req.originalUrl,
    stack: pgish?.stack,
  });

  res.status(statusCode).json({
    success: false,
    status: statusCode,
    error: {
      message,
      code: errorCode,
      stack: process.env.NODE_ENV === "production" ? undefined : pgish?.stack,
    },
  });
}
