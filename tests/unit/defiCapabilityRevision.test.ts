import {
  CapabilityAdvertisementManager,
  fingerprintConfig,
  stableStringify,
} from '../../src/Agents/tools/defi/CapabilityRevision';

/**
 * Issue #855: advertised capabilities must be invalidated when the adapter
 * configuration they were derived from changes.
 */
describe('Issue #855: capability advertisement invalidation', () => {
  const caps = (swap: boolean, lending: boolean) => ({ swap, lending });

  describe('stableStringify / fingerprintConfig', () => {
    it('is independent of object key order', () => {
      expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
      expect(fingerprintConfig({ a: 1, b: 2 })).toBe(
        fingerprintConfig({ b: 2, a: 1 })
      );
    });

    it('changes when a capability flag changes', () => {
      const before = fingerprintConfig({ capabilities: caps(true, false) });
      const after = fingerprintConfig({ capabilities: caps(false, false) });

      expect(after).not.toBe(before);
    });

    it('serialises non-JSON values deterministically instead of throwing', () => {
      const nested: Record<string, unknown> = { value: 1 };
      nested.self = nested; // circular

      expect(() => stableStringify({ nested })).not.toThrow();
      expect(stableStringify({ nested })).toContain('[circular]');
      expect(stableStringify({ fn: () => undefined })).toBe(
        '{"fn":"[function]"}'
      );
    });
  });

  describe('CapabilityAdvertisementManager', () => {
    it('issues an advertisement stamped with revision 0 and the config fingerprint', () => {
      const manager = new CapabilityAdvertisementManager<Record<string, boolean>>();
      const derive = jest.fn(() => caps(true, false));

      const advertisement = manager.get('fp-1', derive);

      expect(advertisement.revision).toBe(0);
      expect(advertisement.configFingerprint).toBe('fp-1');
      expect(advertisement.capabilities).toEqual(caps(true, false));
      expect(derive).toHaveBeenCalledTimes(1);
    });

    it('reuses the live advertisement while the fingerprint is unchanged', () => {
      const manager = new CapabilityAdvertisementManager<Record<string, boolean>>();
      const derive = jest.fn(() => caps(true, false));

      const first = manager.get('fp-1', derive);
      const second = manager.get('fp-1', derive);

      expect(second).toBe(first);
      expect(derive).toHaveBeenCalledTimes(1);
      expect(manager.getRevision()).toBe(0);
    });

    it('invalidates the previous advertisement and bumps the revision when the configuration changes', () => {
      const manager = new CapabilityAdvertisementManager<Record<string, boolean>>();
      const before = manager.get('fp-1', () => caps(true, false));

      const after = manager.get('fp-2', () => caps(false, true));

      expect(after.configFingerprint).toBe('fp-2');
      expect(after.capabilities).toEqual(caps(false, true));
      expect(after.revision).toBe(1);
      expect(manager.getRevision()).toBe(1);
      expect(before.revision).toBe(0);
    });

    it('notifies listeners with the invalidated advertisement and the reason', () => {
      const manager = new CapabilityAdvertisementManager<Record<string, boolean>>();
      const before = manager.get('fp-1', () => caps(true, false));
      const events: unknown[] = [];
      manager.onInvalidate((event) => events.push(event));

      manager.get('fp-2', () => caps(false, false));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        reason: 'config-change',
        revision: 1,
        previous: { revision: 0, configFingerprint: 'fp-1' },
      });
    });

    it('drops the live advertisement on invalidate without deriving a replacement', () => {
      const manager = new CapabilityAdvertisementManager<Record<string, boolean>>();
      const derive = jest.fn(() => caps(true, false));
      manager.get('fp-1', derive);

      const event = manager.invalidate('manual');

      expect(manager.peek()).toBeNull();
      expect(event.reason).toBe('manual');
      expect(event.revision).toBe(1);
      expect(event.previous?.revision).toBe(0);
      expect(derive).toHaveBeenCalledTimes(1);
      expect(manager.getRevision()).toBe(1);
    });

    it('reports a stale advertisement as null through peek()', () => {
      const manager = new CapabilityAdvertisementManager<Record<string, boolean>>();
      manager.get('fp-1', () => caps(true, false));
      expect(manager.peek()).not.toBeNull();

      manager.invalidate('config-change');

      expect(manager.peek()).toBeNull();
    });

    it('stops notifying after the listener unsubscribes', () => {
      const manager = new CapabilityAdvertisementManager<Record<string, boolean>>();
      const listener = jest.fn();
      const unsubscribe = manager.onInvalidate(listener);

      manager.invalidate('first');
      unsubscribe();
      manager.invalidate('second');

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('keeps advancing the revision across repeated invalidations', () => {
      const manager = new CapabilityAdvertisementManager<Record<string, boolean>>();
      manager.get('fp-1', () => caps(true, false));

      manager.invalidate('a'); // revision 1
      manager.invalidate('b'); // revision 2, nothing live to advertise

      const readvertised = manager.get('fp-2', () => caps(false, false));
      expect(readvertised.revision).toBe(2);

      const afterConfigChange = manager.get('fp-3', () => caps(true, true));

      expect(afterConfigChange.revision).toBe(3);
      expect(manager.getRevision()).toBe(3);
      expect(manager.peek()?.revision).toBe(3);
    });

    it('freezes the issued advertisement so consumers cannot mutate it', () => {
      const manager = new CapabilityAdvertisementManager<Record<string, boolean>>();
      const advertisement = manager.get('fp-1', () => caps(true, false));

      expect(Object.isFrozen(advertisement.capabilities)).toBe(true);
      expect(() => {
        (advertisement.capabilities as Record<string, boolean>).swap = false;
      }).toThrow();
      expect(advertisement.capabilities.swap).toBe(true);
    });
  });
});
