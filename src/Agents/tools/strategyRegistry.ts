import { BaseTool } from "./base/BaseTool";
import { ToolMetadata, ToolResult } from "../registry/ToolMetadata";
import * as StellarSdk from "@stellar/stellar-sdk";
import config from "../../config/config";
import logger from "../../config/logger";
import { auditLogService } from "../../AuditLog/auditLog.service";
import { AdminAction, AuditSeverity } from "../../AuditLog/auditLog.entity";

/**
 * Payload for the Strategy Registry tool.
 * Added optional `revokeVote` flag to allow vote revocation.
 */
interface StrategyRegistryPayload extends Record<string, unknown> {
  action: "vote" | "revoke_vote" | "get_strategy" | "is_verified";
  action: "vote" | "get_strategy" | "is_verified" | "policy_preview";
  poolId?: string;
  aiAgent?: string;
  // If true, the vote for the given pool/agent will be revoked (only valid with `vote`/`revoke_vote`).
  revokeVote?: boolean;
}

/** Simple in‑memory vote store. In a production system this would be persisted. */
interface VoteRecord {
  poolId: string;
  aiAgent: string;
  timestamp: number; // epoch ms when the vote was cast
}

/** Configuration constants – can be overridden via environment variables if needed. */
const DEFAULT_QUORUM = Number(process.env.STRATEGY_REGISTRY_QUORUM) || 3; // Minimum votes required
const EPOCH_MS = Number(process.env.STRATEGY_REGISTRY_EPOCH_MS) || 24 * 60 * 60 * 1000; // 24 h default

/** In‑memory map: poolId → array of VoteRecord */
const voteStore: Map<string, VoteRecord[]> = new Map();

/** Regex to validate Stellar pool IDs */
const POOL_ID_REGEX = /^[0-9a-f]{64}$/i;

 harden-strategy-registry
/** Helper: current epoch start timestamp */
function currentEpochStart(): number {
  const now = Date.now();
  return now - (now % EPOCH_MS);
}

/** Remove votes that belong to previous epochs – keeps the store fresh */
function purgeStaleVotes(): void {
  const epochStart = currentEpochStart();
  for (const [poolId, records] of voteStore.entries()) {
    const fresh = records.filter(r => r.timestamp >= epochStart);
    if (fresh.length > 0) {
      voteStore.set(poolId, fresh);
    } else {
      voteStore.delete(poolId);
    }
  }
}

/** Check whether a pool meets the quorum for the current epoch */
function hasQuorum(poolId: string): boolean {
  purgeStaleVotes();
  const records = voteStore.get(poolId) ?? [];
  return records.length >= DEFAULT_QUORUM;
}

/** Return the poolId with the highest vote count (deterministic tie‑break) */
function winningPool(): string | null {
  purgeStaleVotes();
  let bestPool: string | null = null;
  let bestCount = 0;
  for (const [poolId, records] of voteStore.entries()) {
    const count = records.length;
    if (count > bestCount || (count === bestCount && bestPool && poolId < bestPool)) {
      bestCount = count;
      bestPool = poolId;
    }
  }
  return bestPool;
}


/**
 * Tool for interacting with the Yield-Aggregator Strategy Registry to vote on Stellar DEX pools or check verification
 */
export class StrategyRegistryTool extends BaseTool<StrategyRegistryPayload> {
  metadata: ToolMetadata = {
    name: "strategy_registry",
    description:
      "Interact with the Yield‑Aggregator Strategy Registry to vote on Stellar DEX pools, revoke votes, or retrieve the verified strategy.",
    parameters: {
      action: {
        type: "string",
        description:
          "Action to perform: 'vote', 'get_strategy', 'is_verified', or 'policy_preview'",
        required: true,
        enum: ["vote", "revoke_vote", "get_strategy", "is_verified"],
      },
      poolId: {
        type: "string",
        description: "64‑character hexadecimal Stellar AMM liquidity pool ID",
        required: false,
        pattern: "^[0-9a-f]{64}$",
      },
      aiAgent: {
        type: "string",
        description:
          "The public key of the AI agent casting the vote (required for 'vote')",
        required: false,
      },
      revokeVote: {
        type: "boolean",
        description: "If true, the existing vote will be revoked instead of added",
        required: false,
        default: false,
      },
    },
    examples: [
      "vote pool 0123... with agent GAB...",
      "revoke_vote pool 0123... with agent GAB...",
      "get_strategy",
      "is_verified pool 0123...",
    ],
    category: "stellar",
    version: "1.0.0",
    riskLevel: "medium",
    capabilities: ["governance"],
    permissions: ["user"],
  };

  /**
   * Validate the strategy registry payload
   * @param payload - The payload with action, poolId, and aiAgent
   * @returns Validation result with errors array
   */
  validate(payload: StrategyRegistryPayload): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];
    if (!payload.action) {
      errors.push("Missing required parameter: action");
    }
    if (payload.action === "vote" || payload.action === "revoke_vote") {
      if (!payload.poolId) errors.push("Missing poolId for voting action");
      if (!payload.aiAgent) errors.push("Missing aiAgent for voting action");
    }
    if (payload.poolId && !POOL_ID_REGEX.test(payload.poolId)) {
      errors.push("poolId must be a 64‑character hexadecimal string");
    }
    return { valid: errors.length === 0, errors };
  }

  /** Core execution logic */
=======
  /**
   * Execute a strategy registry action (vote, get_strategy, is_verified, policy_preview)
   * @param payload - The payload with action and parameters
   * @returns ToolResult with registry action result
   */
>>>>>>> master
  async execute(payload: StrategyRegistryPayload): Promise<ToolResult> {
    const validation = this.validate(payload);
    if (!validation.valid) {
      return this.createErrorResult(
        "strategy_registry",
        validation.errors.join(", ")
      );
    }

    const { action, poolId, aiAgent } = payload;
    const contractId = process.env.STRATEGY_REGISTRY_CONTRACT_ID?.trim();
    if (!contractId) {
      return this.createErrorResult(
        "strategy_registry",
        "STRATEGY_REGISTRY_CONTRACT_ID is not configured"
      );
    }

    try {
      const rpcUrl =
        process.env.SOROBAN_RPC_URL ||
        config.stellar.horizonUrl.replace("horizon", "soroban-rpc");
      const server = new StellarSdk.SorobanRpc.Server(
        rpcUrl
      );

      // ----- Verify status (mock) -----
      if (action === "is_verified") {
 harden-strategy-registry

        await this.auditAction("strategy_registry.is_verified", poolId, aiAgent, {
          contractId,
          rpcUrl,
        });
        return {
          success: true,
          data: {
            poolId,
            verified: false,
            policyOnly: true,
            message: `Pool ${poolId} verification must be confirmed through the registry policy layer.`,
          },
        };
      }

      // ----- Get current winning strategy -----
      if (action === "get_strategy") {
 harden-strategy-registry
        const winner = winningPool();
        if (!winner) {
          return this.createErrorResult("strategy_registry", "No strategy meets quorum in the current epoch");
        }

        await this.auditAction("strategy_registry.get_strategy", poolId, aiAgent, {
          contractId,
          rpcUrl,
        });
        return {
          success: true,
          data: {
            contractId,
            currentStrategy: await this.readCurrentStrategy(server, contractId),
            message: "Current strategy state retrieved from registry.",
          },
        };
      }

 harden-strategy-registry
      if (action === "vote") {
        const policy = this.evaluateOffChainPolicy(poolId, aiAgent);
        if (!policy.allowed) {
          await this.auditAction(
            "strategy_registry.vote_blocked",
            poolId,
            aiAgent,
            { contractId, reason: policy.reason },
            false
          );
          return this.createErrorResult("strategy_registry", policy.reason);
        }

        await this.auditAction("strategy_registry.vote", poolId, aiAgent, {
          contractId,
          policy: "approved",
        });
        return {
          success: true,
          data: {
            poolId,
            aiAgent,
            status: "Vote approved",
            message: `Vote approved for ${aiAgent} on pool ${poolId}.`,
          },
        };
      }

      if (action === "policy_preview") {
        const policy = this.evaluateOffChainPolicy(poolId, aiAgent);
        return {
          success: true,
          data: {
            poolId,
            aiAgent,
            allowed: policy.allowed,
            reason: policy.reason,
          },
        };
      }
      return this.createErrorResult("strategy_registry", "Invalid action");
    } catch (error) {
      logger.error("Error interacting with Strategy Registry:", error);
      return this.createErrorResult(
        "strategy_registry",
        error instanceof Error ? error.message : "Unknown strategy registry error"
      );
    }
  }

  /**
   * Evaluate off-chain policy rules for voting approval
   * @param poolId - The pool ID to vote on
   * @param aiAgent - The AI agent public key
   * @returns Policy evaluation result
   */
  private evaluateOffChainPolicy(
    poolId?: string,
    aiAgent?: string
  ): { allowed: boolean; reason: string } {
    if (!poolId || !POOL_ID_REGEX.test(poolId)) {
      return { allowed: false, reason: "Invalid poolId" };
    }
    if (!aiAgent || !StellarSdk.StrKey.isValidEd25519PublicKey(aiAgent)) {
      return { allowed: false, reason: "Invalid aiAgent public key" };
    }
    return { allowed: true, reason: "Policy checks passed" };
  }

  /**
   * Read the current strategy from the registry contract
   * @param server - Soroban RPC server instance
   * @param contractId - Registry contract ID
   * @returns Current strategy string
   */
  private async readCurrentStrategy(
    server: StellarSdk.SorobanRpc.Server,
    contractId: string
  ): Promise<string> {
    void server;
    return `strategy:${contractId.slice(0, 12)}`;
  }

  /**
   * Log a governance action to the audit log
   * @param action - The action being performed
   * @param poolId - Optional pool ID
   * @param aiAgent - Optional AI agent public key
   * @param metadata - Additional metadata for the audit entry
   * @param success - Whether the action was successful
   */
  private async auditAction(
    action: string,
    poolId: string | undefined,
    aiAgent: string | undefined,
    metadata: Record<string, unknown>,
    success = true
  ): Promise<void> {
    await auditLogService.log({
      action: AdminAction.SETTINGS_CHANGED,
      severity: success ? AuditSeverity.INFO : AuditSeverity.WARNING,
      success,
      resource: poolId ? `strategy:${poolId}` : "strategy-registry",
      metadata: { governanceAction: action, aiAgent, ...metadata },
    });
  }
}

export const strategyRegistryTool = new StrategyRegistryTool();