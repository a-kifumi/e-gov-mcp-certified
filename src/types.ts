export type Issue = { issue_code?: string; label: string; confidence?: number; reason?: string };
export type LawReference = { citation: string; summary?: string; egov_url?: string };
export type LawSource = {
  provider?: string;
  title?: string;
  law_id?: string;
  law_number?: string;
  version_id?: string;
  version_date?: string;
  source_url?: string;
  checked_on?: string;
};
export type LawCandidate = {
  law_title: string;
  relevance_score?: number;
  why_relevant?: string;
  references?: LawReference[];
  source?: LawSource;
};
export type ChecklistItem = { item?: string; priority?: string; why_needed?: string; question_to_client?: string };
export type DraftReply = { subject: string; body: string; disclaimer_flags?: string[]; review_notes?: string[] };
export type StageKey = 'issues' | 'lawCandidates' | 'checklist' | 'draftReply';

export type StageTrace = {
  slotId: string;
  order: number;
  stageKey: StageKey;
  stageLabel: string;
  label: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  headline: string;
  summary: string;
  startedAt?: string;
  completedAt?: string;
  model?: string;
  fallbackUsed?: boolean;
  usedInFinal?: boolean;
};

export type SectionAttemptTrace = {
  attemptId: string;
  model: string;
  status: 'success' | 'error' | 'skipped';
  stageLabel: string;
  label: string;
  headline: string;
  summary: string;
  startedAt?: string;
  completedAt?: string;
  contentPreview?: string;
  errorMessage?: string;
  usedInFinal?: boolean;
  isFallback?: boolean;
  extracted?: {
    issues?: Issue[];
    lawCandidates?: LawCandidate[];
    checklist?: ChecklistItem[];
    draftReply?: DraftReply;
  };
};

export type SectionTrace = {
  title: string;
  description: string;
  sourceLabel: string;
  sourceSlotId?: string;
  stageKey: StageKey;
  finalModel?: string;
  fallbackUsed?: boolean;
  attempts: SectionAttemptTrace[];
};

export type AnalysisTrace = {
  timeline: StageTrace[];
  sections: {
    issues: SectionTrace;
    lawCandidates: SectionTrace;
    checklist: SectionTrace;
    draftReply: SectionTrace;
  };
};

export type WorkflowSummary = {
  analysis_mode?: string;
  llm_error?: string | null;
  generated_at?: string;
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type CaseData = {
  issues: Issue[];
  lawCandidates: LawCandidate[];
  checklist: ChecklistItem[];
  draftReply: DraftReply;
  missingFacts: string[];
  analysisTrace: AnalysisTrace | null;
  workflowSummary: WorkflowSummary | null;
};

export type ProgressState = {
  status?: 'running' | 'error';
  message: string;
  timeline: StageTrace[];
  trace: AnalysisTrace | null;
};

export type WorkflowEvent = {
  type: 'progress' | 'complete' | 'error';
  message: string;
  timeline: StageTrace[];
  trace?: AnalysisTrace;
  workflow?: {
    outputs?: {
      issues?: { issues?: Issue[]; missing_facts?: string[] };
      related_laws?: { law_candidates?: LawCandidate[] };
      missing_information?: { checklist?: ChecklistItem[] };
      draft_reply?: DraftReply;
    };
    workflow_summary?: WorkflowSummary;
    analysis_trace?: AnalysisTrace;
  };
  error?: string;
};

export type SectionKey = keyof AnalysisTrace['sections'];
