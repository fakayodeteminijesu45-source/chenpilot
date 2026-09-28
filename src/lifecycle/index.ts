/**
 * src/lifecycle/index.ts
 *
 * Barrel export for the data lifecycle management system.
 *
 * Sub-systems:
 *  - classification  : Data class registry (owner, purpose, retention, erasure method)
 *  - keyManagement   : Per-user DEK envelope encryption + cryptographic erasure
 *  - legalHold       : Explicit hold placement / lifting; blocks retention and erasure
 *  - retentionEngine : Scheduled time-based retention enforcement
 *  - deletionCoordinator : Fan-out user erasure across all stores
 *  - erasureReporter : Cryptographic proof-of-erasure receipts
 */

// Classification
export type {
  DataClass,
  DataClassOwner,
  ErasureMethod,
  ClassificationRecord,
} from "./classification";
export {
  REGISTRY,
  getClassification,
  isUserOwned,
  getUserOwnedClasses,
  getCryptoErasureClasses,
  getTimeBasedRetentionClasses,
  getActiveWorkflowProtectedClasses,
} from "./classification";

// Key Management
export { KeyManagementService, keyManagementService, ErasedKeyError, KeyManagementError } from "./keyManagement";

// Legal Hold
export type { PlaceHoldParams } from "./legalHold";
export { LegalHoldService, legalHoldService, HoldBlocksErasureError } from "./legalHold";

// Retention Engine
export type { RetentionPassResult } from "./retentionEngine";
export { RetentionEngine, retentionEngine } from "./retentionEngine";

// Deletion Coordinator
export type { ErasureOptions, ErasureResult } from "./deletionCoordinator";
export { DeletionCoordinator, deletionCoordinator } from "./deletionCoordinator";

// Erasure Reporter
export type { ErasureReceipt, ErasureReport } from "./erasureReporter";
export { ErasureReporter, erasureReporter } from "./erasureReporter";

// Entities (for registration in Datasource.ts)
export { UserKeyTombstone } from "./userKeyTombstone.entity";
export { LegalHoldEntry } from "./legalHoldEntry.entity";
export { ErasureReceipt as ErasureReceiptEntity } from "./erasureReceipt.entity";
