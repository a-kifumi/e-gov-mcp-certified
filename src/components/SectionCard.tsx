import React from 'react';
import SectionDetailButton from './SectionDetailButton';

interface SectionCardProps {
  icon: React.ReactNode;
  title: string;
  detailLabel?: string;
  onOpenTrace?: () => void;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}

export default function SectionCard({
  icon,
  title,
  detailLabel,
  onOpenTrace,
  headerAction,
  children,
}: SectionCardProps) {
  return (
    <div className="clay-card p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-3 text-lg font-bold uppercase tracking-widest text-stone-400">
            {icon}
            {title}
          </h3>
          {detailLabel && <p className="mt-2 text-sm font-semibold text-stone-500">{detailLabel}</p>}
        </div>
        <div className="flex items-center gap-3">
          {onOpenTrace && <SectionDetailButton onClick={onOpenTrace} />}
          {headerAction}
        </div>
      </div>
      {children}
    </div>
  );
}
