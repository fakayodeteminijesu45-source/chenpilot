import { describe, it, expect } from '@jest/globals';
import {
  splitContent,
  splitNotificationContent,
  assertCriticalFactsPreserved,
  PLATFORM_LIMITS,
} from '../messageSplitter';
import { NotificationType, NotificationPriority, DeliveryPlatform } from '../core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  content: string,
  type = NotificationType.TRANSACTION,
) {
  return {
    id: 'test-id',
    userId: 'user-1',
    type,
    priority: NotificationPriority.NORMAL,
    platforms: [DeliveryPlatform.TELEGRAM],
    content,
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// splitContent
// ---------------------------------------------------------------------------

describe('splitContent', () => {
  it('returns the original string as a single chunk when within limit', () => {
    const chunks = splitContent('hello world', 100);
    expect(chunks).toEqual(['hello world']);
  });

  it('splits at newlines when content exceeds limit', () => {
    const line1 = 'A'.repeat(50);
    const line2 = 'B'.repeat(50);
    const content = `${line1}\n${line2}`;
    const chunks = splitContent(content, 60);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it('hard-splits a single line longer than the limit', () => {
    const long = 'X'.repeat(250);
    const chunks = splitContent(long, 100);
    expect(chunks.length).toBe(3); // 100 + 100 + 50
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join('')).toBe(long);
  });

  it('produces no chunk exceeding the limit', () => {
    const content = Array.from({ length: 20 }, (_, i) => `Line ${i}: ${'x'.repeat(300)}`).join('\n');
    const chunks = splitContent(content, PLATFORM_LIMITS.telegram);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(PLATFORM_LIMITS.telegram);
    }
  });
});

// ---------------------------------------------------------------------------
// assertCriticalFactsPreserved
// ---------------------------------------------------------------------------

describe('assertCriticalFactsPreserved', () => {
  it('does not throw when all critical facts are present in chunks', () => {
    const original = 'Hash: abc123\nAmount: 100 XLM\nFrom: GA1\nTo: GB2';
    const chunks = ['Hash: abc123\nAmount: 100 XLM', 'From: GA1\nTo: GB2'];
    expect(() => assertCriticalFactsPreserved(original, chunks)).not.toThrow();
  });

  it('throws when a critical fact value is missing from all chunks', () => {
    const original = 'Hash: abc123\nAmount: 100 XLM';
    const chunks = ['Hash: abc123']; // Amount dropped
    expect(() => assertCriticalFactsPreserved(original, chunks)).toThrow(
      /transaction-critical fact/,
    );
  });

  it('does not throw for non-critical lines being absent', () => {
    const original = 'Status update\nHash: abc123';
    const chunks = ['Hash: abc123']; // "Status update" has no colon so is not a critical line
    expect(() => assertCriticalFactsPreserved(original, chunks)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// splitNotificationContent — transaction messages
// ---------------------------------------------------------------------------

describe('splitNotificationContent (TRANSACTION)', () => {
  it('returns wasSplit=false for a short transaction message', () => {
    const msg = makeMessage('✅ Transaction Successful\n\nHash: `abc`\nAmount: 10 XLM\nFrom: GA1\nTo: GB2');
    const result = splitNotificationContent(msg, PLATFORM_LIMITS.telegram);
    expect(result.wasSplit).toBe(false);
    expect(result.chunks.length).toBe(1);
  });

  it('splits an oversized transaction message without losing critical facts', () => {
    // Build a message that exceeds Discord's 2000-char limit by padding the memo.
    const longMemo = 'M'.repeat(2100);
    const content =
      `✅ Transaction Successful\n\n` +
      `Hash: \`deadbeef1234\`\n` +
      `Amount: 9999.99 XLM\n` +
      `From: GABC\n` +
      `To: GXYZ\n` +
      `Fee: 0.00001\n` +
      `Memo: ${longMemo}`;

    const msg = makeMessage(content);
    const result = splitNotificationContent(msg, PLATFORM_LIMITS.discord);

    expect(result.wasSplit).toBe(true);
    for (const c of result.chunks) {
      expect(c.length).toBeLessThanOrEqual(PLATFORM_LIMITS.discord);
    }

    // Every chunk combined must contain the critical values.
    const combined = result.chunks.join('\n');
    expect(combined).toContain('deadbeef1234');
    expect(combined).toContain('9999.99 XLM');
    expect(combined).toContain('GABC');
    expect(combined).toContain('GXYZ');
  });

  it('does not throw for non-TRANSACTION oversized messages', () => {
    const content = 'x'.repeat(5000);
    const msg = makeMessage(content, NotificationType.ANNOUNCEMENT);
    expect(() => splitNotificationContent(msg, PLATFORM_LIMITS.telegram)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Platform limit constants are sane
// ---------------------------------------------------------------------------

describe('PLATFORM_LIMITS', () => {
  it('telegram limit is 4096', () => expect(PLATFORM_LIMITS.telegram).toBe(4096));
  it('discord limit is 2000', () => expect(PLATFORM_LIMITS.discord).toBe(2000));
});
