import express from "express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import { container } from "tsyringe";
import swaggerUi from "swagger-ui-express";
import routes from "./routes";
import authRoutes from "./auth.routes";
import assetRoutes from "./asset.routes";
import { swaggerSpec } from "./swagger";
import requestLogger from "../middleware/requestLogger";
import {
  createAbusePreventionMiddleware,
  ipBlacklistMiddleware,
  ipBlacklistRoutes,
} from "../Security";

import { observabilityMiddleware, updateObservabilityContext } from "../observability";
import { setTenantContext, setOptionalTenantContext } from "../Auth/tenantContext.middleware";

import { authenticate } from "../Auth/auth";
import UserService from "../Auth/user.service";
import { validateQuery } from "../Agents/validationService";
import { intentAgent } from "../Agents/agents/intentagent";
import { ErrorHandler } from "./middleware/errorHandler";
import { UnauthorizedError, ValidationError, BadError } from "../utils/error";
import { healthService } from "../services/healthService";
import { rawBodyCapture } from "./middleware/rawBodyCapture.middleware";
import { inboundPolicyMiddleware } from "./middleware/inboundPolicy.middleware";
import config from "../config/config";

declare module "express" {
  interface Request {
    requestId?: string;
    executionId?: string;
    rootExecutionId?: string;
    parentExecutionId?: string;
    correlationId?: string;
  }
}

const app = express();

// Serve static files for Telegram WebApp
app.use("/settings", express.static(path.join(__dirname, "../../public")));

// --- GLOBAL SECURITY MIDDLEWARE ---
// AC: Helmet configured securely
app.use(helmet());

// CORS configuration
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS || "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

// Inbound size policy enforcement (JSON, webhook, attachment, and endpoint gaps)
// Early-rejects oversized requests and tracks exhaustion in BudgetManager
app.use(inboundPolicyMiddleware);

// CRITICAL: Raw body capture MUST come before express.json()
// This preserves original request bytes for webhook signature verification
app.use(rawBodyCapture);

// Express JSON parsing configured with max attachment limit so endpoint-specific gaps
// and large attachments can be parsed, with tight limits enforced by inboundPolicyMiddleware
app.use(
  express.json({
    limit: config.inbound?.attachmentLimit || "25mb",
  })
);
app.use(observabilityMiddleware);
app.use(requestLogger);
app.use(ipBlacklistMiddleware);

// Swagger API docs
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(require("./swagger").swaggerSpec));

const sensitiveLimiter = createAbusePreventionMiddleware("query");

// Query endpoint - for AI agent queries
app.post("/query", sensitiveLimiter, async (req, res, next) => {
  try {
    const { userId, query } = req.body;
    updateObservabilityContext({
      userId,
      operationName: "agent.query",
      component: "http.query",
    });

    const user = await authenticate(userId);
    if (!user) throw new UnauthorizedError("invalid credentials");

    const valid = await validateQuery(query, userId);
    if (!valid) throw new ValidationError("invalid query");

    const result = await intentAgent.handle(query, userId);
    res.json({ result });
  } catch (error) {
    next(error);
  }
});

// Mount all API routes under /api prefix
app.use("/api", routes);
app.use("/api/assets", assetRoutes);
app.use("/api/security/blacklist", ipBlacklistRoutes);
app.use("/api/prompts", promptRoutes);
app.use("/api/security/blacklist", ipBlacklistRoutes);

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Liveness probe — always 200 while the process is running
 *     tags: [Ops]
 *     responses:
 *       200:
 *         description: Process is alive
 */
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "UP", timestamp: new Date().toISOString() });
});

/**
 * @swagger
 * /ready:
 *   get:
 *     summary: Readiness probe — 200 if healthy/degraded, 503 if critical deps are down
 *     tags: [Ops]
 *     responses:
 *       200:
 *         description: Service is ready (HEALTHY or DEGRADED)
 *       503:
 *         description: Service is not ready (UNHEALTHY — critical dependency down)
 */
app.get("/ready", async (_req, res) => {
  try {
    const report = await healthService.getFullReport();
    const httpStatus = report.overallStatus === "UNHEALTHY" ? 503 : 200;
    res.status(httpStatus).json(report);
  } catch (err) {
    res.status(503).json({
      overallStatus: "UNHEALTHY",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : "Health check failed",
    });
  }
});

app.use(ErrorHandler);

export default app;
