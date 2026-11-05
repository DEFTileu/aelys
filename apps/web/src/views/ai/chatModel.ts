import type { AIConversation, AIRunStep } from '@aelys/shared'
import { BookOpen, Calendar, ChartColumn, MapPin, MessageCircle, Mail, NotebookText, Sparkles, SquareCheck, Wallet, type AelysIconComponent } from '../../icons'

export type SourceId = 'tasks' | 'calendar' | 'notes' | 'knowledge'
export interface SourceDef { readonly id: SourceId; readonly scope: string; readonly name: string; readonly Icon: AelysIconComponent; readonly color: string; readonly soft: string; readonly on: string; readonly off: string; readonly step: string }
/** Only sources with a real backend read tool; Mail and Finances are deliberately absent. */
export const SOURCES: readonly SourceDef[] = [
  { id: 'tasks', scope: 'tasks.read', name: 'Tasks', Icon: SquareCheck, color: '#2F6FE4', soft: '#E4EEFD', on: 'Can read your tasks', off: 'Not shared in this chat', step: 'Read your tasks' },
  { id: 'calendar', scope: 'calendar.read', name: 'Calendar', Icon: Calendar, color: '#D93636', soft: '#FDE8E7', on: 'Can read your events', off: 'Not shared in this chat', step: 'Read calendar' },
  { id: 'notes', scope: 'notes.read', name: 'Notes', Icon: NotebookText, color: '#B36B00', soft: '#FDF1D9', on: 'Can search your notes', off: 'Not shared in this chat', step: 'Searched notes' },
  { id: 'knowledge', scope: 'knowledge.read', name: 'Knowledge base', Icon: BookOpen, color: '#6A4CF2', soft: '#EEE8FD', on: 'Can search your documents', off: 'Not shared in this chat', step: 'Searched knowledge base' },
]
export const DEFAULT_SOURCES: readonly SourceId[] = ['tasks', 'calendar', 'notes']
const KNOWN_SCOPES = new Set(SOURCES.map((item) => item.scope))

/** Sources a chat shares; a chat without a stored scope list gets the defaults new chats start with. */
export function sourcesOn(conversation: Pick<AIConversation, 'tool_scope_json'> | undefined): ReadonlySet<SourceId> {
  const scopes = conversation?.tool_scope_json?.scopes
  return new Set(scopes ? SOURCES.filter((item) => scopes.includes(item.scope)).map((item) => item.id) : DEFAULT_SOURCES)
}
/** Scope list for PATCH: the toggled sources plus any scope this UI does not know, so nothing is dropped. */
export function scopesFor(on: ReadonlySet<SourceId>, conversation: Pick<AIConversation, 'tool_scope_json'> | undefined): string[] {
  const unknown = (conversation?.tool_scope_json?.scopes ?? []).filter((scope) => !KNOWN_SCOPES.has(scope))
  return [...unknown, ...SOURCES.filter((item) => on.has(item.id)).map((item) => item.scope)]
}
export const sourceChip = (count: number) => count ? `${count} ${count === 1 ? 'source' : 'sources'}` : 'No sources'
export function sourceSummary(on: ReadonlySet<SourceId>) {
  const names = SOURCES.filter((item) => on.has(item.id)).map((item) => item.name.toLocaleLowerCase())
  return names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.length ? names.join(' and ') : 'only this conversation'
}

/** 24-hour clock, as in the design ("10:24"). */
export const clock = (stamp: string) => new Date(stamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export type GroupTitle = 'Pinned' | 'Today' | 'Yesterday' | 'Previous 7 days' | 'Earlier'
const GROUPS: readonly GroupTitle[] = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Earlier']
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
/** Whole local calendar days between a conversation and now. A chat without a timestamp was just created, so it counts as today. */
const ageInDays = (item: AIConversation, now: Date) => {
  const stamp = item.updated_at ? Date.parse(item.updated_at) : NaN
  return Number.isNaN(stamp) ? 0 : Math.max(0, Math.round((startOfDay(now) - startOfDay(new Date(stamp))) / 864e5))
}
export function groupConversations(items: readonly AIConversation[], now = new Date()): { title: GroupTitle; items: AIConversation[] }[] {
  const stamp = (item: AIConversation) => Date.parse(item.updated_at ?? '') || Number.MAX_SAFE_INTEGER
  const byStamp = (a: AIConversation, b: AIConversation) => stamp(b) - stamp(a)
  const title = (item: AIConversation): GroupTitle => { if (item.pinned) return 'Pinned'; const age = ageInDays(item, now); return age < 1 ? 'Today' : age < 2 ? 'Yesterday' : age < 8 ? 'Previous 7 days' : 'Earlier' }
  return GROUPS.map((group) => ({ title: group, items: items.filter((item) => title(item) === group).sort(byStamp) })).filter((group) => group.items.length)
}
/** Right-hand time in the list: clock today, "Yesterday", weekday this week, otherwise "Oct 27". Pinned rows show none. */
export function whenLabel(item: AIConversation, now = new Date()): string {
  if (item.pinned || !item.updated_at || Number.isNaN(Date.parse(item.updated_at))) return ''
  const date = new Date(item.updated_at); const age = ageInDays(item, now)
  return age < 1 ? clock(item.updated_at) : age < 2 ? 'Yesterday' : age < 8 ? date.toLocaleDateString(undefined, { weekday: 'short' }) : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export interface Tone { readonly Icon: AelysIconComponent; readonly color: string; readonly soft: string }
/** Icon tile for a chat, from its title (the API stores no icon). */
export function chatTone(title: string | undefined): Tone {
  const text = (title ?? '').toLocaleLowerCase()
  if (/plan|day|today|schedule/.test(text)) return { Icon: Sparkles, color: '#6A4CF2', soft: '#EEE8FD' }
  if (/mail|inbox|email/.test(text)) return { Icon: Mail, color: '#2F6FE4', soft: '#E4EEFD' }
  if (/budget|money|spend|finance|bill/.test(text)) return { Icon: Wallet, color: '#14966C', soft: '#DCF5EC' }
  if (/trip|travel|flight|pack/.test(text)) return { Icon: MapPin, color: '#F06A58', soft: '#FDE6E1' }
  if (/week|review|summary/.test(text)) return { Icon: ChartColumn, color: '#14966C', soft: '#DCF5EC' }
  if (/note|knowledge|find|doc/.test(text)) return { Icon: NotebookText, color: '#B36B00', soft: '#FDF1D9' }
  return { Icon: MessageCircle, color: '#6A4CF2', soft: '#EEE8FD' }
}

export const formatBytes = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`
/** 200000 -> "200K", 1000000 -> "1M". */
export const formatWindow = (tokens: number) => tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`
export const formatTokens = (tokens: number) => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens)
/** Rough size of text in tokens (about 3.6 characters each), used until a run reports the real count. */
export const estimateTokens = (chars: number) => Math.round(chars / 3.6)
export function formatCost(value: number | string | undefined) {
  const cost = Number(value)
  return !Number.isFinite(cost) || cost <= 0 ? '' : cost < 0.01 ? '< $0.01' : `≈ $${cost.toFixed(2)}`
}

export const ACCEPTED_FILES = ['txt', 'md', 'csv', 'json', 'pdf']
export const MAX_FILE_BYTES = 2 * 1024 * 1024

export interface RunStep { readonly id: string; readonly label: string; readonly detail: string; readonly source?: SourceId; readonly state: 'run' | 'done' }
export const SOURCE_IDS = new Set<string>(SOURCES.map((item) => item.id))
/** Label for a tool event that carried none: "list_tasks" -> "List tasks". */
export const toolLabel = (tool: string) => { const words = tool.replace(/[._-]+/g, ' ').trim(); return words ? words[0]!.toLocaleUpperCase() + words.slice(1) : 'Used a tool' }
/** Steps stored with an answer; unknown sources just lose their icon. */
export const savedSteps = (steps: readonly AIRunStep[] | undefined): RunStep[] => (steps ?? []).map((step) => ({ id: step.id, label: step.label, detail: step.detail ?? '', state: 'done', ...(SOURCES.some((item) => item.id === step.source) ? { source: step.source as SourceId } : {}) }))
export const stepsSummary = (steps: readonly RunStep[]) => steps.map((step) => step.label).join(' · ')
