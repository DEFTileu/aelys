import { useEffect, useRef, useState } from 'react'
import type { EnglishFigure, EnglishLesson, EnglishTask, EnglishTaskResult } from '@aelys/shared'
import { ArrowRight, Lightbulb, Search, Timer } from '../../../icons'
import { getSharedApiClient } from '../../../lib/api'
import type { CourseHook } from '../useEnglishCourse'

const KIND: Record<EnglishTask['type'], string> = { tfng: 'True / False / Not Given', mcq: 'Выбери ответ', heading: 'Заголовок абзаца', gap: 'Впиши слово из текста (не больше двух)', choice: 'Выбери ответ', fix: '' }
const LIMIT = 20 * 60
// Academic Reading raw score out of 40 → band (published conversion, rounded to the usual table).
const BANDS: [number, number][] = [[39, 9], [37, 8.5], [35, 8], [33, 7.5], [30, 7], [27, 6.5], [23, 6], [19, 5.5], [15, 5], [13, 4.5], [10, 4], [0, 3.5]]
export const readingBand = (right: number, total: number) => BANDS.find(([raw]) => Math.round(right / total * 40) >= raw)![1]
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

/** Splits a paragraph into plain text, glossary buttons and the highlighted evidence (glossary inside the evidence stays plain). */
export function segments(text: string, words: readonly string[], evidence: string | null) {
  const mark = evidence ? text.indexOf(evidence) : -1
  const ranges: { start: number; end: number; gloss?: string; mark?: boolean }[] = mark >= 0 ? [{ start: mark, end: mark + evidence!.length, mark: true }] : []
  for (const word of words) {
    const at = text.indexOf(word)
    if (at >= 0 && !ranges.some((r) => at < r.end && at + word.length > r.start)) ranges.push({ start: at, end: at + word.length, gloss: word })
  }
  ranges.sort((a, b) => a.start - b.start)
  const out: { t: string; gloss?: string; mark?: boolean }[] = []
  let pos = 0
  for (const r of ranges) { if (r.start > pos) out.push({ t: text.slice(pos, r.start) }); out.push({ t: text.slice(r.start, r.end), gloss: r.gloss, mark: r.mark }); pos = r.end }
  if (pos < text.length) out.push({ t: text.slice(pos) })
  return out
}

function Chart({ figure, focus }: { figure: EnglishFigure; focus: boolean }) {
  const [pick, setPick] = useState<number | null>(null)
  const all = figure.series.flatMap((s) => s.values)
  const peak = Math.max(...all, 1), unit = 10 ** Math.floor(Math.log10(peak))
  const max = Math.ceil(peak * 1.05 / unit) * unit, min = Math.min(0, ...all) // round axis top: 80 → 90, 7.4 → 8
  const W = 480, H = 200, padL = 36, padB = 8, step = (W - padL) / figure.labels.length
  const y = (v: number) => H - padB - ((v - min) / (max - min)) * (H - padB - 14)
  const ticks = [0, 0.5, 1].map((f) => min + (max - min) * f)
  const groupW = step * 0.7, barW = groupW / figure.series.length
  const summary = figure.series.map((s) => `${s.name}: ${figure.labels.map((l, i) => `${l} — ${s.values[i]}`).join(', ')}`).join('; ')
  return <figure className="en-figure" data-focus={focus || undefined}>
    <figcaption className="en-row"><strong>{figure.title}</strong><span className="en-muted">{figure.unit}</span></figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${figure.title}. ${summary}`} className="en-figure__svg">
      {ticks.map((t) => <g key={t} aria-hidden="true"><line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="en-figure__grid" /><text x={padL - 6} y={y(t) + 4} textAnchor="end" className="en-figure__tick">{Math.round(t)}</text></g>)}
      {figure.kind === 'bar' ? figure.series.map((s, k) => s.values.map((v, i) => <rect key={`${k}-${i}`} data-series={k} data-on={pick === i || undefined} x={padL + step * i + (step - groupW) / 2 + barW * k} y={y(v)} width={barW - 3} height={Math.max(y(min) - y(v), 1)} rx={4} />))
        : figure.series.map((s, k) => <g key={k} data-series={k}><polyline fill="none" className="en-figure__line" points={s.values.map((v, i) => `${padL + step * i + step / 2},${y(v)}`).join(' ')} />
          {s.values.map((v, i) => <circle key={i} data-on={pick === i || undefined} cx={padL + step * i + step / 2} cy={y(v)} r={pick === i ? 7 : 5} />)}</g>)}
      {pick !== null && figure.series.map((s, k) => <text key={k} x={padL + step * pick + step / 2 + (figure.kind === 'bar' ? barW * (k - (figure.series.length - 1) / 2) : 0)} y={y(s.values[pick]!) - 8} textAnchor="middle" className="en-figure__value">{s.values[pick]}</text>)}
    </svg>
    <div className="en-figure__labels" style={{ paddingLeft: `${padL / W * 100}%` }} role="group" aria-label="Значения по подписям">
      {figure.labels.map((label, i) => <button key={label} type="button" aria-pressed={pick === i} onClick={() => setPick(pick === i ? null : i)}>{label}</button>)}</div>
    {figure.series.length > 1 && <ul className="en-figure__legend">{figure.series.map((s, k) => <li key={s.name} data-series={k}><span />{s.name}</li>)}</ul>}
    <p className="en-muted" aria-live="polite">{pick === null ? 'Нажми на подпись под графиком — увидишь значения.' : figure.series.map((s) => `${s.name}: ${s.values[pick]} (${figure.labels[pick]})`).join(' · ')}</p>
  </figure>
}

/** IELTS-style passage with chart, tap-to-translate words and evidence highlighting; all answers are checked at once on the server. */
export function ReadingBlock({ lesson, en, active, onNext }: { lesson: EnglishLesson; en: CourseHook; active: boolean; onNext: () => void }) {
  const p = lesson.content.reading!
  const stored = lesson.progress.reading
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [graded, setGraded] = useState<readonly EnglishTaskResult[]>(() => (stored?.results ?? []) as readonly EnglishTaskResult[])
  const [open, setOpen] = useState<string | null>(null)
  const [focus, setFocus] = useState<{ evidence: string | null; figure: boolean } | null>(null)
  const [seconds, setSeconds] = useState(0)
  const textRef = useRef<HTMLElement>(null)
  const checked = graded.length === p.questions.length
  const byN = new Map(graded.map((r) => [r.n, r]))
  useEffect(() => { if (!active || checked) return; const id = setInterval(() => setSeconds((s) => s + 1), 1000); return () => clearInterval(id) }, [active, checked])
  const words = (p.glossary ?? []).map((g) => g.word), ru = new Map((p.glossary ?? []).map((g) => [g.word, g.ru]))
  const check = () => void en.run(async () => {
    const out = await getSharedApiClient().englishTasks(lesson.id, 'reading', Object.fromEntries(p.questions.map((_, i) => [String(i + 1), answers[String(i + 1)] ?? ''])))
    setGraded(out.results); await en.refresh()
  })
  const show = (r: EnglishTaskResult, aboutFigure: boolean) => {
    setFocus({ evidence: r.evidence ?? null, figure: aboutFigure })
    requestAnimationFrame(() => textRef.current?.querySelector(aboutFigure ? '.en-figure' : 'mark')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }
  const right = graded.filter((r) => r.ok).length
  const band = readingBand(right, p.questions.length)
  return <section className="en-stack" aria-label="Чтение">
    <div className="en-card en-row en-read-head">
      <div className="en-stack en-stack--tight"><span className="en-eyebrow en-eyebrow--ink">Reading · IELTS Academic</span><h2 className="en-h">{p.title}</h2></div>
      <div className="en-pills"><span className="en-pill en-pill--soft" data-state={seconds > LIMIT ? 'bad' : undefined}><Timer size={15} /> {clock(seconds)} из 20:00</span>
        <span className="en-pill en-pill--soft">{checked ? `${right} из ${p.questions.length} верно` : `${Object.values(answers).filter((v) => v.trim()).length} из ${p.questions.length} отвечено`}</span></div>
    </div>
    <div className="en-read">
      <article className="en-card en-stack en-passage-card" ref={textRef}>
        {p.figure && <Chart figure={p.figure} focus={!!focus?.figure} />}
        {p.paragraphs.map((para) => { const hit = focus?.evidence && para.text.includes(focus.evidence)
          return <p key={para.label} className="en-para" data-focus={hit || undefined}><span className="en-para__label">{para.label}</span>
            {segments(para.text, words, hit ? focus!.evidence : null).map((s, i) => s.mark ? <mark key={i}>{s.t}</mark>
              : s.gloss ? <span key={i}><button type="button" className="en-gloss" aria-expanded={open === `${para.label}:${s.gloss}`} onClick={() => setOpen(open === `${para.label}:${s.gloss}` ? null : `${para.label}:${s.gloss}`)}>{s.t}</button>
                {open === `${para.label}:${s.gloss}` && <span role="note" className="en-gloss__ru">{ru.get(s.gloss)}</span>}</span>
              : <span key={i}>{s.t}</span>)}</p> })}
        {words.length > 0 && <p className="en-muted"><Lightbulb size={14} /> Подчёркнутые слова — нажми, чтобы увидеть перевод.</p>}
      </article>
      <form className="en-stack en-stack--tight" onSubmit={(event) => { event.preventDefault(); if (!checked) check() }}>
        {p.questions.map((q, i) => { const n = i + 1, r = byN.get(n), value = r?.given ?? answers[String(n)] ?? ''
          return <div key={n} className="en-card en-q-card" data-state={r ? (r.ok ? 'ok' : 'bad') : undefined}>
            <div className="en-q-card__head"><span className="en-q-card__n">{n}</span><div><span className="en-q-card__kind">{q.about_figure ? `Figure · ${KIND[q.type]}` : KIND[q.type]}</span><p>{q.prompt}</p></div></div>
            {q.options ? <div role="radiogroup" aria-label={`Ответ ${n}`} className="en-pickers">{q.options.map((option) => <button key={option} type="button" role="radio" aria-checked={value === option} disabled={checked}
              data-state={r && option === r.answer ? 'ok' : r && option === r.given ? 'bad' : undefined} onClick={() => setAnswers({ ...answers, [String(n)]: option })}>{option}</button>)}</div>
              : <input value={value} disabled={checked} aria-label={`Ответ ${n}`} autoComplete="off" maxLength={80} className="en-input" onChange={(event) => setAnswers({ ...answers, [String(n)]: event.target.value })} />}
            {r && <div className="en-stack en-stack--tight"><p className="en-q-card__why">{r.ok ? <strong>Верно. </strong> : <strong>Правильно: {r.answer}. </strong>}{r.explain_ru}</p>
              {(r.evidence || q.about_figure) && <button type="button" className="en-btn en-btn--small en-self-start" onClick={() => show(r, !!q.about_figure)}><Search size={14} /> {q.about_figure ? 'Показать на графике' : 'Показать в тексте'}</button>}</div>}
          </div> })}
        {!checked && <button type="submit" className="en-btn en-btn--primary" disabled={en.busy || en.writeBlocked || !Object.values(answers).some((v) => v.trim())}>{en.busy ? 'Проверяем…' : 'Проверить ответы'}</button>}
        {checked && <div className="en-read-result">
          <div className="en-row"><strong>{right} из {p.questions.length}</strong><span>≈ Band {band.toFixed(1)} в пересчёте на 40 вопросов</span></div>
          <div className="en-band" role="img" aria-label={`Шкала от 4 до 9, ты около ${band.toFixed(1)}`}><div style={{ width: `${Math.max(0, Math.min(100, (band - 4) / 5 * 100))}%` }} /></div>
          <div className="en-band__ticks" aria-hidden="true"><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span></div>
          <span>Нажми «Показать в тексте» у ошибок — увидишь, где был ответ.</span>
          <button type="button" className="en-btn en-btn--primary en-self-start" onClick={onNext}>Дальше <ArrowRight size={16} /></button>
        </div>}
      </form>
    </div>
  </section>
}
