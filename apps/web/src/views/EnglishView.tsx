import { useState } from 'react'
import type { EnglishCorrection, EnglishReport, EnglishWord } from '@aelys/shared'
import { StateCard } from '../components/StateCard'
import { SectionHeading } from '../components/SectionHeading'
import { Switch } from '../components/Switch'
import { Checkbox } from '../components/controls/SelectionControls'
import { navigate } from '../lib/router'
import type { ApiStatus, RoutePath } from '../types'
import { MAX_CHARS, MIN_CHARS, reportKey, tomorrowDraft, useEnglish, wordCount } from './english/useEnglish'
import './english/english.css'

const TYPE_RU: Record<string, string> = { tense: 'время', article: 'артикль', preposition: 'предлог', collocation: 'сочетаемость', word_choice: 'выбор слова', word_order: 'порядок слов', spelling: 'орфография', grammar: 'грамматика', punctuation: 'пунктуация', other: 'другое' }

function WordCard({ word }: { word: EnglishWord }) {
  return <article className="en-word">
    <h3>{word.lemma}{word.ipa && <span className="en-ipa"> {word.ipa}</span>}{word.part_of_speech && <span className="en-pos"> {word.part_of_speech}</span>}</h3>
    <p className="en-ru">{word.translation_ru}</p>
    <p>{word.definition_en}</p>
    {word.example && <p className="en-example">{word.example}</p>}
    {word.collocations.length > 0 && <ul className="en-tags" aria-label="Сочетания">{word.collocations.map((item) => <li key={item}>{item}</li>)}</ul>}
    {word.false_friend_ru && <p className="en-warn">Ложный друг: {word.false_friend_ru}</p>}
  </article>
}

function Result({ result }: { result: EnglishCorrection }) {
  return <div className="en-result">
    <p className="en-cefr">Уровень: примерно <strong>{result.cefr_estimate.level}</strong> <span>{result.cefr_estimate.rationale}</span></p>
    <h4>Исправленный текст</h4>
    <p className="en-corrected">{result.corrected_text}</p>
    {result.errors.length > 0 ? <><h4>Ошибки ({result.errors.length})</h4>
      <ul className="en-errors">{result.errors.map((error, index) => <li key={index} data-severity={error.severity}>
        <p><del>{error.original}</del> → <ins>{error.correction}</ins> <span className="en-type">{TYPE_RU[error.type] ?? error.type}</span></p>
        <p>{error.explanation_ru}</p></li>)}</ul></> : <p>Ошибок не найдено.</p>}
    {result.target_words.length > 0 && <><h4>Слова дня в тексте</h4>
      <ul className="en-targets">{result.target_words.map((item) => <li key={item.word}><strong>{item.word}</strong>: {item.used_correctly ? 'использовано верно' : 'нужно поправить'}{item.note && ` — ${item.note}`}</li>)}</ul></>}
    {result.strengths.length > 0 && <><h4>Что получилось</h4><ul>{result.strengths.map((item) => <li key={item}>{item}</li>)}</ul></>}
    <p className="en-summary">{result.summary_ru}</p>
  </div>
}

type Suggestion = { id: number; title: string; time: string | null; checked: boolean }

function TomorrowTasks({ report, en }: { report: EnglishReport; en: ReturnType<typeof useEnglish> }) {
  const [items, setItems] = useState<Suggestion[]>(() => report.result.tomorrow_tasks.map((item, id) => ({ id, ...item, checked: true })))
  const chosen = items.filter((item) => item.checked && item.title.trim())
  const patch = (id: number, change: Partial<Suggestion>) => setItems((prev) => prev.map((item) => item.id === id ? { ...item, ...change } : item))
  const add = () => void en.addTasks(report, chosen.map((item) => tomorrowDraft(report.day, item.title.trim(), item.time)), (index) => setItems((prev) => prev.filter((item) => item.id !== chosen[index]!.id)))
  return <div className="en-tomorrow">
    <h4>Задачи на завтра</h4>
    <ul>{items.map((item) => <li key={item.id}>
      <Checkbox label={<span className="en-sr">Добавить: {item.title}</span>} checked={item.checked} onChange={(checked) => patch(item.id, { checked })} />
      <input type="text" value={item.title} maxLength={200} aria-label="Название задачи" onChange={(event) => patch(item.id, { title: event.target.value })} />
      {item.time && <span className="en-muted">{item.time}</span>}</li>)}</ul>
    <button type="button" className="en-primary" disabled={en.busy || en.writeBlocked || !chosen.length} onClick={add}>Добавить в задачи</button>
  </div>
}

const reportLabel = (report: EnglishReport) => `${report.day} · ${report.cefr || '—'} · ошибок: ${report.result.errors.length}`

export function EnglishView({ apiStatus }: { apiStatus: ApiStatus }) {
  const en = useEnglish(apiStatus)
  const { today, status, notice, busy, writeBlocked, draft, rewriting } = en
  if (status !== 'ready' || !today) return <div className="en">
    <StateCard status={status} title={status === 'loading' ? 'Загружаем слова' : 'English недоступен'} description={notice?.text ?? 'Проверьте соединение и вход в аккаунт.'} />
  </div>
  const report = today.report
  const chars = draft.trim().length
  const canSubmit = !busy && !writeBlocked && chars >= MIN_CHARS && chars <= MAX_CHARS
  return <div className="en">
    {notice && <div className="en-notice" role="alert">
      <p>{notice.text}</p>
      {notice.code === 'AI_UNAVAILABLE' && <button type="button" onClick={() => navigate('/settings?section=ai' as RoutePath)}>Настройки AI</button>}
    </div>}
    {writeBlocked && <p className="en-muted" role="status">Нет соединения: слова и отчёты доступны только для чтения.</p>}
    <section className="en-reminder" aria-label="Напоминание">
      <span>Напоминание</span>
      <Switch label="Вечернее напоминание об отчёте" checked={en.settings.reminder_enabled} pending={en.savingSettings} disabled={writeBlocked}
        onCheckedChange={(reminder_enabled) => void en.saveSettings({ reminder_enabled })} />
      <input type="time" value={en.settings.reminder_time} aria-label="Время напоминания" disabled={writeBlocked || !en.settings.reminder_enabled}
        onChange={(event) => event.target.value && void en.saveSettings({ reminder_time: event.target.value }, true)} />
    </section>
    <section className="en-stats" aria-label="Статистика">
      <div><strong>{today.stats.total}</strong><span>слов</span></div>
      <div><strong>{today.stats.mastered}</strong><span>выучено</span></div>
      <div><strong>{today.stats.streak}</strong><span>дн. подряд</span></div>
    </section>

    <section className="en-card" aria-label="Слова дня">
      <SectionHeading title="Слова дня" />
      {today.new_words.length ? <div className="en-grid">{today.new_words.map((word) => <WordCard key={word.id} word={word} />)}</div> : <>
        <div className="en-row">
          <div className="en-chips" role="radiogroup" aria-label="Сколько слов">{([5, 10] as const).map((n) => <button key={n} type="button" role="radio" aria-checked={en.count === n} onClick={() => en.setCount(n)}>{n}</button>)}</div>
          <button type="button" className="en-primary" disabled={busy || writeBlocked} onClick={() => void en.generate()}>{busy ? 'Подбираем…' : 'Получить слова'}</button>
        </div>
        <p className="en-muted">Сегодня новых слов ещё нет.</p></>}
    </section>

    <section className="en-card" aria-label="Повторение">
      <SectionHeading title="Повторение" />
      {en.queue.length ? (() => { const word = en.queue[0]!; return <div className="en-flash">
        <p className="en-muted">Осталось: {en.queue.length}</p>
        {!en.revealed && <p className="en-lemma">{word.lemma}</p>}
        {en.revealed ? <>
          <WordCard word={word} />
          <div className="en-row"><button type="button" className="en-secondary" disabled={busy || writeBlocked} onClick={() => void en.review(word, false)}>Не помню</button>
            <button type="button" className="en-primary" disabled={busy || writeBlocked} onClick={() => void en.review(word, true)}>Помню</button></div></>
          : <button type="button" className="en-primary" onClick={() => en.setRevealed(true)}>Показать</button>}
      </div> })() : <p className="en-muted">Сегодня повторять нечего.</p>}
    </section>

    <section className="en-card" aria-label="Отчёт дня">
      <SectionHeading title="Отчёт дня" />
      {report && !rewriting ? <>
        <Result result={report.result} />
        {en.addedNote?.key === reportKey(report) && <p className="en-muted" role="status">Добавлено: {en.addedNote.count}</p>}
        {report.result.tomorrow_tasks.length > 0 && !en.added.has(reportKey(report)) && <TomorrowTasks key={reportKey(report)} report={report} en={en} />}
        <button type="button" className="en-secondary" disabled={writeBlocked} onClick={en.startRewrite}>Переписать</button></> : <>
        <label className="en-field"><span className="en-muted">Вечерний отчёт: как прошёл день и что планируешь на завтра. 80–150 слов, используй слова дня.</span>
          <textarea rows={8} value={draft} maxLength={MAX_CHARS} onChange={(event) => en.setDraft(event.target.value)} aria-label="Текст отчёта" /></label>
        <div className="en-row"><span className="en-muted" aria-live="polite">Слов: {wordCount(draft)}{chars > 0 && chars < MIN_CHARS && ` · нужно минимум ${MIN_CHARS} символов`}</span>
          <span className="en-actions">{rewriting && <button type="button" className="en-secondary" onClick={() => en.setRewriting(false)}>Отмена</button>}
            <button type="button" className="en-primary" disabled={!canSubmit} onClick={() => void en.submit()}>{busy ? 'Проверяем…' : 'Отправить на проверку'}</button></span></div></>}
    </section>

    {en.reports.length > 0 && <section className="en-card" aria-label="История">
      <SectionHeading title="История" />
      {en.reports.map((item) => <details key={item.id} className="en-history"><summary>{reportLabel(item)}</summary><Result result={item.result} /></details>)}
    </section>}
  </div>
}
