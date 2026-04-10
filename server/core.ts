import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getOpenRouterConfig } from "../src/lib/ai/openrouter.ts";
import type { FullCaseWorkflowArgs, ToolPayload, WorkflowExecutionHooks, WorkflowProgressEvent } from "./types.ts";
import { isTimeoutLikeError, logServerError, truncateForLog, asNonEmptyString, asObject } from "./utils.ts";
import { withInternalMcpClient as withInternalMcpClientBase } from "./mcp.ts";
import {
  buildDraftArgsFromStageOutputs,
  buildWorkflowTrace,
  createStageTimeline,
  createWorkflowSections,
  generateChecklistAnalysis,
  generateDashboardChatReply,
  generateDraftReplyStage,
  getArticleTracePlan,
  generateIssuesAnalysis,
  generateLawCandidatesAnalysis,
  parseToolPayload,
  recordStageAttempt,
  runDeterministicWorkflow,
  skipPendingStages,
  startStage,
} from "./workflow/index.ts";

function isAllConfiguredModelsFailed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /OpenRouter failed for all configured models/i.test(message);
}

export async function executeCaseWorkflow(
  args: FullCaseWorkflowArgs,
  hooks?: WorkflowExecutionHooks,
): Promise<ToolPayload> {
  const openRouterConfig = getOpenRouterConfig();
  const primaryModel = openRouterConfig.primaryModel;
  const timeline = createStageTimeline();
  const sections = createWorkflowSections();

  const emitProgress = (
    message: string,
    type: WorkflowProgressEvent["type"] = "progress",
    workflow?: ToolPayload,
    error?: string,
  ) => {
    const trace = buildWorkflowTrace(
      timeline,
      sections,
      type === "complete"
        ? (asNonEmptyString(asObject(asObject(workflow)?.workflow_summary)?.analysis_mode) || "openrouter_stage_chain")
        : "openrouter_stage_chain",
      type === "complete"
        ? (asNonEmptyString(asObject(asObject(workflow)?.workflow_summary)?.llm_error) || null)
        : null,
    );

    hooks?.onProgress?.({
      type,
      message,
      timeline: timeline.map((entry) => ({ ...entry })),
      trace,
      workflow,
      error,
    });
  };

  emitProgress("解析キューを準備しています。");

  const workflow = await withInternalMcpClientBase(executeCaseWorkflow, async (client) => {
    let workflowBase: Awaited<ReturnType<typeof runDeterministicWorkflow>>;
    let workflowMode = "deterministic_fallback";
    let llmError: string | null = null;

    if (openRouterConfig.apiKey) {
      emitProgress("論点整理から順番に解析を開始します。");

      try {
        startStage(timeline, "issues");
        emitProgress("1/4 論点整理を主モデルへ送信しました。");
        const issuesResult = await generateIssuesAnalysis(args, {
          onAttempt: (attempt) => {
            const willRetry = attempt.status === "error" && attempt.model !== openRouterConfig.models.at(-1);
            recordStageAttempt(timeline, sections, "issues", attempt, attempt.model === primaryModel, willRetry, args);
            emitProgress(
              attempt.status === "success"
                ? "1/4 論点整理を受信しました。"
                : willRetry
                  ? "1/4 論点整理で主モデルが不安定なため、予備モデルへ切り替えます。"
                  : "1/4 論点整理の生成に失敗しました。",
            );
          },
        });

        startStage(timeline, "lawCandidates");
        emitProgress("2/4 関連法令を整理しています。");
        const lawResult = await generateLawCandidatesAnalysis(args, issuesResult.payload, {
          onAttempt: (attempt) => {
            const willRetry = attempt.status === "error" && attempt.model !== openRouterConfig.models.at(-1);
            recordStageAttempt(timeline, sections, "lawCandidates", attempt, attempt.model === primaryModel, willRetry, args);
            emitProgress(
              attempt.status === "success"
                ? "2/4 関連法令を受信しました。"
                : willRetry
                  ? "2/4 関連法令で主モデルが不安定なため、予備モデルへ切り替えます。"
                  : "2/4 関連法令の生成に失敗しました。",
            );
          },
        });

        startStage(timeline, "checklist");
        emitProgress("3/4 確認事項を組み立てています。");
        const checklistResult = await generateChecklistAnalysis(args, issuesResult.payload, lawResult.payload, {
          onAttempt: (attempt) => {
            const willRetry = attempt.status === "error" && attempt.model !== openRouterConfig.models.at(-1);
            recordStageAttempt(timeline, sections, "checklist", attempt, attempt.model === primaryModel, willRetry, args);
            emitProgress(
              attempt.status === "success"
                ? "3/4 確認事項を受信しました。"
                : willRetry
                  ? "3/4 確認事項で主モデルが不安定なため、予備モデルへ切り替えます。"
                  : "3/4 確認事項の生成に失敗しました。",
            );
          },
        });

        startStage(timeline, "draftReply");
        emitProgress("4/4 返信文を整えています。");
        const draftArgs = buildDraftArgsFromStageOutputs(args, issuesResult.payload, lawResult.payload, checklistResult.payload);
        const draftResult = await generateDraftReplyStage(draftArgs, {
          onAttempt: (attempt) => {
            const willRetry = attempt.status === "error" && attempt.model !== openRouterConfig.models.at(-1);
            recordStageAttempt(timeline, sections, "draftReply", attempt, attempt.model === primaryModel, willRetry, draftArgs);
            emitProgress(
              attempt.status === "success"
                ? "4/4 返信文を受信しました。"
                : willRetry
                  ? "4/4 返信文で主モデルが不安定なため、予備モデルへ切り替えます。"
                  : "4/4 返信文の生成に失敗しました。",
            );
          },
        });

        const lawCandidates = Array.isArray(lawResult.payload.law_candidates) ? lawResult.payload.law_candidates : [];
        const firstLaw = lawCandidates.find((candidate) => Boolean(asNonEmptyString(asObject(candidate)?.law_title)));
        const articleTracePlan = getArticleTracePlan(
          asNonEmptyString(asObject(firstLaw)?.law_title),
          args.domain_hint,
          args.request_text,
        );

        const articleTraceResult = parseToolPayload(await client.callTool({
          name: "trace_articles_and_references",
          arguments: {
            case_id: args.case_id,
            law_id: articleTracePlan.lawTitle,
            entry_points: articleTracePlan.entryPoints,
            max_depth: 2,
            include_delegations: true,
            include_related_rules: true,
          },
        }));

        workflowBase = {
          case_id: args.case_id,
          outputs: {
            issues: issuesResult.payload,
            related_laws: lawResult.payload,
            article_trace: articleTraceResult,
            missing_information: checklistResult.payload,
            draft_reply: draftResult.payload,
          },
        };
        workflowMode = "openrouter_stage_chain";
        emitProgress("4段階の解析結果を統合しています。");
      } catch (error) {
        llmError = error instanceof Error ? error.message : String(error);
        logServerError("run_full_case_workflow.llm_analysis", error, {
          case_id: args.case_id,
          client_name: args.client_name,
          domain_hint: args.domain_hint ?? "auto",
          request_text: truncateForLog(args.request_text, 400),
          timeout_like: isTimeoutLikeError(error),
          fallback_mode: "deterministic_fallback",
        });

        if (isAllConfiguredModelsFailed(error)) {
          skipPendingStages(timeline, "予備モデルを含む全モデルで応答取得に失敗したため、解析を中断しました。");
          const failureTrace = buildWorkflowTrace(timeline, sections, "openrouter_stage_chain", llmError);
          const failure = Object.assign(
            new Error("設定済みモデルとフォールバックモデルの応答取得に失敗したため、解析を完了できませんでした。"),
            {
              timeline: timeline.map((entry) => ({ ...entry })),
              trace: failureTrace,
            },
          );
          throw failure;
        }

        skipPendingStages(timeline, "LLM 連鎖を最後まで完走できなかったため、補助ロジックへ切り替えました。");
        emitProgress("主解析が途切れたため、補助ロジックへ切り替えています。");

        workflowBase = await runDeterministicWorkflow(client, args, { allowLlmDraft: false });
      }
    } else {
      llmError = "OPENROUTER_API_KEY is not configured";
      skipPendingStages(timeline, "API キー未設定のため、補助ロジックで補完しました。");
      emitProgress("API キー未設定のため、補助ロジックのみで解析します。");

      workflowBase = await runDeterministicWorkflow(client, args, { allowLlmDraft: false });
    }

    return {
      ...workflowBase,
      workflow_summary: {
        request_text: args.request_text,
        domain_hint: args.domain_hint ?? "auto",
        jurisdiction: args.jurisdiction ?? null,
        analysis_mode: workflowMode,
        llm_error: llmError,
        completed_steps: [
          "consultation_issue_extraction",
          "relevant_law_search",
          "article_trace",
          "missing_info_checklist",
          "initial_client_reply_draft",
        ],
        generated_at: new Date().toISOString(),
      },
      analysis_trace: buildWorkflowTrace(timeline, sections, workflowMode, llmError),
    };
  });

  emitProgress("解析が完了しました。", "complete", workflow);
  return workflow;
}

export async function withInternalMcpClient<T>(action: (client: Client) => Promise<T>): Promise<T> {
  return withInternalMcpClientBase(executeCaseWorkflow, action);
}

export {
  generateDashboardChatReply,
  isTimeoutLikeError,
  logServerError,
  truncateForLog,
};
