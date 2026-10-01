/**
 * Signing preparation layer.
 *
 * Responsible for:
 *  - Detecting whether a simulation result requires authorization
 *  - Rejecting authorization entries that have already expired
 *  - Rejecting authorization scope wider than the approved intent
 *  - Assembling the transaction with the populated footprint from simulation
 *  - Signing the assembled transaction with a provided keypair
 *
 * This layer does NOT submit the transaction — submission is the invoker's job.
 */

import { StellarSdk, NETWORK_PASSPHRASES, SorobanNetwork } from "./sdkAdapter";
import {
  AuthExpiredError,
  AuthRequiredError,
  AuthScopeMismatchError,
  SigningError,
  NetworkMismatchError,
} from "./errors";
import { SecretBuffer } from "../../utils/secretBuffer";
import type { SimulationSuccess } from "./sdkAdapter";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SigningContext {
  network: SorobanNetwork;
  secretKey: string;
  /**
   * Latest ledger sequence known to the caller. When supplied together with
   * auth entries carrying an expiration, `prepareSignedTransaction` rejects
   * entries that have already expired instead of signing a doomed envelope.
   *
   * Optional — when omitted, no expiry check is performed.
   */
  currentLedgerSeq?: number;
  /**
   * The invocation the user actually approved. When supplied, the
   * authorization tree the simulation asks to be signed is compared against
   * it, and signing is refused if the tree reaches anything this does not
   * already permit.
   *
   * Optional — when omitted, no scope check is performed.
   */
  approvedIntent?: ApprovedAuthScope;
}

/**
 * The scope a user has approved for a contract call.
 *
 * `contractId`/`method` describe the call the user agreed to. `allowedTargets`
 * lists any additional `contractId:method` pairs the user has separately
 * approved, for the common case where a contract legitimately needs auth for a
 * helper contract it calls.
 */
export interface ApprovedAuthScope {
  contractId: string;
  method: string;
  /**
   * Extra approved `contractId:method` pairs. An auth tree node matching any
   * of these is accepted. Intended for cross-contract calls the user has
   * already reviewed.
   */
  allowedTargets?: string[];
}

export interface AssembledTransaction {
  /** The signed XDR string ready for submission */
  signedXdr: string;
  /** The keypair used for signing */
  signerPublicKey: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return true when the simulation result contains auth entries that must be
 * signed before the transaction can be submitted.
 */
export function requiresSigning(sim: SimulationSuccess): boolean {
  const auth = sim.result?.auth;
  return Array.isArray(auth) && auth.length > 0;
}

/**
 * Assemble and sign a transaction using the simulation result's footprint.
 *
 * Throws `AuthRequiredError` when auth entries are present but no signing
 * context is provided.
 *
 * Throws `NetworkMismatchError` when the transaction envelope was built for a
 * different network passphrase than the client claims to be on — before any
 * signature bytes are produced.
 *
 * Throws `AuthExpiredError` when `context.currentLedgerSeq` is supplied and an
 * authorization entry in the simulation result has already expired.
 *
 * Throws `AuthScopeMismatchError` when `context.approvedIntent` is supplied and
 * the authorization tree asks to approve a contract/method outside it.
 *
 * Throws `SigningError` when the SDK's `assembleTransaction` helper is
 * unavailable or signing fails.
 */
export function prepareSignedTransaction(
  unsignedTx: StellarSdk.Transaction,
  sim: SimulationSuccess,
  context: SigningContext
): AssembledTransaction {
  assertNetworkMatches(unsignedTx, context.network);

  if (context.currentLedgerSeq !== undefined) {
    assertAuthNotExpired(sim, context.currentLedgerSeq);
  }

  if (context.approvedIntent !== undefined) {
    assertAuthScopeMatches(sim, context.approvedIntent);
  }

  // Wrap the secret key to minimize its lifetime and prevent accidental
  // exposure through logging, serialization, or error propagation.
  const secret = SecretBuffer.fromString(
    context.secretKey,
    "stellar-secret-key"
  );
  try {
    const keypair = parseKeypair(secret);
    const assembled = assembleWithSimulation(unsignedTx, sim, context.network);
    assembled.sign(keypair);

    return {
      signedXdr: assembled.toEnvelope().toXDR("base64"),
      signerPublicKey: keypair.publicKey(),
    };
  } finally {
    secret.destroy();
  }
}

/**
 * Guard: refuse to sign when the transaction envelope's network passphrase
 * disagrees with the client's declared network. This runs BEFORE any signing
 * step so no signature is ever produced for the wrong environment.
 */
function assertNetworkMatches(
  tx: StellarSdk.Transaction,
  network: SorobanNetwork
): void {
  const expected = NETWORK_PASSPHRASES[network];
  const transactionPassphrase = tx.networkPassphrase;
  if (
    typeof transactionPassphrase === "string" &&
    transactionPassphrase.length > 0 &&
    transactionPassphrase !== expected
  ) {
    throw new NetworkMismatchError({
      expectedNetwork: network,
      transactionNetwork: transactionPassphrase,
    });
  }
}

/**
 * Guard: throw `AuthRequiredError` when the simulation requires signing but
 * no secret key was supplied.
 */
export function assertSigningNotRequired(
  sim: SimulationSuccess,
  hasSecretKey: boolean
): void {
  if (requiresSigning(sim) && !hasSecretKey) {
    throw new AuthRequiredError();
  }
}

/**
 * Guard: throw `AuthExpiredError` when any authorization entry in the
 * simulation result expired before `currentLedgerSeq`.
 *
 * An entry is treated as expired when its expiration ledger is strictly less
 * than the current ledger — an entry expiring on the current ledger is still
 * valid for it. Entries without an expiry — or with a non-numeric one — are
 * left alone; an auth entry that cannot be read must not block signing.
 *
 * A `currentLedgerSeq` of `0` (or any non-positive / non-finite value) means
 * "unknown" and skips the check entirely.
 */
export function assertAuthNotExpired(
  sim: SimulationSuccess,
  currentLedgerSeq: number
): void {
  if (!Number.isFinite(currentLedgerSeq) || currentLedgerSeq <= 0) return;

  const expired: string[] = [];

  for (const entry of readAuthEntries(sim)) {
    const expiry = readExpirationLedgerSeq(entry);
    if (expiry === undefined) continue;
    if (expiry < currentLedgerSeq) {
      expired.push(String(expiry));
    }
  }

  if (expired.length > 0) {
    throw new AuthExpiredError(
      `Soroban authorization entries expired: ` +
        `${expired.join(", ")} < current ledger ${currentLedgerSeq}. ` +
        `Re-simulate the transaction to obtain fresh authorization entries.`
    );
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Guard: throw `AuthScopeMismatchError` when the authorization tree in the
 * simulation result reaches a contract/method the user did not approve.
 *
 * A Soroban contract can call `require_auth` for any contract, method, or
 * account it likes. The signed entry is an authorization *tree*: signing it
 * authorizes the root invocation and every sub-invocation beneath it. If that
 * tree is wider than what the user reviewed, the signature would authorize an
 * action they never saw — a `transfer` of a different token, a `burn`, or a
 * nested call into an entirely different contract.
 *
 * Every node in every entry's tree must match the approved intent or one of
 * the explicitly allowed extra targets. A node whose contract address or
 * function name cannot be read is skipped rather than guessed at, matching how
 * `assertAuthNotExpired` treats an unreadable expiry. Traversal is bounded by
 * `MAX_AUTH_TREE_DEPTH`, so a node nested past that depth is not inspected.
 *
 * A simulation with no auth entries authorizes nothing, so this is a no-op.
 */
export function assertAuthScopeMatches(
  sim: SimulationSuccess,
  approved: ApprovedAuthScope
): void {
  const permitted = buildApprovedTargetSet(approved);
  if (permitted.size === 0) return;

  const requested: string[] = [];

  for (const entry of readAuthEntries(sim)) {
    for (const node of readAuthTree(entry)) {
      const target = node.target;
      if (target === undefined) continue;
      if (!permitted.has(target) && !requested.includes(target)) {
        requested.push(target);
      }
    }
  }

  if (requested.length > 0) {
    throw new AuthScopeMismatchError({
      approved: [...permitted],
      requested,
    });
  }
}

function buildApprovedTargetSet(approved: ApprovedAuthScope): Set<string> {
  const set = new Set<string>();
  const root = formatTarget(approved.contractId, approved.method);
  if (root) set.add(root);

  for (const target of approved.allowedTargets ?? []) {
    if (typeof target !== "string") continue;
    const normalized = target.trim();
    if (normalized) set.add(normalized);
  }
  return set;
}

/**
 * One contract/method pair the simulation wants authorized.
 */
interface AuthTreeNode {
  /** `contractId:method`, or undefined when the node could not be read. */
  target?: string;
}

/**
 * Walk an auth entry's invocation tree depth-first, yielding every node.
 *
 * Handles the raw XDR shape (`rootInvocation.subInvocations`) used by the RPC
 * simulation response and the SDK's accessor-based shape
 * (`entry.address().authorization()[].rootInvocation()`).
 */
function* readAuthTree(entry: unknown): Generator<AuthTreeNode> {
  if (!entry || typeof entry !== "object") return;

  for (const root of readRootInvocations(entry)) {
    yield* walkInvocation(root, 0);
  }
}

function* walkInvocation(
  node: unknown,
  depth: number
): Generator<AuthTreeNode> {
  if (!node || typeof node !== "object" || depth > MAX_AUTH_TREE_DEPTH) return;

  const fn = readMember(node, "function");
  const contractAddress = fn ? readMember(fn, "contractAddress") : undefined;
  const functionName = fn ? readMember(fn, "functionName") : undefined;
  const target = formatTarget(
    normalizeContractAddress(contractAddress),
    normalizeFunctionName(functionName)
  );

  // A node with neither a readable contract nor a readable function cannot be
  // compared, so report it without a target; the caller skips those.
  yield target ? { target } : {};

  for (const sub of readArray(node, "subInvocations")) {
    yield* walkInvocation(sub, depth + 1);
  }
}

/**
 * Collect the root invocations of one auth entry across both supported shapes.
 */
function readRootInvocations(entry: unknown): unknown[] {
  const direct = readMember(entry, "rootInvocation");
  if (direct !== undefined && direct !== null) return [direct];

  // SDK shape: entry.address().authorization() -> [{ rootInvocation() }]
  const address = readMember(entry, "address");
  if (address === undefined || address === null) return [];

  const authorizations = readArray(address, "authorization");
  const roots: unknown[] = [];
  for (const authz of authorizations) {
    const root = readMember(authz, "rootInvocation");
    if (root !== undefined && root !== null) roots.push(root);
  }
  return roots;
}

/**
 * Read a property that the SDK may expose either as a plain field or as an
 * XDR accessor method.
 */
function readMember(target: unknown, name: string): unknown {
  if (!target || typeof target !== "object") return undefined;

  const record = target as Record<string, unknown>;
  const value = record[name];
  if (typeof value === "function") {
    try {
      return (value as () => unknown).call(target);
    } catch {
      return undefined;
    }
  }
  return value;
}

/** Read a member expected to be a list, tolerating XDR accessor methods. */
function readArray(target: unknown, name: string): unknown[] {
  const value = readMember(target, name);
  if (Array.isArray(value)) return value;
  // XDR vectors expose a length-indexed object rather than a real array.
  if (value && typeof value === "object") {
    const len = (value as { length?: unknown }).length;
    if (typeof len === "number") {
      const out: unknown[] = [];
      for (let i = 0; i < len; i++) {
        const item = (value as Record<number, unknown>)[i];
        if (item !== undefined) out.push(item);
      }
      return out;
    }
  }
  return [];
}

/**
 * Normalize an XDR ScAddress (or a plain strkey) to a `C...` contract id.
 *
 * Returns undefined for addresses that are not contracts, and for anything
 * that cannot be read, so account-scoped nodes are compared by the caller
 * only when it can establish equivalence.
 */
function normalizeContractAddress(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (!value || typeof value !== "object") return undefined;

  // An ScAddress-style value: { switch(), contractId() }.
  const contractId = readMember(value, "contractId");
  if (contractId === undefined || contractId === null) return undefined;

  const sdk = StellarSdk as unknown as {
    StrKey?: { encodeContract?: (hash: Uint8Array) => string };
  };
  const encodeContract = sdk.StrKey?.encodeContract;
  if (typeof encodeContract !== "function") return undefined;

  try {
    return encodeContract(contractId as Uint8Array);
  } catch {
    return undefined;
  }
}

/**
 * Normalize a function name. XDR symbols carry a trailing NUL; strip it so
 * `transfer\0` and `transfer` compare equal.
 */
function normalizeFunctionName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\0+$/, "").trim();
  return cleaned || undefined;
}

function formatTarget(
  contractId: string | undefined,
  method: string | undefined
): string | undefined {
  if (!contractId || !method) return undefined;
  return `${contractId}:${method}`;
}

/**
 * Bound on authorization-tree traversal.
 *
 * A hostile or malformed simulation could nest sub-invocations arbitrarily
 * deep; this caps the walk so a comparison cannot be turned into a stack or
 * CPU exhaustion vector. Nodes past the bound are not inspected.
 */
const MAX_AUTH_TREE_DEPTH = 32;

/**
 * Read the auth entry list from a simulation result without assuming a
 * particular SDK version.
 */
function readAuthEntries(sim: SimulationSuccess): unknown[] {
  const auth = sim?.result?.auth;
  return Array.isArray(auth) ? auth : [];
}

/**
 * Extract the expiration ledger from a single authorization entry.
 *
 * Handles both the SDK's `AuthorizationEntry` wrapper (which exposes a
 * `getExpirationLedgerSeq()` method) and the raw XDR shape, where the value
 * lives at `credentials.sorobanAuthorization.expirationLedgerSeq`.
 */
function readExpirationLedgerSeq(entry: unknown): number | undefined {
  if (!entry || typeof entry !== "object") return undefined;

  const wrapper = entry as { getExpirationLedgerSeq?: unknown };
  if (typeof wrapper.getExpirationLedgerSeq === "function") {
    const viaMethod = toLedgerNumber(
      (wrapper.getExpirationLedgerSeq as () => unknown).call(entry)
    );
    if (viaMethod !== undefined) return viaMethod;
  }

  const creds = (entry as { credentials?: unknown }).credentials;
  if (!creds || typeof creds !== "object") return undefined;

  const sorobanAuth = (creds as { sorobanAuthorization?: unknown })
    .sorobanAuthorization;
  if (!sorobanAuth || typeof sorobanAuth !== "object") return undefined;

  return toLedgerNumber(
    (sorobanAuth as { expirationLedgerSeq?: unknown }).expirationLedgerSeq
  );
}

/**
 * Coerce an XDR/native ledger sequence to a number. XDR `Int32` values expose
 * `toNumber()`; `BigInt` and numeric strings are unwrapped as-is.
 */
function toLedgerNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (
    value &&
    typeof (value as { toNumber?: unknown }).toNumber === "function"
  ) {
    return toLedgerNumber((value as { toNumber: () => unknown }).toNumber());
  }
  return undefined;
}

function parseKeypair(secret: SecretBuffer): StellarSdk.Keypair {
  try {
    // Keypair.fromSecret requires a plaintext string — this is the narrowest
    // possible scope for the string conversion.
    return secret.consumeString((plainKey) =>
      StellarSdk.Keypair.fromSecret(plainKey)
    );
  } catch (err) {
    // Do not include the secret key value in the error message.
    throw new SigningError(
      `Invalid secret key: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}

function assembleWithSimulation(
  tx: StellarSdk.Transaction,
  sim: SimulationSuccess,
  network: SorobanNetwork
): StellarSdk.Transaction {
  const sdk = StellarSdk as unknown as Record<string, unknown>;

  // Current SDK: StellarSdk.SorobanRpc.assembleTransaction
  const rpcNs = sdk["SorobanRpc"] as Record<string, unknown> | undefined;
  if (typeof rpcNs?.["assembleTransaction"] === "function") {
    try {
      return (
        rpcNs["assembleTransaction"] as (
          tx: StellarSdk.Transaction,
          sim: unknown
        ) => StellarSdk.Transaction
      )(tx, sim);
    } catch (err) {
      throw new SigningError(
        `assembleTransaction failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  // Fallback: manually attach the simulation's transaction data
  if (sim.transactionData) {
    try {
      const passphrase = NETWORK_PASSPHRASES[network];
      const txBuilder = StellarSdk.TransactionBuilder.cloneFrom(tx, {
        fee: sim.minResourceFee ?? StellarSdk.BASE_FEE,
        networkPassphrase: passphrase,
      });
      return txBuilder.build();
    } catch (err) {
      throw new SigningError(
        `Manual transaction assembly failed: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  throw new SigningError(
    "Cannot assemble transaction: SorobanRpc.assembleTransaction is not available " +
      "and simulation result contains no transactionData. " +
      "Upgrade @stellar/stellar-sdk to ≥ 11."
  );
}
