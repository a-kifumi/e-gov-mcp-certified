import cors from "cors";
import express, { type Express, type Response } from "express";
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
const SERVER_HOST = "0.0.0.0";

function writeJsonLine(res: Response, payload: unknown) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function getStartingPort() {
  const rawPort = process.env.PORT;
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const parsedPort = Number.parseInt(rawPort, 10);
  return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
}

function tryListen(app: Express, port: number) {
  return new Promise<ReturnType<Express["listen"]>>((resolve, reject) => {
    const server = app.listen(port, SERVER_HOST);

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

async function listenOnAvailablePort(app: Express, startingPort: number) {
  let port = startingPort;

  while (true) {
    try {
      const server = await tryListen(app, port);
      return { server, port };
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }

      port += 1;
    }
  }
}

export async function startServer() {
  const app = express();
  const startingPort = getStartingPort();

  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/catalog", async (_req, res) => {
    try {
      CatalogRequestSchema.parse({});

      const payload = await withInternalMcpClient(async (client) => {
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
      logServerError("api.catalog", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/analyze-stream", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
      const payload = AnalyzeStreamRequestSchema.parse(req.body);
      await executeCaseWorkflow(payload, {
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

      logServerError("api.analyze_stream", error, {
        body: truncateForLog(req.body),
        timeout_like: isTimeoutLikeError(error),
      });

      if (!res.writableEnded) {
        writeJsonLine(res, {
          type: "error",
          message: "解析ストリームの実行中にエラーが発生しました。",
          timeline: Array.isArray(structuredError.timeline) ? structuredError.timeline : [],
          trace: structuredError.trace,
          error: error instanceof Error ? error.message : String(error),
        });
        res.end();
      }
    }
  });

  app.post("/api/dashboard-chat", async (req, res) => {
    try {
      const payload = DashboardChatRequestSchema.parse(req.body);
      const result = await generateDashboardChatReply(payload);
      res.json(result);
    } catch (error) {
      logServerError("api.dashboard_chat", error, {
        body: truncateForLog(req.body),
        timeout_like: isTimeoutLikeError(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/tool", async (req, res) => {
    try {
      const payload = ToolCallRequestSchema.parse(req.body);
      const args = Object.keys(payload.arguments).length > 0
        ? payload.arguments
        : getDefaultToolArguments(payload.name);

      const result = await withInternalMcpClient((client) =>
        client.callTool({
          name: payload.name,
          arguments: args,
        }),
      );

      res.json(result);
    } catch (error) {
      logServerError("api.tool", error, {
        tool_name: req.body?.name,
        arguments: truncateForLog(req.body?.arguments),
        timeout_like: isTimeoutLikeError(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/resource", async (req, res) => {
    try {
      const payload = ResourceReadRequestSchema.parse(req.body);
      const result = await withInternalMcpClient((client) =>
        client.readResource({ uri: payload.uri }),
      );

      res.json(result);
    } catch (error) {
      logServerError("api.resource", error, {
        uri: req.body?.uri,
        timeout_like: isTimeoutLikeError(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/prompt", async (req, res) => {
    try {
      const payload = PromptRequestSchema.parse(req.body);
      const args = Object.keys(payload.arguments).length > 0
        ? payload.arguments
        : getDefaultPromptArguments(payload.name);

      const result = await withInternalMcpClient((client) =>
        client.getPrompt({
          name: payload.name,
          arguments: args,
        }),
      );

      res.json(result);
    } catch (error) {
      logServerError("api.prompt", error, {
        prompt_name: req.body?.name,
        arguments: truncateForLog(req.body?.arguments),
        timeout_like: isTimeoutLikeError(error),
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
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

  const { server, port } = await listenOnAvailablePort(app, startingPort);

  if (port !== startingPort) {
    console.log(`Port ${startingPort} is in use. Falling back to http://localhost:${port}`);
  }

  console.log(`Server running on http://localhost:${port}`);
}
