import crypto from "crypto";
import { Repository, LessThan } from "typeorm";
import AppDataSource from "../config/Datasource";
import { WebhookIdempotency } from "./webhookIdempotency.entity";
import { logger } from "../config/logger";
import { VerificationResult } from "./WebhookSignatureService";

/**
 * Webhook replay tracking result
 */
export interface ReplayCheckResult {
  isReplay: boolean;
  isDuplicate: boolean;
  reason?: string;
  existingRecord?: {
    id: string;
    webhookId: string;
    createdAt: Date;
    timestamp?: Date;
  };
}

/**
 * WebhookReplayTracker
 *
 * Provides database-backed replay protection across all service instances.
 * Tracks webhook signatures, timestamps, and payload hashes to detect:
 * - Duplicate deliveries (same webhook ID)
 * - Replay attacks (same signature/payload with different ID)
 * - Payload mutations (same ID but modified content)
 *
 * Features:
 * - Cross-instance replay detection via database
 * - Signature and payload hash tracking
 * - Automatic cleanup of old records
 * - Detailed replay attack detection
 *
 * AC: Replay identifiers are shared across instances
 */
export class WebhookReplayTracker {
  private readonly repository: Repository<WebhookIdempotency>;
  private readonly RETENTION_HOURS = 24; // Keep records for 24 hours

  constructor() {
    this.repository = AppDataSource.getRepository(WebhookIdempotency);
    this.scheduleCleanup();
  }

  /**
   * Check if a webhook is a replay or duplicate
   * Returns detailed information about why a webhook was flagged
   *
   * AC: Replay identifiers are shared across instances
   */
  async checkReplay(
    provider: string,
    webhookId: string,
    rawBody: Buffer,
    verificationResult: VerificationResult
  ): Promise<ReplayCheckResult> {
    // Compute hashes for replay detection
    const payloadHash = crypto
      .createHash("sha256")
      .update(rawBody)
      .digest("hex");

    // Check for exact duplicate (same webhookId + platform)
    const existingById = await this.repository.findOne({
      where: {
        webhookId,
        platform: provider,
      },
    });

    if (existingById) {
      // Check if payload was modified (possible attack)
      if (
        existingById.payloadHash &&
        existingById.payloadHash !== payloadHash
      ) {
        logger.warn("Webhook replay detected: same ID but modified payload", {
          provider,
          webhookId,
          existingHash: existingById.payloadHash,
          newHash: payloadHash,
        });

        return {
          isReplay: true,
          isDuplicate: false,
          reason: "Payload mutation detected - same webhook ID but different content",
          existingRecord: {
            id: existingById.id,
            webhookId: existingById.webhookId,
            createdAt: existingById.createdAt,
            timestamp: existingById.timestamp,
          },
        };
      }

      // Normal duplicate delivery
      return {
        isReplay: false,
        isDuplicate: true,
        reason: "Duplicate webhook delivery",
        existingRecord: {
          id: existingById.id,
          webhookId: existingById.webhookId,
          createdAt: existingById.createdAt,
          timestamp: existingById.timestamp,
        },
      };
    }

    // Check for signature replay (same signature hash, different webhook ID)
    if (verificationResult.valid && verificationResult.timestamp) {
      const signatureHash = this.computeSignatureHash(
        provider,
        webhookId,
        payloadHash
      );

      const existingBySignature = await this.repository.findOne({
        where: {
          platform: provider,
          signatureHash,
        },
      });

      if (
        existingBySignature &&
        existingBySignature.webhookId !== webhookId
      ) {
        logger.warn("Webhook replay detected: signature reused with different ID", {
          provider,
          newWebhookId: webhookId,
          existingWebhookId: existingBySignature.webhookId,
          signatureHash,
        });

        return {
          isReplay: true,
          isDuplicate: false,
          reason: "Signature replay attack - same signature with different webhook ID",
          existingRecord: {
            id: existingBySignature.id,
            webhookId: existingBySignature.webhookId,
            createdAt: existingBySignature.createdAt,
            timestamp: existingBySignature.timestamp,
          },
        };
      }
    }

    // Check for payload replay (same content, different webhook ID)
    // Only check within recent time window to avoid false positives
    const recentCutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour
    const existingByPayload = await this.repository.findOne({
      where: {
        platform: provider,
        payloadHash,
      },
      order: {
        createdAt: "DESC",
      },
    });

    if (
      existingByPayload &&
      existingByPayload.webhookId !== webhookId &&
      existingByPayload.createdAt > recentCutoff
    ) {
      logger.warn("Possible webhook replay detected: same payload with different ID", {
        provider,
        newWebhookId: webhookId,
        existingWebhookId: existingByPayload.webhookId,
        timeSinceOriginal: Date.now() - existingByPayload.createdAt.getTime(),
      });

      return {
        isReplay: true,
        isDuplicate: false,
        reason: "Payload replay - same content delivered with different webhook ID",
        existingRecord: {
          id: existingByPayload.id,
          webhookId: existingByPayload.webhookId,
          createdAt: existingByPayload.createdAt,
          timestamp: existingByPayload.timestamp,
        },
      };
    }

    // No replay detected
    return {
      isReplay: false,
      isDuplicate: false,
    };
  }

  /**
   * Record a processed webhook for replay protection
   *
   * AC: Replay identifiers are shared across instances
   */
  async recordWebhook(
    provider: string,
    webhookId: string,
    rawBody: Buffer,
    verificationResult: VerificationResult,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const payloadHash = crypto
      .createHash("sha256")
      .update(rawBody)
      .digest("hex");

    const signatureHash = verificationResult.valid
      ? this.computeSignatureHash(provider, webhookId, payloadHash)
      : undefined;

    try {
      const record = this.repository.create({
        webhookId,
        platform: provider,
        signatureHash,
        timestamp: verificationResult.timestamp,
        payloadHash,
        metadata: {
          signatureValid: verificationResult.valid,
          usedPreviousSecret: verificationResult.usedPreviousSecret,
          timestampSkewMs: verificationResult.timestampSkewMs,
          ...metadata,
        },
      });

      await this.repository.save(record);

      logger.debug("Recorded webhook for replay protection", {
        provider,
        webhookId,
        signatureHash,
        timestamp: verificationResult.timestamp,
      });
    } catch (error) {
      // If unique constraint violation, it's a duplicate (race condition)
      const pgError = error as { code?: string; message?: string };
      if (
        pgError.code === "23505" ||
        (error instanceof Error && error.message.includes("duplicate"))
      ) {
        logger.info("Webhook already recorded (race condition)", {
          provider,
          webhookId,
        });
        return;
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Compute a deterministic signature hash for replay detection
   */
  private computeSignatureHash(
    provider: string,
    webhookId: string,
    payloadHash: string
  ): string {
    return crypto
      .createHash("sha256")
      .update(`${provider}:${webhookId}:${payloadHash}`)
      .digest("hex");
  }

  /**
   * Clean up old webhook records
   */
  private async cleanup(): Promise<void> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setHours(cutoffDate.getHours() - this.RETENTION_HOURS);

      const result = await this.repository.delete({
        createdAt: LessThan(cutoffDate),
      });

      if (result.affected && result.affected > 0) {
        logger.info("Cleaned up old webhook replay records", {
          deletedCount: result.affected,
          cutoffDate,
        });
      }
    } catch (error) {
      logger.error("Error cleaning up webhook replay records", { error });
    }
  }

  /**
   * Schedule periodic cleanup of old records
   */
  private scheduleCleanup(): void {
    // Run cleanup every hour
    setInterval(
      () => {
        this.cleanup();
      },
      60 * 60 * 1000
    );

    // Run initial cleanup after 1 minute
    setTimeout(() => {
      this.cleanup();
    }, 60 * 1000);
  }

  /**
   * Get statistics about webhook processing
   */
  async getStats(): Promise<{
    totalRecords: number;
    recordsByPlatform: Record<string, number>;
    oldestRecord?: Date;
    newestRecord?: Date;
  }> {
    const [records, count] = await this.repository.findAndCount({
      order: { createdAt: "ASC" },
    });

    const recordsByPlatform: Record<string, number> = {};
    for (const record of records) {
      recordsByPlatform[record.platform] =
        (recordsByPlatform[record.platform] || 0) + 1;
    }

    return {
      totalRecords: count,
      recordsByPlatform,
      oldestRecord: records.length > 0 ? records[0].createdAt : undefined,
      newestRecord:
        records.length > 0 ? records[records.length - 1].createdAt : undefined,
    };
  }
}

// Singleton instance
export const webhookReplayTracker = new WebhookReplayTracker();
