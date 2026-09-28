/**
 * Portfolio Service
 *
 * Fetches a user's Stellar account balances from Horizon and calculates
 * estimated net worth by pricing each asset against a target currency
 * via the Stellar DEX.
 *
 * Since Issue #853 the summary also separates the account's gross deposits
 * from the balances the Stellar protocol actually lets the account withdraw
 * (minimum reserve, open-offer liabilities and frozen trustlines are locked).
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import config from "../config/config";
import logger from "../config/logger";
import stellarPriceService from "./stellarPrice.service";
import {
  aggregateWithdrawableTotals,
  computeProtocolBalance,
  type LockReason,
  type ProtocolAccountContext,
  type WithdrawableTotals,
} from "./protocolBalances";

export interface AssetBalance {
  /** Asset code, e.g. "XLM", "USDC" */
  code: string;
  /** Issuer public key — empty string for native XLM */
  issuer: string;
  /** Raw balance string from Horizon */
  balance: string;
  /** Numeric balance */
  amount: number;
  /** Estimated value in the requested currency (null if price unavailable) */
  valueInCurrency: number | null;
  /** Whether this is the native XLM asset */
  isNative: boolean;
  /** Amount the protocol currently locks (reserve, liabilities, frozen trustline) */
  lockedAmount: number;
  /** Amount withdrawable right now: `amount - lockedAmount` */
  withdrawableAmount: number;
  /** Why part of the balance is locked (`[]` when fully withdrawable) */
  lockedReasons: LockReason[];
}

/**
 * Separation of total deposits from the balances withdrawable right now.
 * `totalDeposits` matches the gross `totalValue` above; `locked` is the value
 * the protocol holds back and `withdrawable + locked === totalDeposits`.
 */
export type PortfolioWithdrawable = WithdrawableTotals;

export interface PortfolioSummary {
  /** Stellar account address */
  address: string;
  /** Currency used for net-worth calculation */
  currency: string;
  /** All asset balances on the account */
  assets: AssetBalance[];
  /**
   * Sum of all asset values in the requested currency.
   * null when no prices could be resolved at all.
   */
  totalValue: number | null;
  /** Gross deposits vs withdrawable protocol balances (Issue #853) */
  withdrawable: PortfolioWithdrawable;
  /** ISO timestamp of when this snapshot was taken */
  fetchedAt: string;
}

const SUPPORTED_CURRENCIES = ["USD", "XLM", "BTC"] as const;
type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// Assets the price service knows how to look up (see stellarPrice.service.ts)
const PRICEABLE_ASSETS = new Set(["XLM", "USDC", "USDT"]);

/** Horizon balance line fields used by the withdrawable accounting. */
interface HorizonBalanceFields {
  asset_code?: string;
  asset_issuer?: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
}

/** Account-level fields used to derive the minimum reserve. */
interface HorizonAccountFields {
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

export class PortfolioService {
  private server: StellarSdk.Horizon.Server;

  constructor() {
    this.server = new StellarSdk.Horizon.Server(config.stellar.horizonUrl);
  }

  /**
   * Fetch all balances for a Stellar account and price them in the given
   * currency (USD | XLM | BTC, default USD).
   */
  async getPortfolio(
    address: string,
    currency: string = "USD"
  ): Promise<PortfolioSummary> {
    const normalizedCurrency = currency.toUpperCase() as SupportedCurrency;

    if (!SUPPORTED_CURRENCIES.includes(normalizedCurrency)) {
      throw new Error(
        `Unsupported currency "${currency}". Supported: ${SUPPORTED_CURRENCIES.join(", ")}`
      );
    }

    // Fetch account from Horizon
    let account: StellarSdk.Horizon.AccountResponse;
    try {
      account = await this.server.accounts().accountId(address).call();
    } catch (err) {
      logger.error("PortfolioService: failed to load account", { address, err });
      throw new Error(`Account not found or Horizon unreachable for: ${address}`);
    }

    const rawBalances =
      account.balances as StellarSdk.Horizon.HorizonApi.BalanceLine[];

    // Protocol-level context: minimum-reserve derivation needs the account
    // subentry count and sponsorship counters from Horizon.
    const accountFields = account as unknown as HorizonAccountFields;
    const reserveContext: ProtocolAccountContext = {
      baseReserveXlm: config.stellar.baseReserve,
      subentryCount: accountFields.subentry_count,
      numSponsoring: accountFields.num_sponsoring,
      numSponsored: accountFields.num_sponsored,
    };

    // Build the asset list, keeping the withdrawable portion separate from the
    // gross balance it was derived from.
    const assets: AssetBalance[] = rawBalances.map((b) => {
      const isNative = b.asset_type === "native";
      const line = b as unknown as HorizonBalanceFields;
      const code = isNative ? "XLM" : (line.asset_code as string);
      const issuer = isNative ? "" : (line.asset_issuer as string);
      const amount = parseFloat(b.balance);

      const breakdown = computeProtocolBalance(
        {
          code,
          issuer,
          amount,
          isNative,
          sellingLiabilities:
            line.selling_liabilities !== undefined
              ? parseFloat(line.selling_liabilities)
              : undefined,
          authorized: isNative ? undefined : line.is_authorized,
        },
        reserveContext
      );

      return {
        code,
        issuer,
        balance: b.balance,
        amount,
        valueInCurrency: null,
        isNative,
        lockedAmount: breakdown.locked,
        withdrawableAmount: breakdown.withdrawable,
        lockedReasons: breakdown.lockedReasons,
      };
    });

    // Price each asset concurrently
    await Promise.all(
      assets.map(async (asset) => {
        // Zero-balance assets are worth zero regardless of price
        if (asset.amount === 0) {
          asset.valueInCurrency = 0;
          return;
        }

        // Asset IS the target currency — 1:1
        if (asset.code === normalizedCurrency) {
          asset.valueInCurrency = asset.amount;
          return;
        }

        // Only attempt DEX pricing for assets the price service supports
        if (!PRICEABLE_ASSETS.has(asset.code)) {
          return; // leave as null
        }

        try {
          const quote = await stellarPriceService.getPrice(
            asset.code,
            normalizedCurrency,
            asset.amount
          );
          asset.valueInCurrency = quote.estimatedOutput;
        } catch (err) {
          logger.warn(
            `PortfolioService: could not price ${asset.code} → ${normalizedCurrency}`,
            { err }
          );
          // leave as null — partial data is still useful
        }
      })
    );

    // Total = sum of assets where a price was resolved
    const pricedAssets = assets.filter((a) => a.valueInCurrency !== null);
    const totalValue =
      pricedAssets.length > 0
        ? pricedAssets.reduce((sum, a) => sum + (a.valueInCurrency ?? 0), 0)
        : null;

    // Split the priced value into withdrawable vs protocol-locked (Issue #853)
    const withdrawable = aggregateWithdrawableTotals(
      assets.map((asset) => ({
        total: asset.amount,
        withdrawable: asset.withdrawableAmount,
        valueInCurrency: asset.valueInCurrency,
      }))
    );

    return {
      address,
      currency: normalizedCurrency,
      assets,
      totalValue,
      withdrawable,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Get the current DEX price of a single asset in the given currency.
   */
  async getAssetPrice(
    assetCode: string,
    currency: string = "USD"
  ): Promise<{ assetCode: string; currency: string; price: number }> {
    const from = assetCode.toUpperCase();
    const to = currency.toUpperCase();

    if (from === to) {
      return { assetCode: from, currency: to, price: 1 };
    }

    const quote = await stellarPriceService.getPrice(from, to, 1);
    return { assetCode: from, currency: to, price: quote.price };
  }
}

export const portfolioService = new PortfolioService();
export default portfolioService;
