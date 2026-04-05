export type WorkshopInputSample = {
  id: string;
  label: string;
  summary: string;
  arguments: Record<string, unknown>;
};

const TOOL_INPUT_SAMPLES: Record<string, WorkshopInputSample[]> = {
  run_full_case_workflow: [
    {
      id: "full-flow-bar-opening",
      label: "一括実行: 深夜バー開業",
      summary: "相談文から論点、関連法令、条文確認、不足情報、一次返信案まで一気に作るぜ。",
      arguments: {
        case_id: "FUEI-2026-001",
        client_name: "株式会社夜更け企画 ご担当者様",
        request_text:
          "新宿区歌舞伎町でカウンター8席、ボックス2卓のバーを新規開業したい。営業時間は19時から翌2時。酒類提供あり。女性スタッフが会話相手になるが、客の隣に座る運営は想定していない。カラオケ導入を検討中。必要な許認可と初回に確認すべき事項をまとめてほしい。",
        domain_hint: "fuei",
        jurisdiction: "東京都新宿区",
        tone: "professional",
        include_disclaimer: true,
        output_language: "ja",
      },
    },
    {
      id: "full-flow-snack-handover",
      label: "一括実行: 居抜きスナック",
      summary: "承継可否と接待論点が混ざる案件を、最初から最後まで通しで整理するんな。",
      arguments: {
        case_id: "FUEI-2026-014",
        client_name: "銀座スナック開業準備室 御中",
        request_text:
          "中央区銀座の居抜き物件でスナックを始めたい。営業時間は18時から24時。ママと女性スタッフが客と会話しながら接客する予定。簡単な調理と酒類提供あり。前テナントの許可を引き継げるかも知りたいので、必要な確認事項から返信案までまとめてほしい。",
        domain_hint: "fuei",
        jurisdiction: "東京都中央区",
        tone: "formal",
        include_disclaimer: true,
        output_language: "ja",
      },
    },
    {
      id: "full-flow-lounge-yokohama",
      label: "一括実行: ラウンジ開業",
      summary: "カラオケ付きラウンジ案件を短めトーンで一括整理する想定だぜ。",
      arguments: {
        case_id: "FUEI-2026-022",
        client_name: "中区ラウンジPJ担当者様",
        request_text:
          "横浜市中区でカラオケラウンジを開業予定。営業時間は20時から翌1時。酒類中心で軽食あり。スタッフは客席で会話する可能性がある。風営法関係、保健所関係、追加ヒアリング事項、初回返信案までまとめてほしい。",
        domain_hint: "fuei",
        jurisdiction: "神奈川県横浜市中区",
        tone: "concise",
        include_disclaimer: true,
        output_language: "ja",
      },
    },
  ],
  extract_issues_from_consultation: [
    {
      id: "fuei-bar-shinjuku",
      label: "深夜バー開業",
      summary: "新宿のバー開業相談。深夜酒類提供と接待該当性の確認が主眼だぜ。",
      arguments: {
        case_id: "FUEI-2026-001",
        request_text:
          "新宿区歌舞伎町でカウンター8席、ボックス2卓のバーを新規開業したい。営業時間は19時から翌2時。酒類提供あり。女性スタッフが会話相手になるが、客の隣に座る運営は想定していない。カラオケ導入を検討中。",
        domain_hint: "fuei",
        jurisdiction: "東京都新宿区",
        output_language: "ja",
      },
    },
    {
      id: "snack-ginza",
      label: "スナック居抜き",
      summary: "中央区の居抜き案件。接待に当たる運営か、保健所系の届出が焦点だな。",
      arguments: {
        case_id: "FUEI-2026-014",
        request_text:
          "中央区銀座の居抜き物件でスナックを始めたい。営業時間は18時から24時。ママと女性スタッフが客と会話しながら接客する予定。簡単な調理と酒類提供あり。前テナントの許可を引き継げるかも知りたい。",
        domain_hint: "fuei",
        jurisdiction: "東京都中央区",
        output_language: "ja",
      },
    },
    {
      id: "karaoke-lounge-yokohama",
      label: "カラオケラウンジ",
      summary: "横浜のラウンジ案件。深夜営業、カラオケ、スタッフ接客の整理向けだぜ。",
      arguments: {
        case_id: "FUEI-2026-022",
        request_text:
          "横浜市中区でカラオケラウンジを開業予定。営業時間は20時から翌1時。酒類中心で軽食あり。スタッフは客席で会話する可能性がある。防火管理や近隣説明の要否も合わせて初期整理したい。",
        domain_hint: "fuei",
        jurisdiction: "神奈川県横浜市中区",
        output_language: "ja",
      },
    },
  ],
  search_relevant_laws: [
    {
      id: "late-night-liquor",
      label: "深夜酒類提供",
      summary: "バー開業相談の法令候補を探すときの叩き台だぜ。",
      arguments: {
        case_id: "FUEI-2026-001",
        issues: ["深夜における酒類提供飲食店営業の届出", "飲食店営業許可", "接待該当性の確認"],
        keywords: ["バー", "深夜営業", "酒類提供", "接待"],
        as_of_date: "2026-04-05",
        max_results: 8,
      },
    },
    {
      id: "girls-bar-review",
      label: "ガールズバー整理",
      summary: "接客態様が曖昧な案件で、風営法系を広めに当てる想定だな。",
      arguments: {
        case_id: "FUEI-2026-018",
        issues: ["接待該当性の確認", "深夜営業可否", "保健所許可の要否"],
        keywords: ["ガールズバー", "接客", "深夜", "保健所"],
        as_of_date: "2026-04-05",
        max_results: 10,
      },
    },
    {
      id: "snack-handover",
      label: "居抜き引継ぎ",
      summary: "前テナントの許可引継ぎ可否を含めた調査向けの入力だぜ。",
      arguments: {
        case_id: "FUEI-2026-014",
        issues: ["飲食店営業許可の承継可否", "深夜営業届出の再整理"],
        keywords: ["居抜き", "許可承継", "スナック", "深夜酒類"],
        as_of_date: "2026-04-05",
        max_results: 6,
      },
    },
  ],
  trace_articles_and_references: [
    {
      id: "fuei-definitions",
      label: "定義規定から追跡",
      summary: "接待該当性の読み始めとして、定義規定から追う形だぜ。",
      arguments: {
        case_id: "FUEI-2026-001",
        law_id: "風俗営業等の規制及び業務の適正化等に関する法律",
        entry_points: ["第2条", "第33条"],
        max_depth: 2,
        include_delegations: true,
        include_related_rules: true,
      },
    },
    {
      id: "late-night-entry",
      label: "深夜営業起点",
      summary: "深夜酒類提供の条文連鎖を見たいときの設定だな。",
      arguments: {
        case_id: "FUEI-2026-018",
        law_id: "風俗営業等の規制及び業務の適正化等に関する法律",
        entry_points: ["第33条"],
        max_depth: 3,
        include_delegations: true,
        include_related_rules: true,
      },
    },
    {
      id: "cabinet-order-check",
      label: "政令委任確認",
      summary: "条文本文だけじゃ足りねぇときに、委任先まで見る用だぜ。",
      arguments: {
        case_id: "FUEI-2026-022",
        law_id: "風俗営業等の規制及び業務の適正化等に関する法律",
        entry_points: ["第2条", "第4条"],
        max_depth: 3,
        include_delegations: true,
        include_related_rules: true,
      },
    },
  ],
  generate_missing_info_checklist: [
    {
      id: "bar-hearing-sheet",
      label: "バー聞き取り",
      summary: "初回ヒアリングで取りこぼしやすい項目を拾うための形だぜ。",
      arguments: {
        case_id: "FUEI-2026-001",
        issues: ["深夜における酒類提供飲食店営業の届出", "接待該当性の確認", "飲食店営業許可"],
        law_candidates: [
          { law_title: "風俗営業等の規制及び業務の適正化等に関する法律" },
          { law_title: "食品衛生法" },
        ],
        client_facts_known: ["営業時間は19時から翌2時", "酒類提供あり", "客の隣に座る予定なし"],
      },
    },
    {
      id: "lounge-layout-check",
      label: "ラウンジ図面確認",
      summary: "図面・接客態様・設備有無を整理したいときの入力だな。",
      arguments: {
        case_id: "FUEI-2026-022",
        issues: ["接待該当性の確認", "客席レイアウト確認", "カラオケ設備の影響"],
        law_candidates: [
          { law_title: "風俗営業等の規制及び業務の適正化等に関する法律" },
        ],
        client_facts_known: ["横浜市中区の物件", "営業時間は20時から翌1時", "カラオケ導入予定"],
      },
    },
    {
      id: "handover-gap-check",
      label: "居抜き承継確認",
      summary: "前テナント情報の引継ぎ漏れを見つける用のサンプルだぜ。",
      arguments: {
        case_id: "FUEI-2026-014",
        issues: ["飲食店営業許可の承継可否", "深夜営業届出の再提出要否"],
        law_candidates: [
          { law_title: "食品衛生法" },
          { law_title: "風俗営業等の規制及び業務の適正化等に関する法律" },
        ],
        client_facts_known: ["銀座の居抜き物件", "前店舗も酒類提供あり", "簡単な調理を予定"],
      },
    },
  ],
  draft_initial_client_reply: [
    {
      id: "first-reply-bar",
      label: "初回返信: バー",
      summary: "相談受付後に送る無難な一次返信の叩き台だぜ。",
      arguments: {
        case_id: "FUEI-2026-001",
        client_name: "株式会社夜更け企画 ご担当者様",
        issues: ["深夜における酒類提供飲食店営業の届出", "接待該当性の確認", "飲食店営業許可"],
        law_candidates: ["風俗営業等の規制及び業務の適正化等に関する法律", "食品衛生法"],
        checklist: [
          "客席配置が分かる平面図",
          "スタッフの接客方法が分かる運営イメージ",
          "カラオケ設備の導入予定有無",
        ],
        tone: "professional",
        include_disclaimer: true,
      },
    },
    {
      id: "first-reply-snack",
      label: "初回返信: スナック",
      summary: "居抜き案件で、承継可否と接待論点を慎重に返す想定だな。",
      arguments: {
        case_id: "FUEI-2026-014",
        client_name: "銀座スナック開業準備室 御中",
        issues: ["飲食店営業許可の承継可否", "接待該当性の確認", "深夜営業届出の要否"],
        law_candidates: ["食品衛生法", "風俗営業等の規制及び業務の適正化等に関する法律"],
        checklist: [
          "前テナントの許可証写し",
          "現在予定している営業時間",
          "スタッフが客席に着く運営を想定しているか",
        ],
        tone: "formal",
        include_disclaimer: true,
      },
    },
    {
      id: "first-reply-lounge",
      label: "初回返信: ラウンジ",
      summary: "相談者が忙しいとき向けの、やや短めの返信案用だぜ。",
      arguments: {
        case_id: "FUEI-2026-022",
        client_name: "中区ラウンジPJ担当者様",
        issues: ["深夜営業の整理", "接待該当性の確認", "防火・近隣対応の確認"],
        law_candidates: ["風俗営業等の規制及び業務の適正化等に関する法律"],
        checklist: [
          "物件所在地と用途地域",
          "客席数とレイアウト",
          "スタッフの接客フロー",
        ],
        tone: "concise",
        include_disclaimer: true,
      },
    },
  ],
};

const PROMPT_INPUT_SAMPLES: Record<string, WorkshopInputSample[]> = {
  new_case_triage: [
    {
      id: "triage-bar",
      label: "バー開業相談",
      summary: "深夜酒類提供と接待の切り分けが必要な相談だぜ。",
      arguments: {
        request_text:
          "新宿でバーを開業予定。営業時間は19時から翌2時。酒類提供あり。女性スタッフが会話対応するが客の隣に座る予定はない。どの許認可や届出が必要か初期整理したい。",
      },
    },
    {
      id: "triage-snack",
      label: "居抜きスナック相談",
      summary: "前テナントの許可承継が絡む相談を想定してるんな。",
      arguments: {
        request_text:
          "銀座の居抜き物件でスナックを始めたい。前の店は深夜まで営業していた。引き継げる許可と取り直しが必要な届出を整理したい。",
      },
    },
    {
      id: "triage-lounge",
      label: "ラウンジ相談",
      summary: "カラオケ設備と接客態様の確認が要る相談の叩き台だぜ。",
      arguments: {
        request_text:
          "横浜でカラオケ付きラウンジを開く予定。スタッフが客席で会話する可能性がある。風営法関係と保健所関係で何を確認すべきか知りたい。",
      },
    },
  ],
  safe_initial_reply: [
    {
      id: "safe-reply-default",
      label: "標準テンプレ",
      summary: "引数は無いが、まずこれを叩けば prompt の中身を確認できるぜ。",
      arguments: {},
    },
  ],
};

function cloneArguments(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function getToolInputSamples(toolName: string): WorkshopInputSample[] {
  return (TOOL_INPUT_SAMPLES[toolName] ?? []).map((sample) => ({
    ...sample,
    arguments: cloneArguments(sample.arguments),
  }));
}

export function getPromptInputSamples(promptName: string): WorkshopInputSample[] {
  return (PROMPT_INPUT_SAMPLES[promptName] ?? []).map((sample) => ({
    ...sample,
    arguments: cloneArguments(sample.arguments),
  }));
}

export function getDefaultToolArguments(toolName: string): Record<string, unknown> {
  const [firstSample] = getToolInputSamples(toolName);
  return firstSample?.arguments ?? {};
}

export function getDefaultPromptArguments(promptName: string): Record<string, unknown> {
  const [firstSample] = getPromptInputSamples(promptName);
  return firstSample?.arguments ?? {};
}
