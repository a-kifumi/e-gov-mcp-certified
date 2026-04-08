import type { WorkflowEvent, CaseData, ChecklistItem, StageTrace, SectionKey, AnalysisTrace, SectionAttemptTrace, ChatMessage } from './types';

export async function streamCaseWorkflow(
  body: Record<string, unknown>,
  onEvent: (event: WorkflowEvent) => void,
) {
  const response = await fetch('/api/analyze-stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `リクエストに失敗しました (${response.status})`;
    try {
      const payload = await response.json() as { error?: string };
      message = payload.error || message;
    } catch {
      const text = await response.text();
      message = text || message;
    }
    throw new Error(localizeUiMessage(message));
  }

  if (!response.body) {
    throw new Error('ストリーム応答を受信できませんでした。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line) {
        onEvent(JSON.parse(line) as WorkflowEvent);
      }

      newlineIndex = buffer.indexOf('\n');
    }

    if (done) {
      const tail = buffer.trim();
      if (tail) {
        onEvent(JSON.parse(tail) as WorkflowEvent);
      }
      break;
    }
  }
}

export async function requestDashboardChat(body: Record<string, unknown>) {
  const response = await fetch('/api/dashboard-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let payload: {
    reply?: string;
    model?: string;
    attempted_models?: string[];
    error?: string;
  } = {};

  if (rawText.trim()) {
    try {
      payload = JSON.parse(rawText) as typeof payload;
    } catch {
      if (response.ok) {
        payload = { reply: rawText.trim() };
      } else {
        payload = { error: rawText.trim() };
      }
    }
  }

  if (!response.ok) {
    throw new Error(localizeUiMessage(payload.error || `Request failed (${response.status})`));
  }

  if (!payload.reply) {
    throw new Error('チャット応答を受信できませんでした。');
  }

  return payload;
}

export function openExternalUrl(url: string) {
  const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
  if (!newWindow) {
    window.location.href = url;
  }
}

export async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'absolute';
  textArea.style.left = '-9999px';
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand('copy');
  document.body.removeChild(textArea);
}

export function getChecklistLabel(item: ChecklistItem) {
  return localizeUiMessage(item.question_to_client || item.item || '確認事項');
}

export function buildPlaceholderTimeline(): StageTrace[] {
  return [
    {
      slotId: 'issues',
      order: 1,
      stageKey: 'issues',
      stageLabel: '解析ステップ',
      label: '論点整理',
      status: 'pending',
      headline: '待機中',
      summary: '相談文から主要論点と未確定要素を洗い出します。',
    },
    {
      slotId: 'lawCandidates',
      order: 2,
      stageKey: 'lawCandidates',
      stageLabel: '解析ステップ',
      label: '関連法令',
      status: 'pending',
      headline: '待機中',
      summary: '論点整理を踏まえて、関連しそうな法令候補を絞り込みます。',
    },
    {
      slotId: 'checklist',
      order: 3,
      stageKey: 'checklist',
      stageLabel: '解析ステップ',
      label: '確認事項',
      status: 'pending',
      headline: '待機中',
      summary: '判断を分ける不足情報を、顧客への確認項目に変換します。',
    },
    {
      slotId: 'draftReply',
      order: 4,
      stageKey: 'draftReply',
      stageLabel: '解析ステップ',
      label: '返信文',
      status: 'pending',
      headline: '待機中',
      summary: 'ここまでの整理結果をもとに、初回返信案を組み立てます。',
    },
  ];
}

export function parseWorkflowToCaseData(workflow: WorkflowEvent['workflow']): CaseData {
  const outputs = workflow?.outputs || {};

  return {
    issues: outputs.issues?.issues || [],
    missingFacts: outputs.issues?.missing_facts || [],
    lawCandidates: outputs.related_laws?.law_candidates || [],
    checklist: outputs.missing_information?.checklist || [],
    draftReply: outputs.draft_reply || { subject: '件名未生成', body: '本文はまだ生成されていません。' },
    analysisTrace: workflow?.analysis_trace || null,
    workflowSummary: workflow?.workflow_summary || null,
  };
}

export function localizeUiMessage(message?: string | null) {
  if (!message) return '';

  return message
    .replace(/Exact location and zoning\s*\(Use District\)/gi, '正確な所在地と用途地域')
    .replace(/Exact location and zoning/gi, '正確な所在地と用途地域')
    .replace(/Use District/gi, '用途地域')
    .replace(/floor plan|layout/gi, '店舗レイアウト')
    .replace(/business hours?/gi, '営業時間')
    .replace(/late-night operations?/gi, '深夜営業の予定')
    .replace(/alcohol|liquor service/gi, '酒類提供')
    .replace(/staff|employee.*customer|hospitality service|entertainment service/gi, '従業員の接客方法や営業実態')
    .replace(/^Request failed \((\d+)\)$/i, 'リクエストに失敗しました ($1)')
    .replace(/OPENROUTER_API_KEY is not configured/gi, 'OpenRouter APIキーが設定されていません')
    .replace(/OpenRouter request timed out after (\d+)ms/gi, 'OpenRouter の応答がタイムアウトしました ($1ms)')
    .replace(/OpenRouter request failed/gi, 'OpenRouter リクエストに失敗しました')
    .replace(/OpenRouter failed for all configured models/gi, '設定済みモデルの応答取得に失敗しました')
    .replace(/Provider returned error/gi, '上流AIプロバイダで一時エラーが発生しました')
    .replace(/temporarily rate-limited upstream/gi, '上流プロバイダ側で一時的なレート制限が発生しています')
    .replace(/Unknown error/gi, '不明なエラー')
    .replace(/\bsupplemental\b/gi, '補助ロジック');
}

export function localizeChecklistReason(reason?: string | null, item?: ChecklistItem) {
  if (!reason) return '';
  if (/[一-龯ぁ-んァ-ン]/.test(reason)) return reason;

  const normalized = reason.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (/entertainment business act|fuei|actively play with customers|classified as entertainment|restricting operating hours to midnight/.test(lower)) {
    return '従業員の接客方法や営業実態によっては風営法上の接待営業に該当し、営業時間規制に影響するため';
  }
  if (/quantity and nature of gaming equipment|commercial vs\. home use|categorized as a gaming facility|gaming facility/.test(lower)) {
    return 'ゲーム機の台数や用途によって、風営法上の遊技設備としての扱いが変わる可能性があるため';
  }
  if (/certain zones prohibit entertainment businesses|types of food service establishments|zones prohibit|zoning/.test(lower)) {
    return '用途地域によって営業できる業態や必要な手続が変わるため';
  }
  if (/food sanitation act permit|liquor sales license|bottle sales|scope of the food sanitation act permit/.test(lower)) {
    return '飲食店営業許可の範囲や酒類販売免許の要否を判断するため';
  }
  if (/operating hours|business hours|late-night/.test(lower)) {
    return '営業時間規制や必要な届出の要否を判断するため';
  }

  const label = item?.question_to_client || item?.item || '';
  if (/用途地域|所在地/.test(label)) {
    return '用途地域や所在地によって営業可否や必要手続が変わるため';
  }
  if (/酒類|お酒|ボトル/.test(label)) {
    return '酒類提供や販売方法によって必要な許可や届出が変わるため';
  }
  if (/ゲーム|ダーツ|遊技/.test(label)) {
    return 'ゲーム設備の内容によって必要な手続や規制の有無が変わるため';
  }
  if (/接客|従業員|客/.test(label)) {
    return '接客方法や営業実態によって風営法上の評価が変わるため';
  }

  return '許認可の要否や必要手続の判断に必要な確認事項です';
}

export function localizeReviewNote(note?: string | null) {
  if (!note) return '';
  if (/[一-龯ぁ-んァ-ン]/.test(note)) return note;

  const normalized = note.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (/adult entertainment business act|fueiho|staff interaction|machine count|falls under/.test(lower)) {
    return '従業員の接客実態や設備内容の確認前に風営法該当性を断定しないこと';
  }
  if (/tone is professional and cautious|proper legal assessment|necessary step/.test(lower)) {
    return '慎重な表現を維持し、正式判断前提の案内にならないようにすること';
  }
  if (/not a final legal opinion|not final legal opinion|do not state legal conclusions as final/.test(lower)) {
    return '最終的な法的意見ではない旨を明記すること';
  }
  if (/human review|manual review|review before sending/.test(lower)) {
    return '人間レビュー前提で送付すること';
  }

  return '内容を日本語で見直し、人間レビュー後に送付すること';
}

export function buildChecklistAnswerSummary(selectedChecklistEntries: Array<{ item: ChecklistItem; answer: string }>) {
  return selectedChecklistEntries
    .map(({ item, answer }) => `- ${getChecklistLabel(item)}: ${answer}`)
    .join('\n');
}

export function buildReanalysisRequestText({
  consultationText,
  history,
  pendingMessage,
  selectedChecklistEntries,
}: {
  consultationText: string;
  history: ChatMessage[];
  pendingMessage: string;
  selectedChecklistEntries: Array<{ item: ChecklistItem; answer: string }>;
}) {
  const transcriptLines = history.map((message) => `${message.role === 'user' ? '利用者' : '補助回答'}: ${message.content}`);
  const answerSummary = buildChecklistAnswerSummary(selectedChecklistEntries);
  const latestUserBlock = [pendingMessage.trim(), answerSummary].filter(Boolean).join('\n\n');

  return [
    consultationText.trim(),
    transcriptLines.length > 0 ? `【これまでのチャット】\n${transcriptLines.join('\n\n')}` : '',
    latestUserBlock ? `【今回の追加要望・回答】\n${latestUserBlock}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function formatModelLabel(model?: string) {
  if (!model) return '補助ロジック';
  if (model === 'supplemental') return '補助ロジック';
  return model.replace(':free', '').replace(/^.*\//, '');
}

export function getAttemptStatusMeta(status: StageTrace['status'] | SectionAttemptTrace['status']) {
  switch (status) {
    case 'success':
      return {
        label: '受信済み',
        badge: 'bg-black text-white border-black',
        card: 'border-black bg-white text-stone-900',
      };
    case 'running':
      return {
        label: '解析中',
        badge: 'bg-amber-100 text-amber-700 border-amber-200',
        card: 'border-amber-200 bg-amber-50/80 text-stone-800',
      };
    case 'error':
      return {
        label: '失敗',
        badge: 'bg-red-100 text-red-700 border-red-200',
        card: 'border-red-200 bg-red-50/80 text-red-900',
      };
    case 'skipped':
      return {
        label: '未実行',
        badge: 'bg-stone-100 text-stone-600 border-stone-200',
        card: 'border-stone-200 bg-stone-50/80 text-stone-700',
      };
    default:
      return {
        label: '待機中',
        badge: 'bg-amber-100 text-amber-700 border-amber-200',
        card: 'border-stone-200 bg-[#f5f6f7] text-stone-700',
      };
  }
}

export function getProgressRatio(timeline: StageTrace[]) {
  if (timeline.length === 0) return 0;
  const finished = timeline.filter((entry) => ['success', 'error', 'skipped'].includes(entry.status)).length;
  return Math.round((finished / timeline.length) * 100);
}

export function getSectionAttempts(trace: AnalysisTrace | null, sectionKey: SectionKey) {
  const attempts = trace?.sections[sectionKey].attempts || [];
  return [...attempts].sort((left, right) => {
    if (left.usedInFinal === right.usedInFinal) {
      return 0;
    }
    return left.usedInFinal ? -1 : 1;
  });
}

export function getRunningStageLabel(timeline: StageTrace[]) {
  return timeline.find((entry) => entry.status === 'running')?.label || null;
}

export function getSectionMetric(sectionKey: SectionKey, caseData: CaseData) {
  switch (sectionKey) {
    case 'issues':
      return `${caseData.issues.length}件の論点`;
    case 'lawCandidates':
      return `${caseData.lawCandidates.length}件の法令候補`;
    case 'checklist':
      return `${caseData.checklist.length}件の確認事項`;
    case 'draftReply':
      return caseData.draftReply.subject || '返信案';
  }
}
