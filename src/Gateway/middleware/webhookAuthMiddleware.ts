import { Request, Response, NextFunction } from "express";
import { webhookSignatureService } from "../WebhookSignatureService";
import { webhookReplayTracker } from "../WebhookReplayTracker";
import { logger } from "../../config/logger";
import { auditLogService, AuditEventAction } from "../../AuditLog/auditLog.service";
import { AuditEventSeverity, EventCategory } from "../../AuditLog/auditEvent.types";

/**
 * Extract webhook ID from request body (provider-specific)
 */
function extractWebhookId(req: Request, provider: string): string | undefined {
  const body = req.body;
  if (!body || typeof body !== "object") {
    return undefined;
  }

  switch (provider.toLowerCase()) {
    case "stellar":
      return body.id || body.transaction_hash;
    case "telegram":
      return body.update_id?.toString();
    case "discord":
      return body.id;
    case "github":
      return req.headers["x-github-delivery"] as string;
    case "stripe":
      return body.id;
    default:
      // Try common fields
      return body.id || body.event_id || body.webhook_id;
  }
}

/**
 * Webhook authentication middleware factory
 *
 * Creates Express middleware that verifies webhook signatures at the edge,
 * BEFORE JSON parsing occurs. This prevents signature bypass via JSON
 * canonicalization attacks.
 *
 * CRITICAL: This middleware requires rawBodyCapture middleware to be
 * applied first to preserve the original request bytes.
 *
 * Features:
 * - Edge signature verification on raw bytes
 * - Provider-specific signature validation
 * - Timestamp-based replay protection
 * - Secret rotation support
 * - Cross-instance replay detection
 * - Comprehensive audit logging
 *
 * Usage:
 *   router.post('/webhook/stellar', webhookAuth('stellar'), handler);
 *   router.post('/webhook/telegram', webhookAuth('telegram'), handler);
 *
 * AC: Signature verification occurs before JSON parsing where platform support permits
 * AC: Replay identifiers are shared across instances
 */
export function webhookAuth(provider: string) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const startTime = Date.now();

    try {
      // Verify signature on raw bytes
      const result = await webhookSignatureService.verify(req, provider);

      const verificationTimeMs = Date.now() - startTime;

      if (!result.valid) {
        // Log failed verification attempt
        logger.warn("Webhook authentication failed", {
          provider,
          path: req.path,
          error: result.error,
          ip: req.ip,
          timestamp: result.timestamp,
          timestampSkewMs: result.timestampSkewMs,
          verificationTimeMs,
        });

        // Audit log for security monitoring
        await auditLogService.logEvent({
          action: "webhook.auth.failed" as AuditEventAction,
          category: EventCategory.INTEGRATION,
          severity: AuditEventSeverity.WARNING,
          actor: {
            serviceId: `webhook:${provider}`,
            ip: req.ip,
          },
          resource: {
            endpoint: req.path,
            type: "Webhook",
            id: provider,
          },
          metadata: {
            error: result.error,
            timestampSkewMs: result.timestampSkewMs,
            verificationTimeMs,
          },
          success: false,
        });

        res.status(401).json({
          success: false,
          message: "Webhook authentication failed",
          error: result.error,
        });
        return;
      }

      // Check for replay attacks and duplicates
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        logger.error("Raw body not available for replay check", {
          provider,
          path: req.path,
        });
        res.status(500).json({
          success: false,
          message: "Internal error during replay protection",
        });
        return;
      }

      // Extract webhook ID from request (provider-specific)
      const webhookId = extractWebhookId(req, provider);
      if (!webhookId) {
        logger.warn("Could not extract webhook ID for replay protection", {
          provider,
          path: req.path,
        });
        res.status(400).json({
          success: false,
          message: "Missing webhook identifier",
        });
        return;
      }

      // Check for replay attacks
      const replayCheck = await webhookReplayTracker.checkReplay(
        provider,
        webhookId,
        rawBody,
        result
      );

      if (replayCheck.isReplay) {
        logger.warn("Webhook replay attack detected", {
          provider,
          webhookId,
          reason: replayCheck.reason,
          existingRecord: replayCheck.existingRecord,
        });

        await auditLogService.logEvent({
          action: "webhook.replay.detected" as AuditEventAction,
          category: EventCategory.INTEGRATION,
          severity: AuditEventSeverity.WARNING,
          actor: {
            serviceId: `webhook:${provider}`,
            ip: req.ip,
          },
          resource: {
            endpoint: req.path,
            type: "Webhook",
            id: webhookId,
          },
          metadata: {
            reason: replayCheck.reason,
            existingRecord: replayCheck.existingRecord,
          },
          success: false,
        });

        res.status(409).json({
          success: false,
          message: "Replay attack detected",
          reason: replayCheck.reason,
        });
        return;
      }

      if (replayCheck.isDuplicate) {
        logger.info("Duplicate webhook delivery detected", {
          provider,
          webhookId,
          existingRecord: replayCheck.existingRecord,
        });

        // Duplicates are accepted but not reprocessed
        res.status(200).json({
          success: true,
          message: "Duplicate webhook acknowledged",
        });
        return;
      }

      // Record webhook for future replay protection
      await webhookReplayTracker.recordWebhook(
        provider,
        webhookId,
        rawBody,
        result
      );

      // Successful verification
      logger.info("Webhook authenticated successfully", {
        provider,
        webhookId,
        path: req.path,
        timestamp: result.timestamp,
        usedPreviousSecret: result.usedPreviousSecret,
        verificationTimeMs,
      });

      // Store verification result and webhook ID in request for downstream handlers
      (req as Request & { webhookAuth?: typeof result }).webhookAuth = result;
      (req as Request & { webhookId?: string }).webhookId = webhookId;

      // Audit log for successful authentication
      await auditLogService.logEvent({
        action: "webhook.auth.success" as AuditEventAction,
        category: EventCategory.INTEGRATION,
        severity: AuditEventSeverity.INFO,
        actor: {
          serviceId: `webhook:${provider}`,
          ip: req.ip,
        },
        resource: {
          endpoint: req.path,
          type: "Webhook",
          id: webhookId,
        },
        metadata: {
          timestamp: result.timestamp,
          usedPreviousSecret: result.usedPreviousSecret,
          verificationTimeMs,
        },
        success: true,
      });

      next();
    } catch (error) {
      logger.error("Webhook authentication error", {
        error: error instanceof Error ? error.message : String(error),
        provider,
        path: req.path,
      });

      // Audit log for errors
      await auditLogService.logEvent({
        action: "webhook.auth.error" as AuditEventAction,
        category: EventCategory.INTEGRATION,
        severity: AuditEventSeverity.ERROR,
        actor: {
          serviceId: `webhook:${provider}`,
          ip: req.ip,
        },
        resource: {
          endpoint: req.path,
          type: "Webhook",
          id: provider,
        },
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
        success: false,
      });

      res.status(500).json({
        success: false,
        message: "Internal server error during webhook authentication",
      });
    }
  };
}

/**
 * Optional webhook authentication middleware
 *
 * Similar to webhookAuth, but only logs warnings instead of rejecting
 * requests with invalid signatures. Useful for gradual rollout or
 * monitoring mode.
 *
 * Usage:
 *   router.post('/webhook/stellar', webhookAuthOptional('stellar'), handler);
 */
export function webhookAuthOptional(provider: string) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const result = await webhookSignatureService.verify(req, provider);

      if (!result.valid) {
        logger.warn("Optional webhook authentication failed (not enforced)", {
          provider,
          path: req.path,
          error: result.error,
        });
      }

      // Store result regardless of validity
      (req as Request & { webhookAuth?: typeof result }).webhookAuth = result;

      next();
    } catch (error) {
      logger.error("Optional webhook authentication error", {
        error: error instanceof Error ? error.message : String(error),
        provider,
      });
      next();
    }
  };
}
