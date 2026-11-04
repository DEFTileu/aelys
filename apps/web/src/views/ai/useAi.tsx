import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { AIAction, AIConversation, AIFeedback, AIMessage, AIProvider, KnowledgeScope, KnowledgeSource } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { ChartColumn, ListChecks, NotebookText, Sparkles, type AelysIconComponent } from '../../icons'
import { DEFAULT_CHOICE_KEY, chatChoiceKey, choiceLabel, clearChoice, isReady, modelName, modelsFor, providerLabel, readChoice, resolveChoice, supportsThinking, writeChoice, type ModelChoice } from '../../data/aiModels'
import { getSharedApiClient } from '../../lib/api'
import { takePendingAsk, useDesktopState } from '../../lib/desktopStore'
import { useOwner } from '../../lib/owner'
import { consumeSse } from '../../lib/sse'
import type { ApiStatus } from '../../types'
import { ActionCard } from './ChatParts'
import { ACCEPTED_FILES, DEFAULT_SOURCES, MAX_FILE_BYTES, SOURCES, SOURCE_IDS, estimateTokens, formatCost, groupConversations, scopesFor, sourcesOn, toolLabel, type RunStep, type SourceId } from './chatModel'

type ChatLine = Pick<AIMessage, 'id' | 'role' | 'content'> & Partial<Pick<AIMessage, 'created_at' | 'source_refs_json' | 'attachments' | 'feedback'>>
/** How the latest run ended in this session; drives the Stopped label and the error card. */
interface Outcome { readonly status: 'done' | 'stopped' | 'error'; readonly prompt: string; readonly code?: string; readonly message?: string }
/** What a finished run leaves next to its answer: the tool steps and the "Claude · Sonnet 4.5 · 3.2s" line. */
interface Extras { readonly steps: readonly RunStep[]; readonly meta: string }
type ChatAction = AIAction & { readonly anchor?: string }
interface Attached { readonly key: string; readonly name: string; readonly size: number; readonly id?: string }
interface Divider { readonly chat: string; readonly after: string; readonly text: string }
export const LIVE = 'live'
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const describe = (error: unknown, fallback: string) => error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : fallback
const readBase64 = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
export const SUGGESTIONS: readonly { title: string; hint: string; prompt: string; Icon: AelysIconComponent; color: string; soft: string }[] = [
  { title: 'Plan my day', hint: 'From tasks and calendar', prompt: 'Plan my day around my tasks and calendar', Icon: Sparkles, color: '#6A4CF2', soft: '#EEE8FD' },
  { title: 'Prioritize my tasks', hint: 'What matters most this week', prompt: 'Help me decide what to prioritize this week', Icon: ListChecks, color: '#2F6FE4', soft: '#E4EEFD' },
  { title: 'Review my week', hint: 'Tasks and calendar', prompt: 'Review my week', Icon: ChartColumn, color: '#14966C', soft: '#DCF5EC' },
  { title: 'Find in my notes', hint: 'Notes and knowledge base', prompt: 'Find what my notes say about the widget grid', Icon: NotebookText, color: '#B36B00', soft: '#FDF1D9' },
]

// compact: phone layout (narrower draft rows, composer lifted above the keyboard).
export function useAi(apiStatus: ApiStatus, compact: boolean) {
  const [message, setMessage] = useState('')
  const [knowledgeScope, setKnowledgeScope] = useState<KnowledgeScope>()
  const [sources, setSources] = useState<readonly KnowledgeSource[]>([])
  const [search, setSearch] = useState('')
  const [allProviders, setAllProviders] = useState<readonly AIProvider[]>([])
  const [pick, setPick] = useState<ModelChoice | null>(() => readChoice(DEFAULT_CHOICE_KEY))
  const [outcome, setOutcome] = useState<Outcome>()
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [conversations, setConversations] = useState<readonly AIConversation[]>([])
  const [conversationId, setConversationId] = useState('')
  const [lines, setLines] = useState<readonly ChatLine[]>([])
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [partial, setPartial] = useState('')
  const [notice, setNotice] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [liveSteps, setLiveSteps] = useState<readonly RunStep[]>([])
  const [extras, setExtras] = useState<Readonly<Record<string, Extras>>>({})
  const [actions, setActions] = useState<readonly ChatAction[]>([])
  const [actionBusy, setActionBusy] = useState('')
  const [feedback, setFeedback] = useState<Readonly<Record<string, AIFeedback>>>({})
  const [dividers, setDividers] = useState<readonly Divider[]>([])
  const [draftSources, setDraftSources] = useState<ReadonlySet<SourceId>>(new Set(DEFAULT_SOURCES))
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [files, setFiles] = useState<readonly Attached[]>([])
  const [focused, setFocused] = useState(false)
  const [runUsage, setRunUsage] = useState<number | null>(null)
  const runId = useRef<string>('')
  const busy = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const picker = useRef<HTMLInputElement>(null)
  // With the keyboard open the pinned composer rises above it.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!compact || !viewport) return
    const lift = () => root.current?.style.setProperty('--ai-kb', `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`)
    lift(); viewport.addEventListener('resize', lift); viewport.addEventListener('scroll', lift)
    return () => { viewport.removeEventListener('resize', lift); viewport.removeEventListener('scroll', lift); root.current?.style.removeProperty('--ai-kb') }
  }, [compact])
  const owner = useOwner(apiStatus)
  const { pendingAsk, pendingKnowledge } = useDesktopState()
  const providers = allProviders.filter(isReady)
  const active = resolveChoice(pick, providers)
  const providerId = active.providerId
  const activeProvider = providers.find((item) => item.id === providerId)
  const defaultStored = readChoice(DEFAULT_CHOICE_KEY)
  const isDefault = defaultStored?.providerId === active.providerId && defaultStored.model === active.model
  const conversation = conversations.find((item) => item.id === conversationId)
  const sharing = conversation ? sourcesOn(conversation) : draftSources
  const uploading = files.some((item) => !item.id)
  const clearRun = () => { setOutcome(undefined); setHidden(new Set()); setActions([]); setLiveSteps([]); setRunUsage(null); pinned.current = true }
  const applyChoice = (choice: ModelChoice) => {
    if (conversationId && lines.length && (choice.providerId !== active.providerId || choice.model !== active.model)) {
      const text = `Switched to ${choiceLabel(providers.find((item) => item.id === choice.providerId), choice)}`
      setDividers((items) => [...items, { chat: conversationId, after: lines[lines.length - 1]!.id, text }])
    }
    setPick(choice); if (conversationId) writeChoice(chatChoiceKey(conversationId), choice)
  }
  const toggleDefault = (on: boolean) => { if (on) writeChoice(DEFAULT_CHOICE_KEY, active); else clearChoice(DEFAULT_CHOICE_KEY); setPick({ ...active }) }
  const mergeConversations = useCallback((incoming: readonly AIConversation[]) => setConversations((items) => {
    const known = new Set(incoming.map((item) => item.id))
    return [...items.filter((item) => !known.has(item.id)), ...incoming]
  }), [])
  const replaceConversation = (next: AIConversation) => setConversations((items) => items.map((item) => item.id === next.id ? { ...item, ...next } : item))

  useEffect(() => {
    if (!pendingAsk) return
    const question = takePendingAsk()
    // StrictMode replays effects: consuming twice must not erase the first draft.
    if (!question) return
    setKnowledgeScope(pendingKnowledge); setConversationId(''); setLines([]); setSources([]); setMessage(question); setPick(readChoice(DEFAULT_CHOICE_KEY)); clearRun(); setDraftSources(new Set(DEFAULT_SOURCES))
  }, [pendingAsk, pendingKnowledge])
  useEffect(() => {
    let live = true
    const client = getSharedApiClient()
    void Promise.all([client.aiProviders(), client.aiConversations()]).then(([items, history]) => {
      if (!live) return
      setAllProviders(items.filter((item) => item.kind !== 'transcription')); mergeConversations(history)
    }).catch(() => { if (live) setNotice('Could not load AI providers and chats. Check your connection and reopen this page.') })
    return () => { live = false }
  }, [apiStatus, mergeConversations])
  useEffect(() => () => { controller.current?.abort() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !busy.current) { event.preventDefault(); newChat() } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    if (!conversationId || busy.current) return
    let live = true; setLoading(true)
    const client = getSharedApiClient()
    void client.aiMessages(conversationId).then((items) => { if (live) { setLines(items); setPartial('') } }).catch(() => { if (live) setNotice('Could not load this conversation.') }).finally(() => { if (live) setLoading(false) })
    // Proposals survive a reload: pending ones can still be approved. A failure here must not block the chat.
    void Promise.resolve().then(() => client.aiConversationActions(conversationId)).then((items) => { if (live && Array.isArray(items)) setActions(items) }).catch(() => undefined)
    return () => { live = false }
  }, [conversationId])
  useEffect(() => { const el = scroller.current; if (el && pinned.current) el.scrollTop = el.scrollHeight }, [lines, partial, liveSteps, running, actions, extras])

  const execute = async (prompt: string, replace?: { now?: readonly string[]; after?: readonly string[] }, override?: ModelChoice) => {
    const choice = override ?? active
    if (!prompt || busy.current || loading || apiStatus !== 'ready' || !choice.providerId || uploading) return
    busy.current = true; setRunning(true); setNotice(''); setPartial(''); setOutcome(undefined); setLiveSteps([]); setSourcesOpen(false); runId.current = ''; pinned.current = true
    if (replace?.now?.length) setHidden((ids) => new Set([...ids, ...replace.now!]))
    const abort = new AbortController(); controller.current = abort
    const known = new Set(lines.map((line) => line.id))
    const attachments = replace ? [] : files
    try {
      const client = getSharedApiClient()
      let current = conversationId ? conversations.find((item) => item.id === conversationId) : undefined
      if (!current && !conversationId) {
        current = await client.createAIConversation({ title: prompt.slice(0, 80), ...(knowledgeScope ? { knowledge: knowledgeScope, project_id: knowledgeScope.project_id } : {}) }, { queueOnOffline: false })
        // Sources toggled before the first message become the new chat's scopes.
        const created = sourcesOn(current)
        if (created.size !== draftSources.size || [...draftSources].some((id) => !created.has(id))) {
          try { current = { ...current, ...await client.updateAIConversation(current.id, { scopes: scopesFor(draftSources, current) }) } } catch (error) { setNotice(describe(error, 'Could not save the shared sources.')) }
        }
        setConversations((items) => [current!, ...items]); setConversationId(current.id)
      }
      if (!current) throw new Error('Choose a conversation or start a new chat.')
      writeChoice(chatChoiceKey(current.id), choice); if (override) setPick(choice)
      const provider = providers.find((item) => item.id === choice.providerId)!
      const effort = choice.effort && choice.effort !== 'off' && supportsThinking(provider, choice.model) ? choice.effort : undefined
      const run = await client.createAIRun({ conversation_id: current.id, message: prompt, routing: { provider_id: provider.id, provider: provider.kind, model: choice.model, ...(effort ? { effort } : {}) }, idempotency_key: crypto.randomUUID(), ...(knowledgeScope ? { knowledge: knowledgeScope } : {}), ...(attachments.length ? { attachment_ids: attachments.flatMap((item) => item.id ? [item.id] : []) } : {}) }, { queueOnOffline: false })
      runId.current = run.id
      if (!replace) { setMessage(''); setFiles([]); setLines((items) => [...items, { id: run.id, role: 'user', content: prompt, created_at: new Date().toISOString(), ...(attachments.length ? { attachments: attachments.map((item) => ({ name: item.name, size: item.size })) } : {}) }]) }
      let terminal: Outcome | undefined; let streamed = ''; let startedAt = Date.now(); let used: { provider: string; model: string } = { provider: provider.kind, model: choice.model }
      let tokens: { input: number; output: number } | undefined
      let steps: RunStep[] = []; const proposed: string[] = []
      await consumeSse(await client.aiRunEvents(run.id, { signal: abort.signal }), (name, data) => {
        if (name === 'ai.knowledge.sources' && Array.isArray(data.sources)) setSources(data.sources as unknown as readonly KnowledgeSource[])
        if (name === 'ai.run.started') { startedAt = Date.now(); used = { provider: String(data.provider ?? used.provider), model: String(data.model ?? used.model) } }
        if (name === 'ai.text.delta') { streamed += String(data.text ?? ''); setPartial(streamed) }
        if (name === 'ai.tool.requested' || name === 'ai.tool.result') {
          const tool = String(data.tool ?? ''); const id = String(data.call_id ?? tool ?? steps.length)
          const source = SOURCE_IDS.has(String(data.source)) ? data.source as SourceId : undefined
          const label = typeof data.label === 'string' && data.label ? data.label : undefined; const detail = typeof data.detail === 'string' ? data.detail : undefined
          const existing = steps.find((step) => step.id === id)
          const next: RunStep = { id, label: label ?? existing?.label ?? (source ? SOURCES.find((item) => item.id === source)!.step : toolLabel(tool)), detail: detail ?? existing?.detail ?? '', ...((source ?? existing?.source) ? { source: (source ?? existing?.source)! } : {}), state: name === 'ai.tool.result' ? 'done' : 'run' }
          steps = existing ? steps.map((step) => step.id === id ? next : step) : [...steps, next]; setLiveSteps(steps)
        }
        if (name === 'ai.action.proposed' && typeof data.action_id === 'string') {
          proposed.push(data.action_id)
          const action: ChatAction = { id: data.action_id, tool: String(data.tool ?? ''), title: String(data.title ?? 'Proposed change'), summary: String(data.summary ?? ''), items: Array.isArray(data.items) ? data.items as AIAction['items'] : [], status: 'pending', anchor: LIVE }
          setActions((items) => [...items.filter((item) => item.id !== action.id), action])
        }
        if (name === 'ai.run.failed') terminal = { prompt, status: 'error', code: String(data.code ?? 'AI_ERROR'), message: String(data.message ?? 'Provider failed. Check its key and model in Settings.') }
        if (name === 'ai.run.cancelled') terminal = { prompt, status: 'stopped' }
        if (name === 'ai.run.completed') {
          terminal = { prompt, status: 'done' }
          const input = Number(data.input_tokens); const output = Number(data.output_tokens)
          if (Number.isFinite(input) || Number.isFinite(output)) { tokens = { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0 }; setRunUsage(tokens.input + tokens.output) }
        }
      })
      if (!terminal) throw new Error('The connection ended before the provider confirmed completion. Reload the conversation to check its status.')
      let items: readonly ChatLine[] = await client.aiMessages(current.id)
      // A stopped run keeps its partial text even when the server did not store it.
      if (terminal.status === 'stopped' && streamed && !items.some((item) => item.role === 'assistant' && !known.has(item.id))) items = [...items, { id: `stopped-${run.id}`, role: 'assistant', content: streamed }]
      const answer = [...items].reverse().find((item) => item.role === 'assistant' && !known.has(item.id)) ?? [...items].reverse().find((item) => item.role === 'assistant')
      if (answer && terminal.status !== 'error') {
        const usedProvider = providers.find((item) => item.kind === used.provider) ?? provider
        const name = choice.model === 'auto' ? `Auto → ${modelName(usedProvider, used.model)}` : modelName(usedProvider, used.model)
        const meta = terminal.status === 'done' ? [providerLabel(used.provider), name, seconds(Date.now() - startedAt), tokens && tokens.output ? `${tokens.output} tokens` : '', effort ? `${effort} effort` : ''].filter(Boolean).join(' · ') : ''
        setExtras((all) => ({ ...all, [answer.id]: { steps, meta } }))
        setActions((all) => all.map((item) => proposed.includes(item.id) ? { ...item, anchor: answer.id } : item))
      }
      setLines(items); setPartial(''); setOutcome(terminal); setLiveSteps([])
      if (replace?.after?.length) setHidden((ids) => new Set([...ids, ...replace.after!]))
      // Pull preview, order and usage the server updated; not essential, so failures stay silent.
      void Promise.resolve().then(() => client.aiConversations()).then((list) => { if (Array.isArray(list)) mergeConversations(list) }).catch(() => undefined)
    } catch (error) { setNotice(describe(error, 'AI request failed')) }
    finally { busy.current = false; setRunning(false); controller.current = null }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void execute(message.trim()) }
  const shown = lines.filter((line) => !hidden.has(line.id))
  const lastAssistant = [...shown].reverse().find((line) => line.role === 'assistant')
  const lastUser = [...shown].reverse().find((line) => line.role === 'user')
  const regenerate = () => {
    if (!lastAssistant) return
    const index = shown.indexOf(lastAssistant); const user = [...shown.slice(0, index)].reverse().find((line) => line.role === 'user')
    if (user) void execute(user.content, { now: [lastAssistant.id], after: [user.id] })
  }
  const fastest = providers.flatMap((provider) => modelsFor(provider).filter((model) => !(provider.id === active.providerId && model.id === active.model)).map((model) => ({ provider, model }))).sort((a, b) => (b.model.speed ?? 0) - (a.model.speed ?? 0))[0]
  const cancel = async () => {
    if (!runId.current) return
    try { await getSharedApiClient().cancelAIRun(runId.current); setNotice('Cancellation requested.') }
    catch { setNotice('Could not confirm cancellation. Try again.') }
  }
  const newChat = () => { if (busy.current) return; setKnowledgeScope(undefined); setSources([]); setConversationId(''); setLines([]); setPartial(''); setNotice(''); setHistoryOpen(false); clearRun(); setDraftSources(new Set(DEFAULT_SOURCES)); setPick(readChoice(DEFAULT_CHOICE_KEY)); setTimeout(() => field.current?.focus(), 0) }
  const openChat = (item: AIConversation) => { setConversationId(item.id); setKnowledgeScope(item.tool_scope_json?.knowledge); setSources([]); setActions([]); setHistoryOpen(false); clearRun(); setPick(readChoice(chatChoiceKey(item.id)) ?? readChoice(DEFAULT_CHOICE_KEY)) }

  const togglePin = async (item: AIConversation) => {
    try { replaceConversation({ ...item, pinned: !item.pinned, ...await getSharedApiClient().updateAIConversation(item.id, { pinned: !item.pinned }) }) }
    catch (error) { setNotice(describe(error, 'Could not update the chat.')) }
  }
  const toggleSource = async (id: SourceId, next: boolean) => {
    const set = new Set(sharing); if (next) set.add(id); else set.delete(id)
    if (!conversation) { setDraftSources(set); return }
    const previous = conversation; const scopes = scopesFor(set, conversation)
    replaceConversation({ ...conversation, tool_scope_json: { ...conversation.tool_scope_json, scopes } })
    try { replaceConversation({ ...conversation, ...await getSharedApiClient().updateAIConversation(conversation.id, { scopes }) }) }
    catch (error) { replaceConversation(previous); setNotice(describe(error, 'Could not change what Aelys can see.')) }
  }
  const decide = async (id: string, verb: 'approve' | 'reject') => {
    setActionBusy(id)
    try { const client = getSharedApiClient(); const saved = await (verb === 'approve' ? client.approveAIAction(id) : client.rejectAIAction(id)); setActions((items) => items.map((item) => item.id === id ? { ...item, ...saved } : item)) }
    catch (error) { setNotice(describe(error, 'Could not update this change.')) }
    finally { setActionBusy('') }
  }
  const rate = async (line: ChatLine, next: AIFeedback) => {
    const previous = feedback[line.id] ?? line.feedback ?? null
    setFeedback((all) => ({ ...all, [line.id]: next }))
    try { await getSharedApiClient().setAIMessageFeedback(line.id, next) } catch (error) { setFeedback((all) => ({ ...all, [line.id]: previous })); setNotice(describe(error, 'Could not save your feedback.')) }
  }
  const attach = async (list: FileList | null) => {
    const client = getSharedApiClient()
    for (const file of Array.from(list ?? [])) {
      const extension = file.name.split('.').pop()?.toLocaleLowerCase() ?? ''
      if (!ACCEPTED_FILES.includes(extension)) { setNotice(`${file.name}: attach a txt, md, csv, json or pdf file.`); continue }
      if (file.size > MAX_FILE_BYTES) { setNotice(`${file.name} is larger than 2 MB.`); continue }
      const key = crypto.randomUUID()
      setFiles((items) => [...items, { key, name: file.name, size: file.size }])
      try { const saved = await client.uploadAIAttachment({ name: file.name, content_base64: await readBase64(file) }); setFiles((items) => items.map((item) => item.key === key ? { ...item, id: saved.id } : item)) }
      catch (error) { setFiles((items) => items.filter((item) => item.key !== key)); setNotice(describe(error, `Could not attach ${file.name}.`)) }
    }
    if (picker.current) picker.current.value = ''
  }
  const removeFile = (item: Attached) => {
    setFiles((items) => items.filter((entry) => entry.key !== item.key))
    if (item.id) void Promise.resolve().then(() => getSharedApiClient().deleteAIAttachment(item.id!)).catch(() => undefined)
  }

  const groups = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return groupConversations(conversations.filter((item) => !needle || `${item.title ?? ''} ${item.preview ?? ''}`.toLocaleLowerCase().includes(needle)))
  }, [conversations, search])
  const selectedTitle = conversation?.title || 'New conversation'
  const windowTokens = (activeProvider ? modelsFor(activeProvider).find((item) => item.id === active.model)?.context_tokens : undefined) ?? 200000
  const usedTokens = runUsage ?? estimateTokens(shown.reduce((total, line) => total + line.content.length, 0))
  const percent = usedTokens ? Math.max(1, Math.min(100, usedTokens / windowTokens * 100)) : 0
  const costLabel = shown.length ? formatCost(conversation?.usage?.estimated_cost) : ''
  const draftRows = Math.min(6, Math.max(1, (message.match(/\n/g) ?? []).length + 1, Math.ceil(message.length / (compact ? 34 : 80))))
  const canSend = !!message.trim() && !running && !loading && !!providerId && apiStatus === 'ready' && !uploading
  const live = running
  const card = (item: ChatAction) => <ActionCard key={item.id} action={item} busy={actionBusy === item.id} onApprove={() => void decide(item.id, 'approve')} onReject={() => void decide(item.id, 'reject')} onAdjust={() => { setMessage((text) => text || `Change “${item.title}”: `); field.current?.focus() }} />
  const actionCards = (anchor: string) => actions.filter((item) => item.anchor === anchor).map(card)
  // Proposals restored after a reload carry no message link; they sit under the latest answer.
  const unanchored = actions.filter((item) => !item.anchor)
  const ask = (prompt: string) => void execute(prompt)
  return { root, historyOpen, setHistoryOpen, search, setSearch, running, newChat, groups, conversationId, loading, openChat, togglePin, selectedTitle, allProviders, active, applyChoice, isDefault, toggleDefault, scroller, pinned, shown, extras, feedback, lastAssistant, actionCards, unanchored, card, providerId, regenerate, rate, dividers, partial, live, liveSteps, actions, outcome, lastUser, execute, fastest, owner, providers, sharing, ask, sources, knowledgeScope, setKnowledgeScope, setConversationId, setLines, setSources, notice, submit, files, removeFile, focused, setFocused, field, message, setMessage, draftRows, canSend, cancel, picker, attach, sourcesOpen, setSourcesOpen, toggleSource, costLabel, usedTokens, windowTokens, percent, activeProvider }
}

export function SourceList({ sources }: { sources: readonly KnowledgeSource[] }) {
  return <details className="knowledge-sources"><summary>Retrieved sources ({sources.length})</summary><ul>{sources.map(source => <li key={source.label}><a href={`/notes?note=${encodeURIComponent(source.note_id)}&version=${source.version}&start=${source.start}`} target="_blank" rel="noopener noreferrer">[{source.label}] {source.title} · v{source.version}{source.heading ? ` · ${source.heading}` : ''}</a><blockquote>{source.excerpt}</blockquote></li>)}</ul></details>
}
