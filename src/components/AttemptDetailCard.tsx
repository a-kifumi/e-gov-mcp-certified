import React from 'react';
import type { SectionAttemptTrace, SectionTrace, SectionKey } from '../types';
import { getAttemptStatusMeta, localizeUiMessage, getChecklistLabel, localizeChecklistReason, localizeReviewNote } from '../utils';

interface AttemptDetailCardProps {
  attempt: SectionAttemptTrace;
  attemptIndex: number;
  section: SectionTrace;
  sectionKey: SectionKey;
}

export default function AttemptDetailCard({
  attempt,
  attemptIndex,
  section,
  sectionKey,
}: AttemptDetailCardProps) {
  const statusMeta = getAttemptStatusMeta(attempt.status);
  const extracted = attempt.extracted;
  const localizedSummary = localizeUiMessage(attempt.summary);
  const localizedError = localizeUiMessage(attempt.errorMessage);

  return (
    <div className={`rounded-[28px] border p-5 md:p-6 ${statusMeta.card}`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/75 text-sm font-black text-stone-900">
              {attemptIndex}
            </span>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-stone-400">{attempt.stageLabel}</p>
              <h3 className="text-xl font-black">{localizeUiMessage(attempt.headline)}</h3>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-stone-400">
            <span>{formatModelLabel(attempt.model)}</span>
            <span>•</span>
            <span>{attempt.label}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusMeta.badge}`}>
            {statusMeta.label}
          </span>
          {attempt.usedInFinal && (
            <span className="rounded-full border border-black bg-black px-3 py-1 text-xs font-bold text-white">
              この結果を採用
            </span>
          )}
          {attempt.isFallback && (
            <span className="rounded-full border border-stone-300 bg-white px-3 py-1 text-xs font-bold text-stone-600">
              予備モデル
            </span>
          )}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-[22px] bg-white/75 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-stone-400">この段階の返答</p>
          <p className="mt-3 text-sm font-semibold leading-relaxed text-stone-700">{localizedSummary}</p>
          {attempt.contentPreview && (
            <p className="mt-4 rounded-[18px] bg-[#f7f8f9] px-4 py-3 text-sm leading-relaxed text-stone-600">
              {localizeUiMessage(attempt.contentPreview)}
            </p>
          )}
          {localizedError && (
            <p className="mt-4 rounded-[18px] bg-red-100 px-4 py-3 text-sm font-bold leading-relaxed text-red-700">
              {localizedError}
            </p>
          )}
        </div>

        <div className="rounded-[22px] bg-white/75 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-stone-400">抽出された内容</p>
          <div className="mt-3">
            {sectionKey === 'issues' && extracted?.issues && extracted.issues.length > 0 && (
              <div className="space-y-3">
                {extracted.issues.slice(0, 4).map((issue, index) => (
                  <div key={index} className="rounded-[18px] bg-[#f7f8f9] px-4 py-3">
                    <p className="text-sm font-bold text-stone-800">{localizeUiMessage(issue.label)}</p>
                    {issue.reason && <p className="mt-1 text-xs leading-relaxed text-stone-500">{localizeUiMessage(issue.reason)}</p>}
                  </div>
                ))}
              </div>
            )}

            {sectionKey === 'lawCandidates' && extracted?.lawCandidates && extracted.lawCandidates.length > 0 && (
              <div className="space-y-3">
                {extracted.lawCandidates.slice(0, 3).map((law, index) => (
                  <div key={index} className="rounded-[18px] bg-[#f7f8f9] px-4 py-3">
                    <p className="text-sm font-bold text-stone-800">{localizeUiMessage(law.law_title)}</p>
                    {law.why_relevant && <p className="mt-1 text-xs leading-relaxed text-stone-500">{localizeUiMessage(law.why_relevant)}</p>}
                  </div>
                ))}
              </div>
            )}

            {sectionKey === 'checklist' && extracted?.checklist && extracted.checklist.length > 0 && (
              <div className="space-y-3">
                {extracted.checklist.slice(0, 4).map((item, index) => (
                  <div key={index} className="rounded-[18px] bg-[#f7f8f9] px-4 py-3">
                    <p className="text-sm font-bold text-stone-800">{getChecklistLabel(item)}</p>
                    {item.why_needed && <p className="mt-1 text-xs leading-relaxed text-stone-500">{localizeChecklistReason(item.why_needed, item)}</p>}
                  </div>
                ))}
              </div>
            )}

            {sectionKey === 'draftReply' && extracted?.draftReply && (
              <div className="rounded-[18px] bg-[#f7f8f9] px-4 py-3">
                <p className="text-sm font-bold text-stone-800">{extracted.draftReply.subject}</p>
                <p className="mt-2 text-sm leading-relaxed text-stone-600 whitespace-pre-wrap">
                  {extracted.draftReply.body}
                </p>
                {extracted.draftReply.review_notes && extracted.draftReply.review_notes.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {extracted.draftReply.review_notes.map((note, index) => (
                      <span key={index} className="rounded-full bg-red-100 px-3 py-1 text-[11px] font-bold text-red-700">
                        {localizeReviewNote(note)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {((sectionKey === 'issues' && (!extracted?.issues || extracted.issues.length === 0))
              || (sectionKey === 'lawCandidates' && (!extracted?.lawCandidates || extracted.lawCandidates.length === 0))
              || (sectionKey === 'checklist' && (!extracted?.checklist || extracted.checklist.length === 0))
              || (sectionKey === 'draftReply' && !extracted?.draftReply)) && (
              <p className="text-sm leading-relaxed text-stone-500">
                このレスポンスからは、このセクション向けの構造化データを十分に取り出せませんでした。
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatModelLabel(model?: string) {
  if (!model) return '補助ロジック';
  if (model === 'supplemental') return '補助ロジック';
  return model.replace(':free', '').replace(/^.*\//, '');
}
