import {
  NetTransferFlowReconciliation,
  TransferFeeComponents,
  TransferFlowWindow,
  computeNetTransferFlow,
  reconcileNetTransferFlow,
  sumFeeComponents,
  transferFeesFromCostComponents,
} from '../../src/domain/execution/portfolioFlow';
import { CostComponentValues } from '../../src/domain/quotes/costComponents';

const FEES: TransferFeeComponents = {
  baseFee: '0.0000100',
  priorityFee: '0.0000200',
  networkFee: '0.0000300',
  contractFee: '0.0001000',
};

const WINDOW: TransferFlowWindow = {
  grossInflow: '100.0000000',
  grossOutflow: '40.0000000',
  fees: FEES,
};

describe('Issue #857: Portfolio net transfer flow reconciliation (explicit fee components)', () => {
  describe('net flow identity', () => {
    it('computes netFlow = grossInflow - grossOutflow - explicit fee components', () => {
      const flow = computeNetTransferFlow(WINDOW);

      expect(flow.grossInflow).toBe('100');
      expect(flow.grossOutflow).toBe('40');
      // 0.00001 + 0.00002 + 0.00003 + 0.0001 = 0.00016
      expect(flow.totalFees).toBe('0.00016');
      expect(flow.netFlow).toBe('59.99984');
    });

    it('keeps every fee component individually attributable', () => {
      const flow = computeNetTransferFlow(WINDOW);

      expect(flow.feeBreakdown).toEqual(FEES);
      // Re-deriving the total from the exposed breakdown reproduces netFlow.
      const fromBreakdown = sumFeeComponents(flow.feeBreakdown);
      expect(fromBreakdown).toBe(flow.totalFees);
    });

    it('is exact for large magnitudes (no floating-point drift)', () => {
      const flow = computeNetTransferFlow({
        grossInflow: '999999999999.9999999',
        grossOutflow: '0.0000001',
        fees: { baseFee: '0.0000001', priorityFee: '0', networkFee: '0', contractFee: '0' },
      });

      expect(flow.netFlow).toBe('999999999999.9999997');
    });
  });

  describe('explicit components are not collapsed into one aggregate', () => {
    it('distinguishes a split that preserves the same total fee', () => {
      const baseCharged: TransferFlowWindow = {
        grossInflow: '100',
        grossOutflow: '40',
        fees: { baseFee: '0.00006', priorityFee: '0', networkFee: '0', contractFee: '0.0001' },
      };
      const priorityCharged: TransferFlowWindow = {
        grossInflow: '100',
        grossOutflow: '40',
        fees: { baseFee: '0', priorityFee: '0.00006', networkFee: '0', contractFee: '0.0001' },
      };

      const a = computeNetTransferFlow(baseCharged);
      const b = computeNetTransferFlow(priorityCharged);

      // Same aggregate fee...
      expect(a.totalFees).toBe(b.totalFees);
      expect(a.netFlow).toBe(b.netFlow);
      // ...but the split stays visible, which a single collapsed fee would hide.
      expect(a.feeBreakdown.baseFee).toBe('0.00006');
      expect(b.feeBreakdown.priorityFee).toBe('0.00006');
      expect(a.feeBreakdown).not.toEqual(b.feeBreakdown);
    });
  });

  describe('reconciliation against the observed net flow', () => {
    it('reconciles exactly when the observed net flow matches', () => {
      const result: NetTransferFlowReconciliation = reconcileNetTransferFlow(
        WINDOW,
        '59.99984'
      );

      expect(result.status).toBe('reconciled');
      expect(result.dataAvailable).toBe(true);
      expect(result.expectedNetFlow).toBe('59.99984');
      expect(result.reportedNetFlow).toBe('59.99984');
      expect(result.attributableDifference).toBe('0');
    });

    it('flags drift when the observed flow collapsed fees, with an attributable difference', () => {
      // Observed figure subtracted only the contract fee, not base/priority/network.
      const reportedWithCollapsedFees = '59.9999';
      const result = reconcileNetTransferFlow(WINDOW, reportedWithCollapsedFees);

      expect(result.status).toBe('drift');
      expect(result.attributableDifference).toBe('-0.00006');
      // The difference is exactly the omitted explicit components.
      const omitted = sumFeeComponents({
        baseFee: FEES.baseFee,
        priorityFee: FEES.priorityFee,
        networkFee: FEES.networkFee,
        contractFee: '0',
      });
      expect(omitted).toBe('0.00006');
    });

    it('reports indeterminate — never reconciled — when the observed flow is unavailable', () => {
      for (const reported of [null, undefined, '   ']) {
        const result = reconcileNetTransferFlow(WINDOW, reported);
        expect(result.status).toBe('indeterminate');
        expect(result.dataAvailable).toBe(false);
        expect(result.reportedNetFlow).toBeNull();
        expect(result.attributableDifference).toBe('N/A — reported net flow unavailable');
      }
    });

    it('applies the tolerance boundary before reporting drift', () => {
      const withinTolerance = reconcileNetTransferFlow(WINDOW, '59.9999', {
        tolerance: '0.0001',
      });
      expect(withinTolerance.status).toBe('reconciled');

      const beyondTolerance = reconcileNetTransferFlow(WINDOW, '59.9999', {
        tolerance: '0.00001',
      });
      expect(beyondTolerance.status).toBe('drift');
    });

    it('reconciles a negative observed net flow (net outflow window)', () => {
      const outflowWindow: TransferFlowWindow = {
        grossInflow: '10',
        grossOutflow: '40',
        fees: { baseFee: '0.00001', priorityFee: '0', networkFee: '0', contractFee: '0' },
      };
      const flow = computeNetTransferFlow(outflowWindow);
      expect(flow.netFlow).toBe('-30.00001');

      const result = reconcileNetTransferFlow(outflowWindow, '-30.00001');
      expect(result.status).toBe('reconciled');
      expect(result.attributableDifference).toBe('0');
    });
  });

  describe('reuses the existing decomposed execution cost model', () => {
    const costs: CostComponentValues = {
      priceImpactBps: 20,
      priceImpactAbsolute: '0.0020000',
      slippageBps: 50,
      slippageAbsolute: '0.0050000',
      protocolFee: '0.0030000',
      networkFee: '0.0000500',
      solverSpreadBps: 15,
      solverSpreadAbsolute: '0.0015000',
    };

    it('maps CostComponentValues fees into explicit flow buckets without inventing a split', () => {
      const fees = transferFeesFromCostComponents(costs);
      expect(fees).toEqual({
        baseFee: '0',
        priorityFee: '0',
        networkFee: '0.0000500',
        contractFee: '0.0030000',
      });
    });

    it('reconciles a window whose fees came from the execution cost model', () => {
      const window: TransferFlowWindow = {
        grossInflow: '500',
        grossOutflow: '100',
        fees: transferFeesFromCostComponents(costs),
      };
      // 500 - 100 - 0.00305 = 399.99695
      const flow = computeNetTransferFlow(window);
      expect(flow.netFlow).toBe('399.99695');

      const result = reconcileNetTransferFlow(window, '399.99695');
      expect(result.status).toBe('reconciled');
      expect(result.totalFees).toBe('0.00305');
    });
  });

  describe('input guarding', () => {
    it('rejects negative fee components', () => {
      expect(() =>
        sumFeeComponents({
          baseFee: '-0.0000100',
          priorityFee: '0',
          networkFee: '0',
          contractFee: '0',
        })
      ).toThrow(/must be non-negative/);
    });

    it('rejects negative gross flows', () => {
      expect(() =>
        computeNetTransferFlow({
          grossInflow: '-1',
          grossOutflow: '0',
          fees: { baseFee: '0', priorityFee: '0', networkFee: '0', contractFee: '0' },
        })
      ).toThrow(/grossInflow must be non-negative/);
    });

    it('rejects amounts with more precision than the asset supports', () => {
      expect(() => computeNetTransferFlow({ ...WINDOW, grossInflow: '1.00000001' })).toThrow(
        /exceeds asset precision/
      );
    });
  });
});
