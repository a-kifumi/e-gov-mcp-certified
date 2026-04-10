import type { OpenRouterAttempt } from "../src/lib/ai/openrouter.ts";

export type DraftInitialReplyArgs = {
  case_id: string;
  client_name?: string;
  issues: string[];
  law_candidates?: string[];
  checklist: unknown[];
  tone?: "professional" | "concise" | "formal";
  include_disclaimer?: boolean;
};

export type FullCaseWorkflowArgs = {
  case_id: string;
  request_text: string;
  client_name?: string;
  domain_hint?: "auto" | "construction" | "kobutsu" | "fuei" | "immigration" | "waste" | "corporate";
  jurisdiction?: string;
  tone?: "professional" | "concise" | "formal";
  include_disclaimer: boolean;
  output_language: string;
};

export type ToolPayload = Record<string, unknown>;

export type WorkflowStageKey = "issues" | "lawCandidates" | "checklist" | "draftReply";
export type WorkflowStageStatus = "pending" | "running" | "success" | "error" | "skipped";

export type WorkflowStageTrace = {
  slotId: string;
  order: number;
  stageKey: WorkflowStageKey;
  stageLabel: string;
  label: string;
  status: WorkflowStageStatus;
  headline: string;
  summary: string;
  startedAt?: string;
  completedAt?: string;
  model?: string;
  fallbackUsed?: boolean;
  usedInFinal?: boolean;
};

export type WorkflowSectionAttemptTrace = {
  attemptId: string;
  model: string;
  status: "success" | "error" | "skipped";
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
    issues?: unknown[];
    lawCandidates?: unknown[];
    checklist?: unknown[];
    draftReply?: ToolPayload;
  };
};

export type WorkflowSectionTrace = {
  title: string;
  description: string;
  sourceLabel: string;
  sourceSlotId?: string;
  stageKey: WorkflowStageKey;
  finalModel?: string;
  fallbackUsed?: boolean;
  attempts: WorkflowSectionAttemptTrace[];
};

export type WorkflowTrace = {
  timeline: WorkflowStageTrace[];
  sections: {
    issues: WorkflowSectionTrace;
    lawCandidates: WorkflowSectionTrace;
    checklist: WorkflowSectionTrace;
    draftReply: WorkflowSectionTrace;
  };
};

export type WorkflowSectionKey = keyof WorkflowTrace["sections"];

export type WorkflowProgressEvent = {
  type: "progress" | "complete" | "error";
  message: string;
  timeline: WorkflowStageTrace[];
  trace?: WorkflowTrace;
  workflow?: ToolPayload;
  error?: string;
};

export type WorkflowExecutionHooks = {
  onProgress?: (event: WorkflowProgressEvent) => void;
};

export type DashboardChatArgs = {
  consultation_text: string;
  client_name?: string;
  user_message: string;
  history: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  selected_checklist_entries: Array<{
    label: string;
    answer: string;
  }>;
  case_data: {
    issues: Array<{ label: string; reason?: string }>;
    lawCandidates: Array<{ law_title: string; why_relevant?: string }>;
    checklist: Array<{ item?: string; question_to_client?: string; why_needed?: string }>;
    draftReply?: { subject?: string; body?: string; review_notes?: string[] };
  };
};

export type OpenRouterAttemptHook = {
  onAttempt?: (attempt: OpenRouterAttempt) => void;
};
