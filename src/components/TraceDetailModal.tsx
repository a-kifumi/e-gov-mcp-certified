import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import type { AnalysisTrace, SectionKey } from '../types';
import { getSectionAttempts, formatModelLabel } from '../utils';
import AttemptDetailCard from './AttemptDetailCard';

interface TraceDetailModalProps {
  analysisTrace: AnalysisTrace | null;
  sectionKey: SectionKey | null;
  onClose: () => void;
}

export default function TraceDetailModal({
  analysisTrace,
  sectionKey,
  onClose,
}: TraceDetailModalProps) {
  useEffect(() => {
    if (!sectionKey) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [sectionKey, onClose]);

  if (!sectionKey || !analysisTrace) {
    return null;
  }

  const section = analysisTrace.sections[sectionKey];
  const attempts = getSectionAttempts(analysisTrace, sectionKey);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          className="w-full max-w-5xl max-h-[88vh] overflow-hidden rounded-[36px] border border-white/50 bg-[#eef0f2] shadow-[24px_24px_60px_rgba(170,174,179,0.65),-16px_-16px_38px_rgba(255,255,255,0.9)]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="border-b border-stone-200/80 bg-white/70 px-6 py-5 md:px-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.28em] text-stone-400">解析の裏側</p>
                <h2 className="mt-2 text-3xl font-black">{section.title}</h2>
                <p className="mt-3 max-w-3xl text-sm leading-relaxed text-stone-600">{section.description}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-stone-300 bg-white/80 p-3 text-stone-500 transition-colors hover:border-black hover:text-black"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <span className="rounded-full border border-stone-300 bg-white/70 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-stone-500">
                採用元: {section.sourceLabel}
              </span>
              {section.finalModel && (
                <span className="rounded-full border border-stone-300 bg-white/70 px-4 py-2 text-xs font-bold text-stone-500">
                  使用モデル: {formatModelLabel(section.finalModel)}
                </span>
              )}
              <span className="rounded-full border border-stone-300 bg-white/70 px-4 py-2 text-xs font-bold text-stone-500">
                応答履歴 {attempts.length}件
              </span>
            </div>
          </div>

          <div className="max-h-[calc(88vh-156px)] overflow-y-auto px-6 py-6 md:px-8">
            <div className="grid grid-cols-1 gap-4">
              {attempts.length === 0 && (
                <div className="rounded-[28px] border border-stone-200 bg-white/75 p-6 text-sm font-medium leading-relaxed text-stone-600">
                  この段階は LLM 応答を保持していません。最終結果は補助ロジックで補完されています。
                </div>
              )}
              {attempts.map((attempt, index) => (
                <AttemptDetailCard
                  attempt={attempt}
                  attemptIndex={index + 1}
                  section={section}
                  sectionKey={sectionKey}
                />
              ))}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
