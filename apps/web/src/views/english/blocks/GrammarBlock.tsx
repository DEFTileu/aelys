import { useState } from 'react'
import type { EnglishGrammarLesson, EnglishLesson, EnglishTask, EnglishTaskResult, EnglishTimelineItem } from '@aelys/shared'
import { ArrowRight, CircleAlert, CircleCheck, Lightbulb, Repeat, Route, TriangleAlert } from '../../../icons'
import { getSharedApiClient } from '../../../lib/api'
import type { CourseHook } from '../useEnglishCourse'

type Step = 'learn' | 'trap' | 'practice' | 'done'
const STEP_TITLE: Record<Step, string> = { learn: 'Понять', trap: 'Ловушка', practice: 'Практика', done: 'Итог' }
const KIND: Record<EnglishTask['type'], string> = { gap: 'Впиши пропущенное', choice: 'Выбери вариант', fix: 'Найди ошибку и перепиши', tfng: '', mcq: '', heading: '' }
const pct = (x: number) => `${Math.round((x + 1) * 50)}%` // timeline axis -1..1 → 0..100%

function Timeline({ title, items }: { title: string; items: readonly EnglishTimelineItem[] }) {
  const [only, setOnly] = useState<number | null>(null)
  const shown = items.map((item, i) => only === null || only === i)
  const aria = items.map((item) => `${item.label}: ${item.kind === 'repeat' ? 'повторяется всегда' : item.kind === 'point' ? 'одно событие' : 'длится какое-то время'}`).join('; ')
  return <div className="en-card en-stack en-stack--tight">
    <div className="en-row"><h3 className="en-h">{title}</h3>
      {items.length > 1 && <div role="group" aria-label="Показать на линии времени" className="en-seg en-seg--soft">
        {items.map((item, i) => <button key={item.label} type="button" aria-pressed={only === i} onClick={() => setOnly(i)}>{item.label}</button>)}
        <button type="button" aria-pressed={only === null} onClick={() => setOnly(null)}>Сравнить</button></div>}
    </div>
    <div className="en-tl" role="img" aria-label={aria}>
      <span className="en-tl__axis" /><span className="en-tl__now">сейчас</span><span className="en-tl__nowline" />
      <span className="en-tl__end en-tl__end--past">прошлое</span><span className="en-tl__end en-tl__end--future">будущее</span>
      {items.map((item, i) => shown[i] && <div key={item.label} className="en-tl__item" data-tone={i}>
        {item.kind === 'repeat' && [-0.9, -0.7, -0.5, -0.3, -0.1, 0.1, 0.3, 0.5, 0.7, 0.9].map((x) => <span key={x} className="en-tl__dot" style={{ left: pct(x) }} />)}
        {item.kind === 'point' && <span className="en-tl__dot en-tl__dot--big" style={{ left: pct(item.at ?? 0) }} />}
        {item.kind === 'span' && <span className="en-tl__span" style={{ left: pct(item.start ?? -0.2), width: `${Math.round(((item.end ?? 0.2) - (item.start ?? -0.2)) * 50)}%` }} />}
      </div>)}
    </div>
    <ul className="en-legend">{items.map((item, i) => shown[i] && <li key={item.label} data-tone={i}><span className="en-legend__mark" data-kind={item.kind} /><strong>{item.label}</strong> — <em>{item.caption_en}</em></li>)}</ul>
  </div>
}

function Learn({ g }: { g: EnglishGrammarLesson }) {
  return <div className="en-stack">
    {g.formulas && g.formulas.length > 0 && <div className="en-formulas">{g.formulas.map((f) => <div key={f.title} className="en-card en-formula" data-tone={f.tone}>
      <div className="en-head"><span className="en-ico"><Repeat size={18} /></span><div><strong>{f.title}</strong><p className="en-muted">{f.when_ru}</p></div></div>
      <div className="en-stack en-stack--tight" aria-label={`Формула: ${f.title}`}>{f.rows.map((row, i) => <div key={i} className="en-chips">{row.map((token, k) => <span key={k} className="en-chip" data-role={token.role}>{token.t}</span>)}</div>)}</div>
      <p className="en-example"><strong>{f.example_en}</strong><span className="en-muted">{f.example_ru}</span></p>
      {f.markers.length > 0 && <div className="en-markers">{f.markers.map((m) => <span key={m}>{m}</span>)}</div>}
    </div>)}</div>}
    {g.timeline && <Timeline title={g.timeline.title_ru} items={g.timeline.items} />}
    {g.table && <div className="en-card en-stack en-stack--tight"><h3 className="en-h">{g.table.title_ru}</h3>
      <div className="en-table-wrap"><table className="en-table"><thead><tr>{g.table.head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{g.table.rows.map((row, i) => <tr key={i}>{row.map((cell, k) => k === 0 ? <th key={k} scope="row">{cell}</th> : <td key={k}>{cell}</td>)}</tr>)}</tbody></table></div></div>}
    <details className="en-card en-rule-box" open={!g.formulas?.length}>
      <summary><Lightbulb size={16} /> Правило словами</summary>
      <div className="en-stack en-stack--tight">{g.rule_ru.map((text, i) => <p key={i}>{text}</p>)}</div>
    </details>
    <div className="en-card en-stack en-stack--tight"><h3 className="en-h">Примеры</h3>
      <ul className="en-examples">{g.examples.map((example) => <li key={example.en}><strong>{example.en}</strong><span className="en-muted">{example.ru}</span></li>)}</ul></div>
  </div>
}

function Trap({ g }: { g: EnglishGrammarLesson }) {
  const [pick, setPick] = useState(0)
  const chip = g.chips?.items[pick]
  return <div className="en-card en-stack">
    <div className="en-head"><span className="en-ico" data-tone="amber"><TriangleAlert size={18} /></span><strong>Типичные ошибки русскоговорящих</strong></div>
    {(g.traps ?? []).map((trap) => <div key={trap.wrong} className="en-trap">
      <div className="en-trap__side" data-state="bad"><span aria-label="Неверно">✗</span><div><s>{trap.wrong}</s></div></div>
      <div className="en-trap__side" data-state="ok"><span aria-label="Верно">✓</span><div><strong>{trap.right}</strong></div></div>
      <p className="en-trap__note">{trap.note_ru}</p>
    </div>)}
    {g.chips && chip && <div className="en-stack en-stack--tight">
      <span className="en-sub">{g.chips.title_ru}</span>
      <div className="en-pickers">{g.chips.items.map((item, i) => <button key={item.en} type="button" aria-pressed={pick === i} onClick={() => setPick(i)}>{item.en}</button>)}</div>
      <p className="en-example" aria-live="polite"><strong>{chip.example}</strong><span className="en-muted">{chip.en} — {chip.ru}</span></p>
    </div>}
  </div>
}

function Practice({ g, results, onAnswer, busy, onFinish }: { g: EnglishGrammarLesson; results: ReadonlyMap<number, EnglishTaskResult>; onAnswer: (n: number, value: string) => void; busy: boolean; onFinish: () => void }) {
  const firstOpen = g.exercises.findIndex((_, i) => !results.has(i + 1))
  const [index, setIndex] = useState(firstOpen === -1 ? 0 : firstOpen)
  const [value, setValue] = useState('')
  const task = g.exercises[index]!, n = index + 1, graded = results.get(n)
  const last = index === g.exercises.length - 1
  const [before, after] = task.type === 'fix' ? [task.prompt, ''] : [task.prompt.split('___')[0] ?? '', task.prompt.split('___').slice(1).join('___')]
  const submit = (answer: string) => { if (!graded && answer.trim()) onAnswer(n, answer) }
  const next = () => { setValue(''); if (last) onFinish(); else setIndex(index + 1) }
  return <div className="en-card en-stack">
    <div className="en-row">
      <div className="en-dots" aria-label={`Упражнение ${n} из ${g.exercises.length}`}>{g.exercises.map((_, i) => { const r = results.get(i + 1)
        return <span key={i} data-state={r ? (r.ok ? 'ok' : 'bad') : i === index ? 'now' : undefined} /> })}</div>
      <span className="en-muted">{n} из {g.exercises.length} · {task.skill ?? KIND[task.type]}</span>
    </div>
    {task.type === 'fix' ? <><span className="en-sub">{KIND.fix}</span><p className="en-sentence"><s className="en-sentence__wrong">{task.prompt}</s></p></>
      : <p className="en-sentence">{before}<span className="en-sentence__gap" data-state={graded ? (graded.ok ? 'ok' : 'bad') : undefined}>{graded ? graded.answer : task.type === 'choice' ? '?' : value || '…'}</span>{after}</p>}
    {task.type === 'choice' && task.options ? <div className="en-pickers en-pickers--big" role="group" aria-label="Варианты ответа">
      {task.options.map((option) => <button key={option} type="button" disabled={!!graded || busy} aria-pressed={graded?.given === option}
        data-state={graded && option === graded.answer ? 'ok' : graded && option === graded.given ? 'bad' : undefined} onClick={() => submit(option)}>{option}</button>)}
    </div> : !graded && <form className="en-answer" onSubmit={(event) => { event.preventDefault(); submit(value) }}>
      <input value={value} onChange={(event) => setValue(event.target.value)} aria-label={task.type === 'fix' ? 'Исправленное предложение' : 'Пропущенное слово'} autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={300} placeholder={task.type === 'fix' ? 'Перепиши предложение правильно' : 'Ответ'} />
      <button type="submit" className="en-btn en-btn--primary" disabled={busy || !value.trim()}>Проверить</button>
    </form>}
    {graded && <>
      <div className="en-feedback" data-state={graded.ok ? 'ok' : 'bad'} aria-live="polite">{graded.ok ? <CircleCheck size={18} /> : <CircleAlert size={18} />}
        <span>{graded.ok ? <strong>Верно. </strong> : <><strong>Правильно: {graded.answer.replace(/[.!?]$/, '')}.</strong>{task.type !== 'choice' && graded.given && <> Ты написал: «{graded.given}». </>} </>}{graded.explain_ru}</span></div>
      <button type="button" className="en-btn en-btn--dark en-self-end" onClick={next}>{last ? 'Посмотреть итог' : 'Следующее'} <ArrowRight size={16} /></button>
    </>}
  </div>
}

function Done({ g, results, onNext }: { g: EnglishGrammarLesson; results: ReadonlyMap<number, EnglishTaskResult>; onNext: () => void }) {
  const right = [...results.values()].filter((r) => r.ok).length, total = g.exercises.length
  const groups = new Map<string, { ok: number; all: number }>()
  g.exercises.forEach((task, i) => { const key = task.skill ?? KIND[task.type]; const entry = groups.get(key) ?? { ok: 0, all: 0 }; entry.all += 1; if (results.get(i + 1)?.ok) entry.ok += 1; groups.set(key, entry) })
  const weak = [...groups.entries()].filter(([, v]) => v.ok < v.all).map(([k]) => k)
  return <div className="en-card en-result">
    <div className="en-ring" role="img" aria-label={`Верно ${right} из ${total}`} style={{ '--en-ring': `${Math.round(right / total * 360)}deg` } as React.CSSProperties}><div><strong>{right} / {total}</strong><span>верно</span></div></div>
    <div className="en-stack">
      <strong className="en-h">{right / total >= 0.8 ? 'Отлично — тема держится.' : right / total >= 0.5 ? 'Хорошая база, но есть что подтянуть.' : 'Тема пока шатается — разбери пояснения ещё раз.'}</strong>
      {[...groups.entries()].map(([label, v]) => <div key={label} className="en-meter"><div className="en-row"><span className="en-label">{label}</span><span className="en-muted">{v.ok} из {v.all}</span></div>
        <div className="en-meter__bar"><div data-state={v.ok === v.all ? 'ok' : 'bad'} style={{ width: `${Math.round(v.ok / v.all * 100)}%` }} /></div></div>)}
      {weak.length > 0 && <p className="en-banner en-banner--warm"><Route size={16} /> Повтори: {weak.join(', ')}. Если ошибки повторятся в отчётах, курс сам добавит урок на эту тему.</p>}
      <button type="button" className="en-btn en-btn--primary en-self-start" onClick={onNext}>Дальше <ArrowRight size={16} /></button>
    </div>
  </div>
}

/** Hand-written grammar lesson as four steps; each exercise is graded on the server as soon as it is answered. */
export function GrammarBlock({ lesson, en, onNext }: { lesson: EnglishLesson; en: CourseHook; onNext: () => void }) {
  const g = lesson.content.grammar!
  const stored = lesson.progress.grammar
  const [graded, setGraded] = useState<readonly EnglishTaskResult[]>(() => (stored?.results ?? []) as readonly EnglishTaskResult[])
  const results = new Map(graded.map((r) => [r.n, r]))
  const allDone = results.size === g.exercises.length
  const steps: Step[] = g.traps?.length ? ['learn', 'trap', 'practice', 'done'] : ['learn', 'practice', 'done']
  const [step, setStep] = useState<Step>(allDone ? 'done' : results.size ? 'practice' : 'learn')
  const at = steps.indexOf(step)
  const answer = (n: number, value: string) => void en.run(async () => {
    const out = await getSharedApiClient().englishTasks(lesson.id, 'grammar', { [String(n)]: value })
    setGraded(out.results)
    if (out.done) await en.refresh()
  })
  return <section className="en-stack" aria-label="Грамматика">
    <div className="en-gram-hero">
      <div className="en-row en-row--top">
        <div className="en-stack en-stack--tight"><span className="en-eyebrow">Грамматика · {lesson.content.grammar_focus}</span><h2 className="en-hero__title">{g.title}</h2></div>
        <span className="en-pill">Шаг {at + 1} из {steps.length}</span>
      </div>
      <ol className="en-steps-bar" aria-label="Шаги урока">{steps.map((s, i) => <li key={s}>
        <button type="button" aria-current={s === step ? 'step' : undefined} data-state={i < at ? 'done' : i === at ? 'now' : undefined} disabled={s === 'done' && !allDone} onClick={() => setStep(s)}><span />{STEP_TITLE[s]}</button></li>)}</ol>
    </div>
    {step === 'learn' && <><Learn g={g} /><button type="button" className="en-btn en-btn--primary en-self-end" onClick={() => setStep(steps[1]!)}>{steps[1] === 'trap' ? 'Дальше: ловушка' : 'К упражнениям'} <ArrowRight size={16} /></button></>}
    {step === 'trap' && <><Trap g={g} /><button type="button" className="en-btn en-btn--primary en-self-end" onClick={() => setStep('practice')}>К упражнениям <ArrowRight size={16} /></button></>}
    {step === 'practice' && <Practice g={g} results={results} busy={en.busy || en.writeBlocked} onAnswer={answer} onFinish={() => setStep('done')} />}
    {step === 'done' && <Done g={g} results={results} onNext={onNext} />}
  </section>
}
