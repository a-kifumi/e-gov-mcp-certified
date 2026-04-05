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
  appName: string;
  siteUrl?: string;
};

export type PublicOpenRouterConfig = Omit<OpenRouterConfig, 'apiKey'> & {
  apiKeyConfigured: boolean;
};

export type OpenRouterChatResult = {
  attemptedModels: string[];
  content: string;
  model: string;
  raw: unknown;
};

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_PRIMARY_MODEL = 'qwen/qwen3.6-plus:free';
const DEFAULT_FALLBACK_MODELS = ['stepfun/step-3.5-flash:free'];
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

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object' && 'text' in part) {
        const text = part.text;
        return typeof text === 'string' ? text : '';
      }

      return '';
    })
    .join('\n')
    .trim();
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

  return {
    apiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    baseUrl: (env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, ''),
    primaryModel,
    fallbackModels: models.filter((model) => model !== primaryModel),
    models,
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
  },
  env: EnvSource = process.env,
): Promise<OpenRouterChatResult> {
  const config = getOpenRouterConfig(env);

  if (!config.apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const attemptedModels: string[] = [];
  const models = uniqueModels(options?.models?.length ? options.models : config.models);
  let lastError: Error | undefined;

  for (const model of models) {
    attemptedModels.push(model);

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
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

      if (!response.ok) {
        const body = await safeErrorBody(response);
        throw new Error(`OpenRouter request failed for ${model} (${response.status}): ${body}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: unknown;
          };
        }>;
      };

      const content = extractAssistantText(payload.choices?.[0]?.message?.content);

      if (!content) {
        throw new Error(`OpenRouter response for ${model} did not include assistant text`);
      }

      return {
        attemptedModels,
        content,
        model,
        raw: payload,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  const attempted = attemptedModels.join(', ');
  throw new Error(
    `OpenRouter failed for all configured models (${attempted}). ${lastError?.message ?? 'Unknown error'}`,
  );
}
