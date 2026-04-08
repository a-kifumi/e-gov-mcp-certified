import express, { type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import path from "path";
import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  type OpenRouterChatMessage,
  type OpenRouterAttempt,
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

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

type DraftInitialReplyArgs = {
  case_id: string;
  client_name?: string;
  issues: string[];
  law_candidates?: string[];
  checklist: unknown[];
  tone?: "professional" | "concise" | "formal";
  include_disclaimer?: boolean;
};

type FullCaseWorkflowArgs = {
  case_id: string;
  request_text: string;
  client_name?: string;
  domain_hint?: "auto" | "construction" | "kobutsu" | "fuei" | "immigration" | "waste" | "corporate";
  jurisdiction?: string;
  tone?: "professional" | "concise" | "formal";
  include_disclaimer: boolean;
  output_language: string;
};

type ToolPayload = Record<string, unknown>;

type WorkflowStageKey = "issues" | "lawCandidates" | "checklist" | "draftReply";
type WorkflowStageStatus = "pending" | "running" | "success" | "error" | "skipped";
type WorkflowSectionKey = keyof WorkflowTrace["sections"];

type WorkflowStageTrace = {
  slotId: string;
  order: number;
  stageKey: WorkflowStageKey;
  stageLabel: string;
  label: string;
  status: WorkflowStageStatus;
  headline: string;
  summary: string;
  startedAt?: string;
  completedAt?: string;
  model?: string;
  fallbackUsed?: boolean;
  usedInFinal?: boolean;
};

type WorkflowSectionAttemptTrace = {
  attemptId: string;
  model: string;
  status: "success" | "error" | "skipped";
  stageLabel: string;
  label: string;
  headline: string;
  summary: string;
  startedAt?: string;
  completedAt?: string;
  contentPreview?: string;
  errorMessage?: string;
  usedInFinal?: boolean;
  isFallback?: boolean;
  extracted?: {
    issues?: unknown[];
    lawCandidates?: unknown[];
    checklist?: unknown[];
    draftReply?: ToolPayload;
  };
};

type WorkflowSectionTrace = {
  title: string;
  description: string;
  sourceLabel: string;
  sourceSlotId?: string;
  stageKey: WorkflowStageKey;
  finalModel?: string;
  fallbackUsed?: boolean;
  attempts: WorkflowSectionAttemptTrace[];
};

type WorkflowTrace = {
  timeline: WorkflowStageTrace[];
  sections: {
    issues: WorkflowSectionTrace;
    lawCandidates: WorkflowSectionTrace;
    checklist: WorkflowSectionTrace;
    draftReply: WorkflowSectionTrace;
  };
};

type WorkflowProgressEvent = {
  type: "progress" | "complete" | "error";
  message: string;
  timeline: WorkflowStageTrace[];
  trace?: WorkflowTrace;
  workflow?: ToolPayload;
  error?: string;
};

type WorkflowExecutionHooks = {
  onProgress?: (event: WorkflowProgressEvent) => void;
};

type DashboardChatArgs = {
  consultation_text: string;
  client_name?: string;
  user_message: string;
  history: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  selected_checklist_entries: Array<{
    label: string;
    answer: string;
  }>;
  case_data: {
    issues: Array<{ label: string; reason?: string }>;
    lawCandidates: Array<{ law_title: string; why_relevant?: string }>;
    checklist: Array<{ item?: string; question_to_client?: string; why_needed?: string }>;
    draftReply?: { subject?: string; body?: string; review_notes?: string[] };
  };
};

function serializeError(error: unknown) {
  if (error instanceof Error) {
    const plain = error as Error & { code?: string; cause?: unknown };
    return {
      name: plain.name,
      message: plain.message,
      stack: plain.stack,
      code: plain.code,
      cause: plain.cause instanceof Error
        ? { name: plain.cause.name, message: plain.cause.message, stack: plain.cause.stack }
        : plain.cause,
    };
  }

  return {
    message: String(error),
  };
}

function truncateForLog(value: unknown, maxLength = 1200): unknown {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (!serialized) return value;
  if (serialized.length <= maxLength) return value;
  return `${serialized.slice(0, maxLength)}... [truncated ${serialized.length - maxLength} chars]`;
}

function logServerError(scope: string, error: unknown, details?: Record<string, unknown>) {
  const payload = {
    level: "error",
    ts: new Date().toISOString(),
    scope,
    ...serializeError(error),
    ...(details ? { details } : {}),
  };

  console.error("[server:error]", JSON.stringify(payload, null, 2));
}

function logServerWarn(scope: string, details?: Record<string, unknown>) {
  const payload = {
    level: "warn",
    ts: new Date().toISOString(),
    scope,
    ...(details ? { details } : {}),
  };

  console.warn("[server:warn]", JSON.stringify(payload, null, 2));
}

function logServerInfo(scope: string, details?: Record<string, unknown>) {
  const payload = {
    level: "info",
    ts: new Date().toISOString(),
    scope,
    ...(details ? { details } : {}),
  };

  console.log("[server:info]", JSON.stringify(payload, null, 2));
}

function isTimeoutLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|ETIMEDOUT|AbortError|deadline/i.test(message);
}

function summarizeText(text: string | undefined, max = 220): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

const WORKFLOW_STAGE_ORDER: WorkflowStageKey[] = ["issues", "lawCandidates", "checklist", "draftReply"];

function getWorkflowStagePresentation(stageKey: WorkflowStageKey) {
  switch (stageKey) {
    case "issues":
      return {
        label: "論点整理",
        description: "相談文から主要論点と未確定要素を洗い出します。",
      };
    case "lawCandidates":
      return {
        label: "関連法令",
        description: "論点整理の結果を踏まえて、関連しそうな法令候補を絞り込みます。",
      };
    case "checklist":
      return {
        label: "確認事項",
        description: "判断を分ける不足情報を、顧客への確認項目に変換します。",
      };
    case "draftReply":
      return {
        label: "返信文",
        description: "ここまでの整理結果をもとに、初回返信案を組み立てます。",
      };
  }
}

function createStageTimeline(): WorkflowStageTrace[] {
  return WORKFLOW_STAGE_ORDER.map((stageKey, index) => {
    const stage = getWorkflowStagePresentation(stageKey);
    return {
      slotId: stageKey,
      order: index + 1,
      stageKey,
      stageLabel: "解析ステップ",
      label: stage.label,
      status: "pending",
      headline: "待機中",
      summary: stage.description,
    };
  });
}

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

const LAW_SOURCE_CATALOG = [
  FUEI_LAW_SOURCE,
  FOOD_SANITATION_LAW_SOURCE,
  {
    provider: "e-Gov 法令検索",
    title: "建設業法",
  },
  {
    provider: "e-Gov 法令検索",
    title: "建築基準法",
  },
  {
    provider: "e-Gov 法令検索",
    title: "出入国管理及び難民認定法",
  },
  {
    provider: "e-Gov 法令検索",
    title: "労働基準法",
  },
  {
    provider: "e-Gov 法令検索",
    title: "廃棄物の処理及び清掃に関する法律",
  },
] as const;

function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  return normalized.length > 0 ? normalized : fallback;
}

const JAPANESE_TEXT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const REVIEW_NOTE_TRANSLATIONS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /human review|manual review|review by (a )?human|review before sending/,
    replacement: "人間レビュー前提で送付すること",
  },
  {
    pattern: /do not (state|treat).*(final|definitive)|avoid.*(final|definitive).*conclusion|do not state legal conclusions as final|not a final legal opinion|not final legal opinion/,
    replacement: "法的な結論を断定しないこと",
  },
  {
    pattern: /(confirm|check|verify).*(municipal|local authority|jurisdiction|competent authority)|municipal|local authority|jurisdictional practice/,
    replacement: "自治体・所轄運用の確認前に断定しないこと",
  },
  {
    pattern: /adult entertainment business act|fueiho|staff interaction|machine count|falls under/,
    replacement: "従業員の接客実態や設備内容の確認前に風営法該当性を断定しないこと",
  },
  {
    pattern: /actual operations?|practical operations?|practice confirmation|operational confirmation|enforcement practice/,
    replacement: "実務運用の確認が取れるまで断定しないこと",
  },
  {
    pattern: /tone is professional and cautious|proper legal assessment|necessary step/,
    replacement: "慎重な表現を維持し、正式判断前提の案内にならないようにすること",
  },
  {
    pattern: /additional documents?|need more information|insufficient information|further confirmation/,
    replacement: "不足資料と事実関係を確認してから送付すること",
  },
];

function normalizeReviewNote(note: string): string {
  const normalized = note.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (JAPANESE_TEXT_PATTERN.test(normalized)) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  const matched = REVIEW_NOTE_TRANSLATIONS.find((entry) => entry.pattern.test(lower));
  if (matched) {
    return matched.replacement;
  }

  return "記載内容を日本語で見直し、人間レビュー後に送付すること";
}

function normalizeReviewNotes(value: unknown, fallback: string[] = []): string[] {
  const notes = toStringArray(value, fallback)
    .map((note) => normalizeReviewNote(note))
    .filter(Boolean);

  return notes.length > 0 ? Array.from(new Set(notes)) : fallback;
}

const CHECKLIST_TEXT_TRANSLATIONS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /exact location and zoning|use district|zoning district/,
    replacement: "正確な所在地と用途地域",
  },
  {
    pattern: /floor plan|layout|seating layout/,
    replacement: "店舗レイアウトや客席配置",
  },
  {
    pattern: /business hours?|operating hours?|late-night operations?/,
    replacement: "営業時間や深夜営業の予定",
  },
  {
    pattern: /alcohol|liquor service/,
    replacement: "酒類提供の有無や提供方法",
  },
  {
    pattern: /staff|employee.*customer|hospitality service|entertainment service/,
    replacement: "従業員の接客方法や営業実態",
  },
];

const CHECKLIST_REASON_TRANSLATIONS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /entertainment business act|fuei|actively play with customers|classified as entertainment|restricting operating hours to midnight/,
    replacement: "従業員の接客方法や営業実態によっては風営法上の接待営業に該当し、営業時間規制に影響するため",
  },
  {
    pattern: /quantity and nature of gaming equipment|commercial vs\. home use|categorized as a gaming facility|gaming facility/,
    replacement: "ゲーム機の台数や用途によって、風営法上の遊技設備としての扱いが変わる可能性があるため",
  },
  {
    pattern: /certain zones prohibit entertainment businesses|types of food service establishments|zones prohibit|zoning/,
    replacement: "用途地域によって営業できる業態や必要な手続が変わるため",
  },
  {
    pattern: /food sanitation act permit|liquor sales license|bottle sales|scope of the food sanitation act permit/,
    replacement: "飲食店営業許可の範囲や酒類販売免許の要否を判断するため",
  },
  {
    pattern: /operating hours|business hours|late-night/,
    replacement: "営業時間規制や必要な届出の要否を判断するため",
  },
];

function normalizeChecklistText(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  if (JAPANESE_TEXT_PATTERN.test(normalized)) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  const matched = CHECKLIST_TEXT_TRANSLATIONS.find((entry) => entry.pattern.test(lower));
  return matched?.replacement || fallback;
}

function normalizeChecklistReason(
  text: string | undefined,
  label: string,
  question: string,
): string | undefined {
  if (!text) return undefined;

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (JAPANESE_TEXT_PATTERN.test(normalized)) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  const matched = CHECKLIST_REASON_TRANSLATIONS.find((entry) => entry.pattern.test(lower));
  if (matched) {
    return matched.replacement;
  }

  if (/用途地域|所在地/.test(label) || /用途地域|所在地/.test(question)) {
    return "用途地域や所在地によって営業可否や必要手続が変わるため";
  }

  if (/酒類|お酒|ボトル/.test(label) || /酒類|お酒|ボトル/.test(question)) {
    return "酒類提供や販売方法によって必要な許可や届出が変わるため";
  }

  if (/ゲーム|ダーツ|遊技/.test(label) || /ゲーム|ダーツ|遊技/.test(question)) {
    return "ゲーム設備の内容によって必要な手続や規制の有無が変わるため";
  }

  if (/接客|従業員|客/.test(label) || /接客|従業員|客/.test(question)) {
    return "接客方法や営業実態によって風営法上の評価が変わるため";
  }

  return "許認可の要否や必要手続の判断に必要な確認事項です";
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
        "あなたは法律相談の一次受付向けに、安全な日本語の返信案を作る。出力は JSON のみで、キーは subject, body, disclaimer_flags, review_notes に限定すること。subject と body と review_notes は必ず自然な日本語で書き、英語の文や英語の箇条書きを混ぜないこと。disclaimer_flags のみ英字スネークケースの識別子でよい。review_notes は担当者向けの内部レビュー注意として、日本語の短い文を 2 件以上返すこと。法的結論や自治体運用を断定してはならない。",
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          task: "初回返信案を日本語で作成する",
          case_id: args.case_id,
          client_name: args.client_name ?? null,
          issues: args.issues,
          law_candidates: args.law_candidates ?? [],
          checklist,
          tone: args.tone ?? "professional",
          include_disclaimer: args.include_disclaimer !== false,
          language_requirements: {
            subject: "日本語",
            body: "日本語",
            review_notes: "各要素を日本語で記載し、英語を混ぜない",
            disclaimer_flags: "英字スネークケースの識別子",
          },
          output_contract: {
            subject: "日本語の件名",
            body: "日本語の本文",
            disclaimer_flags: ["snake_case_identifier"],
            review_notes: ["日本語のレビュー注意"],
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
    review_notes: normalizeReviewNotes(parsed.review_notes, baseDraft.review_notes),
    meta: {
      ...baseDraft.meta,
      generation_mode: "openrouter",
      provider: "openrouter",
      model_used: modelUsed,
      attempted_models: attemptedModels,
    },
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampUnitInterval(value: unknown): number | undefined {
  const numeric = asNumber(value);
  if (numeric === undefined) return undefined;
  return Math.min(1, Math.max(0, numeric));
}

function parseJsonWithRecovery(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]);
    }

    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }

    throw new Error("LLM response did not contain valid JSON");
  }
}

function normalizeLawTitle(title: string): string {
  return title.replace(/\s+/g, "");
}

function resolveLawSource(candidate: Record<string, unknown>): Record<string, unknown> | undefined {
  const explicitSource = asObject(candidate.source);
  const explicitTitle = asNonEmptyString(candidate.law_title) || asNonEmptyString(explicitSource?.title);
  const matchedCatalog = explicitTitle
    ? LAW_SOURCE_CATALOG.find((entry) => normalizeLawTitle(entry.title) === normalizeLawTitle(explicitTitle))
    : undefined;

  if (!explicitSource && !matchedCatalog) {
    return undefined;
  }

  return {
    ...(matchedCatalog ?? {}),
    ...(explicitSource ?? {}),
    title: explicitTitle ?? matchedCatalog?.title,
  };
}

function normalizeIssuePayload(raw: unknown, requestText: string): ToolPayload {
  const root = asObject(raw) ?? {};
  const fallbackLabel = requestText.trim().slice(0, 32) || "主要論点";
  const issueItems = Array.isArray(root.issues) ? root.issues : [];

  const issues = issueItems
    .map((entry) => {
      const item = asObject(entry);
      const label = asNonEmptyString(item?.label) || asNonEmptyString(item?.issue) || asNonEmptyString(item?.title);
      if (!label) return null;

      return {
        issue_code: asNonEmptyString(item?.issue_code),
        label,
        confidence: clampUnitInterval(item?.confidence),
        reason: asNonEmptyString(item?.reason) || asNonEmptyString(item?.why),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return {
    issues: issues.length > 0 ? issues : [{ label: fallbackLabel, reason: "相談文全体を要確認" }],
    missing_facts: toStringArray(root.missing_facts),
    hearing_questions: toStringArray(root.hearing_questions),
    warnings: toStringArray(root.warnings, [
      "法的結論の断定は避け、人間レビュー前提で扱ってください",
    ]),
    meta: {
      needs_human_review: true,
      generated_at: new Date().toISOString(),
      server_version: "0.1.0",
      generation_mode: "openrouter_stage_chain",
      sources: [],
    },
  };
}

function normalizeLawPayload(raw: unknown): ToolPayload {
  const root = asObject(raw) ?? {};
  const candidates = Array.isArray(root.law_candidates) ? root.law_candidates : [];

  return {
    law_candidates: candidates
      .map((entry) => {
        const item = asObject(entry);
        const lawTitle = asNonEmptyString(item?.law_title) || asNonEmptyString(item?.title);
        if (!lawTitle) return null;

        const source = resolveLawSource({ ...(item ?? {}), law_title: lawTitle });
        const sourceUrl = asNonEmptyString(asObject(source)?.source_url);
        const references = Array.isArray(item?.references)
          ? item.references
            .map((reference) => {
              const ref = asObject(reference);
              const citation = asNonEmptyString(ref?.citation);
              if (!citation) return null;

              return {
                citation,
                summary: asNonEmptyString(ref?.summary),
                egov_url: asNonEmptyString(ref?.egov_url) || sourceUrl,
              };
            })
            .filter((reference): reference is NonNullable<typeof reference> => Boolean(reference))
          : [];

        return {
          law_title: lawTitle,
          relevance_score: clampUnitInterval(item?.relevance_score),
          why_relevant: asNonEmptyString(item?.why_relevant) || "関連可能性あり",
          references,
          source: source
            ? {
              ...source,
              checked_on: asNonEmptyString((source as Record<string, unknown>).checked_on)
                || new Date().toISOString().split("T")[0],
            }
            : undefined,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    related_rules: Array.isArray(root.related_rules) ? root.related_rules : [],
    warnings: toStringArray(root.warnings, [
      "候補法令は初期整理用です。条文・運用確認を別途行ってください",
    ]),
    meta: {
      needs_human_review: true,
      generated_at: new Date().toISOString(),
      server_version: "0.1.0",
      generation_mode: "openrouter_stage_chain",
      sources: [],
    },
  };
}

function normalizeChecklistPayload(raw: unknown): ToolPayload {
  const root = asObject(raw) ?? {};
  const checklist = Array.isArray(root.checklist) ? root.checklist : [];

  return {
    checklist: checklist
      .map((entry) => {
        const item = asObject(entry);
        const label = asNonEmptyString(item?.item) || asNonEmptyString(item?.question_to_client);
        if (!label) return null;

        const normalizedLabel = normalizeChecklistText(label, "追加確認事項");
        const normalizedQuestion = normalizeChecklistText(
          asNonEmptyString(item?.question_to_client) || label,
          normalizedLabel,
        );
        const normalizedReason = normalizeChecklistReason(
          asNonEmptyString(item?.why_needed),
          normalizedLabel,
          normalizedQuestion,
        );

        return {
          priority: asNonEmptyString(item?.priority) || "medium",
          item: normalizedLabel,
          why_needed: normalizedReason,
          question_to_client: normalizedQuestion,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    summary: normalizeChecklistText(
      asNonEmptyString(root.summary) || "追加ヒアリング事項を整理しました",
      "追加ヒアリング事項を整理しました",
    ),
    meta: {
      needs_human_review: true,
      generated_at: new Date().toISOString(),
      server_version: "0.1.0",
      generation_mode: "openrouter_stage_chain",
      sources: [],
    },
  };
}

function normalizeDraftPayload(raw: unknown, args: DraftInitialReplyArgs, model: string, attemptedModels: string[]): ToolPayload {
  const template = buildDraftInitialReplyTemplate(args);
  const parsedDraft = JSON.stringify(asObject(raw) ?? {});
  return mergeAiDraftIntoTemplate(template, parsedDraft, model, attemptedModels);
}

function formatModelName(model: string) {
  return model.replace(":free", "").replace(/^.*\//, "");
}

function withOpenRouterMeta(payload: ToolPayload, model: string, attemptedModels: string[], generationMode: string): ToolPayload {
  return {
    ...payload,
    meta: {
      ...(asObject(payload.meta) ?? {}),
      generation_mode: generationMode,
      provider: "openrouter",
      model_used: model,
      attempted_models: attemptedModels,
    },
  };
}

function getIssueLabelsFromPayload(payload: ToolPayload): string[] {
  return Array.isArray(payload.issues)
    ? payload.issues
      .map((issue) => asNonEmptyString(asObject(issue)?.label))
      .filter((label): label is string => Boolean(label))
    : [];
}

function getLawTitlesFromPayload(payload: ToolPayload): string[] {
  return Array.isArray(payload.law_candidates)
    ? payload.law_candidates
      .map((candidate) => asNonEmptyString(asObject(candidate)?.law_title))
      .filter((title): title is string => Boolean(title))
    : [];
}

function getChecklistEntriesFromPayload(payload: ToolPayload): unknown[] {
  return Array.isArray(payload.checklist) ? payload.checklist : [];
}

function buildDraftArgsFromStageOutputs(
  args: FullCaseWorkflowArgs,
  issuesPayload: ToolPayload,
  lawPayload: ToolPayload,
  checklistPayload: ToolPayload,
): DraftInitialReplyArgs {
  return {
    case_id: args.case_id,
    client_name: args.client_name,
    issues: getIssueLabelsFromPayload(issuesPayload),
    law_candidates: getLawTitlesFromPayload(lawPayload),
    checklist: getChecklistEntriesFromPayload(checklistPayload),
    tone: args.tone,
    include_disclaimer: args.include_disclaimer,
  };
}

function createWorkflowSections(): WorkflowTrace["sections"] {
  return {
    issues: {
      title: "論点整理の詳細",
      description: "相談文から拾った論点候補と、判断を分ける未確定要素を確認できます。",
      sourceLabel: "解析待ち",
      stageKey: "issues",
      attempts: [],
    },
    lawCandidates: {
      title: "関連法令の詳細",
      description: "論点整理を踏まえて抽出した法令候補と、関連理由を確認できます。",
      sourceLabel: "解析待ち",
      stageKey: "lawCandidates",
      attempts: [],
    },
    checklist: {
      title: "確認事項の詳細",
      description: "案件を確定させるために必要な追加ヒアリング項目を確認できます。",
      sourceLabel: "解析待ち",
      stageKey: "checklist",
      attempts: [],
    },
    draftReply: {
      title: "返信文の詳細",
      description: "ここまでの解析結果を束ねて作った初回返信案を確認できます。",
      sourceLabel: "解析待ち",
      stageKey: "draftReply",
      attempts: [],
    },
  };
}

function setStageTimelineEntry(
  timeline: WorkflowStageTrace[],
  stageKey: WorkflowStageKey,
  patch: Partial<WorkflowStageTrace>,
) {
  const entry = timeline.find((item) => item.stageKey === stageKey);
  if (!entry) return;
  Object.assign(entry, patch);
}

function startStage(timeline: WorkflowStageTrace[], stageKey: WorkflowStageKey) {
  const stage = getWorkflowStagePresentation(stageKey);
  setStageTimelineEntry(timeline, stageKey, {
    status: "running",
    startedAt: new Date().toISOString(),
    headline: `${stage.label}を解析中`,
    summary: stage.description,
  });
}

function skipPendingStages(timeline: WorkflowStageTrace[], summary: string) {
  for (const entry of timeline) {
    if (entry.status === "pending") {
      entry.status = "skipped";
      entry.headline = "未実行";
      entry.summary = summary;
    }
  }
}

function buildSkippedSectionAttempt(stageKey: WorkflowStageKey, summary: string): WorkflowSectionAttemptTrace {
  const stage = getWorkflowStagePresentation(stageKey);
  return {
    attemptId: `${stageKey}-skipped`,
    model: "supplemental",
    status: "skipped",
    stageLabel: stage.label,
    label: `${stage.label} 補完`,
    headline: "補助ロジックで補完",
    summary,
  };
}

function inspectStageAttempt(
  stageKey: WorkflowStageKey,
  attempt: OpenRouterAttempt,
  context: FullCaseWorkflowArgs | DraftInitialReplyArgs,
) {
  if (!attempt.content) {
    return {
      headline: "応答を受信できませんでした",
      summary: attempt.error || "モデル応答の取得に失敗しました。",
      contentPreview: undefined,
      extracted: undefined,
    };
  }

  try {
    const parsed = parseJsonWithRecovery(attempt.content);

    if (stageKey === "issues") {
      const issuesPayload = normalizeIssuePayload(parsed, (context as FullCaseWorkflowArgs).request_text);
      const issues = Array.isArray(issuesPayload.issues) ? issuesPayload.issues : [];
      const hearingQuestions = toStringArray(issuesPayload.hearing_questions);

      return {
        headline: asNonEmptyString(asObject(issues[0])?.label) || "論点候補を抽出",
        summary: `論点 ${issues.length}件 / ヒアリング候補 ${hearingQuestions.length}件`,
        contentPreview: summarizeText(
          issues
            .map((issue) => asNonEmptyString(asObject(issue)?.reason))
            .filter((reason): reason is string => Boolean(reason))
            .join(" "),
          280,
        ) || summarizeText(attempt.content, 280),
        extracted: {
          issues,
        },
      };
    }

    if (stageKey === "lawCandidates") {
      const lawPayload = normalizeLawPayload(parsed);
      const laws = Array.isArray(lawPayload.law_candidates) ? lawPayload.law_candidates : [];
      const referenceCount = laws.reduce((count, entry) => {
        const refs = asObject(entry)?.references;
        return count + (Array.isArray(refs) ? refs.length : 0);
      }, 0);

      return {
        headline: asNonEmptyString(asObject(laws[0])?.law_title) || "関連法令候補を抽出",
        summary: `法令 ${laws.length}件 / 参照 ${referenceCount}件`,
        contentPreview: summarizeText(
          laws
            .map((law) => asNonEmptyString(asObject(law)?.why_relevant))
            .filter((reason): reason is string => Boolean(reason))
            .join(" "),
          280,
        ) || summarizeText(attempt.content, 280),
        extracted: {
          lawCandidates: laws,
        },
      };
    }

    if (stageKey === "checklist") {
      const checklistPayload = normalizeChecklistPayload(parsed);
      const checklist = Array.isArray(checklistPayload.checklist) ? checklistPayload.checklist : [];

      return {
        headline: asNonEmptyString(asObject(checklist[0])?.item) || "確認事項を整理",
        summary: `確認事項 ${checklist.length}件`,
        contentPreview: summarizeText(
          checklist
            .map((item) => asNonEmptyString(asObject(item)?.why_needed) || asNonEmptyString(asObject(item)?.question_to_client))
            .filter((value): value is string => Boolean(value))
            .join(" "),
          280,
        ) || summarizeText(attempt.content, 280),
        extracted: {
          checklist,
        },
      };
    }

    const draftPayload = normalizeDraftPayload(parsed, context as DraftInitialReplyArgs, attempt.model, [attempt.model]);
    const draft = asObject(draftPayload) ?? {};

    return {
      headline: asNonEmptyString(draft.subject) || "返信案を生成",
      summary: `レビュー注意 ${toStringArray(draft.review_notes).length}件 / 免責 ${toStringArray(draft.disclaimer_flags).length}件`,
      contentPreview: summarizeText(asNonEmptyString(draft.body) || attempt.content, 280),
      extracted: {
        draftReply: draftPayload,
      },
    };
  } catch {
    return {
      headline: "レスポンスを受信",
      summary: "構造化には失敗しましたが、本文は取得できています。",
      contentPreview: summarizeText(attempt.content, 280),
      extracted: undefined,
    };
  }
}

function recordStageAttempt(
  timeline: WorkflowStageTrace[],
  sections: WorkflowTrace["sections"],
  stageKey: WorkflowStageKey,
  attempt: OpenRouterAttempt,
  isPrimaryModel: boolean,
  willRetry: boolean,
  context: FullCaseWorkflowArgs | DraftInitialReplyArgs,
) {
  const stage = getWorkflowStagePresentation(stageKey);
  const section = sections[stageKey];
  const insight = inspectStageAttempt(stageKey, attempt, context);
  const attemptIndex = section.attempts.length + 1;

  section.attempts.push({
    attemptId: `${stageKey}-${attemptIndex}-${attempt.model.replace(/[^a-zA-Z0-9]+/g, "-")}`,
    model: attempt.model,
    status: attempt.status,
    stageLabel: stage.label,
    label: `${stage.label} ${attemptIndex}`,
    headline: attempt.status === "success" ? insight.headline : "応答エラー",
    summary: attempt.status === "success" ? insight.summary : (attempt.error || "モデル応答の取得に失敗しました。"),
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    contentPreview: attempt.status === "success" ? insight.contentPreview : undefined,
    errorMessage: attempt.status === "error" ? attempt.error : undefined,
    isFallback: !isPrimaryModel,
    extracted: attempt.status === "success" ? insight.extracted : undefined,
  });

  if (attempt.status === "success") {
    setStageTimelineEntry(timeline, stageKey, {
      status: "success",
      headline: insight.headline,
      summary: insight.summary,
      startedAt: timeline.find((item) => item.stageKey === stageKey)?.startedAt || attempt.startedAt,
      completedAt: attempt.completedAt,
      model: attempt.model,
      fallbackUsed: !isPrimaryModel,
      usedInFinal: true,
    });

    section.sourceLabel = !isPrimaryModel
      ? `予備モデル (${formatModelName(attempt.model)})`
      : `${formatModelName(attempt.model)}`;
    section.sourceSlotId = stageKey;
    section.finalModel = attempt.model;
    section.fallbackUsed = !isPrimaryModel;
    section.attempts = section.attempts.map((entry) => ({
      ...entry,
      usedInFinal: entry.attemptId === `${stageKey}-${attemptIndex}-${attempt.model.replace(/[^a-zA-Z0-9]+/g, "-")}`,
    }));
    return;
  }

  setStageTimelineEntry(timeline, stageKey, {
    status: willRetry ? "running" : "error",
    headline: willRetry ? `${stage.label}を再試行中` : "応答エラー",
    summary: willRetry
      ? `${formatModelName(attempt.model)} で不安定だったため、予備モデルへ切り替えます。`
      : (attempt.error || `${stage.label}の生成に失敗しました。`),
    completedAt: attempt.completedAt,
  });
}

function buildWorkflowTrace(
  timeline: WorkflowStageTrace[],
  sections: WorkflowTrace["sections"],
  workflowMode: string,
  llmError: string | null,
) : WorkflowTrace {
  const deterministicExplanation = llmError
    ? `LLM 応答を最後まで採用できなかったため、補助ロジックで補完しました。理由: ${llmError}`
    : "補助ロジックで補完しました。";

  const normalizeSection = (sectionKey: WorkflowSectionKey) => {
    const section = sections[sectionKey];
    if (workflowMode === "openrouter_stage_chain" || section.attempts.length > 0) {
      return {
        ...section,
        attempts: section.attempts.map((attempt) => ({ ...attempt })),
      };
    }

    return {
      ...section,
      sourceLabel: "補助ロジック",
      description: deterministicExplanation,
      attempts: [buildSkippedSectionAttempt(section.stageKey, deterministicExplanation)],
    };
  };

  return {
    timeline: timeline.map((entry) => ({ ...entry })),
    sections: {
      issues: normalizeSection("issues"),
      lawCandidates: normalizeSection("lawCandidates"),
      checklist: normalizeSection("checklist"),
      draftReply: normalizeSection("draftReply"),
    },
  };
}

function buildIssuesAnalysisPrompt(args: FullCaseWorkflowArgs) {
  return [
    {
      role: "system" as const,
      content:
        "You are a careful Japanese legal-intake triage assistant. Return JSON only. Extract issues and missing facts from the consultation memo. Do not give final legal conclusions.",
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          task: "Extract legal-intake issues from a Japanese consultation memo",
          case_id: args.case_id,
          client_name: args.client_name ?? null,
          request_text: args.request_text,
          domain_hint: args.domain_hint ?? "auto",
          jurisdiction: args.jurisdiction ?? null,
          output_language: args.output_language,
          output_contract: {
            issues: [
              {
                issue_code: "optional_string",
                label: "string",
                confidence: 0.0,
                reason: "string",
              },
            ],
            missing_facts: ["string"],
            hearing_questions: ["string"],
            warnings: ["string"],
          },
        },
        null,
        2,
      ),
    },
  ];
}

function buildLawAnalysisPrompt(
  args: FullCaseWorkflowArgs,
  issuesPayload: ToolPayload,
) {
  return [
    {
      role: "system" as const,
      content:
        "You are a careful Japanese legal-intake triage assistant. Return JSON only. Select plausible law candidates based on the supplied issues and consultation text. Keep citations cautious.",
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          task: "Identify relevant Japanese laws for the extracted issues",
          case_id: args.case_id,
          request_text: args.request_text,
          extracted_issues: issuesPayload,
          known_law_catalog: LAW_SOURCE_CATALOG.map((entry) => ({
            title: entry.title,
            provider: entry.provider,
            source_url: asNonEmptyString((entry as Record<string, unknown>).source_url),
          })),
          output_contract: {
            law_candidates: [
              {
                law_title: "string",
                relevance_score: 0.0,
                why_relevant: "string",
                references: [
                  {
                    citation: "string",
                    summary: "string",
                  },
                ],
              },
            ],
            warnings: ["string"],
          },
        },
        null,
        2,
      ),
    },
  ];
}

function buildChecklistAnalysisPrompt(
  args: FullCaseWorkflowArgs,
  issuesPayload: ToolPayload,
  lawPayload: ToolPayload,
) {
  return [
    {
      role: "system" as const,
      content:
        "あなたは日本の法律相談の一次受付を補助するアシスタントだ。出力は JSON のみで返すこと。checklist の item, why_needed, question_to_client, および summary は必ず自然な日本語で書き、英語を混ぜないこと。安全に次の判断へ進むための不足情報を、日本語の確認事項として簡潔に整理すること。",
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          task: "法律相談の一次受付に必要な確認事項を日本語で作成する",
          case_id: args.case_id,
          request_text: args.request_text,
          extracted_issues: issuesPayload,
          related_laws: lawPayload,
          language_requirements: {
            checklist: "item, why_needed, question_to_client は日本語",
            summary: "日本語",
          },
          output_contract: {
            checklist: [
              {
                priority: "high|medium|low",
                item: "日本語の確認項目",
                why_needed: "日本語の理由",
                question_to_client: "日本語の顧客向け質問",
              },
            ],
            summary: "日本語の要約",
          },
        },
        null,
        2,
      ),
    },
  ];
}

async function generateIssuesAnalysis(
  args: FullCaseWorkflowArgs,
  hooks?: { onAttempt?: (attempt: OpenRouterAttempt) => void },
) {
  const completion = await createOpenRouterChatCompletion(
    buildIssuesAnalysisPrompt(args),
    { maxTokens: 900, temperature: 0.2, onAttempt: hooks?.onAttempt },
  );

  return {
    payload: withOpenRouterMeta(
      normalizeIssuePayload(parseJsonWithRecovery(completion.content), args.request_text),
      completion.model,
      completion.attemptedModels,
      "openrouter_stage_chain",
    ),
    completion,
  };
}

async function generateLawCandidatesAnalysis(
  args: FullCaseWorkflowArgs,
  issuesPayload: ToolPayload,
  hooks?: { onAttempt?: (attempt: OpenRouterAttempt) => void },
) {
  const completion = await createOpenRouterChatCompletion(
    buildLawAnalysisPrompt(args, issuesPayload),
    { maxTokens: 1100, temperature: 0.2, onAttempt: hooks?.onAttempt },
  );

  return {
    payload: withOpenRouterMeta(
      normalizeLawPayload(parseJsonWithRecovery(completion.content)),
      completion.model,
      completion.attemptedModels,
      "openrouter_stage_chain",
    ),
    completion,
  };
}

async function generateChecklistAnalysis(
  args: FullCaseWorkflowArgs,
  issuesPayload: ToolPayload,
  lawPayload: ToolPayload,
  hooks?: { onAttempt?: (attempt: OpenRouterAttempt) => void },
) {
  const completion = await createOpenRouterChatCompletion(
    buildChecklistAnalysisPrompt(args, issuesPayload, lawPayload),
    { maxTokens: 1000, temperature: 0.2, onAttempt: hooks?.onAttempt },
  );

  return {
    payload: withOpenRouterMeta(
      normalizeChecklistPayload(parseJsonWithRecovery(completion.content)),
      completion.model,
      completion.attemptedModels,
      "openrouter_stage_chain",
    ),
    completion,
  };
}

async function generateDraftReplyStage(
  args: DraftInitialReplyArgs,
  hooks?: { onAttempt?: (attempt: OpenRouterAttempt) => void },
) {
  const completion = await createOpenRouterChatCompletion(
    buildDraftInitialReplyPrompt(args),
    { maxTokens: 900, temperature: 0.2, onAttempt: hooks?.onAttempt },
  );

  return {
    payload: withOpenRouterMeta(
      normalizeDraftPayload(
        parseJsonWithRecovery(completion.content),
        args,
        completion.model,
        completion.attemptedModels,
      ),
      completion.model,
      completion.attemptedModels,
      "openrouter_stage_chain",
    ),
    completion,
  };
}

async function generateDraftInitialReplyPayload(
  args: DraftInitialReplyArgs,
  hooks?: {
    onAttempt?: (attempt: OpenRouterAttempt) => void;
  },
) {
  const templateDraft = buildDraftInitialReplyTemplate(args);
  const openRouterConfig = getOpenRouterConfig();

  if (!openRouterConfig.apiKey) {
    return {
      ...templateDraft,
      meta: {
        ...templateDraft.meta,
        generation_mode: "template_fallback",
        provider: "openrouter",
        attempted_models: openRouterConfig.models,
        reason: "OPENROUTER_API_KEY is not configured",
      },
    };
  }

  try {
    const completion = await createOpenRouterChatCompletion(
      buildDraftInitialReplyPrompt(args),
      { maxTokens: 900, temperature: 0.2, onAttempt: hooks?.onAttempt },
    );

    return mergeAiDraftIntoTemplate(
      templateDraft,
      completion.content,
      completion.model,
      completion.attemptedModels,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logServerError("draft_initial_client_reply.openrouter", error, {
      case_id: args.case_id,
      client_name: args.client_name,
      issues: args.issues,
      law_candidates: args.law_candidates,
      timeout_like: isTimeoutLikeError(error),
      fallback_mode: "template_fallback",
    });

    return {
      ...templateDraft,
      meta: {
        ...templateDraft.meta,
        generation_mode: "template_fallback",
        provider: "openrouter",
        attempted_models: openRouterConfig.models,
        ai_error: message,
      },
    };
  }
}

async function runDeterministicWorkflow(
  client: Client,
  args: FullCaseWorkflowArgs,
  options?: {
    allowLlmDraft?: boolean;
    onDraftAttempt?: (attempt: OpenRouterAttempt) => void;
  },
) {
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

  const draftArgs = {
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
  } satisfies DraftInitialReplyArgs;

  const templateDraft = buildDraftInitialReplyTemplate(draftArgs);
  const draftReplyResult = options?.allowLlmDraft === false
    ? {
      ...templateDraft,
      meta: {
        ...templateDraft.meta,
        generation_mode: "template_fallback",
        provider: "supplemental",
        reason: "deterministic_workflow_requested",
      },
    }
    : generateDraftInitialReplyPayload(
      draftArgs,
      {
        onAttempt: options?.onDraftAttempt,
      },
    );

  return {
    case_id: args.case_id,
    outputs: {
      issues: issuesResult,
      related_laws: lawSearchResult,
      article_trace: articleTraceResult,
      missing_information: missingInfoResult,
      draft_reply: await draftReplyResult,
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
      const workflow = await executeCaseWorkflow(args);
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
      const draftReply = await generateDraftInitialReplyPayload(args);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(draftReply, null, 2)
        }]
      };
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

async function executeCaseWorkflow(
  args: FullCaseWorkflowArgs,
  hooks?: WorkflowExecutionHooks,
): Promise<ToolPayload> {
  const openRouterConfig = getOpenRouterConfig();
  const primaryModel = openRouterConfig.primaryModel;
  let timeline = createStageTimeline();
  const sections = createWorkflowSections();

  const emitProgress = (message: string, type: WorkflowProgressEvent["type"] = "progress", workflow?: ToolPayload, error?: string) => {
    const trace = buildWorkflowTrace(
      timeline,
      sections,
      type === "complete" ? (asNonEmptyString(asObject(asObject(workflow)?.workflow_summary)?.analysis_mode) || "openrouter_stage_chain") : "openrouter_stage_chain",
      type === "complete" ? (asNonEmptyString(asObject(asObject(workflow)?.workflow_summary)?.llm_error) || null) : null,
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

  const workflow = await withInternalMcpClient(async (client) => {
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
                ? `1/4 論点整理を受信しました。`
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

        const lawCandidates = Array.isArray(lawResult.payload.law_candidates)
          ? lawResult.payload.law_candidates
          : [];
        const firstLaw = lawCandidates.find((candidate) => {
          const record = asObject(candidate);
          return Boolean(asNonEmptyString(record?.law_title));
        });
        const firstLawTitle = asNonEmptyString(asObject(firstLaw)?.law_title)
          || "風俗営業等の規制及び業務の適正化等に関する法律";

        const articleTraceResult = parseToolPayload(await client.callTool({
          name: "trace_articles_and_references",
          arguments: {
            case_id: args.case_id,
            law_id: firstLawTitle,
            entry_points: ["第2条", "第33条"],
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
        skipPendingStages(timeline, "LLM 連鎖を最後まで完走できなかったため、補助ロジックへ切り替えました。");
        emitProgress("主解析が途切れたため、補助ロジックへ切り替えています。");

        workflowBase = await runDeterministicWorkflow(client, args, {
          allowLlmDraft: false,
        });
      }
    } else {
      llmError = "OPENROUTER_API_KEY is not configured";
      logServerWarn("run_full_case_workflow.llm_analysis_skipped", {
        case_id: args.case_id,
        reason: llmError,
      });
      skipPendingStages(timeline, "API キー未設定のため、補助ロジックで補完しました。");
      emitProgress("API キー未設定のため、補助ロジックのみで解析します。");

      workflowBase = await runDeterministicWorkflow(client, args, {
        allowLlmDraft: false,
      });
    }

    const workflow = {
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
      analysis_trace: buildWorkflowTrace(
        timeline,
        sections,
        workflowMode,
        llmError,
      ),
    };

    return workflow;
  });

  emitProgress("解析が完了しました。", "complete", workflow);

  logServerInfo("run_full_case_workflow.success", {
    case_id: args.case_id,
    client_name: args.client_name,
    analysis_mode: asObject(workflow.workflow_summary)?.analysis_mode,
    workflow,
  });

  return workflow;
}

function buildDashboardChatPrompt(args: DashboardChatArgs): OpenRouterChatMessage[] {
  const issues = args.case_data.issues.slice(0, 6).map((issue) => ({
    label: issue.label,
    reason: issue.reason,
  }));
  const lawCandidates = args.case_data.lawCandidates.slice(0, 6).map((law) => ({
    law_title: law.law_title,
    why_relevant: law.why_relevant,
  }));
  const checklist = args.case_data.checklist.slice(0, 8).map((item) => ({
    item: item.question_to_client || item.item,
    why_needed: item.why_needed,
  }));
  const history = args.history.slice(-8).map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const draftReply = args.case_data.draftReply
    ? {
      subject: args.case_data.draftReply.subject,
      body_preview: summarizeText(args.case_data.draftReply.body, 500),
      review_notes: (args.case_data.draftReply.review_notes ?? []).slice(0, 4),
    }
    : undefined;

  return [
    {
      role: "system",
      content:
        "あなたは日本の法律相談一次受付を補助するチャット担当だ。返答は必ず自然な日本語のみで、英語を混ぜないこと。提示された解析結果と会話履歴に基づいて実務的に答えること。法的結論を断定せず、必要に応じて追加確認や人間レビューを促すこと。新事実で現状整理が大きく変わりそうなら、その旨を短く指摘してよい。出力はプレーンテキスト本文のみ。",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "解析済み案件に対する追加入力チャットへ日本語で回答する",
          client_name: args.client_name ?? null,
          consultation_text: args.consultation_text,
          current_analysis: {
            issues,
            law_candidates: lawCandidates,
            checklist,
            draft_reply: draftReply,
          },
          prior_chat_history: history,
          selected_checklist_entries: args.selected_checklist_entries,
          latest_user_message: args.user_message,
          output_contract: {
            reply: "日本語のチャット返答本文",
          },
        },
        null,
        2,
      ),
    },
  ];
}

function buildDashboardChatFallbackReply(args: DashboardChatArgs): string {
  const firstIssue = args.case_data.issues[0]?.label || "許認可の要否";
  const firstLaw = args.case_data.lawCandidates[0]?.law_title;
  const remainingChecklist = args.case_data.checklist
    .map((item) => item.question_to_client || item.item)
    .filter((item): item is string => Boolean(item))
    .slice(0, 2);
  const selectedAnswers = args.selected_checklist_entries
    .map((entry) => `${entry.label}: ${entry.answer}`)
    .join("\n");
  const lines: string[] = [];

  if (selectedAnswers) {
    lines.push("追加回答は受け取っています。");
    lines.push(selectedAnswers);
  }

  lines.push(`現時点では、${firstIssue} を軸に整理を進めるのが妥当です。`);

  if (firstLaw) {
    lines.push(`参考候補としては ${firstLaw} の確認が先です。`);
  }

  if (remainingChecklist.length > 0) {
    lines.push(`未確認事項は ${remainingChecklist.join("、")} です。ここが埋まると判断しやすくなります。`);
  }

  lines.push("この返答は一次整理ベースなので、顧客送信前に人間レビューを入れてください。");

  return lines.join("\n\n");
}

async function generateDashboardChatReply(args: DashboardChatArgs) {
  const openRouterConfig = getOpenRouterConfig();

  if (!openRouterConfig.apiKey) {
    return {
      reply: buildDashboardChatFallbackReply(args),
      model: "supplemental",
      attempted_models: openRouterConfig.models,
      generation_mode: "fallback",
    };
  }

  try {
    const completion = await createOpenRouterChatCompletion(
      buildDashboardChatPrompt(args),
      {
        maxTokens: 700,
        temperature: 0.3,
      },
    );

    return {
      reply: completion.content.trim(),
      model: completion.model,
      attempted_models: completion.attemptedModels,
      generation_mode: "openrouter",
    };
  } catch (error) {
    logServerWarn("dashboard_chat.fallback", {
      client_name: args.client_name,
      consultation_text: truncateForLog(args.consultation_text, 300),
      user_message: truncateForLog(args.user_message, 300),
      error: error instanceof Error ? error.message : String(error),
      timeout_like: isTimeoutLikeError(error),
    });

    return {
      reply: buildDashboardChatFallbackReply(args),
      model: "supplemental",
      attempted_models: openRouterConfig.models,
      generation_mode: "fallback_after_error",
      ai_error: error instanceof Error ? error.message : String(error),
    };
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

async function startServer() {
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
      logServerError("api.analyze_stream", error, {
        body: truncateForLog(req.body),
        timeout_like: isTimeoutLikeError(error),
      });

      if (!res.writableEnded) {
        writeJsonLine(res, {
          type: "error",
          message: "解析ストリームの実行中にエラーが発生しました。",
          timeline: [],
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

  server.on("error", (error) => {
    logServerError("server.listen", error, { port });
  });

  if (port !== startingPort) {
    console.log(`Port ${startingPort} is in use. Falling back to http://localhost:${port}`);
  }

  console.log(`Server running on http://localhost:${port}`);
}

process.on("unhandledRejection", (reason) => {
  logServerError("process.unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  logServerError("process.uncaughtException", error);
});

startServer();
