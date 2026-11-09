import { useState } from 'react'
import type { EnglishLesson, EnglishReport } from '@aelys/shared'
import { Checkbox } from '../../../components/controls/SelectionControls'
import { ReportResult } from '../ReportResult'
import { MAX_CHARS, MIN_CHARS, reportKey, tomorrowDraft, wordCount, type useEnglish } from '../useEnglish'
import type { CourseHook } from '../useEnglishCourse'

type Suggestion = { id: number; title: string; time: string | null; checked: boolean }

function TomorrowTasks({ report, daily }: { report: EnglishReport; daily: ReturnType<typeof useEnglish> }) {
  const [items, setItems] = useState<Suggestion[]>(() => report.result.tomorrow_tasks.map((item, id) => ({ id, ...item, checked: true })))
  const chosen = items.filter((item) => item.checked && item.title.trim())
  const patch = (id: number, change: Partial<Suggestion>) => setItems((prev) => prev.map((item) => item.id === id ? { ...item, ...change } : item))
  const add = () => void daily.addTasks(report, chosen.map((item) => tomorrowDraft(report.day, item.title.trim(), item.time)), (index) => setItems((prev) => prev.filter((item) => item.id !== chosen[index]!.id)))
  return <div className="en-tomorrow">
    <h4>Задачи на завтра</h4>
    <ul>{items.map((item) => <li key={item.id}>
      <Checkbox label={<span className="en-sr">Добавить: {item.title}</span>} checked={item.checked} onChange={(checked) => patch(item.id, { checked })} />
      <input type="text" value={item.title} maxLength={200} aria-label="Название задачи" onChange={(event) => patch(item.id, { title: event.target.value })} />
      {item.time && <span className="en-muted">{item.time}</span>}</li>)}</ul>
    <button type="button" className="en-btn en-btn--primary" disabled={daily.busy || daily.writeBlocked || !chosen.length} onClick={add}>Добавить в задачи</button>
  </div>
}

const reportLabel = (report: EnglishReport) => `${report.day} · ${report.cefr || '—'} · ошибок: ${report.result.errors.length}`

/** Journal (evening report + tomorrow tasks) or IELTS Task 2, per lesson.content.writing.kind. */
export function WritingBlock({ lesson, daily, en }: { lesson: EnglishLesson; daily: ReturnType<typeof useEnglish>; en: CourseHook }) {
  const { kind, prompt } = lesson.content.writing
  const task2 = kind === 'task2'
  const { draft, rewriting, writeBlocked } = daily
  const report = daily.today?.report ?? null
  const chars = draft.trim().length
  const busy = daily.busy || en.busy
  const canSubmit = !busy && !writeBlocked && chars >= MIN_CHARS && chars <= MAX_CHARS
  const submit = () => void daily.submit(kind).then(() => en.refresh())
  return <section className="en-card" aria-label="Writing">
    <div className="en-seg en-seg--static" aria-label="Задание"><span aria-current="true">{task2 ? 'Task 2 эссе' : 'Вечерний отчёт'}</span></div>
    {task2 ? <div className="en-topic"><small>WRITING TASK 2 · 40 мин · 250+ слов · по вторникам и пятницам</small><p>{prompt}</p></div>
      : <div><h2 className="en-h">Вечерний отчёт</h2><p className="en-muted">Как прошёл день и планы на завтра — 80–150 слов, используй слова урока. Планы станут задачами.</p></div>}
    {report && !rewriting ? <>
      <ReportResult result={report.result} />
      {daily.addedNote?.key === reportKey(report) && <p className="en-muted" role="status">Добавлено: {daily.addedNote.count}</p>}
      {!task2 && report.result.tomorrow_tasks.length > 0 && !daily.added.has(reportKey(report)) && <TomorrowTasks key={reportKey(report)} report={report} daily={daily} />}
      <button type="button" className="en-btn" disabled={writeBlocked} onClick={daily.startRewrite}>Переписать</button></> : <>
      <label className="en-stack en-stack--tight"><span className="en-sr">Текст</span>
        <textarea rows={task2 ? 12 : 8} value={draft} maxLength={MAX_CHARS} onChange={(event) => daily.setDraft(event.target.value)} aria-label={task2 ? 'Текст эссе' : 'Текст отчёта'} /></label>
      <div className="en-row"><span className="en-muted" aria-live="polite">Слов: {wordCount(draft)} · {task2 ? 'нужно 250+' : 'лучше 80–150'}{chars > 0 && chars < MIN_CHARS && ` · нужно минимум ${MIN_CHARS} символов`}</span>
        <span className="en-actions">{rewriting && <button type="button" className="en-btn" onClick={() => daily.setRewriting(false)}>Отмена</button>}
          <button type="button" className="en-btn en-btn--primary" disabled={!canSubmit} onClick={submit}>{busy ? 'Проверяем…' : 'Проверить'}</button></span></div></>}
    {daily.reports.length > 0 && <div className="en-history-wrap"><h3 className="en-sub">История</h3>
      {daily.reports.map((item) => <details key={item.id} className="en-history"><summary>{reportLabel(item)}</summary><ReportResult result={item.result} /></details>)}</div>}
  </section>
}
