import dotenv from "dotenv";
import path from "path";

// Load .env.local first, then fall back to .env
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

// Import DeFi adapter configurations
import { generateDeFiAdapterConfigs, getEnabledAdapters } from "./defiAdapters";

type StellarNetwork = "testnet" | "public";

function requireEnv(name: string, minLength = 1): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < minLength) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInt(name: string, fallback: string): number {
  const parsed = Number.parseInt(process.env[name] || fallback, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

// Stellar network configurations
const STELLAR_NETWORKS: Record<
  StellarNetwork,
  {
    horizonUrl: string;
    networkPassphrase: string;
    friendbotUrl: string;
    /** Base reserve in XLM (0.5 XLM on both testnet and public). */
    baseReserve: number;
  }
> = {
  testnet: {
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    friendbotUrl: "https://friendbot.stellar.org",
    baseReserve: 0.5,
  },
  public: {
    horizonUrl: "https://horizon.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    friendbotUrl: "", // No friendbot on mainnet
    baseReserve: 0.5,
  },
};

// Validate JWT secret meets minimum security requirements
const jwtSecret = process.env.JWT_SECRET || "secret-token";
if (jwtSecret.length < 32) {
  throw new Error(
    "JWT_SECRET must be at least 32 characters long. Set a strong secret in your environment."
  );
}

const encryptionKey = process.env.ENCRYPTION_KEY?.trim();
const encryptionKeysJson = process.env.ENCRYPTION_KEYS_JSON?.trim();
if (
  !encryptionKeysJson &&
  (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey))
) {
  throw new Error(
    "ENCRYPTION_KEY must be a 64-character hex string when ENCRYPTION_KEYS_JSON is not set"
  );
}

// Get Stellar network from environment, default to testnet
const stellarNetwork: StellarNetwork =
  (process.env.STELLAR_NETWORK as StellarNetwork) || "testnet";

// Validate network type
if (stellarNetwork !== "testnet" && stellarNetwork !== "public") {
  throw new Error(
    `Invalid STELLAR_NETWORK: ${process.env.STELLAR_NETWORK}. Must be "testnet" or "public"`
  );
}

// Get network configuration
const stellarConfig = STELLAR_NETWORKS[stellarNetwork];

export default {
  env: process.env.NODE_ENV || "development",
  port: parsePositiveInt("PORT", "2333"),
  apiKey: requireEnv("ANTHROPIC_API_KEY"),
  node_url: requireEnv("NODE_URL"),
  encryptionKey,
  stellar: {
    network: stellarNetwork,
    horizonUrl: process.env.STELLAR_HORIZON_URL || stellarConfig.horizonUrl,
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE || stellarConfig.networkPassphrase,
    friendbotUrl: stellarConfig.friendbotUrl,
    baseReserve: Number.parseFloat(
      process.env.STELLAR_BASE_RESERVE || String(stellarConfig.baseReserve)
    ),
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parsePositiveInt("REDIS_PORT", "6379"),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number.parseInt(process.env.REDIS_DB || "0", 10),
  },
  kyc: {
    defaultProvider: process.env.KYC_PROVIDER || "mock",
  },
  jwt: {
    secret: jwtSecret,
    resetExpiry: process.env.JWT_RESET_EXPIRY || "1h",
  },
  email: {
    host: process.env.SMTP_HOST || "smtp.example.com",
    port: parsePositiveInt("SMTP_PORT", "587"),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "noreply@chenpilot.com",
    verificationEnabled: process.env.EMAIL_VERIFICATION_ENABLED === "true",
  },
  db: {
    postgres: {
      host: requireEnv("DB_HOST"),
      port: parsePositiveInt("DB_PORT", "5432"),
      username: requireEnv("DB_USERNAME"),
      password: process.env.DB_PASSWORD || undefined,
      database: requireEnv("DB_NAME"),
    },
  },
  defi: {
    adapters: generateDeFiAdapterConfigs(),
    enabledAdapters: getEnabledAdapters(),
  },
  agent: {
    timeouts: {
      llmCall: parsePositiveInt("AGENT_LLM_TIMEOUT", "30000"),
      toolExecution: parsePositiveInt("AGENT_TOOL_TIMEOUT", "60000"),
      agentExecution: parsePositiveInt("AGENT_EXECUTION_TIMEOUT", "120000"),
      planExecution: parsePositiveInt("AGENT_PLAN_TIMEOUT", "180000"),
    },
  },
  admin: {
    allowedIps: process.env.ADMIN_ALLOWED_IPS
      ? process.env.ADMIN_ALLOWED_IPS.split(",")
          .map((ip) => ip.trim())
          .filter(Boolean)
      : [],
  },
externalRequest: {
    defaultBudget: {
      deadlineMs: parsePositiveInt("EXTERNAL_REQUEST_DEADLINE_MS", "10000"),
      attempts: Number.parseInt(process.env.EXTERNAL_REQUEST_ATTEMPTS || "3", 10),
      bytes: Number.parseInt(process.env.EXTERNAL_REQUEST_BYTES || "5242880", 10),
      downstreamCalls: Number.parseInt(
        process.env.EXTERNAL_REQUEST_DOWNSTREAM_CALLS || "10",
        10
      ),
    },
  },
  models: {
    primary: process.env.MODEL_PRIMARY || "claude-3-5-haiku-20241022",
    fallbacks: process.env.MODEL_FALLBACKS
      ? process.env.MODEL_FALLBACKS.split(",").map((m) => m.trim()).filter(Boolean)
      : ["claude-3-5-sonnet-20241022"],
    selectionStrategy: (process.env.MODEL_SELECTION_STRATEGY || "quality_first") as
      | "quality_first"
      | "latency_first"
      | "cost_first"
      | "balanced",
    verifyEquivalence: process.env.MODEL_VERIFY_EQUIVALENCE !== "false",
    maxRetries: parsePositiveInt("MODEL_MAX_RETRIES", "2"),
    differentialEvalOnStartup: process.env.MODEL_DIFFERENTIAL_EVAL_ON_STARTUP === "true",
    minQualityScore: parseFloat(process.env.MODEL_MIN_QUALITY_SCORE || "0.7"),
  },
};
