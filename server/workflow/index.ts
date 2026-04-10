import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type OpenRouterAttempt,
  type OpenRouterChatMessage,
  createOpenRouterChatCompletion,
  getOpenRouterConfig,
} from "../../src/lib/ai/openrouter.ts";
import type {
  DashboardChatArgs,
  DraftInitialReplyArgs,
  FullCaseWorkflowArgs,
  OpenRouterAttemptHook,
  ToolPayload,
  WorkflowSectionAttemptTrace,
  WorkflowSectionKey,
  WorkflowStageKey,
  WorkflowStageTrace,
  WorkflowTrace,
} from "../types.ts";
import {
  asNonEmptyString,
  asObject,
  clampUnitInterval,
  isTimeoutLikeError,
  parseJsonWithRecovery,
  summarizeText,
  toStringArray,
  truncateForLog,
} from "../utils.ts";

export const FUEI_LAW_SOURCE = {
  provider: "e-Gov 法令検索",
  title: "風俗営業等の規制及び業務の適正化等に関する法律",
  law_id: "323AC0000000122",
  law_number: "昭和二十三年法律第百二十二号",
  version_id: "20251128_507AC0000000045",
  version_date: "2025-11-28",
  source_url: "https://laws.e-gov.go.jp/law/323AC0000000122/20251128_507AC0000000045",
} as const;

export const FOOD_SANITATION_LAW_SOURCE = {
  provider: "e-Gov 法令検索",
  title: "食品衛生法",
  law_id: "322AC0000000233",
  law_number: "昭和二十二年法律第二百三十三号",
  version_id: "20250601_504AC0000000068",
  version_date: "2025-06-01",
  source_url: "https://laws.e-gov.go.jp/law/322AC0000000233/20250601_504AC0000000068",
} as const;

export const CONSTRUCTION_BUSINESS_LAW_SOURCE = {
  provider: "e-Gov 法令検索",
  title: "建設業法",
  law_id: "324AC0000000100",
  law_number: "昭和二十四年法律第百号",
  source_url: "https://laws.e-gov.go.jp/law/324AC0000000100",
} as const;

export const BUILDING_STANDARDS_LAW_SOURCE = {
  provider: "e-Gov 法令検索",
  title: "建築基準法",
  law_id: "325AC0000000201",
  law_number: "昭和二十五年法律第二百一号",
  source_url: "https://laws.e-gov.go.jp/law/325AC0000000201",
} as const;

export const IMMIGRATION_CONTROL_LAW_SOURCE = {
  provider: "e-Gov 法令検索",
  title: "出入国管理及び難民認定法",
  law_id: "326CO0000000319",
  law_number: "昭和二十六年政令第三百十九号",
  source_url: "https://laws.e-gov.go.jp/law/326CO0000000319",
} as const;

export const LABOR_STANDARDS_LAW_SOURCE = {
  provider: "e-Gov 法令検索",
  title: "労働基準法",
  law_id: "322AC0000000049",
  law_number: "昭和二十二年法律第四十九号",
  source_url: "https://laws.e-gov.go.jp/law/322AC0000000049",
} as const;

export const WASTE_MANAGEMENT_LAW_SOURCE = {
  provider: "e-Gov 法令検索",
  title: "廃棄物の処理及び清掃に関する法律",
  law_id: "345AC0000000137",
  law_number: "昭和四十五年法律第百三十七号",
  source_url: "https://laws.e-gov.go.jp/law/345AC0000000137",
} as const;

export type ResolvedDomain = "construction" | "kobutsu" | "fuei" | "immigration" | "waste" | "corporate" | "general";

const LAW_SOURCE_CATALOG = [
  FUEI_LAW_SOURCE,
  FOOD_SANITATION_LAW_SOURCE,
  CONSTRUCTION_BUSINESS_LAW_SOURCE,
  BUILDING_STANDARDS_LAW_SOURCE,
  IMMIGRATION_CONTROL_LAW_SOURCE,
  LABOR_STANDARDS_LAW_SOURCE,
  WASTE_MANAGEMENT_LAW_SOURCE,
] as const;

const WORKFLOW_STAGE_ORDER: WorkflowStageKey[] = ["issues", "lawCandidates", "checklist", "draftReply"];

const JAPANESE_TEXT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function normalizeLawTitle(title: string): string {
  return title.replace(/\s+/g, "");
}

export function resolveConsultationDomain(
  requestText: string,
  domainHint?: FullCaseWorkflowArgs["domain_hint"],
  supplementalTexts: string[] = [],
): ResolvedDomain {
  if (domainHint && domainHint !== "auto") {
    return domainHint;
  }

  const combined = [requestText, ...supplementalTexts].join("\n");

  if (/(工務店|建設業|建築工事|内装工事|リフォーム|大工|施工|請負|元請|下請|主任技術者|実務経験|法人成り)/.test(combined)) {
    return "construction";
  }
  if (/(古物|中古品|リユース|買取|転売|オークション|古物商)/.test(combined)) {
    return "kobutsu";
  }
  if (/(バー|スナック|ラウンジ|接待|深夜営業|酒類|カラオケ|飲食店)/.test(combined)) {
    return "fuei";
  }
  if (/(在留資格|ビザ|入管|外国人採用|就労資格|留学生|特定技能|技術・人文知識・国際業務)/.test(combined)) {
    return "immigration";
  }
  if (/(産業廃棄物|一般廃棄物|収集運搬|廃棄物|処分業)/.test(combined)) {
    return "waste";
  }
  if (/(会社設立|定款|株式|取締役|合同会社|株式会社|法人化)/.test(combined)) {
    return "corporate";
  }

  return "general";
}

export function getArticleTracePlan(lawTitle?: string, domainHint?: FullCaseWorkflowArgs["domain_hint"], requestText?: string) {
  const normalizedTitle = normalizeLawTitle(lawTitle || "");
  const resolvedDomain = resolveConsultationDomain(requestText || "", domainHint, lawTitle ? [lawTitle] : []);

  if (normalizedTitle === normalizeLawTitle(FUEI_LAW_SOURCE.title) || resolvedDomain === "fuei") {
    return {
      lawTitle: FUEI_LAW_SOURCE.title,
      entryPoints: ["第2条", "第33条"],
    };
  }

  if (normalizedTitle === normalizeLawTitle(FOOD_SANITATION_LAW_SOURCE.title)) {
    return {
      lawTitle: FOOD_SANITATION_LAW_SOURCE.title,
      entryPoints: ["第54条", "第55条"],
    };
  }

  if (normalizedTitle === normalizeLawTitle("建設業法") || resolvedDomain === "construction") {
    return {
      lawTitle: "建設業法",
      entryPoints: [],
    };
  }

  if (normalizedTitle === normalizeLawTitle("出入国管理及び難民認定法") || resolvedDomain === "immigration") {
    return {
      lawTitle: "出入国管理及び難民認定法",
      entryPoints: [],
    };
  }

  if (normalizedTitle === normalizeLawTitle("廃棄物の処理及び清掃に関する法律") || resolvedDomain === "waste") {
    return {
      lawTitle: "廃棄物の処理及び清掃に関する法律",
      entryPoints: [],
    };
  }

  return {
    lawTitle: lawTitle || "関連法令",
    entryPoints: [],
  };
}

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

const CHECKLIST_TEXT_TRANSLATIONS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /exact location and zoning|use district|zoning district/, replacement: "正確な所在地と用途地域" },
  { pattern: /floor plan|layout|seating layout/, replacement: "店舗レイアウトや客席配置" },
  { pattern: /business hours?|operating hours?|late-night operations?/, replacement: "営業時間や深夜営業の予定" },
  { pattern: /alcohol|liquor service/, replacement: "酒類提供の有無や提供方法" },
  { pattern: /staff|employee.*customer|hospitality service|entertainment service/, replacement: "従業員の接客方法や営業実態" },
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

function getWorkflowStagePresentation(stageKey: WorkflowStageKey) {
  switch (stageKey) {
    case "issues":
      return { label: "論点整理", description: "相談文から主要論点と未確定要素を洗い出します。" };
    case "lawCandidates":
      return { label: "関連法令", description: "論点整理の結果を踏まえて、関連しそうな法令候補を絞り込みます。" };
    case "checklist":
      return { label: "確認事項", description: "判断を分ける不足情報を、顧客への確認項目に変換します。" };
    case "draftReply":
      return { label: "返信文", description: "ここまでの整理結果をもとに、初回返信案を組み立てます。" };
  }
}

function normalizeReviewNote(note: string): string {
  const normalized = note.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (JAPANESE_TEXT_PATTERN.test(normalized)) return normalized;

  const matched = REVIEW_NOTE_TRANSLATIONS.find((entry) => entry.pattern.test(normalized.toLowerCase()));
  return matched?.replacement || "記載内容を日本語で見直し、人間レビュー後に送付すること";
}

function normalizeReviewNotes(value: unknown, fallback: string[] = []): string[] {
  const notes = toStringArray(value, fallback)
    .map((note) => normalizeReviewNote(note))
    .filter(Boolean);

  return notes.length > 0 ? Array.from(new Set(notes)) : fallback;
}

function normalizeChecklistText(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  if (JAPANESE_TEXT_PATTERN.test(normalized)) return normalized;

  const matched = CHECKLIST_TEXT_TRANSLATIONS.find((entry) => entry.pattern.test(normalized.toLowerCase()));
  return matched?.replacement || fallback;
}

function normalizeChecklistReason(text: string | undefined, label: string, question: string): string | undefined {
  if (!text) return undefined;

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (JAPANESE_TEXT_PATTERN.test(normalized)) return normalized;

  const lower = normalized.toLowerCase();
  const matched = CHECKLIST_REASON_TRANSLATIONS.find((entry) => entry.pattern.test(lower));
  if (matched) return matched.replacement;
  if (/用途地域|所在地/.test(label) || /用途地域|所在地/.test(question)) return "用途地域や所在地によって営業可否や必要手続が変わるため";
  if (/酒類|お酒|ボトル/.test(label) || /酒類|お酒|ボトル/.test(question)) return "酒類提供や販売方法によって必要な許可や届出が変わるため";
  if (/ゲーム|ダーツ|遊技/.test(label) || /ゲーム|ダーツ|遊技/.test(question)) return "ゲーム設備の内容によって必要な手続や規制の有無が変わるため";
  if (/接客|従業員|客/.test(label) || /接客|従業員|客/.test(question)) return "接客方法や営業実態によって風営法上の評価が変わるため";
  return "許認可の要否や必要手続の判断に必要な確認事項です";
}

function stringifyChecklistItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item);

  for (const key of ["item", "question_to_client", "label", "why_needed", "priority"]) {
    const value = (item as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
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
    review_notes: ["自治体・所轄運用の確認前に断定しないこと", "人間レビュー前提で送付すること"],
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
        "あなたは法律相談の一次受付向けに、安全な日本語の返信案を作る。出力は JSON のみで、キーは subject, body, disclaimer_flags, review_notes に限定すること。subject と body と review_notes は必ず自然な日本語で書き、英語の文や英語の箇条書きを混ぜないこと。disclaimer_flags のみ英字スネークケースの識別子でよい。review_notes は担当者向けの内部レビュー注意として、日本語の短い文を 2 件以上返すこと。法的結論や自治体運用を断定してはならない。与えられた issues・law_candidates・checklist にない論点を新たに足してはならない。",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
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
      }, null, 2),
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

function resolveLawSource(candidate: Record<string, unknown>): Record<string, unknown> | undefined {
  const explicitSource = asObject(candidate.source);
  const explicitTitle = asNonEmptyString(candidate.law_title) || asNonEmptyString(explicitSource?.title);
  const matchedCatalog = explicitTitle
    ? LAW_SOURCE_CATALOG.find((entry) => normalizeLawTitle(entry.title) === normalizeLawTitle(explicitTitle))
    : undefined;

  if (!explicitSource && !matchedCatalog) return undefined;

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
    warnings: toStringArray(root.warnings, ["法的結論の断定は避け、人間レビュー前提で扱ってください"]),
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
              checked_on: asNonEmptyString((source as Record<string, unknown>).checked_on) || new Date().toISOString().split("T")[0],
            }
            : undefined,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    related_rules: Array.isArray(root.related_rules) ? root.related_rules : [],
    warnings: toStringArray(root.warnings, ["候補法令は初期整理用です。条文・運用確認を別途行ってください"]),
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
        const normalizedQuestion = normalizeChecklistText(asNonEmptyString(item?.question_to_client) || label, normalizedLabel);
        const normalizedReason = normalizeChecklistReason(asNonEmptyString(item?.why_needed), normalizedLabel, normalizedQuestion);

        return {
          priority: asNonEmptyString(item?.priority) || "medium",
          item: normalizedLabel,
          why_needed: normalizedReason,
          question_to_client: normalizedQuestion,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    summary: normalizeChecklistText(asNonEmptyString(root.summary) || "追加ヒアリング事項を整理しました", "追加ヒアリング事項を整理しました"),
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
  return mergeAiDraftIntoTemplate(template, JSON.stringify(asObject(raw) ?? {}), model, attemptedModels);
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

export function buildDraftArgsFromStageOutputs(
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

export function createStageTimeline(): WorkflowStageTrace[] {
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

export function createWorkflowSections(): WorkflowTrace["sections"] {
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

function setStageTimelineEntry(timeline: WorkflowStageTrace[], stageKey: WorkflowStageKey, patch: Partial<WorkflowStageTrace>) {
  const entry = timeline.find((item) => item.stageKey === stageKey);
  if (entry) Object.assign(entry, patch);
}

export function startStage(timeline: WorkflowStageTrace[], stageKey: WorkflowStageKey) {
  const stage = getWorkflowStagePresentation(stageKey);
  setStageTimelineEntry(timeline, stageKey, {
    status: "running",
    startedAt: new Date().toISOString(),
    headline: `${stage.label}を解析中`,
    summary: stage.description,
  });
}

export function skipPendingStages(timeline: WorkflowStageTrace[], summary: string) {
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

function inspectStageAttempt(stageKey: WorkflowStageKey, attempt: OpenRouterAttempt, context: FullCaseWorkflowArgs | DraftInitialReplyArgs) {
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
        extracted: { issues },
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
        extracted: { lawCandidates: laws },
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
        extracted: { checklist },
      };
    }

    const draftPayload = normalizeDraftPayload(parsed, context as DraftInitialReplyArgs, attempt.model, [attempt.model]);
    const draft = asObject(draftPayload) ?? {};

    return {
      headline: asNonEmptyString(draft.subject) || "返信案を生成",
      summary: `レビュー注意 ${toStringArray(draft.review_notes).length}件 / 免責 ${toStringArray(draft.disclaimer_flags).length}件`,
      contentPreview: summarizeText(asNonEmptyString(draft.body) || attempt.content, 280),
      extracted: { draftReply: draftPayload },
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

export function recordStageAttempt(
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
  const attemptId = `${stageKey}-${section.attempts.length + 1}-${attempt.model.replace(/[^a-zA-Z0-9]+/g, "-")}`;

  section.attempts.push({
    attemptId,
    model: attempt.model,
    status: attempt.status,
    stageLabel: stage.label,
    label: `${stage.label} ${section.attempts.length + 1}`,
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

    section.sourceLabel = !isPrimaryModel ? `予備モデル (${formatModelName(attempt.model)})` : formatModelName(attempt.model);
    section.sourceSlotId = stageKey;
    section.finalModel = attempt.model;
    section.fallbackUsed = !isPrimaryModel;
    section.attempts = section.attempts.map((entry) => ({ ...entry, usedInFinal: entry.attemptId === attemptId }));
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

export function buildWorkflowTrace(
  timeline: WorkflowStageTrace[],
  sections: WorkflowTrace["sections"],
  workflowMode: string,
  llmError: string | null,
): WorkflowTrace {
  const deterministicExplanation = llmError
    ? `LLM 応答を最後まで採用できなかったため、補助ロジックで補完しました。理由: ${llmError}`
    : "補助ロジックで補完しました。";

  const normalizeSection = (sectionKey: WorkflowSectionKey) => {
    const section = sections[sectionKey];
    if (workflowMode === "openrouter_stage_chain" || section.attempts.length > 0) {
      return { ...section, attempts: section.attempts.map((attempt) => ({ ...attempt })) };
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
  const resolvedDomain = resolveConsultationDomain(args.request_text, args.domain_hint);

  return [
    {
      role: "system" as const,
      content: "You are a careful Japanese legal-intake triage assistant. Return JSON only. Extract issues and missing facts from the consultation memo. Do not give final legal conclusions. Stay strictly within the actual consultation domain. Never introduce unrelated domains such as food service or nightlife regulation unless the memo itself clearly mentions them.",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "Extract legal-intake issues from a Japanese consultation memo",
        case_id: args.case_id,
        client_name: args.client_name ?? null,
        request_text: args.request_text,
        domain_hint: args.domain_hint ?? "auto",
        resolved_domain: resolvedDomain,
        jurisdiction: args.jurisdiction ?? null,
        output_language: args.output_language,
        output_contract: {
          issues: [{ issue_code: "optional_string", label: "string", confidence: 0.0, reason: "string" }],
          missing_facts: ["string"],
          hearing_questions: ["string"],
          warnings: ["string"],
        },
      }, null, 2),
    },
  ];
}

function buildLawAnalysisPrompt(args: FullCaseWorkflowArgs, issuesPayload: ToolPayload) {
  const resolvedDomain = resolveConsultationDomain(
    args.request_text,
    args.domain_hint,
    getIssueLabelsFromPayload(issuesPayload),
  );

  return [
    {
      role: "system" as const,
      content: "You are a careful Japanese legal-intake triage assistant. Return JSON only. Select plausible law candidates based on the supplied issues and consultation text. Keep citations cautious. Do not switch to an unrelated regulatory field. If the case is about construction, do not introduce food-service or nightlife laws unless explicitly supported by the memo.",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "Identify relevant Japanese laws for the extracted issues",
        case_id: args.case_id,
        request_text: args.request_text,
        resolved_domain: resolvedDomain,
        extracted_issues: issuesPayload,
        known_law_catalog: LAW_SOURCE_CATALOG.map((entry) => ({
          title: entry.title,
          provider: entry.provider,
          source_url: asNonEmptyString((entry as Record<string, unknown>).source_url),
        })),
        output_contract: {
          law_candidates: [{ law_title: "string", relevance_score: 0.0, why_relevant: "string", references: [{ citation: "string", summary: "string" }] }],
          warnings: ["string"],
        },
      }, null, 2),
    },
  ];
}

function buildChecklistAnalysisPrompt(args: FullCaseWorkflowArgs, issuesPayload: ToolPayload, lawPayload: ToolPayload) {
  const resolvedDomain = resolveConsultationDomain(
    args.request_text,
    args.domain_hint,
    [
      ...getIssueLabelsFromPayload(issuesPayload),
      ...getLawTitlesFromPayload(lawPayload),
    ],
  );

  return [
    {
      role: "system" as const,
      content: "あなたは日本の法律相談の一次受付を補助するアシスタントだ。出力は JSON のみで返すこと。checklist の item, why_needed, question_to_client, および summary は必ず自然な日本語で書き、英語を混ぜないこと。安全に次の判断へ進むための不足情報を、日本語の確認事項として簡潔に整理すること。相談文にない業態の確認事項を混ぜてはならない。",
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "法律相談の一次受付に必要な確認事項を日本語で作成する",
        case_id: args.case_id,
        request_text: args.request_text,
        resolved_domain: resolvedDomain,
        extracted_issues: issuesPayload,
        related_laws: lawPayload,
        language_requirements: {
          checklist: "item, why_needed, question_to_client は日本語",
          summary: "日本語",
        },
        output_contract: {
          checklist: [{ priority: "high|medium|low", item: "日本語の確認項目", why_needed: "日本語の理由", question_to_client: "日本語の顧客向け質問" }],
          summary: "日本語の要約",
        },
      }, null, 2),
    },
  ];
}

export async function generateIssuesAnalysis(args: FullCaseWorkflowArgs, hooks?: OpenRouterAttemptHook) {
  const completion = await createOpenRouterChatCompletion(
    buildIssuesAnalysisPrompt(args),
    { maxTokens: 900, temperature: 0.2, onAttempt: hooks?.onAttempt },
  );

  return {
    payload: withOpenRouterMeta(normalizeIssuePayload(parseJsonWithRecovery(completion.content), args.request_text), completion.model, completion.attemptedModels, "openrouter_stage_chain"),
    completion,
  };
}

export async function generateLawCandidatesAnalysis(args: FullCaseWorkflowArgs, issuesPayload: ToolPayload, hooks?: OpenRouterAttemptHook) {
  const completion = await createOpenRouterChatCompletion(
    buildLawAnalysisPrompt(args, issuesPayload),
    { maxTokens: 1100, temperature: 0.2, onAttempt: hooks?.onAttempt },
  );

  return {
    payload: withOpenRouterMeta(normalizeLawPayload(parseJsonWithRecovery(completion.content)), completion.model, completion.attemptedModels, "openrouter_stage_chain"),
    completion,
  };
}

export async function generateChecklistAnalysis(
  args: FullCaseWorkflowArgs,
  issuesPayload: ToolPayload,
  lawPayload: ToolPayload,
  hooks?: OpenRouterAttemptHook,
) {
  const completion = await createOpenRouterChatCompletion(
    buildChecklistAnalysisPrompt(args, issuesPayload, lawPayload),
    { maxTokens: 1000, temperature: 0.2, onAttempt: hooks?.onAttempt },
  );

  return {
    payload: withOpenRouterMeta(normalizeChecklistPayload(parseJsonWithRecovery(completion.content)), completion.model, completion.attemptedModels, "openrouter_stage_chain"),
    completion,
  };
}

export async function generateDraftReplyStage(args: DraftInitialReplyArgs, hooks?: OpenRouterAttemptHook) {
  const completion = await createOpenRouterChatCompletion(
    buildDraftInitialReplyPrompt(args),
    { maxTokens: 900, temperature: 0.2, onAttempt: hooks?.onAttempt },
  );

  return {
    payload: withOpenRouterMeta(
      normalizeDraftPayload(parseJsonWithRecovery(completion.content), args, completion.model, completion.attemptedModels),
      completion.model,
      completion.attemptedModels,
      "openrouter_stage_chain",
    ),
    completion,
  };
}

export async function generateDraftInitialReplyPayload(args: DraftInitialReplyArgs, hooks?: OpenRouterAttemptHook) {
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

    return mergeAiDraftIntoTemplate(templateDraft, completion.content, completion.model, completion.attemptedModels);
  } catch (error) {
    return {
      ...templateDraft,
      meta: {
        ...templateDraft.meta,
        generation_mode: "template_fallback",
        provider: "openrouter",
        attempted_models: openRouterConfig.models,
        ai_error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function runDeterministicWorkflow(
  client: Client,
  args: FullCaseWorkflowArgs,
  options?: { allowLlmDraft?: boolean; onDraftAttempt?: (attempt: OpenRouterAttempt) => void },
): Promise<{
  case_id: string;
  outputs: {
    issues: ToolPayload;
    related_laws: ToolPayload;
    article_trace: ToolPayload;
    missing_information: ToolPayload;
    draft_reply: ToolPayload;
  };
}> {
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

  const keywords = issueLabels.length > 0 ? issueLabels : [args.request_text.slice(0, 40)];

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

  const articleTracePlan = getArticleTracePlan(
    primaryLawId &&
      typeof primaryLawId === "object" &&
      "law_title" in primaryLawId &&
      typeof (primaryLawId as { law_title?: unknown }).law_title === "string"
      ? (primaryLawId as { law_title: string }).law_title
      : undefined,
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
        if (typeof question === "string" && question.trim()) return question;
      }
      if (item && typeof item === "object" && "item" in item) {
        const label = (item as { item?: unknown }).item;
        if (typeof label === "string" && label.trim()) return label;
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
    : generateDraftInitialReplyPayload(draftArgs, { onAttempt: options?.onDraftAttempt });

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

export function parseToolPayload(result: unknown): ToolPayload {
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

function buildDashboardChatPrompt(args: DashboardChatArgs): OpenRouterChatMessage[] {
  const issues = args.case_data.issues.slice(0, 6).map((issue) => ({ label: issue.label, reason: issue.reason }));
  const lawCandidates = args.case_data.lawCandidates.slice(0, 6).map((law) => ({ law_title: law.law_title, why_relevant: law.why_relevant }));
  const checklist = args.case_data.checklist.slice(0, 8).map((item) => ({ item: item.question_to_client || item.item, why_needed: item.why_needed }));
  const history = args.history.slice(-8).map((message) => ({ role: message.role, content: message.content }));
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
      content: "あなたは日本の法律相談一次受付を補助するチャット担当だ。返答は必ず自然な日本語のみで、英語を混ぜないこと。提示された解析結果と会話履歴に基づいて実務的に答えること。法的結論を断定せず、必要に応じて追加確認や人間レビューを促すこと。新事実で現状整理が大きく変わりそうなら、その旨を短く指摘してよい。出力はプレーンテキスト本文のみ。",
    },
    {
      role: "user",
      content: JSON.stringify({
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
      }, null, 2),
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
  if (firstLaw) lines.push(`参考候補としては ${firstLaw} の確認が先です。`);
  if (remainingChecklist.length > 0) lines.push(`未確認事項は ${remainingChecklist.join("、")} です。ここが埋まると判断しやすくなります。`);
  lines.push("この返答は一次整理ベースなので、顧客送信前に人間レビューを入れてください。");

  return lines.join("\n\n");
}

export async function generateDashboardChatReply(args: DashboardChatArgs) {
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
      { maxTokens: 700, temperature: 0.3 },
    );

    return {
      reply: completion.content.trim(),
      model: completion.model,
      attempted_models: completion.attemptedModels,
      generation_mode: "openrouter",
    };
  } catch (error) {
    return {
      reply: buildDashboardChatFallbackReply(args),
      model: "supplemental",
      attempted_models: openRouterConfig.models,
      generation_mode: "fallback_after_error",
      ai_error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { isTimeoutLikeError, truncateForLog };
