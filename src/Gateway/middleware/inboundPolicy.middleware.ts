import { Request, Response, NextFunction } from "express";
import config from "../../config/config";
import {
  resolveInboundLimit,
  checkInboundBudget,
  InboundPolicyConfig,
  InboundPolicyType,
  DEFAULT_INBOUND_JSON_LIMIT,
  DEFAULT_WEBHOOK_LIMIT,
  DEFAULT_ATTACHMENT_LIMIT,
} from "../../utils/budget";
import { logger } from "../../config/logger";

/**
 * Global inbound policy configuration resolved from environment and defaults
 */
export function getGlobalInboundConfig(): InboundPolicyConfig {
  return {
    jsonLimit: config.inbound?.jsonLimit || DEFAULT_INBOUND_JSON_LIMIT,
    webhookLimit: config.inbound?.webhookLimit || DEFAULT_WEBHOOK_LIMIT,
    attachmentLimit: config.inbound?.attachmentLimit || DEFAULT_ATTACHMENT_LIMIT,
    attachmentPaths: ["/export", "/attachments", "/upload", "/media", "/voice", "/kyc/submit"],
    webhookPaths: ["/webhook", "/api/webhook"],
  };
}

/**
 * Inbound policy middleware
 *
 * Enforces uniform inbound payload size policies across standard JSON, webhook,
 * and attachment endpoints, with support for endpoint-specific gaps (custom overrides).
 *
 * Rejects oversized requests early (413 Payload Too Large) before heavy parsing or downstream
 * queueing occurs, and records exhaustion metrics in the centralized BudgetManager.
 */
export function createInboundLimitMiddleware(customConfig?: Partial<InboundPolicyConfig>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const policyConfig: InboundPolicyConfig = {
      ...getGlobalInboundConfig(),
      ...customConfig,
      endpointGaps: {
        ...customConfig?.endpointGaps,
      },
    };

    // Check custom route-level override attached to request (e.g. from endpointGap/attachmentEndpoint)
    const routeOverrideLimit = (req as Request & { routeSizeLimit?: number }).routeSizeLimit;
    const contentLengthHeader = req.headers["content-length"];

    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength >= 0) {
        if (routeOverrideLimit !== undefined) {
          if (contentLength > routeOverrideLimit) {
            checkInboundBudget(req.path, contentLength, {
              endpointGaps: { [req.path]: routeOverrideLimit },
            });
            logger.warn("Request exceeded endpoint-specific size limit", {
              path: req.path,
              contentLength,
              limit: routeOverrideLimit,
              ip: req.ip,
            });
            res.status(413).json({
              success: false,
              status: 413,
              message: "Payload too large",
              error: `Payload exceeded endpoint-specific limit of ${routeOverrideLimit} bytes`,
              details: {
                limit: routeOverrideLimit,
                actualBytes: contentLength,
                policyType: "custom",
                path: req.path,
              },
            });
            return;
          }
        } else {
          const check = checkInboundBudget(req.path, contentLength, policyConfig);
          if (!check.allowed) {
            logger.warn(`Inbound ${check.policyType} payload exceeded size limit`, {
              path: req.path,
              contentLength,
              limit: check.limit,
              policyType: check.policyType,
              ip: req.ip,
            });
            res.status(413).json({
              success: false,
              status: 413,
              message: "Payload too large",
              error: `Inbound ${check.policyType} payload exceeded size limit of ${check.limit} bytes`,
              details: {
                limit: check.limit,
                actualBytes: contentLength,
                policyType: check.policyType,
                path: req.path,
              },
            });
            return;
          }
        }
      }
    }

    next();
  };
}

export const inboundPolicyMiddleware = createInboundLimitMiddleware();

/**
 * Route-level middleware to declare an attachment endpoint (endpoint-specific gap for attachments).
 * Allows payloads up to the attachment limit (default 25MB) or custom limit.
 */
export function attachmentEndpoint(customLimit?: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const limit = customLimit ?? config.inbound?.attachmentLimit ?? DEFAULT_ATTACHMENT_LIMIT;
    (req as Request & { routeSizeLimit?: number }).routeSizeLimit = limit;
    next();
  };
}

/**
 * Route-level middleware to specify an explicit endpoint size limit (endpoint-specific gap).
 */
export function endpointGap(limitBytes: number) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { routeSizeLimit?: number }).routeSizeLimit = limitBytes;
    next();
  };
}
