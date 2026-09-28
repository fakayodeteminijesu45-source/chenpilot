import {
  DEFAULT_BASE_RESERVE_XLM,
  aggregateWithdrawableTotals,
  computeProtocolBalance,
  minimumReserveXlm,
  type ProtocolAccountContext,
} from '../../src/services/protocolBalances';

/**
 * Issue #853: the portfolio must separate the balances the Stellar protocol
 * actually lets an account withdraw from the gross deposits it reports.
 */
describe('Issue #853: withdrawable protocol balances', () => {
  const baseContext: ProtocolAccountContext = {
    baseReserveXlm: DEFAULT_BASE_RESERVE_XLM,
    subentryCount: 0,
    numSponsoring: 0,
    numSponsored: 0,
  };

  describe('minimumReserveXlm', () => {
    it('charges two base reserves for the account itself', () => {
      expect(minimumReserveXlm(baseContext)).toBe(1);
    });

    it('adds one base reserve per subentry', () => {
      expect(minimumReserveXlm({ ...baseContext, subentryCount: 3 })).toBe(2.5);
    });

    it('credits sponsored subentries and charges sponsored ones', () => {
      expect(
        minimumReserveXlm({
          ...baseContext,
          subentryCount: 4,
          numSponsoring: 1,
          numSponsored: 2,
        })
      ).toBe(2.5);
    });

    it('never returns a negative reserve when sponsorship exceeds the account size', () => {
      expect(
        minimumReserveXlm({ ...baseContext, subentryCount: 0, numSponsored: 9 })
      ).toBe(0);
    });

    it('falls back to the documented default base reserve when none is supplied', () => {
      expect(minimumReserveXlm({ subentryCount: 2 })).toBe(
        4 * DEFAULT_BASE_RESERVE_XLM
      );
    });
  });

  describe('computeProtocolBalance', () => {
    it('locks the minimum reserve out of the native XLM balance', () => {
      const result = computeProtocolBalance(
        { code: 'XLM', issuer: '', amount: 100, isNative: true },
        { ...baseContext, subentryCount: 2 }
      );

      expect(result.locked).toBe(2); // (2 + 2) * 0.5
      expect(result.withdrawable).toBe(98);
      expect(result.lockedReasons).toEqual(['minimum-reserve']);
    });

    it('locks selling liabilities on top of the native reserve', () => {
      const result = computeProtocolBalance(
        {
          code: 'XLM',
          issuer: '',
          amount: 100,
          isNative: true,
          sellingLiabilities: 30,
        },
        baseContext
      );

      expect(result.locked).toBe(31); // 1 reserve + 30 liabilities
      expect(result.withdrawable).toBe(69);
      expect(result.lockedReasons).toEqual([
        'minimum-reserve',
        'selling-liabilities',
      ]);
    });

    it('locks selling liabilities on an issued asset without charging the XLM reserve to it', () => {
      const result = computeProtocolBalance(
        {
          code: 'USDC',
          issuer: 'GISSUER',
          amount: 250,
          isNative: false,
          sellingLiabilities: 10,
          authorized: true,
        },
        { ...baseContext, subentryCount: 5 }
      );

      expect(result.locked).toBe(10);
      expect(result.withdrawable).toBe(240);
      expect(result.lockedReasons).toEqual(['selling-liabilities']);
    });

    it('treats a frozen trustline as fully non-withdrawable', () => {
      const result = computeProtocolBalance(
        {
          code: 'SCAM',
          issuer: 'GISSUER',
          amount: 42,
          isNative: false,
          authorized: false,
        },
        baseContext
      );

      expect(result.locked).toBe(42);
      expect(result.withdrawable).toBe(0);
      expect(result.lockedReasons).toEqual(['trustline-frozen']);
    });

    it('reports a clean balance as fully withdrawable', () => {
      const result = computeProtocolBalance(
        { code: 'USDC', issuer: 'GISSUER', amount: 10, isNative: false },
        baseContext
      );

      expect(result.withdrawable).toBe(10);
      expect(result.locked).toBe(0);
      expect(result.lockedReasons).toEqual([]);
    });

    it('never lets locked exceed the balance when the reserve is larger than the funds', () => {
      const result = computeProtocolBalance(
        { code: 'XLM', issuer: '', amount: 0.25, isNative: true },
        { ...baseContext, subentryCount: 10 }
      );

      expect(result.locked).toBe(0.25);
      expect(result.withdrawable).toBe(0);
      expect(result.locked).toBeLessThanOrEqual(result.total);
    });

    it('treats an empty balance as fully withdrawable with no locks', () => {
      const result = computeProtocolBalance(
        { code: 'XLM', issuer: '', amount: 0, isNative: true },
        baseContext
      );

      expect(result).toMatchObject({
        total: 0,
        locked: 0,
        withdrawable: 0,
        lockedReasons: [],
      });
    });

    it('conserves value: locked + withdrawable always equals the gross balance', () => {
      const cases = [
        { code: 'XLM', issuer: '', amount: 12.345, isNative: true },
        { code: 'XLM', issuer: '', amount: 12.345, isNative: true, sellingLiabilities: 2 },
        { code: 'USDC', issuer: 'G', amount: 7.5, isNative: false },
        { code: 'USDC', issuer: 'G', amount: 7.5, isNative: false, authorized: false },
      ];

      for (const input of cases) {
        const result = computeProtocolBalance(input, {
          ...baseContext,
          subentryCount: 3,
        });
        expect(result.locked + result.withdrawable).toBeCloseTo(result.total, 10);
      }
    });
  });

  describe('aggregateWithdrawableTotals', () => {
    it('returns nulls when nothing could be priced', () => {
      expect(
        aggregateWithdrawableTotals([
          { total: 100, withdrawable: 80, valueInCurrency: null },
        ])
      ).toEqual({ totalDeposits: null, withdrawable: null, locked: null });
    });

    it('scales the withdrawable value with the withdrawable ratio of each asset', () => {
      const totals = aggregateWithdrawableTotals([
        // 100 XLM worth 200 USD, of which 25% is withdrawable.
        { total: 100, withdrawable: 25, valueInCurrency: 200 },
        // 500 USDC worth 500 USD, fully withdrawable.
        { total: 500, withdrawable: 500, valueInCurrency: 500 },
      ]);

      expect(totals.totalDeposits).toBe(700);
      expect(totals.withdrawable).toBe(550);
      expect(totals.locked).toBe(150);
    });

    it('ignores unpriced assets so the split matches totalValue semantics', () => {
      const totals = aggregateWithdrawableTotals([
        { total: 1000, withdrawable: 1000, valueInCurrency: null },
        { total: 10, withdrawable: 5, valueInCurrency: 10 },
      ]);

      expect(totals.totalDeposits).toBe(10);
      expect(totals.withdrawable).toBe(5);
      expect(totals.locked).toBe(5);
    });

    it('treats a zero balance as nothing withdrawable without dividing by zero', () => {
      const totals = aggregateWithdrawableTotals([
        { total: 0, withdrawable: 0, valueInCurrency: 0 },
        { total: 10, withdrawable: 10, valueInCurrency: 10 },
      ]);

      expect(totals).toEqual({
        totalDeposits: 10,
        withdrawable: 10,
        locked: 0,
      });
    });
  });
});
