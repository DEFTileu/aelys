import { useEffect, useState } from 'react'
import type { AIFeature, AIFeatureDefaults, AIProvider, TelegramStatus } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'
import { ModelPicker } from '../components/ModelPicker'
import { SelectField } from '../components/controls/SelectionControls'
import { DEFAULT_CHOICE_KEY, isReady, resolveChoice, writeChoice, type ModelChoice } from '../data/aiModels'
import { Card, Group, Row } from './settings/ui'

const MODEL_FEATURES: readonly (readonly [Exclude<AIFeature, 'transcription'>, string, string])[] = [
  ['chat', 'AI Chat', 'Default model for new chats; each chat can still switch'],
  ['english', 'English', 'Words, lessons, corrections and speaking feedback'],
  ['automation', 'Automation', 'Turns a described rule into a draft'],
]

/** One place to choose which provider and model every AI feature uses. */
export function AiFeatureDefaults({ providers }: { providers: readonly AIProvider[] }) {
  const [defaults, setDefaults] = useState<AIFeatureDefaults>({})
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const client = getSharedApiClient()
    void Promise.resolve().then(() => client.aiDefaults()).then((value) => setDefaults(value ?? {})).catch(() => setNotice('Could not load the current choices.'))
    void Promise.resolve().then(() => client.telegramStatus()).then((value) => setTelegram(value ?? null)).catch(() => undefined)
  }, [])
  const chatProviders = providers.filter((item) => item.kind !== 'transcription')
  const ready = providers.filter(isReady)
  const voices = providers.filter((item) => item.kind === 'transcription' && item.enabled && item.has_secret)
  if (!ready.length && !voices.length) return null

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setNotice('')
    try { await work() } catch (error) { setNotice(error instanceof Error && error.message ? error.message : 'Could not save this choice.') }
    finally { setBusy(false) }
  }
  const choose = (feature: AIFeature, providerId: string, model?: string) => void run(async () => {
    const next = await getSharedApiClient().setAIDefaults({ ...defaults, [feature]: providerId ? { provider_id: providerId, model: model ?? null } : null })
    setDefaults(next)
    if (feature === 'chat' && model) writeChoice(DEFAULT_CHOICE_KEY, { providerId, model })
  })
  const valueFor = (feature: AIFeature): ModelChoice => {
    const stored = defaults[feature]
    return resolveChoice(stored ? { providerId: stored.provider_id, model: stored.model ?? 'auto' } : null, ready)
  }

  return <Group title="Use for">
    <Card>
      {MODEL_FEATURES.map(([feature, title, hint]) => <Row key={feature} title={title} hint={hint} wrap>
        <ModelPicker compact label={title} disabled={busy || !ready.length} providers={chatProviders} value={valueFor(feature)} onChange={(choice) => choose(feature, choice.providerId, choice.model)} />
      </Row>)}
      {telegram?.version != null && <Row title="Telegram" hint="Bot assistant and business replies" wrap>
        <ModelPicker compact label="Telegram" disabled={busy || !ready.length} providers={chatProviders} value={resolveChoice(telegram.provider_id ? { providerId: telegram.provider_id, model: telegram.model ?? 'auto' } : null, ready)}
          onChange={(choice) => void run(async () => setTelegram(await getSharedApiClient().updateTelegramSettings({ version: telegram.version!, provider_id: choice.providerId || null, model: choice.model.trim() || null })))} />
      </Row>}
      {voices.length > 0 && <Row title="Voice" hint="Voice messages and speaking practice" wrap>
        <SelectField label="Voice" hideLabel disabled={busy} value={defaults.transcription?.provider_id ?? voices[0]!.id} onChange={(id) => choose('transcription', id)}
          options={voices.map((item) => ({ value: item.id, label: String(item.model_policy?.default_model ?? 'Transcription') }))} />
      </Row>}
    </Card>
    {notice && <p className="st-hint" role="alert">{notice}</p>}
  </Group>
}
