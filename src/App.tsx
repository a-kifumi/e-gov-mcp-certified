/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useRef, useState } from 'react';
import {
  type WorkshopInputSample,
  getDefaultPromptArguments as getSharedDefaultPromptArguments,
  getDefaultToolArguments as getSharedDefaultToolArguments,
  getPromptInputSamples,
  getToolInputSamples,
} from './lib/workshopSamples';

type ToolSummary = {
  name: string;
  description?: string;
  defaultArguments?: Record<string, unknown>;
  samples?: WorkshopInputSample[];
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

type ResourceSummary = {
  uri: string;
  name: string;
};

type PromptSummary = {
  name: string;
  defaultArguments?: Record<string, unknown>;
  samples?: WorkshopInputSample[];
  arguments?: Array<{
    name: string;
    required?: boolean;
  }>;
};

type CatalogResponse = {
  tools: ToolSummary[];
  resources: ResourceSummary[];
  prompts: PromptSummary[];
};

type OutputState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  label: string;
  payload: unknown;
};

type DisplayMeta = {
  title: string;
  description: string;
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }

  return payload;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJsonText(text: string): unknown {
  const trimmed = text.trim();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

function formatLabel(label: string): string {
  return label
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

const TOOL_DISPLAY_META: Record<string, DisplayMeta> = {
  run_full_case_workflow: {
    title: '相談全体をまとめて整理',
    description: '論点抽出、関連法令、条文確認、不足情報、一次返信案まで一括で流すぜ。',
  },
  extract_issues_from_consultation: {
    title: '相談内容から論点を抽出',
    description: '相談文を読み、許認可や確認ポイントの候補を洗い出すぜ。',
  },
  search_relevant_laws: {
    title: '関連法令の候補を探す',
    description: '論点やキーワードから、当たりを付ける法令候補を整理するんな。',
  },
  trace_articles_and_references: {
    title: '条文と参照先をたどる',
    description: '起点条文から参照条文や委任先を追って、読む順番を組み立てるぜ。',
  },
  generate_missing_info_checklist: {
    title: '不足情報のヒアリング項目を作る',
    description: '初回相談で追加確認すべき資料や質問をチェックリスト化するんな。',
  },
  draft_initial_client_reply: {
    title: '顧客向けの一次返信案を作る',
    description: '確認前提の慎重な初回返信文を下書きするぜ。',
  },
};

const RESOURCE_DISPLAY_META: Record<string, DisplayMeta> = {
  'resource://domains/common_issue_patterns': {
    title: 'よくある論点パターン集',
    description: '業種ごとの典型論点やキーワードのメモだぜ。',
  },
  'resource://templates/client_reply_cautions': {
    title: '返信文で使う注意表現',
    description: '断定を避ける言い回しや、安全側の表現集だんな。',
  },
  'resource://runtime/llm_runtime_config': {
    title: 'LLM実行設定',
    description: '今どのモデル系統で動かしているか確認できるぜ。',
  },
  'resource://safety/human_review_rules': {
    title: '人間レビューの安全ルール',
    description: '送信前に人が見るべき判断基準をまとめたものだぜ。',
  },
};

const PROMPT_DISPLAY_META: Record<string, DisplayMeta> = {
  new_case_triage: {
    title: '新規相談の整理プロンプト',
    description: '論点抽出から一次返信までの流れをまとめて指示するんな。',
  },
  safe_initial_reply: {
    title: '安全な一次返信テンプレ',
    description: '断定を避けた返信を作るための基本指示だぜ。',
  },
};

function getToolDisplayMeta(tool: ToolSummary): DisplayMeta {
  return TOOL_DISPLAY_META[tool.name] ?? {
    title: tool.name,
    description: tool.description || 'この tool の表示説明はまだ未設定だぜ。',
  };
}

function getResourceDisplayMeta(resource: ResourceSummary): DisplayMeta {
  return RESOURCE_DISPLAY_META[resource.uri] ?? {
    title: resource.name,
    description: 'この resource の表示説明はまだ未設定だぜ。',
  };
}

function getPromptDisplayMeta(prompt: PromptSummary): DisplayMeta {
  return PROMPT_DISPLAY_META[prompt.name] ?? {
    title: prompt.name,
    description: 'この prompt の表示説明はまだ未設定だぜ。',
  };
}

function toDisplayBlocks(payload: unknown): Array<{ title: string; value: unknown }> {
  if (!payload) {
    return [];
  }

  if (typeof payload === 'string') {
    return [{ title: 'Message', value: tryParseJsonText(payload) }];
  }

  if (!isRecord(payload)) {
    return [{ title: 'Result', value: payload }];
  }

  if (Array.isArray(payload.content)) {
    return payload.content.map((item, index) => {
      if (isRecord(item) && typeof item.text === 'string') {
        return {
          title: item.type === 'text' ? `Content ${index + 1}` : `Item ${index + 1}`,
          value: tryParseJsonText(item.text),
        };
      }

      return { title: `Content ${index + 1}`, value: item };
    });
  }

  if (Array.isArray(payload.contents)) {
    return payload.contents.map((item, index) => {
      if (isRecord(item) && typeof item.text === 'string') {
        return {
          title: typeof item.uri === 'string' ? item.uri : `Resource ${index + 1}`,
          value: tryParseJsonText(item.text),
        };
      }

      return { title: `Resource ${index + 1}`, value: item };
    });
  }

  if (Array.isArray(payload.messages)) {
    return payload.messages.map((item, index) => {
      if (isRecord(item) && isRecord(item.content) && typeof item.content.text === 'string') {
        return {
          title: typeof item.role === 'string' ? `${item.role} message` : `Message ${index + 1}`,
          value: tryParseJsonText(item.content.text),
        };
      }

      return { title: `Message ${index + 1}`, value: item };
    });
  }

  return [{ title: 'Result', value: payload }];
}

function renderValue(value: unknown, depth = 0): JSX.Element {
  if (typeof value === 'string') {
    return (
      <div className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">
        {value}
      </div>
    );
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return (
      <div className="text-sm text-gray-800">
        {String(value)}
      </div>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <div className="text-sm text-gray-500">No items</div>;
    }

    return (
      <div className="space-y-3">
        {value.map((item, index) => (
          <div
            key={index}
            className={isRecord(item) ? 'rounded-lg border border-gray-200 bg-gray-50 p-3' : ''}
          >
            {isRecord(item) ? (
              renderValue(item, depth + 1)
            ) : (
              <div className="flex gap-2 text-sm text-gray-800">
                <span className="text-gray-400">{index + 1}.</span>
                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{String(item)}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);

    if (entries.length === 0) {
      return <div className="text-sm text-gray-500">Empty object</div>;
    }

    return (
      <div className="space-y-4">
        {entries.map(([key, entryValue]) => (
          <div key={key} className={depth > 0 ? 'rounded-lg border border-gray-200 bg-white p-3' : ''}>
            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
              {formatLabel(key)}
            </div>
            {renderValue(entryValue, depth + 1)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <pre className="overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-green-300">
      {formatJson(value)}
    </pre>
  );
}

function buildSampleValue(schema: unknown, keyName = ''): unknown {
  if (!schema || typeof schema !== 'object') {
    return keyName ? `sample_${keyName}` : 'sample_value';
  }

  const typedSchema = schema as {
    type?: string;
    default?: unknown;
    enum?: unknown[];
    items?: unknown;
    properties?: Record<string, unknown>;
  };

  if (typedSchema.default !== undefined) {
    return typedSchema.default;
  }

  if (Array.isArray(typedSchema.enum) && typedSchema.enum.length > 0) {
    return typedSchema.enum[0];
  }

  if (typedSchema.type === 'string') {
    if (keyName === 'case_id') {
      return '123';
    }
    if (keyName.includes('date')) {
      return '2026-04-05';
    }
    if (keyName.includes('uri')) {
      return 'sample://value';
    }
    return keyName ? `sample_${keyName}` : 'sample_text';
  }

  if (typedSchema.type === 'number' || typedSchema.type === 'integer') {
    return 1;
  }

  if (typedSchema.type === 'boolean') {
    return true;
  }

  if (typedSchema.type === 'array') {
    return [buildSampleValue(typedSchema.items, keyName ? `${keyName}_item` : 'item')];
  }

  if (typedSchema.type === 'object') {
    return buildSampleObjectFromSchema(typedSchema.properties);
  }

  return keyName ? `sample_${keyName}` : 'sample_value';
}

function buildSampleObjectFromSchema(properties?: Record<string, unknown>): Record<string, unknown> {
  if (!properties) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(properties).map(([key, schema]) => [key, buildSampleValue(schema, key)]),
  );
}

function buildPromptArgumentsFromDefinition(prompt: PromptSummary): Record<string, unknown> {
  if (prompt.defaultArguments && Object.keys(prompt.defaultArguments).length > 0) {
    return prompt.defaultArguments;
  }

  const sharedDefaults = getSharedDefaultPromptArguments(prompt.name);

  if (Object.keys(sharedDefaults).length > 0) {
    return sharedDefaults;
  }

  if (!prompt.arguments || prompt.arguments.length === 0) {
    return {};
  }

  return Object.fromEntries(
    prompt.arguments.map((argument) => [argument.name, `sample_${argument.name}`]),
  );
}

function getToolSamples(tool: ToolSummary): WorkshopInputSample[] {
  if (tool.samples && tool.samples.length > 0) {
    return tool.samples;
  }

  const sharedSamples = getToolInputSamples(tool.name);

  if (sharedSamples.length > 0) {
    return sharedSamples;
  }

  return [
    {
      id: `${tool.name}-fallback`,
      label: '基本サンプル',
      summary: '入力スキーマから組み立てた簡易サンプルだぜ。',
      arguments: buildSampleObjectFromSchema(tool.inputSchema?.properties),
    },
  ];
}

function getPromptSamples(prompt: PromptSummary): WorkshopInputSample[] {
  if (prompt.samples && prompt.samples.length > 0) {
    return prompt.samples;
  }

  const sharedSamples = getPromptInputSamples(prompt.name);

  if (sharedSamples.length > 0) {
    return sharedSamples;
  }

  return [
    {
      id: `${prompt.name}-fallback`,
      label: '基本サンプル',
      summary: 'prompt 引数の簡易サンプルだぜ。',
      arguments: buildPromptArgumentsFromDefinition(prompt),
    },
  ];
}

function getToolInitialArguments(tool: ToolSummary): Record<string, unknown> {
  const toolSamples = getToolSamples(tool);

  if (toolSamples.length > 0) {
    return toolSamples[0].arguments;
  }

  if (tool.defaultArguments && Object.keys(tool.defaultArguments).length > 0) {
    return tool.defaultArguments;
  }

  const sharedDefaults = getSharedDefaultToolArguments(tool.name);

  if (Object.keys(sharedDefaults).length > 0) {
    return sharedDefaults;
  }

  return buildSampleObjectFromSchema(tool.inputSchema?.properties);
}

function getPromptInitialArguments(prompt: PromptSummary): Record<string, unknown> {
  const promptSamples = getPromptSamples(prompt);

  if (promptSamples.length > 0) {
    return promptSamples[0].arguments;
  }

  return buildPromptArgumentsFromDefinition(prompt);
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [connectionStage, setConnectionStage] = useState<'idle' | 'loading' | 'connected'>('idle');
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [resources, setResources] = useState<ResourceSummary[]>([]);
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [output, setOutput] = useState<OutputState>({
    status: 'idle',
    label: '',
    payload: null,
  });
  const [connectionError, setConnectionError] = useState<string>('');
  const [selectedToolName, setSelectedToolName] = useState<string>('');
  const [toolArgumentsText, setToolArgumentsText] = useState<string>('{}');
  const [toolArgumentsError, setToolArgumentsError] = useState<string>('');
  const [selectedToolSampleId, setSelectedToolSampleId] = useState<string>('');
  const [selectedPromptName, setSelectedPromptName] = useState<string>('');
  const [promptArgumentsText, setPromptArgumentsText] = useState<string>('{}');
  const [promptArgumentsError, setPromptArgumentsError] = useState<string>('');
  const [selectedPromptSampleId, setSelectedPromptSampleId] = useState<string>('');
  const loadAttempted = useRef(false);

  useEffect(() => {
    if (loadAttempted.current) {
      return;
    }
    loadAttempted.current = true;

    let active = true;

    const loadCatalog = async () => {
      try {
        setConnectionStage('loading');

        const response = await fetch('/api/catalog');
        const payload = (await response.json()) as CatalogResponse & { error?: string };

        if (!response.ok) {
          throw new Error(payload.error || `Catalog request failed (${response.status})`);
        }

        if (!active) {
          return;
        }

        setConnected(true);
        setConnectionStage('connected');
        setConnectionError('');
        setTools(payload.tools);
        setResources(payload.resources);
        setPrompts(payload.prompts);
        if (payload.tools.length > 0) {
          const initialToolSamples = getToolSamples(payload.tools[0]);
          setSelectedToolName(payload.tools[0].name);
          setToolArgumentsText(formatJson(getToolInitialArguments(payload.tools[0])));
          setToolArgumentsError('');
          setSelectedToolSampleId(initialToolSamples[0]?.id ?? '');
        }
        if (payload.prompts.length > 0) {
          const initialPromptSamples = getPromptSamples(payload.prompts[0]);
          setSelectedPromptName(payload.prompts[0].name);
          setPromptArgumentsText(formatJson(getPromptInitialArguments(payload.prompts[0])));
          setPromptArgumentsError('');
          setSelectedPromptSampleId(initialPromptSamples[0]?.id ?? '');
        }
      } catch (error) {
        if (!active) {
          return;
        }

        setConnected(false);
        setConnectionStage('idle');
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    };

    void loadCatalog();

    return () => {
      active = false;
    };
  }, []);

  const handleSelectTool = (tool: ToolSummary) => {
    const toolSamples = getToolSamples(tool);
    setSelectedToolName(tool.name);
    setToolArgumentsText(formatJson(getToolInitialArguments(tool)));
    setToolArgumentsError('');
    setSelectedToolSampleId(toolSamples[0]?.id ?? '');
  };

  const handleSelectPrompt = (prompt: PromptSummary) => {
    const promptSamples = getPromptSamples(prompt);
    setSelectedPromptName(prompt.name);
    setPromptArgumentsText(formatJson(getPromptInitialArguments(prompt)));
    setPromptArgumentsError('');
    setSelectedPromptSampleId(promptSamples[0]?.id ?? '');
  };

  const handleApplyToolSample = (tool: ToolSummary, sample: WorkshopInputSample) => {
    setSelectedToolName(tool.name);
    setSelectedToolSampleId(sample.id);
    setToolArgumentsText(formatJson(sample.arguments));
    setToolArgumentsError('');
  };

  const handleApplyPromptSample = (prompt: PromptSummary, sample: WorkshopInputSample) => {
    setSelectedPromptName(prompt.name);
    setSelectedPromptSampleId(sample.id);
    setPromptArgumentsText(formatJson(sample.arguments));
    setPromptArgumentsError('');
  };

  const handleCallTool = async () => {
    if (!selectedToolName) {
      setOutput({
        status: 'error',
        label: 'Tool execution failed',
        payload: 'Select a tool first.',
      });
      return;
    }

    let parsedArguments: Record<string, unknown>;

    try {
      const parsed = JSON.parse(toolArgumentsText) as unknown;

      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('Tool input must be a JSON object.');
      }

      parsedArguments = parsed as Record<string, unknown>;
      setToolArgumentsError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToolArgumentsError(message);
      setOutput({
        status: 'error',
        label: 'Tool input error',
        payload: `Invalid tool input JSON. ${message}`,
      });
      return;
    }

    try {
      setOutput({
        status: 'loading',
        label: selectedToolName,
        payload: 'Calling tool...',
      });
      const result = await postJson('/api/tool', {
        name: selectedToolName,
        arguments: parsedArguments,
      });
      setOutput({
        status: 'ready',
        label: selectedToolName,
        payload: result,
      });
    } catch (error) {
      setOutput({
        status: 'error',
        label: selectedToolName,
        payload: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleReadResource = async (uri: string) => {
    try {
      setOutput({
        status: 'loading',
        label: uri,
        payload: 'Reading resource...',
      });
      const result = await postJson('/api/resource', { uri });
      setOutput({
        status: 'ready',
        label: uri,
        payload: result,
      });
    } catch (error) {
      setOutput({
        status: 'error',
        label: uri,
        payload: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleGetPrompt = async (name: string) => {
    let parsedArguments: Record<string, unknown>;

    try {
      const parsed = JSON.parse(promptArgumentsText) as unknown;

      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('Prompt input must be a JSON object.');
      }

      parsedArguments = parsed as Record<string, unknown>;
      setPromptArgumentsError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPromptArgumentsError(message);
      setOutput({
        status: 'error',
        label: 'Prompt input error',
        payload: `Invalid prompt input JSON. ${message}`,
      });
      return;
    }

    try {
      setOutput({
        status: 'loading',
        label: name,
        payload: 'Getting prompt...',
      });
      const result = await postJson('/api/prompt', { name, arguments: parsedArguments });
      setOutput({
        status: 'ready',
        label: name,
        payload: result,
      });
    } catch (error) {
      setOutput({
        status: 'error',
        label: name,
        payload: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8 font-sans">
      <div className="max-w-5xl mx-auto space-y-8">
        <header className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
          <h1 className="text-2xl font-semibold text-gray-900">Legal Intake & e-Gov Practice MCP Server</h1>
          <p className="text-gray-500 mt-2">
            Status: {connected ? <span className="text-green-600 font-medium">Connected</span> : <span className="text-amber-600 font-medium">Loading...</span>}
            {' '}
            {connectionStage === 'loading' && <span className="text-blue-600 font-medium">Fetching workshop catalog...</span>}
          </p>
          {connectionError && (
            <p className="mt-2 text-sm text-red-600">
              Connection error: {connectionError}
            </p>
          )}
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,0.9fr)_minmax(0,1.1fr)] gap-8 items-start">
          <div className="space-y-6">
            <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h2 className="text-lg font-medium text-gray-900 mb-4">Tools</h2>
              <div className="space-y-2">
                {tools.map((tool) => (
                  <button
                    key={tool.name}
                    onClick={() => handleSelectTool(tool)}
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                      selectedToolName === tool.name
                        ? 'border-blue-500 bg-blue-50 text-blue-900'
                        : 'border-gray-200 hover:border-blue-500 hover:bg-blue-50 text-gray-700'
                    }`}
                  >
                    <div className="text-sm font-medium">
                      {getToolDisplayMeta(tool).title}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {getToolDisplayMeta(tool).description}
                    </div>
                  </button>
                ))}
                {tools.length === 0 && <p className="text-sm text-gray-500">No tools available</p>}
              </div>
              {selectedToolName && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Tool Input</p>
                      <p className="text-xs text-gray-500">現場でよくある相談をサンプル化してある。近いものを選んでから調整しろよな。</p>
                    </div>
                    <button
                      onClick={handleCallTool}
                      className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                    >
                      Run Tool
                    </button>
                  </div>
                  {(() => {
                    const selectedTool = tools.find((tool) => tool.name === selectedToolName);

                    if (!selectedTool) {
                      return null;
                    }

                    const samples = getToolSamples(selectedTool);
                    const activeSample = samples.find((sample) => sample.id === selectedToolSampleId) ?? samples[0];

                    return (
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                          {samples.map((sample) => (
                            <button
                              key={sample.id}
                              onClick={() => handleApplyToolSample(selectedTool, sample)}
                              className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                                selectedToolSampleId === sample.id
                                  ? 'border-blue-600 bg-blue-100 text-blue-900'
                                  : 'border-gray-200 bg-white text-gray-700 hover:border-blue-400 hover:text-blue-900'
                              }`}
                            >
                              {sample.label}
                            </button>
                          ))}
                        </div>
                        {activeSample && (
                          <p className="text-xs text-gray-500">
                            {activeSample.summary}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                  <textarea
                    value={toolArgumentsText}
                    onChange={(event) => {
                      setToolArgumentsText(event.target.value);
                      if (toolArgumentsError) {
                        setToolArgumentsError('');
                      }
                    }}
                    spellCheck={false}
                    className="w-full h-56 rounded-lg border border-gray-200 bg-gray-950 text-green-300 font-mono text-xs p-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {toolArgumentsError && (
                    <p className="text-xs text-red-600">
                      JSON error: {toolArgumentsError}
                    </p>
                  )}
                </div>
              )}
            </section>

            <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h2 className="text-lg font-medium text-gray-900 mb-4">Resources</h2>
              <div className="space-y-2">
                {resources.map((resource) => (
                  <button
                    key={resource.uri}
                    onClick={() => handleReadResource(resource.uri)}
                    className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-green-500 hover:bg-green-50 transition-colors text-gray-700"
                  >
                    <div className="text-sm font-medium">
                      {getResourceDisplayMeta(resource).title}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {getResourceDisplayMeta(resource).description}
                    </div>
                  </button>
                ))}
                {resources.length === 0 && <p className="text-sm text-gray-500">No resources available</p>}
              </div>
            </section>

            <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h2 className="text-lg font-medium text-gray-900 mb-4">Prompts</h2>
              <div className="space-y-2">
                {prompts.map((prompt) => (
                  <button
                    key={prompt.name}
                    onClick={() => handleSelectPrompt(prompt)}
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                      selectedPromptName === prompt.name
                        ? 'border-purple-500 bg-purple-50 text-purple-900'
                        : 'border-gray-200 hover:border-purple-500 hover:bg-purple-50 text-gray-700'
                    }`}
                  >
                    <div className="text-sm font-medium">
                      {getPromptDisplayMeta(prompt).title}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {getPromptDisplayMeta(prompt).description}
                    </div>
                  </button>
                ))}
                {prompts.length === 0 && <p className="text-sm text-gray-500">No prompts available</p>}
              </div>
              {selectedPromptName && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Prompt Input</p>
                      <p className="text-xs text-gray-500">用途に近い相談文を選んで、そこから直すと早ぇぜ。</p>
                    </div>
                    <button
                      onClick={() => handleGetPrompt(selectedPromptName)}
                      className="px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700"
                    >
                      Run Prompt
                    </button>
                  </div>
                  {(() => {
                    const selectedPrompt = prompts.find((prompt) => prompt.name === selectedPromptName);

                    if (!selectedPrompt) {
                      return null;
                    }

                    const samples = getPromptSamples(selectedPrompt);
                    const activeSample = samples.find((sample) => sample.id === selectedPromptSampleId) ?? samples[0];

                    return (
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                          {samples.map((sample) => (
                            <button
                              key={sample.id}
                              onClick={() => handleApplyPromptSample(selectedPrompt, sample)}
                              className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                                selectedPromptSampleId === sample.id
                                  ? 'border-purple-600 bg-purple-100 text-purple-900'
                                  : 'border-gray-200 bg-white text-gray-700 hover:border-purple-400 hover:text-purple-900'
                              }`}
                            >
                              {sample.label}
                            </button>
                          ))}
                        </div>
                        {activeSample && (
                          <p className="text-xs text-gray-500">
                            {activeSample.summary}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                  <textarea
                    value={promptArgumentsText}
                    onChange={(event) => {
                      setPromptArgumentsText(event.target.value);
                      if (promptArgumentsError) {
                        setPromptArgumentsError('');
                      }
                    }}
                    spellCheck={false}
                    className="w-full h-40 rounded-lg border border-gray-200 bg-gray-950 text-green-300 font-mono text-xs p-4 focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  {promptArgumentsError && (
                    <p className="text-xs text-red-600">
                      JSON error: {promptArgumentsError}
                    </p>
                  )}
                </div>
              )}
            </section>
          </div>

          <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden xl:sticky xl:top-8">
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center">
              <div>
                <h2 className="text-lg font-medium text-gray-900">Output</h2>
                <p className="text-xs text-gray-500 mt-1">
                  {output.label || '選択した tool / resource / prompt の結果をここに整形表示するぜ。'}
                </p>
              </div>
              <button
                onClick={() => setOutput({ status: 'idle', label: '', payload: null })}
                className="text-xs text-gray-500 hover:text-gray-900"
              >
                Clear
              </button>
            </div>
            <div className="p-6 space-y-4 max-h-[calc(100vh-12rem)] overflow-auto">
              {output.status === 'idle' && (
                <p className="text-sm text-gray-500">
                  左の項目を実行すると、`text` の中身を読みやすく整えてここに出すんな。
                </p>
              )}

              {output.status === 'loading' && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                  {typeof output.payload === 'string' ? output.payload : 'Loading...'}
                </div>
              )}

              {output.status === 'error' && (
                <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-800 whitespace-pre-wrap">
                  {typeof output.payload === 'string' ? output.payload : formatJson(output.payload)}
                </div>
              )}

              {output.status === 'ready' && (
                <div className="space-y-4">
                  {toDisplayBlocks(output.payload).map((block, index) => (
                    <section key={`${block.title}-${index}`} className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                      <h3 className="text-sm font-semibold text-gray-900 mb-3">
                        {block.title}
                      </h3>
                      {renderValue(block.value)}
                    </section>
                  ))}

                  <details className="rounded-xl border border-gray-200 bg-white">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700">
                      Raw JSON
                    </summary>
                    <div className="border-t border-gray-200 p-4">
                      <pre className="overflow-auto rounded-lg bg-gray-950 p-4 text-xs text-green-300 whitespace-pre-wrap break-words">
                        {formatJson(output.payload)}
                      </pre>
                    </div>
                  </details>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
