import { useState } from 'react'
import type { EnglishErrorType, EnglishLesson } from '@aelys/shared'
import { Lightbulb } from '../../../icons'
import { getSharedApiClient } from '../../../lib/api'
import type { CourseHook } from '../useEnglishCourse'

const DRILL_TITLE: Record<EnglishErrorType, string> = { tense: 'времена', article: 'артикли', preposition: 'предлоги', collocation: 'сочетания слов', word_choice: 'выбор слова', word_order: 'порядок слов', spelling: 'орфография', grammar: 'грамматика', punctuation: 'пунктуация', other: 'ошибки из отчётов' }

/** Local-only gap-fill on the learner's recurring writing mistake; nothing is sent to the API. */
function Drill({ drill }: { drill: NonNullable<EnglishLesson['content']['drill']> }) {
  const [given, setGiven] = useState<string[]>([])
  const [checked, setChecked] = useState(false)
  const right = (i: number) => (given[i] ?? '').trim().toLowerCase() === drill.items[i]!.answer.trim().toLowerCase()
  return <div className="en-stack en-stack--tight" role="group" aria-label="Мини-упражнение">
    <h3 className="en-sub">Мини-упражнение: {DRILL_TITLE[drill.type] ?? DRILL_TITLE.other}</h3>
    {drill.items.map((item, i) => <label key={i} className="en-q"><span className="en-q__n">{i + 1}</span><span>{item.before}</span>
      <input value={given[i] ?? ''} maxLength={40} disabled={checked} autoComplete="off" aria-label={`Пропуск ${i + 1}`} data-state={checked ? (right(i) ? 'ok' : 'bad') : undefined} onChange={(event) => setGiven((prev) => { const next = [...prev]; next[i] = event.target.value; return next })} />
      <span>{item.after}</span>{checked && <span className={`en-q__ans ${right(i) ? 'is-ok' : 'is-bad'}`}>{right(i) ? '✓' : item.answer}</span>}</label>)}
    {!checked && <div className="en-actions"><button type="button" className="en-btn" onClick={() => setChecked(true)}>Проверить</button></div>}
  </div>
}

/** Cloze review built server-side from due words; each answer feeds the Leitner schedule. */
export function WarmupBlock({ lesson, en, onNext }: { lesson: EnglishLesson; en: CourseHook; onNext: () => void }) {
  const cards = lesson.content.warmup
  const drill = lesson.content.drill
  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState(false)
  const [knew, setKnew] = useState(0)
  const done = lesson.progress.warmup?.done ?? false
  const card = cards[index]
  const nextTitle = lesson.content.vocab ? 'слова темы' : 'грамматика'
  const answer = (correct: boolean) => void en.run(async () => {
    await getSharedApiClient().englishReview(card!.word_id, en.day, correct)
    setKnew((n) => n + (correct ? 1 : 0)); setIndex((i) => i + 1); setShown(false)
  })
  const finish = () => void en.markDone('warmup').then((ok) => ok && onNext())
  return <section className="en-card" aria-label="Разминка">
    <div className="en-row"><h2 className="en-h">Разминка: вспомни слово в предложении</h2>
      <span className="en-muted">{card ? `${index + 1} из ${cards.length}` : 'Готово'}</span></div>
    {card && <>
      <div className="en-cloze">
        <p className="en-cloze__text">{card.before}<span className="en-cloze__gap">{shown ? card.answer : '?'}</span>{card.after}</p>
        <p className="en-muted"><Lightbulb size={14} /> {card.hint_ru}</p>
      </div>
      {!shown ? <button type="button" className="en-btn en-btn--dark" onClick={() => setShown(true)}>Показать слово</button>
        : <div className="en-pair">
          <button type="button" className="en-btn" disabled={en.busy || en.writeBlocked} onClick={() => answer(false)}>Не вспомнил</button>
          <button type="button" className="en-btn en-btn--primary" disabled={en.busy || en.writeBlocked} onClick={() => answer(true)}>Вспомнил</button></div>}
    </>}
    {!card && <div className="en-banner en-banner--ok" role="status">
      <span>{cards.length ? `Разминка готова: ${knew} из ${cards.length}` : `Сегодня повторять нечего — переходи дальше: ${nextTitle}.`}</span>
      {done ? <button type="button" className="en-btn en-btn--ok" onClick={onNext}>Дальше: {nextTitle}</button>
        : <button type="button" className="en-btn en-btn--ok" disabled={en.busy || en.writeBlocked} onClick={finish}>Дальше: {nextTitle}</button>}
    </div>}
    {drill && drill.items.length > 0 && <Drill drill={drill} />}
  </section>
}
