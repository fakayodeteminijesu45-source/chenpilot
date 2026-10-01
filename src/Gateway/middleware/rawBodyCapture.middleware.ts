import { Request, Response, NextFunction } from "express";
import { logger } from "../../config/logger";
import config from "../../config/config";
import { budgetManager, DEFAULT_WEBHOOK_LIMIT } from "../../utils/budget";

/**
 * Maximum allowed webhook payload size (default 1MB or configured via INBOUND_WEBHOOK_LIMIT_BYTES)
 * Prevents memory exhaustion from oversized payloads
 */
function getMaxPayloadSize(): number {
  return config.inbound?.webhookLimit || DEFAULT_WEBHOOK_LIMIT;
}

/**
 * Raw body capture middleware
 *
 * Captures the raw request body as a Buffer before JSON parsing occurs.
 * This is critical for webhook signature verification, which must operate
 * on the exact bytes sent by the provider to prevent signature bypass via
 * JSON canonicalization attacks.
 *
 * SECURITY: This middleware MUST be registered before express.json() in
 * the middleware chain to preserve the original payload bytes.
 *
 * Usage:
 *   app.use('/api/webhook', rawBodyCapture);
 *   app.use(express.json());
 */
export function rawBodyCapture(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Only capture raw body for webhook endpoints
  if (!req.path.includes("/webhook")) {
    next();
    return;
  }

  const maxSize = getMaxPayloadSize();
  const chunks: Buffer[] = [];
  let totalSize = 0;

  req.on("data", (chunk: Buffer) => {
    totalSize += chunk.length;

    // Reject oversized payloads early to prevent DoS
    if (totalSize > maxSize) {
      budgetManager.recordExhaustion(req.path, "bytes");
      logger.warn("Webhook payload exceeds maximum size", {
        path: req.path,
        totalSize,
        maxSize,
        ip: req.ip,
      });

      res.status(413).json({
        success: false,
        status: 413,
        message: "Payload too large",
        error: `Webhook payload exceeded size limit of ${maxSize} bytes`,
        details: {
          limit: maxSize,
          actualBytes: totalSize,
          policyType: "webhook",
          path: req.path,
        },
      });

      // Destroy the request stream
      req.destroy();
      return;
    }

    chunks.push(chunk);
  });

  req.on("end", () => {
    // Store raw body as Buffer for signature verification
    const rawBodyBuffer = Buffer.concat(chunks);
    (req as Request & { rawBody?: Buffer }).rawBody = rawBodyBuffer;

    // Parse JSON body so downstream handlers and express.json have req.body populated
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    if (
      contentType.includes("application/json") ||
      req.path.includes("/webhook")
    ) {
      try {
        if (rawBodyBuffer.length > 0) {
          req.body = JSON.parse(rawBodyBuffer.toString("utf8"));
          (req as Request & { _body?: boolean })._body = true;
        }
      } catch {
        // Malformed JSON will be handled downstream by validation or auth
      }
    }

    logger.debug("Captured raw webhook body", {
      path: req.path,
      size: totalSize,
    });

    next();
  });

  req.on("error", (error) => {
    logger.error("Error reading webhook request body", {
      error,
      path: req.path,
    });

    res.status(400).json({
      success: false,
      message: "Error reading request body",
    });
  });
}
