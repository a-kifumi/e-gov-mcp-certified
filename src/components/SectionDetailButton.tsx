import React from 'react';

interface SectionDetailButtonProps {
  onClick: () => void;
}

export default function SectionDetailButton({ onClick }: SectionDetailButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-stone-300 bg-white/70 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-stone-500 transition-colors hover:border-black hover:text-black"
    >
      解析の詳細
    </button>
  );
}
