import React, { useState } from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, Bot, Check, Copy, FileText, MessageSquare, RefreshCw, Scale, CheckSquare, Send } from 'lucide-react';
import type { CaseData, ChatMessage, ChecklistItem } from '../types';
import { CHECKLIST_ANSWER_OPTIONS } from '../constants';
import { getSectionMetric, localizeUiMessage, localizeChecklistReason, localizeReviewNote, getChecklistLabel, copyTextToClipboard, openExternalUrl } from '../utils';
import SectionCard from './SectionCard';

interface DashboardViewProps {
  caseData: CaseData;
  clientName: string;
  originalConsultationText: string;
  onReset: () => void;
  brushUpText: string;
  setBrushUpText: (text: string) => void;
  history: ChatMessage[];
  onChatSubmit: (message: string, selectedChecklistEntries: Array<{ item: ChecklistItem; answer: string }>) => void;
  onReanalyzeSubmit: (message: string, selectedChecklistEntries: Array<{ item: ChecklistItem; answer: string }>) => void;
  isChatSubmitting: boolean;
  error: string | null;
}

export default function DashboardView({
  caseData,
  clientName,
  originalConsultationText,
  onReset,
  brushUpText,
  setBrushUpText,
  history,
  onChatSubmit,
  onReanalyzeSubmit,
  isChatSubmitting,
  error,
}: DashboardViewProps) {
  const [checklistAnswers, setChecklistAnswers] = useState<Record<number, string>>({});
  const [isBrushUpInputFocused, setIsBrushUpInputFocused] = useState(false);
  const [draftCopied, setDraftCopied] = useState(false);
  const usedFallback = Boolean(caseData.workflowSummary?.analysis_mode && caseData.workflowSummary.analysis_mode !== 'openrouter_stage_chain');

  const selectedChecklistEntries = caseData.checklist
    .map((item: ChecklistItem, index: number) => ({ index, item, answer: checklistAnswers[index] || '' }))
    .filter((entry) => Boolean(entry.answer));

  const handleDraftCopy = async () => {
    if (!caseData.draftReply?.body) return;

    try {
      await copyTextToClipboard(caseData.draftReply.body);
      setDraftCopied(true);
      window.setTimeout(() => setDraftCopied(false), 1600);
    } catch (copyError) {
      // エラーを無視
    }
  };

  const handleBrushUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitToChat();
  };

  const collectSelectedEntries = () => {
    return Object.entries(checklistAnswers)
      .map(([index, value]) => ({
        index: parseInt(index, 10),
        item: caseData.checklist[parseInt(index, 10)],
        answer: value as string,
      }))
      .filter((entry) => Boolean(entry.answer) && Boolean(entry.item));
  };

  const submitToChat = async () => {
    const selectedEntries = collectSelectedEntries();
    if (selectedEntries.length > 0 || brushUpText.trim()) {
      await onChatSubmit(brushUpText, selectedEntries);
      setChecklistAnswers({});
      setIsBrushUpInputFocused(false);
    }
  };

  const submitToReanalysis = async () => {
    const selectedEntries = collectSelectedEntries();
    if (selectedEntries.length > 0 || brushUpText.trim()) {
      await onReanalyzeSubmit(brushUpText, selectedEntries);
      setChecklistAnswers({});
      setIsBrushUpInputFocused(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="max-w-[1400px] mx-auto px-6 py-12"
    >
      <div className="flex justify-between items-center mb-12">
        <div>
          <h1 className="text-4xl md:text-5xl tracking-tight font-black mb-2">{clientName || 'お客様'} 様の事案</h1>
          <p className="text-stone-500 font-medium">事案ダッシュボード</p>
          {usedFallback && (
            <p className="mt-2 text-xs font-semibold text-amber-700">
              この結果は主解析を最後まで採用できず、補助ロジックで補完した内容を含んでいます。
              {caseData.workflowSummary?.llm_error ? ` 理由: ${localizeUiMessage(caseData.workflowSummary.llm_error)}` : ''}
            </p>
          )}
        </div>
        <button
          onClick={onReset}
          className="clay-btn p-4 rounded-full text-stone-500 hover:text-black"
          title="新しい相談を開始"
        >
          <RefreshCw className="w-6 h-6" />
        </button>
      </div>

      <div className="swiss-grid">
        <div className="col-span-12">
          <SectionCard
            icon={<FileText className="w-5 h-5" />}
            title="元の相談内容"
            detailLabel={originalConsultationText.trim() ? `${originalConsultationText.trim().length}文字` : '初回入力を表示'}
          >
            <div className="clay-inset rounded-[2rem] p-6 text-base font-medium leading-relaxed text-stone-700 whitespace-pre-wrap">
              {originalConsultationText.trim() || '元の相談内容はまだありません。'}
            </div>
          </SectionCard>
        </div>

        <div className="col-span-12 lg:col-span-4 space-y-8">
          <SectionCard
            icon={<FileText className="w-5 h-5" />}
            title="論点整理"
            detailLabel={getSectionMetric('issues', caseData)}
          >
            <div className="space-y-4">
              {caseData.issues?.map((issue, index: number) => (
                <div key={index} className="border-l-4 border-black pl-5 py-1">
                  <h4 className="font-bold text-lg">{localizeUiMessage(issue.label)}</h4>
                  {issue.reason && <p className="text-stone-500 text-sm mt-1 leading-relaxed">{localizeUiMessage(issue.reason)}</p>}
                </div>
              ))}
              {caseData.issues?.length === 0 && <p className="text-stone-400 font-medium">明確な論点はまだ抽出されていません。</p>}
            </div>
          </SectionCard>

          <SectionCard
            icon={<Scale className="w-5 h-5" />}
            title="関連法令"
            detailLabel={getSectionMetric('lawCandidates', caseData)}
          >
            <div className="space-y-4">
              {caseData.lawCandidates?.map((law, index: number) => (
                <div key={index} className="clay-inset p-4">
                  <h4 className="font-bold text-md mb-1">{localizeUiMessage(law.law_title)}</h4>
                  <p className="text-stone-500 text-xs font-semibold">{localizeUiMessage(law.why_relevant)}</p>
                  {law.references && law.references.length > 0 && (
                    <div className="mt-4 space-y-2">
                      {law.references.map((reference, refIndex: number) => (
                        <div key={`${index}-${refIndex}`} className="rounded-2xl bg-white/70 px-3 py-2 text-xs text-stone-700">
                          <div className="font-semibold">{reference.citation}</div>
                          {reference.summary && <p className="mt-1 text-stone-500">{reference.summary}</p>}
                          {reference.egov_url && (
                            <button
                              type="button"
                              onClick={() => openExternalUrl(reference.egov_url!)}
                              className="mt-2 inline-flex items-center gap-1 cursor-pointer bg-transparent p-0 text-left font-semibold underline underline-offset-2"
                            >
                              e-Gov 法令検索で確認
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {law.source && (
                    <div className="mt-4 border-t border-stone-300 pt-3 text-[11px] leading-relaxed text-stone-500">
                      出典:{' '}
                      {law.source.source_url ? (
                        <button
                          type="button"
                          onClick={() => openExternalUrl(law.source.source_url!)}
                          className="cursor-pointer bg-transparent p-0 font-semibold underline underline-offset-2"
                        >
                          {law.source.provider || 'e-Gov 法令検索'}
                        </button>
                      ) : (
                        <span className="font-semibold">{law.source.provider || 'e-Gov 法令検索'}</span>
                      )}
                      {law.source.law_number && ` / ${law.source.law_number}`}
                      {law.source.law_id && ` / 法令ID: ${law.source.law_id}`}
                      {law.source.version_date && ` / 版日付: ${law.source.version_date}`}
                      {law.source.checked_on && ` / 確認日: ${law.source.checked_on}`}
                    </div>
                  )}
                </div>
              ))}
              {caseData.lawCandidates?.length === 0 && <p className="text-stone-400 font-medium">関連法令の候補はまだ見つかっていません。</p>}
            </div>
          </SectionCard>
        </div>

        <div className="col-span-12 lg:col-span-8 flex flex-col gap-8">
          <SectionCard
            icon={<MessageSquare className="w-5 h-5" />}
            title="初回返信案"
            detailLabel={getSectionMetric('draftReply', caseData)}
            headerAction={(
              <button
                type="button"
                onClick={handleDraftCopy}
                className="rounded-full border border-stone-300 p-3 text-stone-500 transition-colors hover:border-black hover:text-black"
                aria-label="初回返信案の本文をコピー"
                title={draftCopied ? 'コピーしました' : '本文をコピー'}
              >
                {draftCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </button>
            )}
          >
            <div className="clay-inset relative w-full overflow-hidden rounded-2xl bg-[#fcfcfc] p-6 text-left md:p-8">
              <div className="absolute top-0 left-0 w-2 h-full bg-black"></div>
              {caseData.draftReply.subject && (
                <h4 className="text-2xl font-bold mb-6 pb-6 border-b border-stone-200">
                  {caseData.draftReply.subject}
                </h4>
              )}
              <div className="whitespace-pre-wrap font-medium leading-relaxed text-lg text-stone-800">
                {caseData.draftReply.body}
              </div>
            </div>

            {caseData.draftReply.review_notes && caseData.draftReply.review_notes.length > 0 && (
              <div className="mt-8 pt-8 border-t border-stone-200">
                <h4 className="text-xs font-bold uppercase tracking-widest text-stone-400 mb-3">レビュー時の注意</h4>
                <ul className="flex flex-wrap gap-2">
                  {caseData.draftReply.review_notes.map((note, index: number) => (
                    <li key={index} className="bg-red-100 text-red-800 px-3 py-1 rounded-full text-xs font-bold">
                      {localizeReviewNote(note)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </SectionCard>

          <SectionCard
            icon={<CheckSquare className="w-5 h-5" />}
            title="確認事項"
            detailLabel={getSectionMetric('checklist', caseData)}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {caseData.checklist?.map((item, index: number) => (
                <div key={index} className="clay-inset p-5 flex flex-col gap-4">
                  <div>
                    <h4 className="font-bold text-md mb-1">{getChecklistLabel(item)}</h4>
                    {item.why_needed && (
                      <p className="text-stone-500 text-xs font-semibold">{localizeChecklistReason(item.why_needed, item)}</p>
                    )}
                  </div>
                  <div className="mt-auto pt-2 border-t border-stone-200/50">
                    <p className="text-xs font-bold uppercase tracking-widest text-stone-400">
                      下のチャット欄で選択して回答
                    </p>
                  </div>
                </div>
              ))}
              {caseData.checklist?.length === 0 && <p className="text-stone-400 font-medium">追加確認が必要な事項は見つかっていません。</p>}
            </div>
          </SectionCard>
        </div>
      </div>

      <div className="mt-8">
        <SectionCard
          icon={<Bot className="w-5 h-5" />}
          title="チャット"
          detailLabel={history.length > 0 ? `${history.length}件のやり取り` : '追加の質問を受け付けます'}
        >
          <div className="space-y-4">
            {history.length === 0 && (
              <p className="text-sm font-medium text-stone-500">
                追加の質問はそのまま返答できるし、必要なら右のボタンから再解析にも回せるぜ。
              </p>
            )}
            {history.map((message, index: number) => (
              <div
                key={`${message.role}-${index}`}
                className={`max-w-3xl rounded-[24px] px-5 py-4 text-sm leading-relaxed ${
                  message.role === 'assistant'
                    ? 'bg-white text-stone-700 shadow-[10px_10px_24px_rgba(170,174,179,0.25),-8px_-8px_20px_rgba(255,255,255,0.85)]'
                    : 'ml-auto bg-black text-white'
                }`}
              >
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] opacity-60">
                  {message.role === 'assistant' ? '応答' : '質問'}
                </p>
                <p className="whitespace-pre-wrap">{message.content}</p>
              </div>
            ))}
            {isChatSubmitting && (
              <div className="max-w-3xl rounded-[24px] bg-white px-5 py-4 text-sm leading-relaxed text-stone-500 shadow-[10px_10px_24px_rgba(170,174,179,0.25),-8px_-8px_20px_rgba(255,255,255,0.85)]">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] opacity-60">応答</p>
                <p>返答を生成中です...</p>
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      <div className="fixed bottom-0 left-0 w-full p-6 z-40">
        <div className="max-w-[1400px] mx-auto flex items-end justify-center md:justify-end">
          <form
            onSubmit={handleBrushUpSubmit}
            className="w-full md:w-[42rem] clay-card p-3 backdrop-blur-md bg-[#e8eaed]/90"
          >
            {caseData.checklist?.length > 0 && isBrushUpInputFocused && (
              <div className="mb-3 rounded-[1.75rem] border border-stone-300/70 bg-white/70 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-stone-400">かんたん回答</p>
                  </div>
                  {selectedChecklistEntries.length > 0 && (
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setChecklistAnswers({})}
                      className="text-xs font-bold text-stone-500 underline underline-offset-2"
                    >
                      選択をクリア
                    </button>
                  )}
                </div>

                <div className="max-h-52 space-y-3 overflow-y-auto pr-1">
                  {caseData.checklist.map((item, index: number) => (
                    <div key={index} className="rounded-2xl bg-[#f6f6f4] px-3 py-3">
                      <p className="text-sm font-bold leading-snug text-stone-800">{getChecklistLabel(item)}</p>
                      {item.why_needed && (
                        <p className="mt-1 text-[11px] font-medium leading-relaxed text-stone-500">{localizeChecklistReason(item.why_needed, item)}</p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {CHECKLIST_ANSWER_OPTIONS.map((answer) => (
                          <button
                            key={answer}
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => setChecklistAnswers((prev) => ({ ...prev, [index]: prev[index] === answer ? '' : answer }))}
                            className={`rounded-full border px-3 py-1.5 text-xs font-bold transition-colors ${
                              checklistAnswers[index] === answer
                                ? 'border-black bg-black text-white'
                                : 'border-stone-300 bg-white text-stone-600 hover:border-black hover:text-black'
                            }`}
                          >
                            {answer}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {selectedChecklistEntries.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-200 pt-3">
                    {selectedChecklistEntries.map(({ index, item, answer }: { index: number; item: ChecklistItem; answer: string }) => (
                      <button
                        key={`${index}-${answer}`}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => setChecklistAnswers((prev) => ({ ...prev, [index]: '' }))}
                        className="rounded-full bg-black px-3 py-1.5 text-xs font-bold text-white"
                      >
                        {getChecklistLabel(item)}: {answer}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <input
                type="text"
                placeholder="質問や要望を追加する"
                value={brushUpText}
                onChange={(event) => setBrushUpText(event.target.value)}
                onFocus={() => setIsBrushUpInputFocused(true)}
                onBlur={() => setIsBrushUpInputFocused(false)}
                className="flex-grow bg-transparent px-4 py-3 text-md font-medium outline-none placeholder:text-stone-400"
              />
              <button
                type="submit"
                disabled={isChatSubmitting || (!brushUpText.trim() && selectedChecklistEntries.length === 0)}
                className="clay-btn-primary p-4 rounded-2xl flex-shrink-0 disabled:opacity-50"
                title="通常チャットで送信"
              >
                <Send className="w-5 h-5" />
              </button>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={submitToReanalysis}
                disabled={isChatSubmitting || (!brushUpText.trim() && selectedChecklistEntries.length === 0)}
                className="rounded-2xl border border-stone-300 bg-white px-4 py-3 text-xs font-bold text-stone-600 transition-colors hover:border-black hover:text-black disabled:opacity-50"
                title="チャット内容を踏まえて再解析"
              >
                再解析
              </button>
            </div>
          </form>
        </div>
        {error && (
          <div className="max-w-[1400px] mx-auto mt-2">
            <div className="bg-red-100 text-red-700 p-3 rounded-lg text-sm font-bold text-center">
              チャット返答の生成中にエラーが発生した: {error}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
