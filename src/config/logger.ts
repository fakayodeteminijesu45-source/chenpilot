import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import { getObservabilityLogFields } from "../observability";
import { SecretBuffer } from "../utils/secretBuffer";

// Sensitive fields to redact from logs
const SENSITIVE_FIELDS = [
  "pk", "privateKey", "password", "token", "secret",
  "fullName", "dateOfBirth", "email", "phoneNumber",
  "addressLine1", "addressLine2", "postalCode", "countryCode",
  "documentId", "fileUrl"
];

/**
 * Recursively redacts sensitive data from objects
 */
export function redactSensitiveData(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  // SecretBuffer instances must never have their contents exposed.
  if (obj instanceof SecretBuffer) {
    return obj.toString();
  }

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveData);
  }

  if (typeof obj === "object") {
    const redacted: Record<string, unknown> = {};
    for (const key in obj as Record<string, unknown>) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        redacted[key] = SENSITIVE_FIELDS.includes(key)
          ? "[REDACTED]"
          : redactSensitiveData((obj as Record<string, unknown>)[key]);
      }
    }
    return redacted;
  }

  return obj;
}

// Custom format to redact sensitive data
const redactFormat = winston.format((info: Record<string, unknown>) => {
  if (typeof info.message === "object") {
    info.message = redactSensitiveData(info.message);
  }

  const { level, message, timestamp, ...meta } = info;
  const redactedMeta = redactSensitiveData(meta);
  const contextFields = getObservabilityLogFields();

  return {
    level,
    message,
    timestamp,
    ...contextFields,
    ...(typeof redactedMeta === "object" && redactedMeta !== null
      ? redactedMeta
      : {}),
  };
});

// JSON format for file logs
const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  redactFormat(),
  winston.format.json()
);

// Logs directory
const logsDir = path.join(process.cwd(), "logs");

// Application logs
const dailyRotateFileTransport = new DailyRotateFile({
  filename: path.join(logsDir, "application-%DATE%.log"),
  datePattern: "YYYY-MM-DD",
  zippedArchive: true,
  maxSize: "20m",
  maxFiles: "14d",
  format: jsonFormat,
  auditFile: path.join(logsDir, ".application-audit.json"),
  createSymlink: true,
  symlinkName: "application-current.log",
});

// Error-only logs
const errorRotateFileTransport = new DailyRotateFile({
  level: "error",
  filename: path.join(logsDir, "error-%DATE%.log"),
  datePattern: "YYYY-MM-DD",
  zippedArchive: true,
  maxSize: "20m",
  maxFiles: "30d",
  format: jsonFormat,
  auditFile: path.join(logsDir, ".error-audit.json"),
  createSymlink: true,
  symlinkName: "error-current.log",
});

// Console logs (dev)
const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    redactFormat(),
    winston.format.printf((info) => {
      const { timestamp, level, message, stack, ...meta } = info;
      let log = `${timestamp} [${level}]: ${message}`;

      if (stack) log += `\n${stack}`;
      if (Object.keys(meta).length > 0) {
        log += `\n${JSON.stringify(meta, null, 2)}`;
      }

      return log;
    })
  ),
});

// Logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  transports: [
    dailyRotateFileTransport,
    errorRotateFileTransport,
    consoleTransport,
  ],
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(logsDir, "exceptions-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "30d",
      format: jsonFormat,
      auditFile: path.join(logsDir, ".exceptions-audit.json"),
      createSymlink: true,
      symlinkName: "exceptions-current.log",
    }),
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(logsDir, "rejections-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "30d",
      format: jsonFormat,
      auditFile: path.join(logsDir, ".rejections-audit.json"),
      createSymlink: true,
      symlinkName: "rejections-current.log",
    }),
  ],
  exitOnError: false,
});

// Rotation events
dailyRotateFileTransport.on("rotate", (oldFilename, newFilename) => {
  logger.info("Log file rotated", { oldFilename, newFilename });
});

dailyRotateFileTransport.on("archive", (zipFilename) => {
  logger.info("Log file archived", { zipFilename });
});

dailyRotateFileTransport.on("logRemoved", (removedFilename) => {
  logger.info("Old log file removed", { removedFilename });
});

errorRotateFileTransport.on("rotate", (oldFilename, newFilename) => {
  logger.info("Error log file rotated", { oldFilename, newFilename });
});

// Helper functions
export const logError = (
  message: string,
  error?: unknown,
  meta?: Record<string, unknown>
) => {
  const errorInfo =
    error instanceof Error
      ? { error: error.message, stack: error.stack }
      : error
        ? { error: String(error) }
        : {};

  logger.error(message, { ...errorInfo, ...meta });
};

export const logInfo = (message: string, meta?: Record<string, unknown>) =>
  logger.info(message, meta);

export const logWarn = (message: string, meta?: Record<string, unknown>) =>
  logger.warn(message, meta);

export const logDebug = (message: string, meta?: Record<string, unknown>) =>
  logger.debug(message, meta);

export { logger };
export default logger;
