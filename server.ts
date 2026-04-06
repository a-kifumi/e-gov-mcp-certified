import express from "express";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  createOpenRouterChatCompletion,
  getOpenRouterConfig,
  getPublicOpenRouterConfig,
} from "./src/lib/ai/openrouter.ts";
import {
  getDefaultPromptArguments,
  getDefaultToolArguments,
  getPromptInputSamples,
  getToolInputSamples,
} from "./src/lib/workshopSamples.ts";

type DraftInitialReplyArgs = {
  case_id: string;
  client_name?: string;
  issues: string[];
  law_candidates?: string[];
  checklist: unknown[];
  tone?: "professional" | "concise" | "formal";
  include_disclaimer?: boolean;
};

type ToolPayload = Record<string, unknown>;

const FUEI_LAW_SOURCE = {
  provider: "e-Gov 法令検索",
  title: "風俗営業等の規制及び業務の適正化等に関する法律",
  law_id: "323AC0000000122",
  law_number: "昭和二十三年法律第百二十二号",
  version_id: "20251128_507AC0000000045",
  version_date: "2025-11-28",
  source_url: "https://laws.e-gov.go.jp/law/323AC0000000122/20251128_507AC0000000045",
} as const;

const FOOD_SANITATION_LAW_SOURCE = {
  provider: "e-Gov 法令検索",
  title: "食品衛生法",
  law_id: "322AC0000000233",
  law_number: "昭和二十二年法律第二百三十三号",
  version_id: "20250601_504AC0000000068",
  version_date: "2025-06-01",
  source_url: "https://laws.e-gov.go.jp/law/322AC0000000233/20250601_504AC0000000068",
} as const;

function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : fallback;
}

function stringifyChecklistItem(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }

  if (!item || typeof item !== "object") {
    return String(item);
  }

  const candidateKeys = ["item", "question_to_client", "label", "why_needed", "priority"];

  for (const key of candidateKeys) {
    const value = (item as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return JSON.stringify(item);
}

function buildDraftInitialReplyTemplate(args: DraftInitialReplyArgs) {
  const checklistLines = args.checklist
    .map((item) => stringifyChecklistItem(item))
    .filter(Boolean)
    .map((item) => `- ${item}`);
  const issueLine = args.issues.length > 0 ? args.issues.join("、") : "関連手続";
  const lawLine = args.law_candidates?.length ? `参考候補法令: ${args.law_candidates.join("、")}\n\n` : "";
  const disclaimerFlags = args.include_disclaimer === false
    ? ["human_review_required"]
    : ["human_review_required", "not_final_legal_opinion", "practice_confirmation_needed"];

  return {
    case_id: args.case_id,
    subject: "必要手続の初期整理について",
    body: `${args.client_name || "お客様"}\n\nご相談内容を踏まえて初期整理を行いました。現時点では、${issueLine}に関する確認が必要と考えられます。\n\n${lawLine}特に、営業実態や所轄運用によって評価が分かれる事項が含まれるため、現段階では断定を避けるべきです。\n\n追加で以下をご共有ください。\n${checklistLines.join("\n") || "- 追加資料をご共有ください"}\n\n上記を確認後、必要手続の整理をより具体化してご案内します。\n`,
    disclaimer_flags: disclaimerFlags,
    review_notes: [
      "自治体・所轄運用の確認前に断定しないこと",
      "人間レビュー前提で送付すること",
    ],
    meta: {
      needs_human_review: true,
      generated_at: new Date().toISOString(),
      server_version: "0.1.0",
      sources: [],
    },
  };
}

function buildDraftInitialReplyPrompt(args: DraftInitialReplyArgs) {
  const checklist = args.checklist.map((item) => stringifyChecklistItem(item)).filter(Boolean);

  return [
    {
      role: "system" as const,
      content:
        "You draft safe Japanese client replies for legal-intake workflows. Return JSON only with keys: subject, body, disclaimer_flags, review_notes. Keep the tone cautious, practical, and human-review-first. Do not state legal conclusions as final.",
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          task: "Draft an initial Japanese client reply",
          case_id: args.case_id,
          client_name: args.client_name ?? null,
          issues: args.issues,
          law_candidates: args.law_candidates ?? [],
          checklist,
          tone: args.tone ?? "professional",
          include_disclaimer: args.include_disclaimer !== false,
          output_contract: {
            subject: "string",
            body: "string",
            disclaimer_flags: ["string"],
            review_notes: ["string"],
          },
        },
        null,
        2,
      ),
    },
  ];
}

function mergeAiDraftIntoTemplate(
  baseDraft: ReturnType<typeof buildDraftInitialReplyTemplate>,
  aiContent: string,
  modelUsed: string,
  attemptedModels: string[],
) {
  const parsed = JSON.parse(aiContent) as Record<string, unknown>;

  return {
    ...baseDraft,
    subject: typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim() : baseDraft.subject,
    body: typeof parsed.body === "string" && parsed.body.trim() ? parsed.body.trim() : baseDraft.body,
    disclaimer_flags: toStringArray(parsed.disclaimer_flags, baseDraft.disclaimer_flags),
    review_notes: toStringArray(parsed.review_notes, baseDraft.review_notes),
    meta: {
      ...baseDraft.meta,
      generation_mode: "openrouter",
      provider: "openrouter",
      model_used: modelUsed,
      attempted_models: attemptedModels,
    },
  };
}

function parseToolPayload(result: unknown): ToolPayload {
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content?: unknown[] }).content)
  ) {
    for (const item of (result as { content?: unknown[] }).content ?? []) {
      if (
        item &&
        typeof item === "object" &&
        "text" in item &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        return JSON.parse((item as { text: string }).text) as ToolPayload;
      }
    }
  }

  throw new Error("Tool result did not contain JSON text content");
}

function createMcpServer() {
  const mcp = new McpServer({
    name: "legal-intake-egov-mcp",
    version: "0.1.0",
  });

  mcp.resource(
    "common_issue_patterns",
    "resource://domains/common_issue_patterns",
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: JSON.stringify({
          fuei: {
            keywords: ["深夜営業", "酒類", "接待", "バー", "カラオケ"],
            common_issues: ["深夜酒類提供の要否", "接待該当性の確認", "図面確認"]
          }
        }, null, 2)
      }]
    })
  );

  mcp.resource(
    "client_reply_cautions",
    "resource://templates/client_reply_cautions",
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: JSON.stringify({
          cautions: [
            "現時点では断定できません",
            "営業実態により判断が分かれます",
            "法令本文に加えて運用確認が必要です"
          ]
        }, null, 2)
      }]
    })
  );

  mcp.resource(
    "llm_runtime_config",
    "resource://runtime/llm_runtime_config",
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: JSON.stringify(getPublicOpenRouterConfig(), null, 2)
      }]
    })
  );

  mcp.resource(
    "human_review_rules",
    "resource://safety/human_review_rules",
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: JSON.stringify({
          rules: [
            "法的結論の断定禁止",
            "自治体運用の断定禁止",
            "顧客送信前に人間レビュー必須"
          ]
        }, null, 2)
      }]
    })
  );

  mcp.prompt(
    "new_case_triage",
    { request_text: z.string() },
    ({ request_text }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `新規相談の整理ワークフローを開始します。\n\n相談内容:\n${request_text}\n\n以下の手順で処理してください:\n1. 論点抽出\n2. 候補法令検索\n3. 不足情報リスト生成\n4. 顧客返信案生成`
        }
      }]
    })
  );

  mcp.prompt(
    "safe_initial_reply",
    {},
    () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "一次返信案を安全に作成してください。\n\n想定ルール:\n- 断定しない\n- 未確認事項を明示\n- 次に必要な資料を列挙\n- 人間レビュー前提で出力"
        }
      }]
    })
  );

  mcp.tool(
    "run_full_case_workflow",
    {
      case_id: z.string(),
      request_text: z.string(),
      client_name: z.string().optional(),
      domain_hint: z.enum(["auto", "construction", "kobutsu", "fuei", "immigration", "waste", "corporate"]).optional(),
      jurisdiction: z.string().optional(),
      tone: z.enum(["professional", "concise", "formal"]).optional(),
      include_disclaimer: z.boolean().default(true),
      output_language: z.string().default("ja"),
    },
    async (args) => {
      const workflow = await withInternalMcpClient(async (client) => {
        const issuesResult = parseToolPayload(await client.callTool({
          name: "extract_issues_from_consultation",
          arguments: {
            case_id: args.case_id,
            request_text: args.request_text,
            domain_hint: args.domain_hint,
            jurisdiction: args.jurisdiction,
            output_language: args.output_language,
          },
        }));

        const issueLabels = Array.isArray(issuesResult.issues)
          ? issuesResult.issues
            .map((issue) => (
              issue && typeof issue === "object" && "label" in issue && typeof (issue as { label?: unknown }).label === "string"
                ? (issue as { label: string }).label
                : null
            ))
            .filter((label): label is string => Boolean(label))
          : [];

        const keywords = issueLabels.length > 0
          ? issueLabels
          : [args.request_text.slice(0, 40)];

        const lawSearchResult = parseToolPayload(await client.callTool({
          name: "search_relevant_laws",
          arguments: {
            case_id: args.case_id,
            issues: issueLabels,
            keywords,
            as_of_date: new Date().toISOString().split("T")[0],
            max_results: 8,
          },
        }));

        const primaryLawId = Array.isArray(lawSearchResult.law_candidates)
          ? lawSearchResult.law_candidates.find((candidate) => (
            candidate &&
            typeof candidate === "object" &&
            "law_title" in candidate &&
            typeof (candidate as { law_title?: unknown }).law_title === "string"
          ))
          : null;

        const articleTraceResult = parseToolPayload(await client.callTool({
          name: "trace_articles_and_references",
          arguments: {
            case_id: args.case_id,
            law_id:
              primaryLawId &&
              typeof primaryLawId === "object" &&
              "law_title" in primaryLawId &&
              typeof (primaryLawId as { law_title?: unknown }).law_title === "string"
                ? (primaryLawId as { law_title: string }).law_title
                : "風俗営業等の規制及び業務の適正化等に関する法律",
            entry_points: ["第2条", "第33条"],
            max_depth: 2,
            include_delegations: true,
            include_related_rules: true,
          },
        }));

        const missingInfoResult = parseToolPayload(await client.callTool({
          name: "generate_missing_info_checklist",
          arguments: {
            case_id: args.case_id,
            issues: issueLabels,
            law_candidates: Array.isArray(lawSearchResult.law_candidates) ? lawSearchResult.law_candidates : [],
            client_facts_known: Array.isArray(issuesResult.missing_facts) ? issuesResult.missing_facts : [],
          },
        }));

        const checklistItems = Array.isArray(missingInfoResult.checklist)
          ? missingInfoResult.checklist.map((item) => {
            if (item && typeof item === "object" && "question_to_client" in item) {
              const question = (item as { question_to_client?: unknown }).question_to_client;
              if (typeof question === "string" && question.trim()) {
                return question;
              }
            }

            if (item && typeof item === "object" && "item" in item) {
              const label = (item as { item?: unknown }).item;
              if (typeof label === "string" && label.trim()) {
                return label;
              }
            }

            return JSON.stringify(item);
          })
          : [];

        const draftReplyResult = parseToolPayload(await client.callTool({
          name: "draft_initial_client_reply",
          arguments: {
            case_id: args.case_id,
            client_name: args.client_name,
            issues: issueLabels,
            law_candidates: Array.isArray(lawSearchResult.law_candidates)
              ? lawSearchResult.law_candidates
                .map((candidate) => (
                  candidate &&
                  typeof candidate === "object" &&
                  "law_title" in candidate &&
                  typeof (candidate as { law_title?: unknown }).law_title === "string"
                    ? (candidate as { law_title: string }).law_title
                    : null
                ))
                .filter((title): title is string => Boolean(title))
              : [],
            checklist: checklistItems,
            tone: args.tone,
            include_disclaimer: args.include_disclaimer,
          },
        }));

        return {
          case_id: args.case_id,
          workflow_summary: {
            request_text: args.request_text,
            domain_hint: args.domain_hint ?? "auto",
            jurisdiction: args.jurisdiction ?? null,
            completed_steps: [
              "consultation_issue_extraction",
              "relevant_law_search",
              "article_trace",
              "missing_info_checklist",
              "initial_client_reply_draft",
            ],
            generated_at: new Date().toISOString(),
          },
          outputs: {
            issues: issuesResult,
            related_laws: lawSearchResult,
            article_trace: articleTraceResult,
            missing_information: missingInfoResult,
            draft_reply: draftReplyResult,
          },
        };
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify(workflow, null, 2),
        }],
      };
    }
  );

  mcp.tool(
    "extract_issues_from_consultation",
    {
      case_id: z.string(),
      request_text: z.string(),
      domain_hint: z.enum(["auto", "construction", "kobutsu", "fuei", "immigration", "waste", "corporate"]).optional(),
      jurisdiction: z.string().optional(),
      output_language: z.string().default("ja")
    },
    async (args) => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            case_id: args.case_id,
            domain_detected: args.domain_hint || "fuei",
            issues: [
              {
                issue_code: "food_business_permission",
                label: "飲食店営業許可",
                confidence: 0.88,
                reason: "飲食提供を伴う店舗営業のため"
              },
              {
                issue_code: "late_night_liquor",
                label: "深夜酒類提供の要否",
                confidence: 0.93,
                reason: "深夜営業・酒類提供あり"
              },
              {
                issue_code: "hospitality_risk",
                label: "接待該当性の確認",
                confidence: 0.84,
                reason: "バー営業で接客態様により評価が分かれるため"
              }
            ],
            missing_facts: [
              "客席配置",
              "従業員の接客態様",
              "カラオケ有無",
              "店内面積",
              "物件用途"
            ],
            hearing_questions: [
              "従業員が客の隣に座る運営は予定していますか？",
              "カウンター越し以外の接客はありますか？",
              "客席図面はありますか？"
            ],
            warnings: [
              "法令本文だけでは自治体・警察運用を確定できません"
            ],
            meta: {
              needs_human_review: true,
              generated_at: new Date().toISOString(),
              server_version: "0.1.0",
              sources: []
            }
          }, null, 2)
        }]
      };
    }
  );

  mcp.tool(
    "search_relevant_laws",
    {
      case_id: z.string(),
      issues: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
      as_of_date: z.string().optional(),
      max_results: z.number().default(10)
    },
    async (args) => {
      const checkedOn = args.as_of_date || new Date().toISOString().split("T")[0];
      const searchText = [...(args.issues ?? []), ...(args.keywords ?? [])].join(" ");
      const needsSuccessionReference = /(承継|譲渡|相続|合併|分割|居抜き)/.test(searchText);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            case_id: args.case_id,
            law_candidates: [
              {
                law_id: FUEI_LAW_SOURCE.law_id,
                law_title: FUEI_LAW_SOURCE.title,
                relevance_score: 0.95,
                matched_terms: ["深夜営業", "接待", "酒類"],
                why_relevant: "深夜営業および接待該当性の論点に関連",
                references: [
                  {
                    citation: "第2条第1項第1号・第3項",
                    summary: "接待を伴う営業類型と「接待」の定義を確認する起点。",
                    egov_url: FUEI_LAW_SOURCE.source_url,
                  },
                  {
                    citation: "第33条第1項",
                    summary: "深夜における酒類提供飲食店営業の届出根拠。",
                    egov_url: FUEI_LAW_SOURCE.source_url,
                  },
                ],
                source: {
                  ...FUEI_LAW_SOURCE,
                  checked_on: checkedOn,
                },
              },
              {
                law_id: FOOD_SANITATION_LAW_SOURCE.law_id,
                law_title: FOOD_SANITATION_LAW_SOURCE.title,
                relevance_score: 0.89,
                matched_terms: ["飲食店営業"],
                why_relevant: needsSuccessionReference
                  ? "飲食店営業許可と営業承継可否の確認根拠"
                  : "飲食提供を伴う営業許可の根拠法令",
                references: [
                  {
                    citation: "第54条",
                    summary: "営業施設の基準を都道府県条例で定める根拠。",
                    egov_url: FOOD_SANITATION_LAW_SOURCE.source_url,
                  },
                  {
                    citation: "第55条第1項・第2項",
                    summary: "飲食店営業の許可と施設基準適合の要件。",
                    egov_url: FOOD_SANITATION_LAW_SOURCE.source_url,
                  },
                  ...(needsSuccessionReference
                    ? [{
                      citation: "第56条第1項・第2項",
                      summary: "営業譲渡等による許可営業者の地位承継と届出。",
                      egov_url: FOOD_SANITATION_LAW_SOURCE.source_url,
                    }]
                    : []),
                ],
                source: {
                  ...FOOD_SANITATION_LAW_SOURCE,
                  checked_on: checkedOn,
                },
              },
            ],
            related_rules: [
              {
                parent_law_title: FUEI_LAW_SOURCE.title,
                related_rule_hint: "施行規則・施行令の確認が必要"
              }
            ],
            warnings: [
              "候補法令は案件論点との関連推定であり、確定結論ではありません"
            ],
            meta: {
              needs_human_review: true,
              generated_at: new Date().toISOString(),
              server_version: "0.1.0",
              sources: [
                {
                  provider: FUEI_LAW_SOURCE.provider,
                  law_id: FUEI_LAW_SOURCE.law_id,
                  source_url: FUEI_LAW_SOURCE.source_url,
                  checked_on: checkedOn,
                },
                {
                  provider: FOOD_SANITATION_LAW_SOURCE.provider,
                  law_id: FOOD_SANITATION_LAW_SOURCE.law_id,
                  source_url: FOOD_SANITATION_LAW_SOURCE.source_url,
                  checked_on: checkedOn,
                },
              ]
            }
          }, null, 2)
        }]
      };
    }
  );

  mcp.tool(
    "trace_articles_and_references",
    {
      case_id: z.string(),
      law_id: z.string(),
      entry_points: z.array(z.string()),
      max_depth: z.number().default(2),
      include_delegations: z.boolean().default(true),
      include_related_rules: z.boolean().default(true)
    },
    async (args) => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            case_id: args.case_id,
            law_id: args.law_id,
            entry_points: args.entry_points,
            article_graph: [
              {
                citation: "第2条",
                summary_for_practice: "定義規定。接待・営業類型を読む起点。",
                references: [
                  {
                    reference_type: "internal_reference",
                    target_citation: "第33条"
                  }
                ],
                delegations: []
              },
              {
                citation: "第33条",
                summary_for_practice: "深夜営業関連の確認起点。",
                references: [],
                delegations: [
                  {
                    delegation_type: "cabinet_order",
                    label: "政令で定める"
                  }
                ]
              }
            ],
            practical_next_reads: [
              "施行令の該当条文",
              "施行規則の届出関係条文"
            ],
            warnings: [
              "条文追跡は法令本文ベースであり、運用通知は別確認が必要です"
            ],
            meta: {
              needs_human_review: true,
              generated_at: new Date().toISOString(),
              server_version: "0.1.0",
              sources: [{ provider: "e-Gov Law API v2", retrieved_at: new Date().toISOString() }]
            }
          }, null, 2)
        }]
      };
    }
  );

  mcp.tool(
    "generate_missing_info_checklist",
    {
      case_id: z.string(),
      issues: z.array(z.string()),
      law_candidates: z.array(z.record(z.string(), z.any())),
      client_facts_known: z.array(z.string()).optional()
    },
    async (args) => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            case_id: args.case_id,
            checklist: [
              {
                priority: "high",
                item: "客席の配置図",
                why_needed: "接待該当性や営業態様の確認に必要",
                question_to_client: "客席の配置図または簡単なレイアウト図はありますか？"
              },
              {
                priority: "high",
                item: "従業員の接客態様",
                why_needed: "接待該当性の判断材料になるため",
                question_to_client: "従業員が客の隣に座る、または特定客に継続的に会話サービスを行う予定はありますか？"
              },
              {
                priority: "medium",
                item: "カラオケ設備の有無",
                why_needed: "営業実態の評価に影響しうるため",
                question_to_client: "カラオケ設備や歌唱サービスの提供予定はありますか？"
              }
            ],
            summary: "現時点では営業実態の確認不足が主な未確定要素です",
            meta: {
              needs_human_review: true,
              generated_at: new Date().toISOString(),
              server_version: "0.1.0",
              sources: []
            }
          }, null, 2)
        }]
      };
    }
  );

  mcp.tool(
    "draft_initial_client_reply",
    {
      case_id: z.string(),
      client_name: z.string().optional(),
      issues: z.array(z.string()),
      law_candidates: z.array(z.string()).optional(),
      checklist: z.array(z.any()),
      tone: z.enum(["professional", "concise", "formal"]).optional(),
      include_disclaimer: z.boolean().default(true)
    },
    async (args) => {
      const templateDraft = buildDraftInitialReplyTemplate(args);
      const openRouterConfig = getOpenRouterConfig();

      if (!openRouterConfig.apiKey) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...templateDraft,
              meta: {
                ...templateDraft.meta,
                generation_mode: "template_fallback",
                provider: "openrouter",
                attempted_models: openRouterConfig.models,
                reason: "OPENROUTER_API_KEY is not configured",
              }
            }, null, 2)
          }]
        };
      }

      try {
        const completion = await createOpenRouterChatCompletion(
          buildDraftInitialReplyPrompt(args),
          { maxTokens: 900, temperature: 0.2 },
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              mergeAiDraftIntoTemplate(
                templateDraft,
                completion.content,
                completion.model,
                completion.attemptedModels,
              ),
              null,
              2,
            )
          }]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...templateDraft,
              meta: {
                ...templateDraft.meta,
                generation_mode: "template_fallback",
                provider: "openrouter",
                attempted_models: openRouterConfig.models,
                ai_error: message,
              }
            }, null, 2)
          }]
        };
      }
    }
  );

  return mcp;
}

async function withInternalMcpClient<T>(action: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer();
  const client = new Client({ name: "web-workshop-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

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

async function startServer() {
  const app = express();
  const PORT = 3000;

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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
