import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Bot, Sparkles } from 'lucide-react';
import type { ProgressState, SectionKey } from '../types';
import { buildPlaceholderTimeline, getProgressRatio, getRunningStageLabel, getAttemptStatusMeta, localizeUiMessage, formatModelLabel } from '../utils';
import TraceDetailModal from './TraceDetailModal.tsx';

interface AnalyzingViewProps {
  progressState: ProgressState | null;
}

export default function AnalyzingView({ progressState }: AnalyzingViewProps) {
  const timeline = progressState?.timeline?.length ? progressState.timeline : buildPlaceholderTimeline();
  const analysisTrace = progressState?.trace || null;
  const progressRatio = getProgressRatio(timeline);
  const runningStage = getRunningStageLabel(timeline);
  const finishedCount = timeline.filter((entry) => ['success', 'error', 'skipped'].includes(entry.status)).length;
  const [activeSection, setActiveSection] = useState<SectionKey | null>(null);

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="min-h-screen flex items-center justify-center px-6 py-16"
      >
        <div className="w-full max-w-6xl swiss-grid items-stretch">
        <div className="col-span-12 lg:col-span-4 clay-card p-8 md:p-10 flex flex-col justify-between relative overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-black via-stone-500 to-white opacity-70" />
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white/70 px-4 py-2 text-xs font-bold uppercase tracking-[0.25em] text-stone-500">
              <Sparkles className="w-4 h-4" />
              進行中
            </div>
            <h2 className="mt-6 text-4xl md:text-5xl tracking-tight">事案を解析しています</h2>
            <p className="mt-4 text-lg font-medium leading-relaxed text-stone-500">
              gemma を主系にして、論点整理から返信文まで4段階で順番に進めています。待ち時間のあいだも、いま何を組み立てているか追えるようにしています。
            </p>
          </div>

          <div className="my-10 flex items-center justify-center">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 3, ease: 'linear', repeat: Infinity }}
              className="relative h-32 w-32 rounded-full border-[14px] border-stone-200 border-t-black"
            >
              <div className="absolute inset-5 rounded-full border border-stone-300 bg-white/70" />
              <div className="absolute inset-0 flex items-center justify-center text-2xl font-black">{progressRatio}%</div>
            </motion.div>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between text-xs font-bold uppercase tracking-[0.25em] text-stone-400">
              <span>完了状況</span>
              <span>{finishedCount}/{timeline.length}</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-white/70">
              <motion.div
                animate={{ width: `${progressRatio}%` }}
                className="h-full rounded-full bg-black"
              />
            </div>
            {runningStage && (
              <p className="mt-4 text-xs font-bold uppercase tracking-[0.22em] text-stone-400">
                現在: {runningStage}
              </p>
            )}
            <p className="mt-4 text-sm font-semibold leading-relaxed text-stone-600">
              {progressState?.message || '解析の準備をしています。'}
            </p>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-8 clay-card p-6 md:p-8">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-stone-400">解析トラック</p>
              <h3 className="mt-2 text-2xl font-black">4段階進行</h3>
            </div>
            <div className="rounded-full bg-white/70 px-4 py-2 text-sm font-bold text-stone-600">
              ４段階で分析中
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {timeline.map((stageEntry) => {
              const statusMeta = getAttemptStatusMeta(stageEntry.status);
              const canOpenDetail = stageEntry.status === 'success' && Boolean(analysisTrace?.sections[stageEntry.stageKey]);
              return (
                <motion.div
                  key={stageEntry.slotId}
                  layout
                  initial={{ opacity: 0.65, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`rounded-[28px] border p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] ${statusMeta.card}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-sm font-black text-stone-900">
                          {stageEntry.order}
                        </span>
                        <div>
                          <p className="text-xs font-bold uppercase tracking-[0.22em] text-stone-400">{stageEntry.stageLabel}</p>
                          <h4 className="text-lg font-black">{stageEntry.label}</h4>
                        </div>
                      </div>
                    </div>
                    <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusMeta.badge}`}>
                      {statusMeta.label}
                    </span>
                  </div>

                  <div className="mt-4 flex items-center gap-2 text-sm font-semibold text-stone-500">
                    <Bot className="w-4 h-4" />
                    {stageEntry.model ? formatModelLabel(stageEntry.model) : 'gemma を優先'}
                  </div>

                  <div className="mt-4 rounded-2xl bg-white/70 px-4 py-4">
                    <p className="text-sm font-bold text-stone-800">{localizeUiMessage(stageEntry.headline)}</p>
                    <p className="mt-2 text-sm leading-relaxed text-stone-600">{localizeUiMessage(stageEntry.summary)}</p>
                    {stageEntry.fallbackUsed && (
                      <p className="mt-3 rounded-2xl bg-stone-100 px-3 py-2 text-xs font-bold leading-relaxed text-stone-700">
                        主モデルで詰まったため、この段階だけ予備モデルへ切り替えています。
                      </p>
                    )}
                    {stageEntry.status === 'error' && (
                      <p className="mt-3 rounded-2xl bg-red-100 px-3 py-2 text-xs font-bold leading-relaxed text-red-700">
                        {localizeUiMessage(stageEntry.summary)}
                      </p>
                    )}
                    {canOpenDetail && (
                      <button
                        type="button"
                        onClick={() => setActiveSection(stageEntry.stageKey)}
                        className="mt-4 inline-flex rounded-full border border-stone-300 bg-white px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-stone-600 transition-colors hover:border-black hover:text-black"
                      >
                        詳細を見る
                      </button>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
        </div>
      </motion.div>

      <TraceDetailModal
        analysisTrace={analysisTrace}
        sectionKey={activeSection}
        onClose={() => setActiveSection(null)}
      />
    </>
  );
}
