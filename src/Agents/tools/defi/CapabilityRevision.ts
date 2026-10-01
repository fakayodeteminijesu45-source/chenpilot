/**
 * Capability advertisement revisions (Issue #855).
 *
 * DeFi adapters advertise the operations they support through
 * `DeFiAdapter.hasCapability()`. That advertisement is derived from the
 * adapter's configuration, so a configuration change must not leave a stale
 * advertisement in place: the previous advertisement is dropped, its revision
 * is bumped and every registered listener is notified before the next
 * advertisement is derived.
 *
 * The module is intentionally free of runtime dependencies (only Node's
 * `crypto`) so the invalidation semantics can be unit-tested in isolation.
 */

import * as crypto from "crypto";

/** Capability map shape advertised by an adapter. */
export type CapabilityFlags = Record<string, boolean>;

/** An advertisement of the capabilities valid for one configuration. */
export interface CapabilityAdvertisement<C extends CapabilityFlags> {
  /** Monotonic revision. Advances every time an advertisement is invalidated. */
  revision: number;
  /** Fingerprint of the configuration this advertisement was derived from. */
  configFingerprint: string;
  /** Frozen copy of the advertised capability flags. */
  capabilities: Readonly<C>;
  /** ISO timestamp the advertisement was issued. */
  issuedAt: string;
}

/** Emitted when a live advertisement is dropped. */
export interface CapabilityInvalidation<C extends CapabilityFlags> {
  /** Advertisement that was live before the invalidation (null when none was live). */
  previous: CapabilityAdvertisement<C> | null;
  /** Why the advertisement was invalidated, e.g. `"config-change"`. */
  reason: string;
  /** New revision after the invalidation. */
  revision: number;
  /** ISO timestamp of the invalidation. */
  invalidatedAt: string;
}

export type CapabilityInvalidationListener<C extends CapabilityFlags> = (
  event: CapabilityInvalidation<C>
) => void;

/**
 * Deterministic JSON serialisation: object keys are sorted and values that
 * JSON would drop (functions, `undefined`, symbols, cycles) get a stable
 * placeholder so the fingerprint only changes when the config does.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const normalise = (input: unknown): unknown => {
    if (input === null) return null;

    switch (typeof input) {
      case "undefined":
        return "[undefined]";
      case "function":
        return "[function]";
      case "symbol":
        return "[symbol]";
      case "bigint":
        return `[bigint:${input.toString()}]`;
      case "number":
        return Number.isFinite(input) ? input : `[number:${String(input)}]`;
      case "string":
      case "boolean":
        return input;
      default:
        break;
    }

    const object = input as object;

    if (seen.has(object)) return "[circular]";

    if (Array.isArray(object)) {
      seen.add(object);
      const array = object.map((entry) => normalise(entry));
      seen.delete(object);
      return array;
    }

    if (object instanceof Date) return object.toISOString();

    seen.add(object);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      sorted[key] = normalise((object as Record<string, unknown>)[key]);
    }
    seen.delete(object);
    return sorted;
  };

  return JSON.stringify(normalise(value));
}

/** SHA-256 fingerprint of a configuration. */
export function fingerprintConfig(config: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(config)).digest("hex");
}

export interface CapabilityAdvertisementManagerOptions {
  /** Injectable clock, mainly for deterministic tests. */
  now?: () => Date;
}

/**
 * Tracks the capability advertisement belonging to a configuration fingerprint.
 * A fingerprint change invalidates the previous advertisement before the new
 * one is derived, and an explicit `invalidate()` drops the live advertisement.
 */
export class CapabilityAdvertisementManager<C extends CapabilityFlags> {
  private revision = 0;
  private advertisement: CapabilityAdvertisement<C> | null = null;
  private readonly listeners = new Set<CapabilityInvalidationListener<C>>();
  private readonly now: () => Date;

  constructor(options: CapabilityAdvertisementManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Return the advertisement for `configFingerprint`, deriving it with `derive`
   * when none is live or the configuration changed. A changed fingerprint
   * invalidates the previous advertisement first (reasoning `reason`).
   */
  get(
    configFingerprint: string,
    derive: () => C,
    reason = "config-change"
  ): CapabilityAdvertisement<C> {
    if (
      this.advertisement &&
      this.advertisement.configFingerprint === configFingerprint
    ) {
      return this.advertisement;
    }

    // A live advertisement for a different configuration is stale: drop it and
    // bump the revision before deriving the replacement.
    if (this.advertisement) {
      this.invalidate(reason);
    }

    this.advertisement = Object.freeze({
      revision: this.revision,
      configFingerprint,
      capabilities: Object.freeze({ ...derive() }),
      issuedAt: this.now().toISOString(),
    });

    return this.advertisement;
  }

  /**
   * Drop the live advertisement. The revision always advances so consumers
   * holding an older advertisement can detect that it is stale.
   */
  invalidate(reason: string): CapabilityInvalidation<C> {
    const previous = this.advertisement;
    this.advertisement = null;
    this.revision += 1;

    const event: CapabilityInvalidation<C> = {
      previous,
      reason,
      revision: this.revision,
      invalidatedAt: this.now().toISOString(),
    };

    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }

  /** Current revision; advances on every invalidation. */
  getRevision(): number {
    return this.revision;
  }

  /** The live advertisement, or null when it has been invalidated. */
  peek(): CapabilityAdvertisement<C> | null {
    return this.advertisement;
  }

  /** Subscribe to invalidations; the returned function unsubscribes. */
  onInvalidate(listener: CapabilityInvalidationListener<C>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
