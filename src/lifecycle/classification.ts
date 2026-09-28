/**
 * classification.ts
 *
 * Data lifecycle classification registry.
 * Every persisted data class in chenpilot must have an entry here declaring:
 *   - owner       who controls the data (user | tenant | system)
 *   - purpose     why it exists
 *   - retentionDays  how long to keep it (0 = expire immediately / governed by TTL)
 *   - erasureMethod  how to destroy it on deletion
 *   - requiresEncryption  whether it must be encrypted at rest
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

export type DataClassOwner = "user" | "tenant" | "system";

export type ErasureMethod =
  | "crypto"       // destroy the per-user DEK → ciphertext becomes unreadable
  | "hard-delete"  // physically remove rows/files
  | "nullify"      // zero/null PII fields, keep aggregate rows
  | "retain";      // legally immutable; never deleted (holds only)

export type DataClass =
  | "user_profile"
  | "user_private_key"
  | "refresh_token"
  | "contact"
  | "bot_session"
  | "bot_identity"
  | "conversation_memory"
  | "audit_log"
  | "transaction_lifecycle"
  | "queue_job"
  | "agent_execution_metrics"
  | "durable_execution"
  | "intervention_record"
  | "webhook_idempotency"
  | "reconciliation_report"
  | "user_preferences"
  | "account_secrets"
  | "redis_session"
  | "price_cache"
  | "rate_limit"
  | "log_file";

export interface ClassificationRecord {
  /** Canonical data class identifier */
  dataClass: DataClass;
  /** Who owns / controls this data */
  owner: DataClassOwner;
  /** Business purpose */
  purpose: string;
  /**
   * Maximum retention in days.
   * 0 = governed by Redis / system TTL (no explicit DB retention task needed).
   * 9999 = "keep until owner account is deleted" (enforced by eraseUser, not by time).
   */
  retentionDays: number;
  /** How this data class is erased */
  erasureMethod: ErasureMethod;
  /** Whether data at rest must be encrypted */
  requiresEncryption: boolean;
  /** Which DB table(s) / file path this covers */
  stores: string[];
  /**
   * When set, this data class must NOT be deleted while a parent workflow is
   * in an active (non-terminal) state.  The string describes the specific
   * protection rule so the retention engine and operators know why a time-based
   * cutoff is insufficient on its own.
   *
   * Terminal states for durable_execution: completed | failed | cancelled.
   * Retention engine must always include a status guard in its WHERE clause.
   */
  activeWorkflowGuard?: string;
  /** Notes for operators */
  notes?: string;
}

// ─── Registry ──────────────────────────────────────────────────────────────────

export const REGISTRY: Record<DataClass, ClassificationRecord> = {
  user_profile: {
    dataClass: "user_profile",
    owner: "user",
    purpose: "identity",
    retentionDays: 2555, // 7 years
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["user"],
    notes:
      "Includes name, email, address, role. Password hash is nullified before delete.",
  },

  user_private_key: {
    dataClass: "user_private_key",
    owner: "user",
    purpose: "signing",
    retentionDays: 9999, // retained until account deleted
    erasureMethod: "crypto",
    requiresEncryption: true,
    stores: ["user.encryptedPrivateKey"],
    notes:
      "Envelope-encrypted under per-user DEK. Cryptographic erasure = tombstone the DEK.",
  },

  refresh_token: {
    dataClass: "refresh_token",
    owner: "user",
    purpose: "auth_session",
    retentionDays: 30,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["refresh_token"],
    notes: "Expired and revoked tokens purged by retention engine.",
  },

  contact: {
    dataClass: "contact",
    owner: "user",
    purpose: "address_book",
    retentionDays: 2555,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["contact"],
  },

  bot_session: {
    dataClass: "bot_session",
    owner: "user",
    purpose: "wizard_state",
    retentionDays: 7,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["bot_session"],
    notes: "Transient wizard state; expired and inactive sessions purged quickly.",
  },

  bot_identity: {
    dataClass: "bot_identity",
    owner: "user",
    purpose: "platform_link",
    retentionDays: 2555,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["bot_identity"],
  },

  conversation_memory: {
    dataClass: "conversation_memory",
    owner: "user",
    purpose: "ai_context",
    retentionDays: 90,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["data/agent-memory.json"],
    notes:
      "Disk file keyed by userId. Cleared on user erasure; stale entries pruned by retention engine.",
  },

  audit_log: {
    dataClass: "audit_log",
    owner: "tenant",
    purpose: "compliance",
    retentionDays: 2555, // 7 years
    erasureMethod: "retain",
    requiresEncryption: false,
    stores: ["audit_log"],
    notes:
      "Immutable hash-chained ledger. Never deleted; only legal holds apply. User references become pseudonymous after user_profile erasure.",
  },

  transaction_lifecycle: {
    dataClass: "transaction_lifecycle",
    owner: "user",
    purpose: "financial_record",
    retentionDays: 2555, // 7 years financial record-keeping
    erasureMethod: "nullify",
    requiresEncryption: false,
    stores: ["transaction_lifecycle"],
    notes:
      "user_id nullified; tx hash and amount retained for financial audit. Complies with financial record-keeping requirements.",
  },

  queue_job: {
    dataClass: "queue_job",
    owner: "system",
    purpose: "operational",
    retentionDays: 30,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["job_queue"],
    notes: "Completed / cancelled jobs purged by retention engine.",
  },

  agent_execution_metrics: {
    dataClass: "agent_execution_metrics",
    owner: "system",
    purpose: "observability",
    retentionDays: 365,
    erasureMethod: "nullify",
    requiresEncryption: false,
    stores: ["agent_execution_metrics"],
    notes: "user_id nullified after retention period; aggregate metrics retained.",
  },

  durable_execution: {
    dataClass: "durable_execution",
    owner: "system",
    purpose: "saga_log",
    retentionDays: 90,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["durable_execution", "durable_step"],
    activeWorkflowGuard:
      "DELETE must include WHERE status IN ('completed','failed','cancelled'). " +
      "Records in pending|running|paused|awaiting_approval must never be reaped — " +
      "durable_step rows are deleted first (FK child) before the parent execution row.",
    notes:
      "Terminal saga state purged after 90 days. Child steps are deleted before their " +
      "parent execution rows to satisfy the FK RESTRICT constraint on intervention_records.",
  },

  intervention_record: {
    dataClass: "intervention_record",
    owner: "system",
    purpose: "operator_audit",
    retentionDays: 90,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["intervention_records"],
    activeWorkflowGuard:
      "An intervention_record row whose status is 'pending_approval' is a " +
      "temporary artifact tied to an active durable_execution. It must not be " +
      "deleted while the parent execution is non-terminal (pending|running|paused|" +
      "awaiting_approval). Retention cleanup must JOIN on durable_execution.status " +
      "IN ('completed','failed','cancelled') or check intervention_records.status " +
      "NOT IN ('pending_approval') before purging.",
    notes:
      "Immutable INSERT-only audit record of every operator intervention. " +
      "Rows in 'pending_approval' are live temporary artifacts: deleting them " +
      "would silently discard an in-flight high-risk approval request. " +
      "Only rows whose status is applied|rejected|failed|dry_run AND whose " +
      "parent execution is terminal may be purged after retentionDays.",
  },

  webhook_idempotency: {
    dataClass: "webhook_idempotency",
    owner: "system",
    purpose: "dedup",
    retentionDays: 7,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["webhook_idempotency"],
  },

  reconciliation_report: {
    dataClass: "reconciliation_report",
    owner: "system",
    purpose: "financial_audit",
    retentionDays: 2555,
    erasureMethod: "retain",
    requiresEncryption: false,
    stores: ["reconciliation_report"],
    notes: "Financial audit records; never deleted.",
  },

  user_preferences: {
    dataClass: "user_preferences",
    owner: "user",
    purpose: "config",
    retentionDays: 2555,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["user_preferences"],
  },

  account_secrets: {
    dataClass: "account_secrets",
    owner: "user",
    purpose: "signing",
    retentionDays: 9999, // retained until account deleted
    erasureMethod: "crypto",
    requiresEncryption: true,
    stores: ["AccountSecretStore (file)"],
    notes:
      "Encrypted file store. Cryptographic erasure = tombstone the per-user DEK.",
  },

  redis_session: {
    dataClass: "redis_session",
    owner: "user",
    purpose: "cache",
    retentionDays: 1,
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["Redis: session:*, user:*, bot:*"],
    notes: "Keys expire via Redis TTL; also explicitly deleted on user erasure.",
  },

  price_cache: {
    dataClass: "price_cache",
    owner: "system",
    purpose: "cache",
    retentionDays: 0, // governed by Redis TTL (~20 min)
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["Redis: price:*"],
    notes: "No user data. Expires automatically via Redis TTL.",
  },

  rate_limit: {
    dataClass: "rate_limit",
    owner: "system",
    purpose: "security",
    retentionDays: 0, // governed by Redis TTL (~1hr)
    erasureMethod: "hard-delete",
    requiresEncryption: false,
    stores: ["Redis: rl:*, rate-limit:*"],
    notes: "No persistent user data. Expires automatically via Redis TTL.",
  },

  log_file: {
    dataClass: "log_file",
    owner: "system",
    purpose: "operations",
    retentionDays: 30,
    erasureMethod: "retain",
    requiresEncryption: false,
    stores: ["logs/*.log, logs/*.gz"],
    notes:
      "Winston log rotation already manages 14–30 day retention. Sensitive fields auto-redacted at write time.",
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the ClassificationRecord for a given DataClass.
 * Throws if the class is not in the registry (should never happen with typed enum).
 */
export function getClassification(dataClass: DataClass): ClassificationRecord {
  const record = REGISTRY[dataClass];
  if (!record) {
    throw new Error(`Unknown data class: ${dataClass}`);
  }
  return record;
}

/**
 * Returns true if the data class is owned by a specific user
 * (as opposed to the tenant or the system).
 */
export function isUserOwned(dataClass: DataClass): boolean {
  return REGISTRY[dataClass]?.owner === "user";
}

/**
 * Returns all data classes owned by users.
 */
export function getUserOwnedClasses(): DataClass[] {
  return (Object.keys(REGISTRY) as DataClass[]).filter(isUserOwned);
}

/**
 * Returns all data classes that use cryptographic erasure.
 */
export function getCryptoErasureClasses(): DataClass[] {
  return (Object.keys(REGISTRY) as DataClass[]).filter(
    (dc) => REGISTRY[dc].erasureMethod === "crypto"
  );
}

/**
 * Returns all data classes with a time-based retention period (retentionDays > 0 and < 9999).
 */
export function getTimeBasedRetentionClasses(): DataClass[] {
  return (Object.keys(REGISTRY) as DataClass[]).filter(
    (dc) => REGISTRY[dc].retentionDays > 0 && REGISTRY[dc].retentionDays < 9999
  );
}

/**
 * Returns all data classes that carry an activeWorkflowGuard.
 *
 * These are "temporary artifacts" whose time-based retention cutoff is a
 * necessary but insufficient condition for deletion: the record must also
 * belong to a terminal workflow before it may be purged.
 *
 * The retention engine and any future cleanup jobs MUST check this set and
 * include the appropriate workflow-status guard in their DELETE statements.
 */
export function getActiveWorkflowProtectedClasses(): DataClass[] {
  return (Object.keys(REGISTRY) as DataClass[]).filter(
    (dc) => REGISTRY[dc].activeWorkflowGuard !== undefined
  );
}
