/**
 * Discord Notification Handler
 * Platform-specific delivery handler for Discord notifications
 */

import {
  PlatformDeliveryHandler,
  NotificationMessage,
  DeliveryResult,
  DeliveryPlatform,
  DeliveryStatus,
} from '../core.js';
import { splitNotificationContent, PLATFORM_LIMITS } from '../messageSplitter.js';

/**
 * Discord notification handler
 */
export class DiscordNotificationHandler implements PlatformDeliveryHandler {
  platform = DeliveryPlatform.DISCORD;
  private discordAdapter: any;
  private available: boolean;
  private latency: number;
  private errorCount: number;
  private totalRequests: number;

  constructor(discordAdapter: any) {
    this.discordAdapter = discordAdapter;
    this.available = !!discordAdapter;
    this.latency = 0;
    this.errorCount = 0;
    this.totalRequests = 0;
  }

  /**
   * Deliver notification to Discord
   */
  async deliver(message: NotificationMessage): Promise<DeliveryResult> {
    const startTime = Date.now();

    try {
      this.totalRequests++;

      if (!this.discordAdapter) {
        throw new Error('Discord adapter not available');
      }

      // Split oversized content before sending; critical facts are validated internally.
      const { chunks } = splitNotificationContent(message, PLATFORM_LIMITS.discord);
      const send = typeof this.discordAdapter.sendNotification === 'function'
        ? (text: string, embed: unknown) => this.discordAdapter.sendNotification(message.userId, text, embed)
        : typeof this.discordAdapter.sendMessage === 'function'
          ? (text: string, embed: unknown) => this.discordAdapter.sendMessage(message.userId, text, embed)
          : null;

      if (!send) {
        throw new Error('Discord adapter does not have sendNotification method');
      }

      // Only attach the embed to the first chunk; subsequent chunks are plain text continuations.
      for (let i = 0; i < chunks.length; i++) {
        await send(chunks[i], i === 0 ? message.embed : undefined);
      }

      this.latency = Date.now() - startTime;

      return {
        success: true,
        platform: DeliveryPlatform.DISCORD,
        attempt: 1,
        duration: this.latency,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.errorCount++;
      this.latency = Date.now() - startTime;

      return {
        success: false,
        platform: DeliveryPlatform.DISCORD,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'DISCORD_DELIVERY_ERROR',
        attempt: 1,
        duration: this.latency,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Check if handler is available
   */
  isAvailable(): boolean {
    return this.available && !!this.discordAdapter;
  }

  /**
   * Get handler health status
   */
  getHealth(): {
    available: boolean;
    latency?: number;
    errorRate?: number;
  } {
    const errorRate = this.totalRequests > 0 ? this.errorCount / this.totalRequests : 0;

    return {
      available: this.available,
      latency: this.latency || undefined,
      errorRate: errorRate || undefined,
    };
  }

  /**
   * Set adapter availability
   */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /**
   * Reset error counters
   */
  resetErrors(): void {
    this.errorCount = 0;
    this.totalRequests = 0;
  }
}
