import { useCallback, useEffect, useState } from 'react'
import type { EnglishReport, EnglishSettings, EnglishToday, EnglishWord } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'
import { draftToInput, emptyDraft, type TaskDraft } from '../tasks/taskModel'

export const MIN_CHARS = 20
export const MAX_CHARS = 4000
const COUNT_KEY = 'aelys.english.count.v1'
const ADDED_KEY = 'aelys.english.tasks-added.v1'
const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const DEFAULT_SETTINGS = (): EnglishSettings => ({ reminder_enabled: false, reminder_time: '21:00', timezone: browserTimezone() })
/** A rewritten report keeps its id, so suggestions are tracked per revision. */
export const reportKey = (report: EnglishReport) => `${report.id}:${report.updated_at}`
const readAdded = (): ReadonlySet<string> => { try { return new Set(JSON.parse(localStorage.getItem(ADDED_KEY) ?? '[]') as string[]) } catch { return new Set() } }
/** Tomorrow relative to the report's own day; a time without a valid HH:MM falls back to the Tasks default end-of-day. */
export const tomorrowDraft = (day: string, title: string, time: string | null): TaskDraft => {
  const [y, m, d] = day.split('-').map(Number)
  const next = new Date(y!, m! - 1, d! + 1)
  const dueDate = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
  return { ...emptyDraft(), title, dueDate, dueTime: time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '' }
}

export type Notice = { code: string; text: string }
const toNotice = (error: unknown): Notice => error instanceof ApiError || error instanceof OfflineWriteUnavailableError
  ? { code: error.code, text: error.message } : { code: '', text: 'Не удалось выполнить запрос. Проверьте соединение.' }
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const readCount = (): 5 | 10 => { try { return localStorage.getItem(COUNT_KEY) === '10' ? 10 : 5 } catch { return 5 } }
export const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

export function useEnglish(apiStatus: ApiStatus) {
  const [day] = useState(localDay)
  const [today, setToday] = useState<EnglishToday | null>(null)
  const [reports, setReports] = useState<readonly EnglishReport[]>([])
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [count, setCountState] = useState<5 | 10>(readCount)
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set())
  const [revealed, setRevealed] = useState(false)
  const [draft, setDraft] = useState('')
  const [rewriting, setRewriting] = useState(false)
  const [settings, setSettings] = useState<EnglishSettings>(DEFAULT_SETTINGS)
  const [savingSettings, setSavingSettings] = useState(false)
  const [added, setAdded] = useState<ReadonlySet<string>>(readAdded)
  const [addedNote, setAddedNote] = useState<{ key: string; count: number } | null>(null)

  const load = useCallback(async (forceRefresh = true) => {
    try {
      const client = getSharedApiClient()
      setToday(await client.englishToday(day, { forceRefresh })); setStatus('ready')
      // History is secondary: its failure must not hide today's words.
      await client.englishReports(30, { forceRefresh }).then(setReports, () => undefined)
      await client.englishSettings({ forceRefresh }).then(setSettings, () => undefined)
    } catch (error) { setNotice(toNotice(error)); setStatus(navigator.onLine ? 'error' : 'offline') }
  }, [day])
  useEffect(() => { void load(false) }, [load, apiStatus])

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setNotice(null)
    try { await action() } catch (error) { setNotice(toNotice(error)) } finally { setBusy(false) }
  }
  const setCount = (next: 5 | 10) => { setCountState(next); try { localStorage.setItem(COUNT_KEY, String(next)) } catch { /* Preference is optional. */ } }
  const generate = () => run(async () => { setToday(await getSharedApiClient().englishGenerate(day, count)) })
  const queue: readonly EnglishWord[] = (today?.due_words ?? []).filter((word) => !reviewed.has(word.id))
  const review = (word: EnglishWord, correct: boolean) => run(async () => {
    await getSharedApiClient().englishReview(word.id, day, correct)
    setReviewed((prev) => new Set(prev).add(word.id)); setRevealed(false)
  })
  const submit = () => run(async () => {
    const report = await getSharedApiClient().englishSubmitReport(day, draft.trim())
    setToday((prev) => prev && { ...prev, report }); setRewriting(false); setDraft('')
    setReports((prev) => [report, ...prev.filter((item) => item.day !== report.day)])
    await getSharedApiClient().englishToday(day, { forceRefresh: true }).then(setToday, () => undefined) // refresh the streak
  })
  const saveSettings = async (patch: Partial<EnglishSettings>, optimistic = false) => {
    const previous = settings, next = { ...settings, ...patch, timezone: browserTimezone() }
    setSavingSettings(true); setNotice(null); if (optimistic) setSettings(next)
    try { setSettings(await getSharedApiClient().englishSaveSettings(next)) } catch (error) { setSettings(previous); setNotice(toNotice(error)) } finally { setSavingSettings(false) }
  }
  /** Creates one task per draft; onCreated lets the caller drop rows already saved so a retry cannot duplicate them. */
  const addTasks = (report: EnglishReport, drafts: readonly TaskDraft[], onCreated: (index: number) => void) => run(async () => {
    const client = getSharedApiClient()
    for (const [index, draft] of drafts.entries()) { await client.createTask(draftToInput(draft)); onCreated(index) }
    const key = reportKey(report)
    setAddedNote({ key, count: drafts.length }); setAdded((prev) => new Set(prev).add(key))
    try { localStorage.setItem(ADDED_KEY, JSON.stringify([...added, key].slice(-200))) } catch { /* Remembering is optional. */ }
  })
  const startRewrite = () => { setDraft(today?.report?.text ?? ''); setRewriting(true) }
  const writeBlocked = apiStatus !== 'ready'
  return { day, today, reports, status, notice, busy, count, setCount, queue, revealed, setRevealed, draft, setDraft, rewriting, setRewriting, startRewrite, generate, review, submit, writeBlocked, load, settings, savingSettings, saveSettings, added, addedNote, addTasks }
}
