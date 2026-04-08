import React, { useState } from 'react';
import { AnimatePresence } from 'motion/react';
import type { CaseData, ChatMessage, ChecklistItem, ProgressState, WorkflowEvent } from './types';
import { streamCaseWorkflow, requestDashboardChat, buildPlaceholderTimeline, parseWorkflowToCaseData, localizeUiMessage, buildChecklistAnswerSummary, buildReanalysisRequestText, getChecklistLabel } from './utils';
import IntakeView from './components/IntakeView';
import AnalyzingView from './components/AnalyzingView';
import DashboardView from './components/DashboardView';

export default function App() {
  const [stage, setStage] = useState<'intake' | 'analyzing' | 'dashboard'>('intake');
  const [clientName, setClientName] = useState('');
  const [consultationText, setConsultationText] = useState('');
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [brushUpText, setBrushUpText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [progressState, setProgressState] = useState<ProgressState | null>(null);
  const [isChatSubmitting, setIsChatSubmitting] = useState(false);

  const runAnalysis = async ({
    requestText,
    resetHistory,
    fallbackStage,
    successHistoryMessage,
  }: {
    requestText: string;
    resetHistory?: boolean;
    fallbackStage?: 'intake' | 'dashboard';
    successHistoryMessage?: string;
  }) => {
    if (!requestText.trim()) return;
    setError(null);
    setStage('analyzing');
    setProgressState({
      message: '解析の準備をしています。',
      timeline: buildPlaceholderTimeline(),
      trace: null,
    });

    try {
      let finalWorkflow: WorkflowEvent['workflow'] | undefined;

      await streamCaseWorkflow(
        {
          case_id: `case-${Date.now()}`,
          request_text: requestText,
          client_name: clientName || 'お客様',
          domain_hint: 'auto',
          include_disclaimer: true,
          output_language: 'ja',
        },
        (event) => {
          if (event.type === 'error') {
            throw new Error(localizeUiMessage(event.error || event.message));
          }

      setProgressState({
            message: localizeUiMessage(event.message),
            timeline: event.timeline.length > 0 ? event.timeline : buildPlaceholderTimeline(),
            trace: event.trace || null,
          });

          if (event.type === 'complete' && event.workflow) {
            finalWorkflow = event.workflow;
          }
        },
      );

      if (!finalWorkflow) {
        throw new Error('解析結果を受信できませんでした。');
      }

      const newCaseData = parseWorkflowToCaseData(finalWorkflow);
      setCaseData(newCaseData);
      setConsultationText(requestText);
      setProgressState(null);
      if (resetHistory) {
        setHistory([
          {
            role: 'assistant',
            content: successHistoryMessage || '追加で質問があればどうぞ。',
          },
        ]);
      } else if (successHistoryMessage) {
        setHistory((prev) => [...prev, { role: 'assistant', content: successHistoryMessage }]);
      }

      setStage('dashboard');
    } catch (err) {
      setProgressState(null);
      setError(localizeUiMessage(err instanceof Error ? err.message : String(err)));
      setStage(fallbackStage || 'intake');
    }
  };

  const handleStartAnalysis = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    await runAnalysis({
      requestText: consultationText,
      resetHistory: true,
      fallbackStage: 'intake',
    });
  };

  const handleDashboardReanalysis = async (
    message: string,
    selectedChecklistEntries: Array<{ item: ChecklistItem; answer: string }>,
  ) => {
    if (!caseData) return;

    const pendingMessage = message.trim();
    const answerSummary = buildChecklistAnswerSummary(selectedChecklistEntries);
    const combinedMessage = [pendingMessage, answerSummary].filter(Boolean).join('\n\n');
    if (!combinedMessage) return;

    const requestText = buildReanalysisRequestText({
      consultationText,
      history,
      pendingMessage,
      selectedChecklistEntries,
    });

    setError(null);
    setHistory((prev) => [...prev, { role: 'user', content: combinedMessage }]);
    setBrushUpText('');

    await runAnalysis({
      requestText,
      fallbackStage: 'dashboard',
      successHistoryMessage: 'チャット内容と追加回答を踏まえて、解析結果を更新したぜ。',
      resetHistory: false,
    });
  };

  const handleDashboardChat = async (message: string, selectedChecklistEntries: Array<{ item: ChecklistItem; answer: string }>) => {
    if (!caseData) return;

    const trimmedMessage = message.trim();
    const answerSummary = buildChecklistAnswerSummary(selectedChecklistEntries);
    const combinedMessage = [trimmedMessage, answerSummary].filter(Boolean).join('\n\n');
    if (!combinedMessage) return;

    setError(null);
    setIsChatSubmitting(true);
    setHistory((prev) => [...prev, { role: 'user', content: combinedMessage }]);
    setBrushUpText('');
    try {
      const response = await requestDashboardChat({
        consultation_text: consultationText,
        client_name: clientName || 'お客様',
        user_message: trimmedMessage,
        history,
        selected_checklist_entries: selectedChecklistEntries.map(({ item, answer }) => ({
          label: getChecklistLabel(item),
          answer,
        })),
        case_data: {
          issues: caseData.issues,
          lawCandidates: caseData.lawCandidates,
          checklist: caseData.checklist,
          draftReply: caseData.draftReply,
        },
      });

      setHistory((prev) => [...prev, { role: 'assistant', content: response.reply || '応答を受信できませんでした。' }]);
    } catch (err) {
      setError(localizeUiMessage(err instanceof Error ? err.message : String(err)));
    } finally {
      setIsChatSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#e8eaed] text-[#111111] overflow-hidden selection:bg-black selection:text-white pb-24">
      <AnimatePresence mode="wait">
        {stage === 'intake' && (
          <IntakeView
            clientName={clientName}
            setClientName={setClientName}
            consultationText={consultationText}
            setConsultationText={setConsultationText}
            onSubmit={handleStartAnalysis}
            error={error}
          />
        )}

        {stage === 'analyzing' && (
          <AnalyzingView
            progressState={progressState}
          />
        )}

        {stage === 'dashboard' && caseData && (
          <DashboardView
            caseData={caseData}
            clientName={clientName}
            onReset={() => {
              setCaseData(null);
              setConsultationText('');
              setClientName('');
              setBrushUpText('');
              setError(null);
              setIsChatSubmitting(false);
              setHistory([]);
              setProgressState(null);
              setStage('intake');
            }}
            brushUpText={brushUpText}
            setBrushUpText={setBrushUpText}
            history={history}
            onChatSubmit={handleDashboardChat}
            onReanalyzeSubmit={handleDashboardReanalysis}
            isChatSubmitting={isChatSubmitting}
            error={error}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
