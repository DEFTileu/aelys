import type { AIProvider } from '@aelys/shared'

export type Capability = 'tools' | 'vision' | 'thinking'
export type Effort = 'off' | 'low' | 'medium' | 'high'
export interface ModelInfo {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly context_tokens?: number
  /** 1 slower, 2 balanced, 3 fast */
  readonly speed?: 1 | 2 | 3
  /** 0 free ... 4 $$$$ */
  readonly cost?: 0 | 1 | 2 | 3 | 4
  readonly capabilities: readonly Capability[]
}
/** Provider + model (+ reasoning effort). `model: 'auto'` lets the backend pick. */
export interface ModelChoice { readonly providerId: string; readonly model: string; readonly effort?: Effort }

export const PROVIDER_LABEL: Readonly<Record<string, string>> = { claude: 'Claude', openrouter: 'OpenRouter' }
export const providerLabel = (kind: string) => PROVIDER_LABEL[kind] ?? kind

// Frontend catalog keyed by provider.kind; provider.model_policy.models overrides it.
export const MODEL_CATALOG: Readonly<Record<string, readonly ModelInfo[]>> = {
  claude: [
    { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', description: 'Best balance of quality and speed', context_tokens: 200000, speed: 2, cost: 2, capabilities: ['tools', 'vision', 'thinking'] },
    { id: 'claude-opus-4-1', name: 'Opus 4.1', description: 'Deepest reasoning for hard problems', context_tokens: 200000, speed: 1, cost: 4, capabilities: ['tools', 'vision', 'thinking'] },
    { id: 'claude-haiku-4-5', name: 'Haiku 4.5', description: 'Fast answers for quick questions', context_tokens: 200000, speed: 3, cost: 1, capabilities: ['tools', 'vision'] },
  ],
  openrouter: [
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', description: 'Cheap and solid for everyday asks', context_tokens: 128000, speed: 2, cost: 1, capabilities: ['tools'] },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Huge context for long documents', context_tokens: 1000000, speed: 2, cost: 3, capabilities: ['tools', 'vision', 'thinking'] },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', description: 'Strong at code, low cost', context_tokens: 64000, speed: 3, cost: 1, capabilities: ['tools'] },
  ],
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Catalog for a provider; `model_policy.models` (ids or partial objects) overrides it, `default_model` is always selectable. */
export function modelsFor(provider: Pick<AIProvider, 'kind' | 'model_policy'>): readonly ModelInfo[] {
  const catalog = MODEL_CATALOG[provider.kind] ?? []
  const policy = provider.model_policy?.models
  let list: ModelInfo[] = [...catalog]
  if (Array.isArray(policy) && policy.length) {
    list = policy.flatMap((entry): ModelInfo[] => {
      const id = typeof entry === 'string' ? entry : isObject(entry) && typeof entry.id === 'string' ? entry.id : ''
      if (!id) return []
      const known = catalog.find((item) => item.id === id)
      const extra = isObject(entry) ? entry : {}
      const context = typeof extra.context_tokens === 'number' ? extra.context_tokens : known?.context_tokens
      const speed = extra.speed === 1 || extra.speed === 2 || extra.speed === 3 ? extra.speed : known?.speed
      const cost = typeof extra.cost === 'number' && extra.cost >= 0 && extra.cost <= 4 ? (extra.cost as ModelInfo['cost']) : known?.cost
      return [{
        id, name: String(extra.name ?? known?.name ?? id), description: String(extra.description ?? known?.description ?? ''),
        capabilities: (Array.isArray(extra.capabilities) ? extra.capabilities : known?.capabilities ?? []) as readonly Capability[],
        ...(context ? { context_tokens: context } : {}), ...(speed ? { speed } : {}), ...(cost !== undefined ? { cost } : {}),
      }]
    })
  }
  const fallback = provider.model_policy?.default_model
  if (typeof fallback === 'string' && fallback && fallback !== 'auto' && !list.some((item) => item.id === fallback)) list.unshift({ id: fallback, name: fallback, description: '', capabilities: [] })
  return list
}

export const isReady = (provider: AIProvider) => provider.enabled && !!provider.has_secret && provider.kind !== 'transcription'
export const supportsThinking = (provider: AIProvider | undefined, model: string) => !!provider && modelsFor(provider).find((item) => item.id === model)?.capabilities.includes('thinking') === true
export const formatContext = (tokens: number) => tokens >= 1_000_000 ? `${tokens / 1_000_000}M context` : `${Math.round(tokens / 1000)}K context`
export const SPEED_LABEL = ['', 'Slower', 'Balanced', 'Fast'] as const
export const COST_LABEL = ['Free', '$', '$$', '$$$', '$$$$'] as const
export const EFFORTS: readonly (readonly [Effort, string])[] = [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]
export const EFFORT_SHORT: Readonly<Record<Effort, string>> = { off: 'Off', low: 'Low', medium: 'Med', high: 'High' }
export const EFFORT_HINT: Readonly<Record<Effort, string>> = { off: 'Fastest, no thinking', low: 'Quick check', medium: 'Balanced', high: 'Careful, slower and pricier' }

export const modelName = (provider: AIProvider | undefined, model: string) => model === 'auto' ? 'Auto' : provider ? modelsFor(provider).find((item) => item.id === model)?.name ?? model : model
/** "Auto", or "Claude · Sonnet 4.5". */
export const choiceLabel = (provider: AIProvider | undefined, choice: ModelChoice) => choice.model === 'auto' ? 'Auto' : provider ? `${providerLabel(provider.kind)} · ${modelName(provider, choice.model)}` : choice.model

/** Default choice for a provider: its configured default model, else Auto. */
export const defaultChoice = (provider: AIProvider): ModelChoice => ({ providerId: provider.id, model: String(provider.model_policy?.default_model ?? 'auto') })
/** A stored choice only counts while its provider still has a key; otherwise fall back to the first ready provider. */
export function resolveChoice(choice: ModelChoice | null | undefined, ready: readonly AIProvider[]): ModelChoice {
  if (choice && ready.some((item) => item.id === choice.providerId)) return choice
  return ready[0] ? defaultChoice(ready[0]) : { providerId: '', model: 'auto' }
}

export const DEFAULT_CHOICE_KEY = 'aelys.chat.defaultModel'
export const chatChoiceKey = (conversationId: string) => `aelys.chat.${conversationId}.model`
export function readChoice(key: string): ModelChoice | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown
    if (!isObject(raw) || typeof raw.providerId !== 'string' || typeof raw.model !== 'string') return null
    const effort = EFFORTS.find(([id]) => id === raw.effort)?.[0]
    return { providerId: raw.providerId, model: raw.model, ...(effort ? { effort } : {}) }
  } catch { return null }
}
export function writeChoice(key: string, choice: ModelChoice) {
  try { localStorage.setItem(key, JSON.stringify(choice)) } catch { /* storage unavailable: the choice lives for this session only */ }
}
export function clearChoice(key: string) {
  try { localStorage.removeItem(key) } catch { /* storage unavailable */ }
}
