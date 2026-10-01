import logger from "../config/logger";

export type BudgetResource =
  | "deadline"
  | "attempts"
  | "bytes"
  | "downstreamCalls";

export interface RequestBudget {
  deadline: number;
  attempts: number;
  bytes: number;
  downstreamCalls: number;
  path: string;
  consumedAttempts: number;
  consumedBytes: number;
  consumedDownstreamCalls: number;
}

export interface BudgetOptions {
  deadlineMs: number;
  attempts: number;
  bytes: number;
  downstreamCalls: number;
  path: string;
}

export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    public readonly resource: BudgetResource,
    public readonly budget: RequestBudget,
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export class BudgetManager {
  private static instance: BudgetManager;
  private metrics: Map<string, { exhausted: Record<BudgetResource, number>; total: number }> =
    new Map();

  static getInstance(): BudgetManager {
    if (!BudgetManager.instance) {
      BudgetManager.instance = new BudgetManager();
    }
    return BudgetManager.instance;
  }

  createRootBudget(options: BudgetOptions): RequestBudget {
    return {
      deadline: Date.now() + options.deadlineMs,
      attempts: options.attempts,
      bytes: options.bytes,
      downstreamCalls: options.downstreamCalls,
      path: options.path,
      consumedAttempts: 0,
      consumedBytes: 0,
      consumedDownstreamCalls: 0,
    };
  }

  deriveChildBudget(
    parent: RequestBudget,
    options: Partial<BudgetOptions> = {}
  ): RequestBudget {
    if (Date.now() > parent.deadline) {
      throw new BudgetExhaustedError(
        "Cannot derive child budget from expired parent",
        "deadline",
        parent,
      );
    }

    const childDeadline = options.deadlineMs
      ? Math.min(parent.deadline, Date.now() + options.deadlineMs)
      : parent.deadline;

    const childAttempts = options.attempts ?? parent.attempts;
    const childBytes = options.bytes ?? parent.bytes;
    const childDownstreamCalls = options.downstreamCalls ?? parent.downstreamCalls;

    if (childDeadline > parent.deadline) {
      throw new BudgetExhaustedError(
        "Child budget cannot exceed parent deadline",
        "deadline",
        parent,
      );
    }
    if (childAttempts > parent.attempts) {
      throw new BudgetExhaustedError(
        "Child budget cannot exceed parent attempts",
        "attempts",
        parent,
      );
    }
    if (childBytes > parent.bytes) {
      throw new BudgetExhaustedError(
        "Child budget cannot exceed parent bytes",
        "bytes",
        parent,
      );
    }
    if (childDownstreamCalls > parent.downstreamCalls) {
      throw new BudgetExhaustedError(
        "Child budget cannot exceed parent downstreamCalls",
        "downstreamCalls",
        parent,
      );
    }

    return {
      deadline: childDeadline,
      attempts: childAttempts,
      bytes: childBytes,
      downstreamCalls: childDownstreamCalls,
      path: parent.path,
      consumedAttempts: 0,
      consumedBytes: 0,
      consumedDownstreamCalls: 0,
    };
  }

  consume(budget: RequestBudget, resource: BudgetResource, amount: number): void {
    switch (resource) {
      case "deadline":
        if (Date.now() > budget.deadline) {
          this.recordExhaustion(budget.path, resource);
          throw new BudgetExhaustedError(
            `Budget deadline exhausted for ${budget.path}`,
            resource,
            budget,
          );
        }
        break;
      case "attempts":
        budget.consumedAttempts += amount;
        if (budget.consumedAttempts > budget.attempts) {
          this.recordExhaustion(budget.path, resource);
          throw new BudgetExhaustedError(
            `Budget attempts exhausted for ${budget.path}: ${budget.consumedAttempts}/${budget.attempts}`,
            resource,
            budget,
          );
        }
        break;
      case "bytes":
        budget.consumedBytes += amount;
        if (budget.consumedBytes > budget.bytes) {
          this.recordExhaustion(budget.path, resource);
          throw new BudgetExhaustedError(
            `Budget bytes exhausted for ${budget.path}: ${budget.consumedBytes}/${budget.bytes}`,
            resource,
            budget,
          );
        }
        break;
      case "downstreamCalls":
        budget.consumedDownstreamCalls += amount;
        if (budget.consumedDownstreamCalls > budget.downstreamCalls) {
          this.recordExhaustion(budget.path, resource);
          throw new BudgetExhaustedError(
            `Budget downstream calls exhausted for ${budget.path}: ${budget.consumedDownstreamCalls}/${budget.downstreamCalls}`,
            resource,
            budget,
          );
        }
        break;
    }
  }

  isExhausted(budget: RequestBudget, resource: BudgetResource): boolean {
    switch (resource) {
      case "deadline":
        return Date.now() > budget.deadline;
      case "attempts":
        return budget.consumedAttempts >= budget.attempts;
      case "bytes":
        return budget.consumedBytes >= budget.bytes;
      case "downstreamCalls":
        return budget.consumedDownstreamCalls >= budget.downstreamCalls;
    }
  }

  getMetrics(path: string) {
    const entry = this.metrics.get(path);
    if (!entry) {
      return { exhausted: { deadline: 0, attempts: 0, bytes: 0, downstreamCalls: 0 }, total: 0 };
    }
    return entry;
  }

  getAllMetrics(): Record<string, { exhausted: Record<BudgetResource, number>; total: number }> {
    const result: Record<string, { exhausted: Record<BudgetResource, number>; total: number }> = {};
    for (const [path, metrics] of this.metrics.entries()) {
      result[path] = metrics;
    }
    return result;
  }

  resetMetrics(path?: string): void {
    if (path) {
      this.metrics.delete(path);
    } else {
      this.metrics.clear();
    }
  }

  recordExhaustion(path: string, resource: BudgetResource): void {
    const current = this.metrics.get(path) || {
      exhausted: { deadline: 0, attempts: 0, bytes: 0, downstreamCalls: 0 },
      total: 0,
    };
    current.total += 1;
    current.exhausted[resource] += 1;
    this.metrics.set(path, current);

    logger.warn("Budget resource exhausted", {
      path,
      resource,
      exhaustedCount: current.exhausted[resource],
      totalExhaustions: current.total,
    });
  }
}

export const budgetManager = BudgetManager.getInstance();

/**
 * Inbound payload size policy defaults (in bytes)
 */
export const DEFAULT_INBOUND_JSON_LIMIT = 1024 * 1024; // 1MB
export const DEFAULT_WEBHOOK_LIMIT = 1024 * 1024; // 1MB
export const DEFAULT_ATTACHMENT_LIMIT = 25 * 1024 * 1024; // 25MB

export type InboundPolicyType = "json" | "webhook" | "attachment" | "custom";

export interface InboundPolicyConfig {
  jsonLimit?: number;
  webhookLimit?: number;
  attachmentLimit?: number;
  endpointGaps?: Record<string, number>;
  attachmentPaths?: string[];
  webhookPaths?: string[];
}

export interface InboundBudgetCheck {
  allowed: boolean;
  limit: number;
  actualBytes: number;
  policyType: InboundPolicyType;
}

/**
 * Resolves the applicable byte limit and policy type for a given request path
 */
export function resolveInboundLimit(
  path: string,
  options?: InboundPolicyConfig
): { limit: number; policyType: InboundPolicyType } {
  const jsonLimit = options?.jsonLimit ?? DEFAULT_INBOUND_JSON_LIMIT;
  const webhookLimit = options?.webhookLimit ?? DEFAULT_WEBHOOK_LIMIT;
  const attachmentLimit = options?.attachmentLimit ?? DEFAULT_ATTACHMENT_LIMIT;

  // 1. Endpoint-specific gaps (exact or prefix match)
  if (options?.endpointGaps) {
    if (options.endpointGaps[path] !== undefined) {
      return { limit: options.endpointGaps[path], policyType: "custom" };
    }
    for (const [gapPath, customLimit] of Object.entries(options.endpointGaps)) {
      if (path.startsWith(gapPath)) {
        return { limit: customLimit, policyType: "custom" };
      }
    }
  }

  // 2. Webhook endpoints
  const isWebhook =
    path.includes("/webhook") ||
    Boolean(options?.webhookPaths?.some((p) => path.startsWith(p)));
  if (isWebhook) {
    return { limit: webhookLimit, policyType: "webhook" };
  }

  // 3. Attachment endpoints (e.g. export, upload, media, audio, etc.)
  const defaultAttachmentPrefixes = ["/export", "/attachments", "/upload", "/media", "/voice"];
  const isAttachment =
    defaultAttachmentPrefixes.some((prefix) => path.includes(prefix)) ||
    Boolean(options?.attachmentPaths?.some((p) => path.startsWith(p)));
  if (isAttachment) {
    return { limit: attachmentLimit, policyType: "attachment" };
  }

  // 4. Default standard JSON
  return { limit: jsonLimit, policyType: "json" };
}

/**
 * Evaluates whether an inbound request of `bytes` size is within policy for `path`.
 * If exceeded, records exhaustion on `budgetManager`.
 */
export function checkInboundBudget(
  path: string,
  bytes: number,
  options?: InboundPolicyConfig
): InboundBudgetCheck {
  const { limit, policyType } = resolveInboundLimit(path, options);

  if (bytes > limit) {
    budgetManager.recordExhaustion(path, "bytes");
    return {
      allowed: false,
      limit,
      actualBytes: bytes,
      policyType,
    };
  }

  return {
    allowed: true,
    limit,
    actualBytes: bytes,
    policyType,
  };
}

/**
 * Enforces inbound budget for a path, throwing BudgetExhaustedError if violated.
 */
export function enforceInboundBudget(
  path: string,
  bytes: number,
  options?: InboundPolicyConfig
): void {
  const check = checkInboundBudget(path, bytes, options);
  if (!check.allowed) {
    const syntheticBudget: RequestBudget = {
      deadline: Date.now(),
      attempts: 1,
      bytes: check.limit,
      downstreamCalls: 0,
      path,
      consumedAttempts: 1,
      consumedBytes: bytes,
      consumedDownstreamCalls: 0,
    };
    throw new BudgetExhaustedError(
      `Inbound ${check.policyType} payload exceeded byte limit for ${path}: ${bytes}/${check.limit}`,
      "bytes",
      syntheticBudget
    );
  }
}

export function createBudget(options: BudgetOptions): RequestBudget {
  return budgetManager.createRootBudget(options);
}

export function withBudget<T>(
  budget: RequestBudget,
  fn: () => Promise<T>,
  options: { resource?: BudgetResource; amount?: number } = {}
): Promise<T> {
  const { resource = "deadline", amount = 1 } = options;
  budgetManager.consume(budget, resource, amount);
  return fn();
}

export async function withChildBudget<T>(
  parent: RequestBudget,
  fn: (child: RequestBudget) => Promise<T>,
  childOptions: Partial<BudgetOptions> = {}
): Promise<T> {
  const child = budgetManager.deriveChildBudget(parent, childOptions);
  return fn(child);
}

export function isBudgetExhausted(budget: RequestBudget, resource: BudgetResource): boolean {
  return budgetManager.isExhausted(budget, resource);
}

export function isBudgetExhaustedError(error: unknown): error is BudgetExhaustedError {
  return error instanceof BudgetExhaustedError;
}

export async function budgetedFetch(
  budget: RequestBudget,
  input: RequestInfo | URL,
  init?: RequestInit & { maxBytes?: number }
): Promise<Response> {
  budgetManager.consume(budget, "downstreamCalls", 1);
  budgetManager.consume(budget, "deadline", 0);

  const remainingMs = Math.max(0, budget.deadline - Date.now());
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), remainingMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!init?.maxBytes) {
      return response;
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.length;
        budgetManager.consume(budget, "bytes", value.length);

        if (totalBytes > init.maxBytes) {
          throw new BudgetExhaustedError(
            `Response exceeded byte budget for ${budget.path}: ${totalBytes}/${init.maxBytes}`,
            "bytes",
            budget,
          );
        }

        chunks.push(value);
      }
    } else if (response.headers.get("content-length")) {
      const contentLength = Number.parseInt(response.headers.get("content-length")!, 10);
      budgetManager.consume(budget, "bytes", contentLength);

      if (budget.consumedBytes > budget.bytes) {
        throw new BudgetExhaustedError(
          `Response exceeded byte budget for ${budget.path}: ${budget.consumedBytes}/${budget.bytes}`,
          "bytes",
          budget,
        );
      }
    }

    const blob = new Blob(chunks);
    return new Response(blob, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    clearTimeout(timeoutId);

    if (
      error instanceof Error &&
      error.name === "AbortError" &&
      Date.now() > budget.deadline
    ) {
      throw new BudgetExhaustedError(
        `Budget deadline exhausted for ${budget.path}`,
        "deadline",
        budget,
      );
    }

    throw error;
  }
}
