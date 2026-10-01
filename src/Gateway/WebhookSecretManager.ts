import { logger } from "../config/logger";

/**
 * Secret configuration for a webhook provider
 * Supports multiple active secrets for zero-downtime rotation
 */
interface SecretConfig {
  current: string;
  previous?: string;
  rotatedAt?: Date;
}

/**
 * WebhookSecretManager
 *
 * Manages webhook secrets with support for zero-downtime rotation.
 * Allows multiple active secrets (current + previous) so that webhooks
 * signed with the old secret continue to validate during the rotation window.
 *
 * Secret rotation flow:
 * 1. Generate new secret in provider (GitHub, Stripe, etc.)
 * 2. Set PROVIDER_WEBHOOK_SECRET_PREVIOUS=<old_secret>
 * 3. Set PROVIDER_WEBHOOK_SECRET=<new_secret>
 * 4. Provider gradually migrates to new secret
 * 5. After rotation window (e.g., 24h), remove PREVIOUS env var
 *
 * Features:
 * - Zero-downtime rotation via overlapping secrets
 * - Environment-based configuration
 * - Automatic fallback to previous secret
 * - Audit logging of secret usage
 *
 * AC: Secret rotation supports overlap without disabling verification
 */
export class WebhookSecretManager {
  private readonly secrets = new Map<string, SecretConfig>();

  constructor() {
    this.loadSecretsFromEnvironment();
  }

  /**
   * Load secrets from environment variables
   * Convention: {PROVIDER}_WEBHOOK_SECRET and {PROVIDER}_WEBHOOK_SECRET_PREVIOUS
   */
  private loadSecretsFromEnvironment(): void {
    const providers = [
      "STELLAR",
      "TELEGRAM",
      "DISCORD",
      "GITHUB",
      "STRIPE",
      "WEBHOOK", // Generic fallback
    ];

    for (const provider of providers) {
      const currentKey = `${provider}_WEBHOOK_SECRET`;
      const previousKey = `${provider}_WEBHOOK_SECRET_PREVIOUS`;

      const current = process.env[currentKey];
      const previous = process.env[previousKey];

      if (current) {
        this.secrets.set(provider.toLowerCase(), {
          current,
          previous,
          rotatedAt: previous ? new Date() : undefined,
        });

        logger.info("WebhookSecretManager: loaded secrets", {
          provider: provider.toLowerCase(),
          hasCurrent: !!current,
          hasPrevious: !!previous,
        });
      }
    }

    // Check for generic WEBHOOK_SECRET as fallback
    if (process.env.WEBHOOK_SECRET && !this.secrets.has("webhook")) {
      this.secrets.set("webhook", {
        current: process.env.WEBHOOK_SECRET,
      });
    }
  }

  /**
   * Get all active secrets for a provider (current + previous)
   * Returns array ordered by preference: [current, previous]
   */
  getSecrets(provider: string): string[] {
    const normalized = provider.toLowerCase();
    const config = this.secrets.get(normalized);

    if (!config) {
      // Fallback to generic webhook secret
      const fallback = this.secrets.get("webhook");
      if (fallback) {
        return [fallback.current, fallback.previous].filter(
          (s): s is string => !!s
        );
      }
      return [];
    }

    return [config.current, config.previous].filter((s): s is string => !!s);
  }

  /**
   * Get the current (primary) secret for a provider
   */
  getCurrentSecret(provider: string): string | undefined {
    const secrets = this.getSecrets(provider);
    return secrets[0];
  }

  /**
   * Check if a provider has any configured secrets
   */
  hasSecrets(provider: string): boolean {
    return this.getSecrets(provider).length > 0;
  }

  /**
   * Check if a provider is in rotation (has both current and previous secrets)
   */
  isRotating(provider: string): boolean {
    return this.getSecrets(provider).length > 1;
  }

  /**
   * Get rotation metadata for a provider
   */
  getRotationInfo(provider: string): {
    isRotating: boolean;
    rotatedAt?: Date;
    secretCount: number;
  } {
    const normalized = provider.toLowerCase();
    const config = this.secrets.get(normalized);

    return {
      isRotating: this.isRotating(provider),
      rotatedAt: config?.rotatedAt,
      secretCount: this.getSecrets(provider).length,
    };
  }

  /**
   * Manually register a secret (for testing or dynamic configuration)
   */
  registerSecret(
    provider: string,
    current: string,
    previous?: string
  ): void {
    const normalized = provider.toLowerCase();
    this.secrets.set(normalized, {
      current,
      previous,
      rotatedAt: previous ? new Date() : undefined,
    });

    logger.info("WebhookSecretManager: manually registered secret", {
      provider: normalized,
      hasCurrent: !!current,
      hasPrevious: !!previous,
    });
  }

  /**
   * Remove a secret (for testing)
   */
  unregisterSecret(provider: string): void {
    const normalized = provider.toLowerCase();
    this.secrets.delete(normalized);
  }

  /**
   * Get all registered providers
   */
  getRegisteredProviders(): string[] {
    return Array.from(this.secrets.keys());
  }
}

// Singleton instance
export const webhookSecretManager = new WebhookSecretManager();
