type EnvSource = Record<string, string | undefined>;

export type OpenRouterChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type OpenRouterConfig = {
  apiKey?: string;
  baseUrl: string;
  primaryModel: string;
  fallbackModels: string[];
  models: string[];
  timeoutMs: number;
  appName: string;
  siteUrl?: string;
};

export type PublicOpenRouterConfig = Omit<OpenRouterConfig, 'apiKey'> & {
  apiKeyConfigured: boolean;
};

export type OpenRouterChatResult = {
  attemptedModels: string[];
  attempts: OpenRouterAttempt[];
  content: string;
  model: string;
  raw: unknown;
};

export type OpenRouterAttempt = {
  model: string;
  status: 'success' | 'error';
  startedAt: string;
  completedAt: string;
  content?: string;
  raw?: unknown;
  error?: string;
};

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_PRIMARY_MODEL = 'google/gemma-4-31b-it';
const DEFAULT_FALLBACK_MODELS = ['qwen/qwen3.5-35b-a3b'];
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_APP_NAME = 'legal-intake-egov-mcp';

function uniqueModels(models: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const model of models) {
    if (!seen.has(model)) {
      seen.add(model);
      deduped.push(model);
    }
  }

  return deduped;
}

function parseModelList(raw?: string): string[] {
  return raw
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function collectTextSegments(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) {
    return [];
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextSegments(item, depth + 1));
  }

  if (typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = ['text', 'content', 'output_text', 'message', 'reasoning'];
  const segments: string[] = [];

  for (const key of preferredKeys) {
    if (key in record) {
      segments.push(...collectTextSegments(record[key], depth + 1));
    }
  }

  if (segments.length > 0) {
    return segments;
  }

  return Object.values(record).flatMap((item) => collectTextSegments(item, depth + 1));
}

function extractAssistantText(content: unknown): string {
  return collectTextSegments(content)
    .join('\n')
    .trim();
}

function summarizePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload).slice(0, 1000);
  } catch {
    return String(payload).slice(0, 1000);
  }
}

async function safeErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 1000);
  } catch {
    return '';
  }
}

export function getOpenRouterConfig(env: EnvSource = process.env): OpenRouterConfig {
  const primaryModel = env.OPENROUTER_PRIMARY_MODEL?.trim() || DEFAULT_PRIMARY_MODEL;
  const fallbackModels = parseModelList(env.OPENROUTER_FALLBACK_MODELS);
  const effectiveFallbacks = fallbackModels.length > 0 ? fallbackModels : DEFAULT_FALLBACK_MODELS;
  const models = uniqueModels([primaryModel, ...effectiveFallbacks]).filter(Boolean);
  const parsedTimeout = Number.parseInt(env.OPENROUTER_TIMEOUT_MS?.trim() || '', 10);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;

  return {
    apiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    baseUrl: (env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ''),
    primaryModel,
    fallbackModels: models.filter((model) => model !== primaryModel),
    models,
    timeoutMs,
    appName: env.OPENROUTER_APP_NAME?.trim() || DEFAULT_APP_NAME,
    siteUrl: env.APP_URL?.trim() || undefined,
  };
}

export function getPublicOpenRouterConfig(env: EnvSource = process.env): PublicOpenRouterConfig {
  const config = getOpenRouterConfig(env);

  return {
    apiKeyConfigured: Boolean(config.apiKey),
    baseUrl: config.baseUrl,
    primaryModel: config.primaryModel,
    fallbackModels: config.fallbackModels,
    models: config.models,
    timeoutMs: config.timeoutMs,
    appName: config.appName,
    siteUrl: config.siteUrl,
  };
}

export async function createOpenRouterChatCompletion(
  messages: OpenRouterChatMessage[],
  options?: {
    maxTokens?: number;
    models?: string[];
    temperature?: number;
    onAttempt?: (attempt: OpenRouterAttempt) => void;
  },
  env: EnvSource = process.env,
): Promise<OpenRouterChatResult> {
  const config = getOpenRouterConfig(env);

  if (!config.apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const attemptedModels: string[] = [];
  const attempts: OpenRouterAttempt[] = [];
  const models = uniqueModels(options?.models?.length ? options.models : config.models);
  const modelErrors: string[] = [];

  for (const model of models) {
    attemptedModels.push(model);
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`OpenRouter request timed out after ${config.timeoutMs}ms`));
    }, config.timeoutMs);

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          ...(config.siteUrl ? { 'HTTP-Referer': config.siteUrl } : {}),
          'X-Title': config.appName,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options?.temperature ?? 0.2,
          max_tokens: options?.maxTokens ?? 900,
        }),
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await safeErrorBody(response);
        throw new Error(`OpenRouter request failed for ${model} (${response.status}): ${body}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{
          text?: unknown;
          message?: {
            content?: unknown;
            reasoning?: unknown;
          };
        }>;
      };

      const choice = payload.choices?.[0];
      const content = extractAssistantText(
        choice?.message?.content
        ?? choice?.message?.reasoning
        ?? choice?.text
        ?? payload,
      );

      if (!content) {
        throw new Error(
          `OpenRouter response for ${model} did not include assistant text. payload=${summarizePayload(payload)}`,
        );
      }

      const completedAt = new Date().toISOString();
      const successAttempt: OpenRouterAttempt = {
        model,
        status: 'success',
        startedAt,
        completedAt,
        content,
        raw: payload,
      };
      attempts.push(successAttempt);
      options?.onAttempt?.(successAttempt);

      return {
        attemptedModels,
        attempts,
        content,
        model,
        raw: payload,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : String(error);
      modelErrors.push(`${model}: ${message}`);
      const completedAt = new Date().toISOString();
      const failedAttempt: OpenRouterAttempt = {
        model,
        status: 'error',
        startedAt,
        completedAt,
        error: message,
      };
      attempts.push(failedAttempt);
      options?.onAttempt?.(failedAttempt);
    }
  }

  const attempted = attemptedModels.join(', ');
  throw new Error(
    `OpenRouter failed for all configured models (${attempted}). ${modelErrors.join(' | ') || 'Unknown error'}`,
  );
}
