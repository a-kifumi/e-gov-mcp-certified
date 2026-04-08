import React from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, ArrowUpRight, ChevronRight } from 'lucide-react';
import { PRESETS } from '../constants';
import { openExternalUrl } from '../utils';

interface IntakeViewProps {
  clientName: string;
  setClientName: (name: string) => void;
  consultationText: string;
  setConsultationText: (text: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  error: string | null;
}

export default function IntakeView({
  clientName,
  setClientName,
  consultationText,
  setConsultationText,
  onSubmit,
  error,
}: IntakeViewProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="max-w-4xl mx-auto pt-[10vh] lg:pt-[15vh] px-6"
    >
      <div className="mb-12">
        <h1 className="text-6xl md:text-8xl tracking-tight mb-4 text-black">事案整理くんβ</h1>
        <p className="text-xl text-stone-500 font-medium">相談内容を整理し、初動対応を組み立てます</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-12">
        <div className="clay-panel p-8 md:p-12 space-y-8">
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <span className="text-xs font-bold uppercase tracking-widest text-stone-400 mr-2">相談例:</span>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setClientName(preset.clientName);
                    setConsultationText(preset.consultationText);
                  }}
                  className="px-4 py-2 text-xs font-bold bg-[#e8eaed] text-stone-600 rounded-full border border-stone-300 hover:text-black hover:border-black transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3 pt-4 border-t border-stone-300/50">
            <label className="block text-sm font-bold uppercase tracking-widest text-stone-400">相談者名</label>
            <input
              type="text"
              placeholder="例: 鈴木 太郎"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              className="w-full bg-transparent border-b-2 border-stone-300 focus:border-black py-3 text-2xl font-medium outline-none transition-colors placeholder:text-stone-300"
            />
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-bold uppercase tracking-widest text-stone-400">相談内容</label>
            <textarea
              placeholder="ご相談内容をこちらにペーストしてください..."
              value={consultationText}
              onChange={(e) => setConsultationText(e.target.value)}
              rows={6}
              className="w-full clay-inset p-6 text-lg font-medium outline-none resize-y placeholder:text-stone-400"
            />
            <div className="space-y-2 px-1 text-sm font-medium leading-relaxed text-stone-500">
              <p>※1日のAI使用上限を超えると、このサイトは使用できなくなります。</p>
              <p>
                ※このサイトはエージェントを使った模擬的なサイトです。さらなる改善や要望や問い合わせがあれば、
                <button
                  type="button"
                  onClick={() => openExternalUrl('https://note.com/akiufmi_dx')}
                  className="ml-1 inline-flex items-center gap-1 bg-transparent p-0 font-semibold text-stone-700 underline underline-offset-2 transition-colors hover:text-black"
                >
                  note のアカウント
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
                まで連絡してください。
              </p>
            </div>
          </div>

          {error && (
            <div className="bg-red-100 text-red-700 p-4 rounded-xl flex items-center gap-3 text-sm font-medium">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!consultationText.trim()}
            className="clay-btn-primary px-10 py-5 text-lg font-bold flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-wider"
          >
            解析を開始
            <ChevronRight className="w-6 h-6" />
          </button>
        </div>
      </form>
    </motion.div>
  );
}
