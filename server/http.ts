import cors from "cors";
import express, { type Express, type RequestHandler, type Response } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { z } from "zod";
import {
  getDefaultPromptArguments,
  getDefaultToolArguments,
  getPromptInputSamples,
  getToolInputSamples,
} from "../src/lib/workshopSamples.ts";
import {
  executeCaseWorkflow,
  generateDashboardChatReply,
  isTimeoutLikeError,
  logServerError,
  truncateForLog,
  withInternalMcpClient,
} from "./core.ts";
import {
  createCorsOptions,
  createRateLimiter,
  getSecurityConfig,
  requestAuditLogger,
  requireAllowedOrigin,
  requireBasicAuth,
  securityHeaders,
} from "./security.ts";

type ServerDependencies = {
  executeCaseWorkflow: typeof executeCaseWorkflow;
  generateDashboardChatReply: typeof generateDashboardChatReply;
  isTimeoutLikeError: typeof isTimeoutLikeError;
  logServerError: typeof logServerError;
  truncateForLog: typeof truncateForLog;
  withInternalMcpClient: typeof withInternalMcpClient;
  createViteServer: typeof createViteServer;
};

export type CreateAppOptions = {
  dependencies?: Partial<ServerDependencies>;
  enableSpaMiddleware?: boolean;
};

const CatalogRequestSchema = z.object({});
const ToolCallRequestSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.any()).optional().default({}),
});
const ResourceReadRequestSchema = z.object({
  uri: z.string(),
});
const PromptRequestSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.any()).optional().default({}),
});
const AnalyzeStreamRequestSchema = z.object({
  case_id: z.string(),
  request_text: z.string(),
  client_name: z.string().optional(),
  domain_hint: z.enum(["auto", "construction", "kobutsu", "fuei", "immigration", "waste", "corporate"]).optional(),
  jurisdiction: z.string().optional(),
  tone: z.enum(["professional", "concise", "formal"]).optional(),
  include_disclaimer: z.boolean().default(true),
  output_language: z.string().default("ja"),
});
const DashboardChatRequestSchema = z.object({
  consultation_text: z.string(),
  client_name: z.string().optional(),
  user_message: z.string(),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).default([]),
  selected_checklist_entries: z.array(z.object({
    label: z.string(),
    answer: z.string(),
  })).default([]),
  case_data: z.object({
    issues: z.array(z.object({
      label: z.string(),
      reason: z.string().optional(),
    })).default([]),
    lawCandidates: z.array(z.object({
      law_title: z.string(),
      why_relevant: z.string().optional(),
    })).default([]),
    checklist: z.array(z.object({
      item: z.string().optional(),
      question_to_client: z.string().optional(),
      why_needed: z.string().optional(),
    })).default([]),
    draftReply: z.object({
      subject: z.string().optional(),
      body: z.string().optional(),
      review_notes: z.array(z.string()).optional(),
    }).optional(),
  }),
});

const DEFAULT_PORT = 3000;
const DEFAULT_DEPENDENCIES: ServerDependencies = {
  executeCaseWorkflow,
  generateDashboardChatReply,
  isTimeoutLikeError,
  logServerError,
  truncateForLog,
  withInternalMcpClient,
  createViteServer,
};

function writeJsonLine(res: Response, payload: unknown) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function toPublicErrorMessage(error: unknown, isTimeoutLikeErrorFn: typeof isTimeoutLikeError) {
  if (error instanceof z.ZodError) {
    return "リクエスト形式が不正です。";
  }

  if (isTimeoutLikeErrorFn(error)) {
    return "上流サービスの応答がタイムアウトしました。";
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/origin is not allowed/i.test(message)) {
    return "許可されていないアクセス元です。";
  }
  if (/authentication required/i.test(message)) {
    return "認証が必要です。";
  }
  if (/too many requests/i.test(message)) {
    return "短時間のリクエストが多すぎます。少し待ってから再試行してください。";
  }

  return "サーバー処理中にエラーが発生しました。";
}

function resolveDependencies(overrides?: Partial<ServerDependencies>): ServerDependencies {
  return {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
}

export function getStartingPort(env: NodeJS.ProcessEnv = process.env) {
  const rawPort = env.PORT;
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const parsedPort = Number.parseInt(rawPort, 10);
  return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
}

export function tryListen(app: Express, port: number, host: string) {
  return new Promise<ReturnType<Express["listen"]>>((resolve, reject) => {
    const server = app.listen(port, host);

    const handleListening = () => {
      cleanup();
      resolve(server);
    };

    const handleError = (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      server.off("listening", handleListening);
      server.off("error", handleError);
    };

    server.once("listening", handleListening);
    server.once("error", handleError);
  });
}

export async function listenOnAvailablePort(app: Express, startingPort: number, host: string) {
  let port = startingPort;

  while (true) {
    try {
      const server = await tryListen(app, port, host);
      return { server, port };
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }

      port += 1;
    }
  }
}

export function createApiHandlers(overrides?: Partial<ServerDependencies>): Record<
  "health" | "catalog" | "analyzeStream" | "dashboardChat" | "tool" | "resource" | "prompt",
  RequestHandler
> {
  const dependencies = resolveDependencies(overrides);

  return {
    health: (_req, res) => {
      res.json({ ok: true });
    },
    catalog: async (_req, res) => {
      try {
        CatalogRequestSchema.parse({});

        const payload = await dependencies.withInternalMcpClient(async (client) => {
          const [tools, resources, prompts] = await Promise.all([
            client.listTools(),
            client.listResources(),
            client.listPrompts(),
          ]);

          return {
            tools: tools.tools
              .map((tool) => ({
                ...tool,
                defaultArguments: getDefaultToolArguments(tool.name),
                samples: getToolInputSamples(tool.name),
              }))
              .sort((left, right) => {
                if (left.name === "run_full_case_workflow") {
                  return -1;
                }
                if (right.name === "run_full_case_workflow") {
                  return 1;
                }
                return 0;
              }),
            resources: resources.resources,
            prompts: prompts.prompts.map((prompt) => ({
              ...prompt,
              defaultArguments: getDefaultPromptArguments(prompt.name),
              samples: getPromptInputSamples(prompt.name),
            })),
          };
        });

        res.json(payload);
      } catch (error) {
        dependencies.logServerError("api.catalog", error);
        res.status(500).json({
          error: toPublicErrorMessage(error, dependencies.isTimeoutLikeError),
        });
      }
    },
    analyzeStream: async (req, res) => {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      try {
        const payload = AnalyzeStreamRequestSchema.parse(req.body);
        await dependencies.executeCaseWorkflow(payload, {
          onProgress: (event) => {
            writeJsonLine(res, event);
          },
        });
        res.end();
      } catch (error) {
        const structuredError = error as Error & {
          timeline?: unknown;
          trace?: unknown;
        };

        dependencies.logServerError("api.analyze_stream", error, {
          body: dependencies.truncateForLog(req.body),
          timeout_like: dependencies.isTimeoutLikeError(error),
        });

        if (!res.writableEnded) {
          writeJsonLine(res, {
            type: "error",
            message: "解析ストリームの実行中にエラーが発生しました。",
            timeline: Array.isArray(structuredError.timeline) ? structuredError.timeline : [],
            trace: structuredError.trace,
            error: toPublicErrorMessage(error, dependencies.isTimeoutLikeError),
          });
          res.end();
        }
      }
    },
    dashboardChat: async (req, res) => {
      try {
        const payload = DashboardChatRequestSchema.parse(req.body);
        const result = await dependencies.generateDashboardChatReply(payload);
        res.json(result);
      } catch (error) {
        dependencies.logServerError("api.dashboard_chat", error, {
          body: dependencies.truncateForLog(req.body),
          timeout_like: dependencies.isTimeoutLikeError(error),
        });
        res.status(500).json({
          error: toPublicErrorMessage(error, dependencies.isTimeoutLikeError),
        });
      }
    },
    tool: async (req, res) => {
      try {
        const payload = ToolCallRequestSchema.parse(req.body);
        const args = Object.keys(payload.arguments).length > 0
          ? payload.arguments
          : getDefaultToolArguments(payload.name);

        const result = await dependencies.withInternalMcpClient((client) =>
          client.callTool({
            name: payload.name,
            arguments: args,
          }),
        );

        res.json(result);
      } catch (error) {
        dependencies.logServerError("api.tool", error, {
          tool_name: req.body?.name,
          arguments: dependencies.truncateForLog(req.body?.arguments),
          timeout_like: dependencies.isTimeoutLikeError(error),
        });
        res.status(500).json({
          error: toPublicErrorMessage(error, dependencies.isTimeoutLikeError),
        });
      }
    },
    resource: async (req, res) => {
      try {
        const payload = ResourceReadRequestSchema.parse(req.body);
        const result = await dependencies.withInternalMcpClient((client) =>
          client.readResource({ uri: payload.uri }),
        );

        res.json(result);
      } catch (error) {
        dependencies.logServerError("api.resource", error, {
          uri: req.body?.uri,
          timeout_like: dependencies.isTimeoutLikeError(error),
        });
        res.status(500).json({
          error: toPublicErrorMessage(error, dependencies.isTimeoutLikeError),
        });
      }
    },
    prompt: async (req, res) => {
      try {
        const payload = PromptRequestSchema.parse(req.body);
        const args = Object.keys(payload.arguments).length > 0
          ? payload.arguments
          : getDefaultPromptArguments(payload.name);

        const result = await dependencies.withInternalMcpClient((client) =>
          client.getPrompt({
            name: payload.name,
            arguments: args,
          }),
        );

        res.json(result);
      } catch (error) {
        dependencies.logServerError("api.prompt", error, {
          prompt_name: req.body?.name,
          arguments: dependencies.truncateForLog(req.body?.arguments),
          timeout_like: dependencies.isTimeoutLikeError(error),
        });
        res.status(500).json({
          error: toPublicErrorMessage(error, dependencies.isTimeoutLikeError),
        });
      }
    },
  };
}

export async function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const dependencies = resolveDependencies(options.dependencies);
  const handlers = createApiHandlers(dependencies);
  const security = getSecurityConfig();
  const analyzeRateLimit = createRateLimiter({ windowMs: 60_000, max: 6, scope: "analyze-stream" });
  const dashboardChatRateLimit = createRateLimiter({ windowMs: 60_000, max: 20, scope: "dashboard-chat" });
  const internalMcpRateLimit = createRateLimiter({ windowMs: 60_000, max: 30, scope: "internal-mcp-http" });
  const notFoundHandler: RequestHandler = (_req, res) => {
    res.status(404).json({ error: "Not found" });
  };

  app.disable("x-powered-by");
  app.use(requestAuditLogger());
  app.use(securityHeaders());
  app.use(requireBasicAuth(security));
  app.use(cors(createCorsOptions(security)));
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", requireAllowedOrigin(security));

  app.get("/api/health", handlers.health);
  app.post("/api/analyze-stream", analyzeRateLimit, handlers.analyzeStream);
  app.post("/api/dashboard-chat", dashboardChatRateLimit, handlers.dashboardChat);

  if (security.mcpHttpEnabled) {
    app.get("/api/catalog", internalMcpRateLimit, handlers.catalog);
    app.post("/api/tool", internalMcpRateLimit, handlers.tool);
    app.post("/api/resource", internalMcpRateLimit, handlers.resource);
    app.post("/api/prompt", internalMcpRateLimit, handlers.prompt);
  } else {
    app.get("/api/catalog", notFoundHandler);
    app.post("/api/tool", notFoundHandler);
    app.post("/api/resource", notFoundHandler);
    app.post("/api/prompt", notFoundHandler);
  }

  if (options.enableSpaMiddleware !== false) {
    if (process.env.NODE_ENV !== "production") {
      const vite = await dependencies.createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      app.get("*", (_req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }
  }

  return app;
}

export async function startServer(options: CreateAppOptions = {}) {
  const app = await createApp(options);
  const startingPort = getStartingPort();
  const security = getSecurityConfig();

  const { server, port } = await listenOnAvailablePort(app, startingPort, security.serverHost);

  if (port !== startingPort) {
    console.log(`Port ${startingPort} is in use. Falling back to http://localhost:${port}`);
  }

  const hostLabel = security.serverHost === "0.0.0.0" ? "localhost" : security.serverHost;
  console.log(`Server running on http://${hostLabel}:${port}`);
  if (!security.mcpHttpEnabled) {
    console.log("HTTP MCP routes are disabled.");
  }
  return { app, server, port };
}
