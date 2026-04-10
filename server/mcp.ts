import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getPublicOpenRouterConfig } from "../src/lib/ai/openrouter.ts";
import type { FullCaseWorkflowArgs, ToolPayload, WorkflowExecutionHooks } from "./types.ts";
import {
  FOOD_SANITATION_LAW_SOURCE,
  FUEI_LAW_SOURCE,
  generateDraftInitialReplyPayload,
  getArticleTracePlan,
  resolveConsultationDomain,
} from "./workflow/index.ts";

type ExecuteCaseWorkflow = (
  args: FullCaseWorkflowArgs,
  hooks?: WorkflowExecutionHooks,
) => Promise<ToolPayload>;

function createMcpServer(executeCaseWorkflow: ExecuteCaseWorkflow) {
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
            common_issues: ["深夜酒類提供の要否", "接待該当性の確認", "図面確認"],
          },
        }, null, 2),
      }],
    }),
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
            "法令本文に加えて運用確認が必要です",
          ],
        }, null, 2),
      }],
    }),
  );

  mcp.resource(
    "llm_runtime_config",
    "resource://runtime/llm_runtime_config",
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: JSON.stringify(getPublicOpenRouterConfig(), null, 2),
      }],
    }),
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
            "顧客送信前に人間レビュー必須",
          ],
        }, null, 2),
      }],
    }),
  );

  mcp.prompt(
    "new_case_triage",
    { request_text: z.string() },
    ({ request_text }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `新規相談の整理ワークフローを開始します。\n\n相談内容:\n${request_text}\n\n以下の手順で処理してください:\n1. 論点抽出\n2. 候補法令検索\n3. 不足情報リスト生成\n4. 顧客返信案生成`,
        },
      }],
    }),
  );

  mcp.prompt(
    "safe_initial_reply",
    {},
    () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "一次返信案を安全に作成してください。\n\n想定ルール:\n- 断定しない\n- 未確認事項を明示\n- 次に必要な資料を列挙\n- 人間レビュー前提で出力",
        },
      }],
    }),
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
    async (args) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await executeCaseWorkflow(args), null, 2),
      }],
    }),
  );

  mcp.tool(
    "extract_issues_from_consultation",
    {
      case_id: z.string(),
      request_text: z.string(),
      domain_hint: z.enum(["auto", "construction", "kobutsu", "fuei", "immigration", "waste", "corporate"]).optional(),
      jurisdiction: z.string().optional(),
      output_language: z.string().default("ja"),
    },
    async (args) => {
      const resolvedDomain = resolveConsultationDomain(args.request_text, args.domain_hint);
      const meta = {
        needs_human_review: true,
        generated_at: new Date().toISOString(),
        server_version: "0.1.0",
        sources: [],
      };

      const payload = resolvedDomain === "construction"
        ? {
          case_id: args.case_id,
          domain_detected: resolvedDomain,
          issues: [
            { issue_code: "construction_license_scope", label: "建設業許可の要否", confidence: 0.95, reason: "請負予定金額や工事区分によって許可要否が分かれるため" },
            { issue_code: "construction_staffing", label: "技術者・実務経験要件の確認", confidence: 0.87, reason: "資格や実務経験の裏付けで申請方針が変わるため" },
            { issue_code: "construction_business_setup", label: "営業所体制と財産要件の確認", confidence: 0.82, reason: "法人成りや営業所設置の状況で必要資料が変わるため" },
          ],
          missing_facts: ["請け負う予定工事の種類", "1件あたりの請負予定金額", "営業所所在地", "資格・実務経験の裏付け資料", "役員・技術者候補の常勤体制"],
          hearing_questions: [
            "請け負う予定の工事は主にどの業種で、1件あたりの請負金額はいくらを想定していますか？",
            "国家資格の有無に加えて、実務経験を裏付ける資料はどこまで用意できますか？",
            "法人成り後の営業所所在地と、常勤で配置できる役員・技術者候補は固まっていますか？",
          ],
          warnings: ["許可要件の最終判断には、工事区分・金額・人的体制の確認が必要です"],
          meta,
        }
        : resolvedDomain === "fuei"
          ? {
          case_id: args.case_id,
          domain_detected: resolvedDomain,
          issues: [
            { issue_code: "food_business_permission", label: "飲食店営業許可", confidence: 0.88, reason: "飲食提供を伴う店舗営業のため" },
            { issue_code: "late_night_liquor", label: "深夜酒類提供の要否", confidence: 0.93, reason: "深夜営業・酒類提供あり" },
            { issue_code: "hospitality_risk", label: "接待該当性の確認", confidence: 0.84, reason: "バー営業で接客態様により評価が分かれるため" },
          ],
          missing_facts: ["客席配置", "従業員の接客態様", "カラオケ有無", "店内面積", "物件用途"],
          hearing_questions: ["従業員が客の隣に座る運営は予定していますか？", "カウンター越し以外の接客はありますか？", "客席図面はありますか？"],
          warnings: ["法令本文だけでは自治体・警察運用を確定できません"],
          meta,
        }
          : {
            case_id: args.case_id,
            domain_detected: resolvedDomain,
            issues: [
              { issue_code: "general_scope", label: "主要な許認可・手続の特定", confidence: 0.72, reason: "相談文だけでは対象法分野の確定に追加確認が必要なため" },
            ],
            missing_facts: ["事業内容の詳細", "対象となる商品・サービス", "営業形態", "所在地", "開始予定時期"],
            hearing_questions: ["予定している事業内容を、提供する商品やサービスが分かる形で具体的に教えてください。"],
            warnings: ["補助ロジックでは分野特定が不十分なため、追加確認後に再解析してください"],
            meta,
          };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(payload, null, 2),
        }],
      };
    },
  );

  mcp.tool(
    "search_relevant_laws",
    {
      case_id: z.string(),
      issues: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
      as_of_date: z.string().optional(),
      max_results: z.number().default(10),
    },
    async (args) => {
      const checkedOn = args.as_of_date || new Date().toISOString().split("T")[0];
      const searchText = [...(args.issues ?? []), ...(args.keywords ?? [])].join(" ");
      const needsSuccessionReference = /(承継|譲渡|相続|合併|分割|居抜き)/.test(searchText);
      const resolvedDomain = resolveConsultationDomain(searchText);

      if (resolvedDomain === "construction") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              case_id: args.case_id,
              law_candidates: [
                {
                  law_title: "建設業法",
                  relevance_score: 0.97,
                  matched_terms: ["建設業許可", "工事請負", "実務経験"],
                  why_relevant: "建設業許可の要否、業種区分、人的要件や財産要件の確認に関連",
                  references: [],
                  source: { provider: "e-Gov 法令検索", title: "建設業法", checked_on: checkedOn },
                },
              ],
              related_rules: [{ parent_law_title: "建設業法", related_rule_hint: "施行令・施行規則と許可行政庁の案内を確認" }],
              warnings: ["候補法令は初期整理用です。具体的な業種区分・請負金額・人的体制に応じて条文と運用を確認してください"],
              meta: {
                needs_human_review: true,
                generated_at: new Date().toISOString(),
                server_version: "0.1.0",
                sources: [{ provider: "e-Gov 法令検索", title: "建設業法", checked_on: checkedOn }],
              },
            }, null, 2),
          }],
        };
      }

      if (resolvedDomain !== "fuei") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              case_id: args.case_id,
              law_candidates: resolvedDomain === "general"
                ? []
                : [{
                  law_title:
                    resolvedDomain === "immigration"
                      ? "出入国管理及び難民認定法"
                      : resolvedDomain === "waste"
                        ? "廃棄物の処理及び清掃に関する法律"
                        : "関連法令の個別確認が必要",
                  relevance_score: 0.8,
                  matched_terms: args.issues ?? [],
                  why_relevant: "相談分野に対応する主要法令の候補",
                  references: [],
                  source: { provider: "e-Gov 法令検索", title: resolvedDomain === "immigration" ? "出入国管理及び難民認定法" : resolvedDomain === "waste" ? "廃棄物の処理及び清掃に関する法律" : "関連法令" },
                }],
              related_rules: [],
              warnings: ["補助ロジックでは候補法令を絞り切れていません。主解析または人間レビューで確認してください"],
              meta: {
                needs_human_review: true,
                generated_at: new Date().toISOString(),
                server_version: "0.1.0",
                sources: [],
              },
            }, null, 2),
          }],
        };
      }

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
                source: { ...FUEI_LAW_SOURCE, checked_on: checkedOn },
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
                source: { ...FOOD_SANITATION_LAW_SOURCE, checked_on: checkedOn },
              },
            ],
            related_rules: [{ parent_law_title: FUEI_LAW_SOURCE.title, related_rule_hint: "施行規則・施行令の確認が必要" }],
            warnings: ["候補法令は案件論点との関連推定であり、確定結論ではありません"],
            meta: {
              needs_human_review: true,
              generated_at: new Date().toISOString(),
              server_version: "0.1.0",
              sources: [
                { provider: FUEI_LAW_SOURCE.provider, law_id: FUEI_LAW_SOURCE.law_id, source_url: FUEI_LAW_SOURCE.source_url, checked_on: checkedOn },
                { provider: FOOD_SANITATION_LAW_SOURCE.provider, law_id: FOOD_SANITATION_LAW_SOURCE.law_id, source_url: FOOD_SANITATION_LAW_SOURCE.source_url, checked_on: checkedOn },
              ],
            },
          }, null, 2),
        }],
      };
    },
  );

  mcp.tool(
    "trace_articles_and_references",
    {
      case_id: z.string(),
      law_id: z.string(),
      entry_points: z.array(z.string()),
      max_depth: z.number().default(2),
      include_delegations: z.boolean().default(true),
      include_related_rules: z.boolean().default(true),
    },
    async (args) => {
      const articleTracePlan = getArticleTracePlan(args.law_id, "auto", args.law_id);
      const isFuei = articleTracePlan.lawTitle === FUEI_LAW_SOURCE.title;
      const isFood = articleTracePlan.lawTitle === FOOD_SANITATION_LAW_SOURCE.title;

      const payload = isFuei
        ? {
          case_id: args.case_id,
          law_id: args.law_id,
          entry_points: args.entry_points,
          article_graph: [
            {
              citation: "第2条",
              summary_for_practice: "定義規定。接待・営業類型を読む起点。",
              references: [{ reference_type: "internal_reference", target_citation: "第33条" }],
              delegations: [],
            },
            {
              citation: "第33条",
              summary_for_practice: "深夜営業関連の確認起点。",
              references: [],
              delegations: [{ delegation_type: "cabinet_order", label: "政令で定める" }],
            },
          ],
          practical_next_reads: ["施行令の該当条文", "施行規則の届出関係条文"],
          warnings: ["条文追跡は法令本文ベースであり、運用通知は別確認が必要です"],
          meta: {
            needs_human_review: true,
            generated_at: new Date().toISOString(),
            server_version: "0.1.0",
            sources: [{ provider: "e-Gov Law API v2", retrieved_at: new Date().toISOString() }],
          },
        }
        : isFood
          ? {
            case_id: args.case_id,
            law_id: args.law_id,
            entry_points: args.entry_points,
            article_graph: [
              {
                citation: "第54条",
                summary_for_practice: "施設基準を都道府県条例に委ねる条文の確認起点。",
                references: [{ reference_type: "internal_reference", target_citation: "第55条" }],
                delegations: [],
              },
              {
                citation: "第55条",
                summary_for_practice: "営業許可と施設基準適合の確認起点。",
                references: [],
                delegations: [],
              },
            ],
            practical_next_reads: ["都道府県条例の施設基準", "営業承継がある場合の関連条文"],
            warnings: ["条文追跡は法令本文ベースであり、自治体運用は別確認が必要です"],
            meta: {
              needs_human_review: true,
              generated_at: new Date().toISOString(),
              server_version: "0.1.0",
              sources: [{ provider: "e-Gov Law API v2", retrieved_at: new Date().toISOString() }],
            },
          }
          : {
            case_id: args.case_id,
            law_id: args.law_id,
            entry_points: args.entry_points,
            article_graph: [],
            practical_next_reads: ["e-Gov で許可要件の条文を確認", "施行令・施行規則と所管庁の案内を確認"],
            warnings: ["この補助トレースは一般的な確認観点のみです。具体的な条文番号は個別に確認してください"],
            meta: {
              needs_human_review: true,
              generated_at: new Date().toISOString(),
              server_version: "0.1.0",
              sources: [{ provider: "e-Gov Law API v2", retrieved_at: new Date().toISOString() }],
            },
          };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(payload, null, 2),
        }],
      };
    },
  );

  mcp.tool(
    "generate_missing_info_checklist",
    {
      case_id: z.string(),
      issues: z.array(z.string()),
      law_candidates: z.array(z.record(z.string(), z.any())),
      client_facts_known: z.array(z.string()).optional(),
    },
    async (args) => {
      const resolvedDomain = resolveConsultationDomain([...(args.issues ?? []), ...(args.client_facts_known ?? [])].join("\n"));
      const payload = resolvedDomain === "construction"
        ? {
          case_id: args.case_id,
          checklist: [
            {
              priority: "high",
              item: "工事内容と業種区分",
              why_needed: "どの建設業許可が必要か、または許可不要範囲かを切り分けるため",
              question_to_client: "請け負う予定の工事内容を具体的に教えてください。複数ある場合は主な工事を挙げてください。",
            },
            {
              priority: "high",
              item: "請負金額の見込み",
              why_needed: "1件ごとの請負金額によって許可要否の判断が変わるため",
              question_to_client: "1件あたりの請負金額は、税込でどの程度を想定していますか？",
            },
            {
              priority: "high",
              item: "資格・実務経験の裏付け資料",
              why_needed: "人的要件の整理には資格証や実務経験証明の可否が重要なため",
              question_to_client: "資格証、実務経験を示す契約書や請求書など、手元にある資料を教えてください。",
            },
          ],
          summary: "現時点では許可要否と人的要件の確認に必要な事実が不足しています",
          meta: {
            needs_human_review: true,
            generated_at: new Date().toISOString(),
            server_version: "0.1.0",
            sources: [],
          },
        }
        : resolvedDomain === "fuei"
          ? {
          case_id: args.case_id,
          checklist: [
            {
              priority: "high",
              item: "客席の配置図",
              why_needed: "接待該当性や営業態様の確認に必要",
              question_to_client: "客席の配置図または簡単なレイアウト図はありますか？",
            },
            {
              priority: "high",
              item: "従業員の接客態様",
              why_needed: "接待該当性の判断材料になるため",
              question_to_client: "従業員が客の隣に座る、または特定客に継続的に会話サービスを行う予定はありますか？",
            },
            {
              priority: "medium",
              item: "カラオケ設備の有無",
              why_needed: "営業実態の評価に影響しうるため",
              question_to_client: "カラオケ設備や歌唱サービスの提供予定はありますか？",
            },
          ],
          summary: "現時点では営業実態の確認不足が主な未確定要素です",
          meta: {
            needs_human_review: true,
            generated_at: new Date().toISOString(),
            server_version: "0.1.0",
            sources: [],
          },
        }
          : {
            case_id: args.case_id,
            checklist: [
              {
                priority: "high",
                item: "事業内容の具体化",
                why_needed: "対象法分野と必要手続を絞り込むため",
                question_to_client: "予定している事業内容、提供物、想定顧客、営業方法を具体的に教えてください。",
              },
            ],
            summary: "現時点では対象法分野の切り分けに必要な情報が不足しています",
            meta: {
              needs_human_review: true,
              generated_at: new Date().toISOString(),
              server_version: "0.1.0",
              sources: [],
            },
          };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(payload, null, 2),
        }],
      };
    },
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
      include_disclaimer: z.boolean().default(true),
    },
    async (args) => ({
      content: [{
        type: "text",
        text: JSON.stringify(await generateDraftInitialReplyPayload(args), null, 2),
      }],
    }),
  );

  return mcp;
}

export async function withInternalMcpClient<T>(
  executeCaseWorkflow: ExecuteCaseWorkflow,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createMcpServer(executeCaseWorkflow);
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
