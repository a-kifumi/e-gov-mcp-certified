import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight, FileText, Scale, CheckSquare, MessageSquare, Plus, RefreshCw, Send, AlertTriangle } from 'lucide-react';

// --- API Utils ---
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

// --- Types ---
type Issue = { issue_code?: string; label: string; confidence?: number; reason?: string };
type LawCandidate = { law_title: string; relevance_score?: number; why_relevant?: string };
type ChecklistItem = { item?: string; priority?: string; why_needed?: string; question_to_client?: string };
type DraftReply = { subject: string; body: string; disclaimer_flags?: string[]; review_notes?: string[] };

type CaseData = {
  issues: Issue[];
  lawCandidates: LawCandidate[];
  checklist: ChecklistItem[];
  draftReply: DraftReply;
  missingFacts: string[];
};

export default function App() {
  const [stage, setStage] = useState<'intake' | 'analyzing' | 'dashboard'>('intake');
  const [clientName, setClientName] = useState('');
  const [consultationText, setConsultationText] = useState('');
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [brushUpText, setBrushUpText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{role: 'user' | 'assistant', content: string}[]>([]);

  const handleStartAnalysis = async (e?: React.FormEvent, isBrushUp = false) => {
    if (e) e.preventDefault();
    if (!consultationText.trim() && !isBrushUp) return;
    if (isBrushUp && !brushUpText.trim()) return;

    setError(null);
    setStage('analyzing');

    // Setup the accumulative consultation context
    let fullContext = consultationText;
    if (isBrushUp) {
      fullContext += `\n\n【追加の顧客回答・情報】：\n${brushUpText}`;
      setHistory(prev => [...prev, { role: 'user', content: brushUpText }]);
      setConsultationText(fullContext);
      setBrushUpText('');
    }

    try {
      const response = await postJson<{ content: { text: string }[] }>('/api/tool', {
        name: 'run_full_case_workflow',
        arguments: {
          case_id: `case-${Date.now()}`,
          request_text: fullContext,
          client_name: clientName || 'お客様',
          domain_hint: 'auto',
          include_disclaimer: true,
        },
      });

      const parsedInner = JSON.parse(response.content[0].text);
      const outputs = parsedInner.outputs || {};
      
      const newCaseData: CaseData = {
        issues: outputs.issues?.issues || [],
        missingFacts: outputs.issues?.missing_facts || [],
        lawCandidates: outputs.related_laws?.law_candidates || [],
        checklist: outputs.missing_information?.checklist || [],
        draftReply: outputs.draft_reply || { subject: 'No subject', body: 'No body generated.' },
      };

      setCaseData(newCaseData);
      
      if (isBrushUp) {
        setHistory(prev => [...prev, { role: 'assistant', content: '情報を更新しました。' }]);
      } else {
        setHistory([{ role: 'user', content: consultationText }]);
      }

      setStage('dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage(isBrushUp && caseData ? 'dashboard' : 'intake');
    }
  };

  return (
    <div className="min-h-screen bg-[#e8eaed] text-[#111111] overflow-hidden selection:bg-black selection:text-white pb-24">
      <AnimatePresence mode="wait">
        {stage === 'intake' && (
          <IntakeView 
            key="intake"
            clientName={clientName}
            setClientName={setClientName}
            consultationText={consultationText}
            setConsultationText={setConsultationText}
            onSubmit={handleStartAnalysis}
            error={error}
          />
        )}
        
        {stage === 'analyzing' && <AnalyzingView key="analyzing" />}

        {stage === 'dashboard' && caseData && (
          <DashboardView 
            key="dashboard"
            caseData={caseData}
            clientName={clientName}
            onReset={() => {
              setCaseData(null);
              setConsultationText('');
              setClientName('');
              setHistory([]);
              setStage('intake');
            }}
            brushUpText={brushUpText}
            setBrushUpText={setBrushUpText}
            onBrushUp={(e) => handleStartAnalysis(e, true)}
            error={error}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

const PRESETS = [
  {
    label: "飲食店(深夜営業)",
    clientName: "バーテンダー 山田",
    consultationText: "駅前でダーツバーを開業しようと思っています。\nお酒を提供しつつ、お客様と一緒にゲームを楽しめるスタイルを予定しています。\n朝の5時ごろまで営業したいのですが、何か特別な手続きや許可は必要でしょうか？\n店舗面積は15坪ほどで、カウンター席とボックス席があります。",
  },
  {
    label: "建設業許可(新規)",
    clientName: "株式会社ビルド・タナカ",
    consultationText: "現在、個人事業主として大工仕事や内装トラブルの修繕を請け負っています。\n来月から法人成りして、500万円以上のリフォーム工事も受注していきたいと考えています。\n自分は10年以上実務経験がありますが、国家資格は持っていません。\nどのような条件を満たせば許可が取れますか？",
  },
  {
    label: "外国人在留資格",
    clientName: "IT企業 採用担当",
    consultationText: "この度、ベトナム国籍のエンジニアを採用することになりました。\n彼は日本の専門学校で「情報処理」を学んで来月卒業予定です。\n弊社では主にウェブアプリケーションの開発やサーバー保守を担当してもらう予定です。\nビザの変更手続きが必要だと思うのですが、どのような書類やフローになりますか？",
  }
];

function IntakeView({ clientName, setClientName, consultationText, setConsultationText, onSubmit, error }: any) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="max-w-4xl mx-auto pt-[10vh] lg:pt-[15vh] px-6"
    >
      <div className="mb-12">
        <h1 className="text-6xl md:text-8xl tracking-tight mb-4 text-black">Triage.</h1>
        <p className="text-xl text-stone-500 font-medium">Automatic Intake & Case Structuring</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-12">
        <div className="clay-panel p-8 md:p-12 space-y-8">
          
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <span className="text-xs font-bold uppercase tracking-widest text-stone-400 mr-2">Quick Presets:</span>
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
            <label className="block text-sm font-bold uppercase tracking-widest text-stone-400">Client Name</label>
            <input 
              type="text" 
              placeholder="Ex: 鈴木 太郎"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              className="w-full bg-transparent border-b-2 border-stone-300 focus:border-black py-3 text-2xl font-medium outline-none transition-colors placeholder:text-stone-300"
            />
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-bold uppercase tracking-widest text-stone-400">Consultation Details</label>
            <textarea 
              placeholder="ご相談内容をこちらにペーストしてください..."
              value={consultationText}
              onChange={(e) => setConsultationText(e.target.value)}
              rows={6}
              className="w-full clay-inset p-6 text-lg font-medium outline-none resize-y placeholder:text-stone-400"
            />
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
            Start Analysis
            <ChevronRight className="w-6 h-6" />
          </button>
        </div>
      </form>
    </motion.div>
  );
}

function AnalyzingView() {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="min-h-screen flex flex-col items-center justify-center font-bold text-center"
    >
      <motion.div 
        animate={{ rotate: 360 }}
        transition={{ duration: 3, ease: "linear", repeat: Infinity }}
        className="w-24 h-24 border-[12px] border-stone-200 border-t-black rounded-full mb-12"
      />
      <h2 className="text-4xl md:text-5xl tracking-tight mb-4">Processing Case</h2>
      <p className="text-stone-500 text-xl font-medium">Extracting issues, retrieving laws, generating replies...</p>
    </motion.div>
  );
}

function DashboardView({ caseData, clientName, onReset, brushUpText, setBrushUpText, onBrushUp, error }: any) {
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="max-w-[1400px] mx-auto px-6 py-12"
    >
      {/* Header */}
      <div className="flex justify-between items-center mb-12">
        <div>
          <h1 className="text-4xl md:text-5xl tracking-tight font-black mb-2">{clientName || 'お客様'}の事案</h1>
          <p className="text-stone-500 font-medium">Intake Dashboard</p>
        </div>
        <button 
          onClick={onReset} 
          className="clay-btn p-4 rounded-full text-stone-500 hover:text-black"
          title="New Case"
        >
          <RefreshCw className="w-6 h-6" />
        </button>
      </div>

      {/* Swiss Grid Layout */}
      <div className="swiss-grid">
        
        {/* Left Column: Triage & Data */}
        <div className="col-span-12 lg:col-span-4 space-y-8">
          
          <div className="clay-card p-8">
            <h3 className="flex items-center gap-3 text-lg font-bold uppercase tracking-widest text-stone-400 mb-6">
              <FileText className="w-5 h-5" />
              Identified Issues
            </h3>
            <div className="space-y-4">
              {caseData.issues?.map((issue: Issue, i: number) => (
                <div key={i} className="border-l-4 border-black pl-5 py-1">
                  <h4 className="font-bold text-lg">{issue.label}</h4>
                  {issue.reason && <p className="text-stone-500 text-sm mt-1 leading-relaxed">{issue.reason}</p>}
                </div>
              ))}
              {caseData.issues?.length === 0 && <p className="text-stone-400 font-medium">No clear issues identified.</p>}
            </div>
          </div>

          <div className="clay-card p-8">
            <h3 className="flex items-center gap-3 text-lg font-bold uppercase tracking-widest text-stone-400 mb-6">
              <Scale className="w-5 h-5" />
              Relevant Laws
            </h3>
            <div className="space-y-4">
              {caseData.lawCandidates?.map((law: LawCandidate, i: number) => (
                <div key={i} className="clay-inset p-4">
                  <h4 className="font-bold text-md mb-1">{law.law_title}</h4>
                  <p className="text-stone-500 text-xs font-semibold">{law.why_relevant}</p>
                </div>
              ))}
              {caseData.lawCandidates?.length === 0 && <p className="text-stone-400 font-medium">No specific laws triggered.</p>}
            </div>
          </div>

        </div>

        {/* Right Column: Output & Actionable */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-8">
          
          {/* Main Actionable Box: Draft Reply */}
          <div className="clay-card p-8 md:p-12 flex-grow bg-white">
            <div className="flex justify-between items-start mb-8">
              <h3 className="flex items-center gap-3 text-lg font-bold uppercase tracking-widest text-stone-400">
                <MessageSquare className="w-5 h-5" />
                Draft Initial Reply
              </h3>
            </div>
            
            <div className="clay-inset bg-[#fcfcfc] p-6 md:p-8 rounded-2xl relative overflow-hidden group">
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

            {/* Caveats */}
            {caseData.draftReply.review_notes && caseData.draftReply.review_notes.length > 0 && (
              <div className="mt-8 pt-8 border-t border-stone-200">
                <h4 className="text-xs font-bold uppercase tracking-widest text-stone-400 mb-3">Review Notes</h4>
                <ul className="flex flex-wrap gap-2">
                  {caseData.draftReply.review_notes.map((note: string, i: number) => (
                    <li key={i} className="bg-red-100 text-red-800 px-3 py-1 rounded-full text-xs font-bold">
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Missing Information Checklist */}
          <div className="clay-card p-8">
            <h3 className="flex items-center gap-3 text-lg font-bold uppercase tracking-widest text-stone-400 mb-6">
              <CheckSquare className="w-5 h-5" />
              Information Checklist
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {caseData.checklist?.map((item: ChecklistItem, i: number) => (
                <div key={i} className="clay-inset p-5 flex items-start gap-4">
                  <div className="mt-1 flex-shrink-0 w-6 h-6 rounded border-2 border-black opacity-30"></div>
                  <div>
                    <h4 className="font-bold text-md mb-1">{item.item || item.question_to_client || '確認事項'}</h4>
                    {item.why_needed && (
                      <p className="text-stone-500 text-xs font-semibold">{item.why_needed}</p>
                    )}
                  </div>
                </div>
              ))}
              {caseData.checklist?.length === 0 && <p className="text-stone-400 font-medium">No missing information detected.</p>}
            </div>
          </div>
          
        </div>
      </div>

      {/* Floating Brush Up / Interactivity Bar */}
      <div className="fixed bottom-0 left-0 w-full p-6 z-50">
        <div className="max-w-[1400px] mx-auto flex items-end justify-center md:justify-end">
          <form 
            onSubmit={onBrushUp}
            className="w-full md:w-1/2 clay-card p-3 flex gap-3 backdrop-blur-md bg-[#e8eaed]/90"
          >
            <input 
              type="text"
              placeholder="顧客の追加質問や事実を入力してブラッシュアップ..."
              value={brushUpText}
              onChange={(e) => setBrushUpText(e.target.value)}
              className="flex-grow bg-transparent px-4 py-3 text-md font-medium outline-none placeholder:text-stone-400"
            />
            <button 
              type="submit"
              disabled={!brushUpText.trim()}
              className="clay-btn-primary p-4 rounded-2xl flex-shrink-0 disabled:opacity-50"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>
        {error && (
          <div className="max-w-[1400px] mx-auto mt-2">
            <div className="bg-red-100 text-red-700 p-3 rounded-lg text-sm font-bold text-center">
              Error applying brush up: {error}
            </div>
          </div>
        )}
      </div>

    </motion.div>
  );
}
