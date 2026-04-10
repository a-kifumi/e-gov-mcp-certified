import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Request, Response } from "express";
import {
  getDefaultPromptArguments,
  getDefaultToolArguments,
} from "../../src/lib/workshopSamples.ts";
import { createApiHandlers, getStartingPort } from "../../server/http.ts";

type MockClient = {
  listTools: () => Promise<{ tools: Array<Record<string, unknown>> }>;
  listResources: () => Promise<{ resources: Array<Record<string, unknown>> }>;
  listPrompts: () => Promise<{ prompts: Array<Record<string, unknown>> }>;
  callTool: (input: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
  readResource: (input: { uri: string }) => Promise<unknown>;
  getPrompt: (input: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
};

function createMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    listPrompts: async () => ({ prompts: [] }),
    callTool: async () => ({ ok: true }),
    readResource: async () => ({ contents: [] }),
    getPrompt: async () => ({ messages: [] }),
    ...overrides,
  };
}

function createMockRequest(body?: unknown) {
  return { body } as Request;
}

function createMockResponse() {
  const headers = new Map<string, string>();
  const chunks: string[] = [];

  const response = {
    statusCode: 200,
    writableEnded: false,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      this.writableEnded = true;
      return this;
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    flushHeaders() {
      return undefined;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) {
        chunks.push(chunk);
      }
      this.writableEnded = true;
      return this;
    },
  };

  return {
    res: response as unknown as Response,
    statusCode: () => response.statusCode,
    jsonBody: () => response.jsonBody,
    header: (name: string) => headers.get(name.toLowerCase()),
    textBody: () => chunks.join(""),
    writableEnded: () => response.writableEnded,
  };
}

describe("server/http", () => {
  test("GET /api/health returns ok", async () => {
    const handlers = createApiHandlers();
    const response = createMockResponse();

    await handlers.health(createMockRequest(), response.res, (() => undefined) as never);

    assert.equal(response.statusCode(), 200);
    assert.deepEqual(response.jsonBody(), { ok: true });
  });

  test("GET /api/catalog sorts workflow tool first and decorates defaults", async () => {
    const handlers = createApiHandlers({
      withInternalMcpClient: async (action) => action(createMockClient({
        listTools: async () => ({
          tools: [
            { name: "search_relevant_laws", description: "search" },
            { name: "run_full_case_workflow", description: "run" },
          ],
        }),
        listResources: async () => ({
          resources: [{ uri: "resource://domains/common_issue_patterns" }],
        }),
        listPrompts: async () => ({
          prompts: [{ name: "new_case_triage", description: "triage" }],
        }),
      }) as any),
    });
    const response = createMockResponse();

    await handlers.catalog(createMockRequest(), response.res, (() => undefined) as never);

    const payload = response.jsonBody() as {
      tools: Array<{ name: string; defaultArguments: Record<string, unknown> }>;
      prompts: Array<{ name: string; defaultArguments: Record<string, unknown> }>;
    };

    assert.equal(response.statusCode(), 200);
    assert.equal(payload.tools[0]?.name, "run_full_case_workflow");
    assert.deepEqual(
      payload.tools[0]?.defaultArguments,
      getDefaultToolArguments("run_full_case_workflow"),
    );
    assert.deepEqual(
      payload.prompts[0]?.defaultArguments,
      getDefaultPromptArguments("new_case_triage"),
    );
  });

  test("POST /api/tool falls back to default sample arguments", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const handlers = createApiHandlers({
      withInternalMcpClient: async (action) => action(createMockClient({
        callTool: async (input) => {
          calls.push(input);
          return { ok: true };
        },
      }) as any),
    });
    const response = createMockResponse();

    await handlers.tool(createMockRequest({
      name: "extract_issues_from_consultation",
      arguments: {},
    }), response.res, (() => undefined) as never);

    assert.equal(response.statusCode(), 200);
    assert.deepEqual(response.jsonBody(), { ok: true });
    assert.deepEqual(calls, [{
      name: "extract_issues_from_consultation",
      arguments: getDefaultToolArguments("extract_issues_from_consultation"),
    }]);
  });

  test("POST /api/resource forwards the requested uri", async () => {
    const calls: Array<{ uri: string }> = [];
    const handlers = createApiHandlers({
      withInternalMcpClient: async (action) => action(createMockClient({
        readResource: async (input) => {
          calls.push(input);
          return { contents: [] };
        },
      }) as any),
    });
    const response = createMockResponse();

    await handlers.resource(createMockRequest({
      uri: "resource://templates/client_reply_cautions",
    }), response.res, (() => undefined) as never);

    assert.equal(response.statusCode(), 200);
    assert.deepEqual(response.jsonBody(), { contents: [] });
    assert.deepEqual(calls, [{ uri: "resource://templates/client_reply_cautions" }]);
  });

  test("POST /api/prompt falls back to default sample arguments", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const handlers = createApiHandlers({
      withInternalMcpClient: async (action) => action(createMockClient({
        getPrompt: async (input) => {
          calls.push(input);
          return { messages: [] };
        },
      }) as any),
    });
    const response = createMockResponse();

    await handlers.prompt(createMockRequest({
      name: "new_case_triage",
      arguments: {},
    }), response.res, (() => undefined) as never);

    assert.equal(response.statusCode(), 200);
    assert.deepEqual(response.jsonBody(), { messages: [] });
    assert.deepEqual(calls, [{
      name: "new_case_triage",
      arguments: getDefaultPromptArguments("new_case_triage"),
    }]);
  });

  test("POST /api/dashboard-chat returns the generated reply", async () => {
    const handlers = createApiHandlers({
      generateDashboardChatReply: async () => ({
        reply: "確認事項を先に伺うぜ。",
        model: "supplemental",
        attempted_models: ["supplemental"],
        generation_mode: "fallback",
      }),
    });
    const response = createMockResponse();

    await handlers.dashboardChat(createMockRequest({
      consultation_text: "バーを開業したい",
      user_message: "次に何を確認すべき？",
      history: [],
      selected_checklist_entries: [],
      case_data: {
        issues: [],
        lawCandidates: [],
        checklist: [],
      },
    }), response.res, (() => undefined) as never);

    assert.equal(response.statusCode(), 200);
    assert.deepEqual(response.jsonBody(), {
      reply: "確認事項を先に伺うぜ。",
      model: "supplemental",
      attempted_models: ["supplemental"],
      generation_mode: "fallback",
    });
  });

  test("POST /api/analyze-stream emits ndjson progress events", async () => {
    const handlers = createApiHandlers({
      executeCaseWorkflow: async (args, hooks) => {
        hooks?.onProgress?.({ type: "progress", message: "queued", timeline: [] });
        hooks?.onProgress?.({
          type: "complete",
          message: "done",
          timeline: [],
          workflow: { case_id: args.case_id },
        });
        return { case_id: args.case_id };
      },
      logServerError: () => undefined,
    });
    const response = createMockResponse();

    await handlers.analyzeStream(createMockRequest({
      case_id: "CASE-001",
      request_text: "深夜営業の届出が必要か確認したい",
    }), response.res, (() => undefined) as never);

    const lines = response.textBody()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(response.statusCode(), 200);
    assert.match(response.header("content-type") ?? "", /application\/x-ndjson/);
    assert.equal(response.writableEnded(), true);
    assert.deepEqual(lines, [
      { type: "progress", message: "queued", timeline: [] },
      { type: "complete", message: "done", timeline: [], workflow: { case_id: "CASE-001" } },
    ]);
  });

  test("POST /api/analyze-stream emits structured error events on failure", async () => {
    const expectedTrace = { timeline: [], sections: {} };
    const handlers = createApiHandlers({
      executeCaseWorkflow: async () => {
        throw Object.assign(new Error("boom"), {
          timeline: [{ label: "論点整理", status: "error" }],
          trace: expectedTrace,
        });
      },
      logServerError: () => undefined,
      isTimeoutLikeError: () => false,
    });
    const response = createMockResponse();

    await handlers.analyzeStream(createMockRequest({
      case_id: "CASE-002",
      request_text: "届出の要否を確認したい",
    }), response.res, (() => undefined) as never);

    const lines = response.textBody()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(response.statusCode(), 200);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      type: "error",
      message: "解析ストリームの実行中にエラーが発生しました。",
      timeline: [{ label: "論点整理", status: "error" }],
      trace: expectedTrace,
      error: "boom",
    });
  });

  test("getStartingPort uses default port when env is missing or invalid", () => {
    assert.equal(getStartingPort({} as NodeJS.ProcessEnv), 3000);
    assert.equal(getStartingPort({ PORT: "not-a-number" } as NodeJS.ProcessEnv), 3000);
    assert.equal(getStartingPort({ PORT: "4567" } as NodeJS.ProcessEnv), 4567);
  });
});
