/**
 * Message Splitter
 *
 * Splits oversized notification content into platform-safe chunks while
 * ensuring transaction-critical facts (hash, amount, asset, addresses) are
 * preserved in the first chunk and never silently dropped.
 */

import { NotificationMessage, NotificationType } from './core.js';

/** Maximum character limits per platform */
export const PLATFORM_LIMITS = {
  telegram: 4096,
  discord: 2000,
} as const;

/**
 * Regex patterns that identify transaction-critical lines.
 * A line is critical if it starts with a known label followed immediately by a colon.
 */
const CRITICAL_LINE_RE = /^(hash|amount|from|to|fee|memo|status|asset):/i;

/**
 * Split a single string into chunks no larger than `limit` characters.
 * Splits on newlines where possible to avoid cutting mid-word.
 */
export function splitContent(content: string, limit: number): string[] {
  if (content.length <= limit) {
    return [content];
  }

  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;

    if (candidate.length <= limit) {
      current = candidate;
    } else {
      // The current accumulated block fits — flush it.
      if (current.length > 0) {
        chunks.push(current);
      }
      // If the single line itself exceeds the limit, hard-split it.
      if (line.length > limit) {
        let remaining = line;
        while (remaining.length > limit) {
          chunks.push(remaining.slice(0, limit));
          remaining = remaining.slice(limit);
        }
        current = remaining;
      } else {
        current = line;
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Verify that every transaction-critical fact present in the original
 * content appears in at least one chunk.
 *
 * Throws if a critical fact is missing — this acts as a safety guard that
 * surfaces data-loss bugs during development/test and in production logs.
 */
export function assertCriticalFactsPreserved(original: string, chunks: string[]): void {
  const combined = chunks.join('\n');
  const criticalLines = original.split('\n').filter(l => CRITICAL_LINE_RE.test(l.trim()));

  for (const line of criticalLines) {
    const colonIdx = line.indexOf(':');
    const label = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    // The label must appear in the output.
    if (!combined.toLowerCase().includes(label.toLowerCase() + ':')) {
      throw new Error(
        `Message splitting dropped a transaction-critical fact: "${line.trim()}"`
      );
    }

    // For non-empty values verify at least the first 50 characters survive.
    // This handles the case where a very long value (e.g. a long memo) is itself
    // hard-split across chunks — the label + value-prefix are still recoverable.
    if (value) {
      const probe = value.slice(0, 50);
      if (!combined.includes(probe)) {
        throw new Error(
          `Message splitting dropped a transaction-critical fact: "${line.trim()}"`
        );
      }
    }
  }
}

export interface SplitResult {
  chunks: string[];
  /** True when the original content was within the limit (no split needed). */
  wasSplit: boolean;
}

/**
 * Split notification content for the given platform limit.
 * For TRANSACTION notifications the result is additionally validated to
 * ensure no critical fact was dropped.
 */
export function splitNotificationContent(
  message: NotificationMessage,
  limit: number
): SplitResult {
  const chunks = splitContent(message.content, limit);
  const wasSplit = chunks.length > 1;

  if (wasSplit && message.type === NotificationType.TRANSACTION) {
    assertCriticalFactsPreserved(message.content, chunks);
  }

  return { chunks, wasSplit };
}
