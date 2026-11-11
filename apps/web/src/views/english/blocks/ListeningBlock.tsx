import { useEffect, useRef, useState } from 'react'
import type { EnglishLesson, EnglishListeningResult } from '@aelys/shared'
import { ArrowUpRight, Pause, Play, Volume2 } from '../../../icons'
import { getSharedApiClient } from '../../../lib/api'
import { speakParts, speechSupported, stopSpeaking } from '../speech'
import type { CourseHook } from '../useEnglishCourse'

const MAX_PLAYS = 2
const STEPS: [string, string, string][] = [['Предскажи', 'По заголовку: какие 5 слов прозвучат?', ''], ['Послушай', 'Живая запись, без текста', 'on'], ['Проверь', 'Вопросы, потом текст', ''], ['Разбери', 'Что не услышал и почему', '']]

export function ListeningBlock({ lesson, en, active, defaultRate }: { lesson: EnglishLesson; en: CourseHook; active: boolean; defaultRate: number }) {
  const listening = lesson.content.listening!
  const stored = lesson.progress.listening
  const [rate, setRate] = useState(defaultRate)
  const [plays, setPlays] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [turn, setTurn] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<EnglishListeningResult | null>(null)
  const [showScript, setShowScript] = useState(false)
  const [drilling, setDrilling] = useState<number | null>(null)
  const cancel = useRef<() => void>(() => undefined)
  const checked = result !== null || !!stored?.done
  const stop = () => { cancel.current(); stopSpeaking(); setPlaying(false); setDrilling(null) }
  useEffect(() => { if (!active) stop() }, [active])
  useEffect(() => stop, [])

  const play = () => {
    if (playing) return stop()
    if (plays >= MAX_PLAYS && !checked) return
    setPlays((n) => n + 1); setPlaying(true); setTurn(0)
    cancel.current = speakParts(listening.script.map((line) => ({ text: line.text, rate, pitch: line.speaker === 'B' ? 1.15 : 0.95 })), { onPart: setTurn, onDone: () => { setPlaying(false); setTurn(0) } })
  }
  const drill = (index: number) => {
    stop()
    const phrase = listening.connected_speech[index]!.phrase
    setDrilling(index)
    cancel.current = speakParts([{ text: phrase, rate: 0.7 }, { text: phrase, rate: 1 }], { onDone: () => setDrilling(null) })
  }
  const check = () => void en.run(async () => {
    stop()
    setResult(await getSharedApiClient().englishListening(lesson.id, answers))
    await en.refresh()
  })
  const byN = new Map((result?.results ?? stored?.results ?? []).map((item) => [item.n, item]))
  const percent = playing ? Math.round(((turn + 1) / listening.script.length) * 100) : 0

  return <section className="en-card" aria-label="Listening">
    <div><h2 className="en-h">Listening</h2>
      <p className="en-muted">Цикл: предскажи → послушай → проверь → разбери, что не расслышал. Так учат понимать речь, а не угадывать.</p></div>
    <ol className="en-steps">{STEPS.map(([title, detail, mark], i) => <li key={title} data-on={mark || undefined}><span>Шаг {i + 1}</span><strong>{title}</strong><small>{detail}</small></li>)}</ol>
    <div className="en-live">
      <span className="en-live__badge" aria-hidden="true">BBC</span>
      <div className="en-live__text"><strong>Шаг 1 · Живая речь: {listening.live.source}</strong><span className="en-muted">{listening.live.hint_ru}</span></div>
      <a className="en-link-btn" href={listening.live.url} target="_blank" rel="noreferrer noopener">Открыть <ArrowUpRight size={14} /></a>
    </div>
    <h3 className="en-sub">Шаг 2 · «{listening.title}» (озвучено синтезом, скорость регулируется)</h3>
    {speechSupported() ? <div className="en-player">
      <button type="button" className="en-play" onClick={play} disabled={!playing && plays >= MAX_PLAYS && !checked} aria-label={playing ? 'Остановить' : 'Слушать'}>{playing ? <Pause size={22} /> : <Play size={22} />}</button>
      <div className="en-player__bar"><div className="en-progress" role="progressbar" aria-label="Прогресс записи" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div style={{ width: `${percent}%` }} /></div>
        <span className="en-muted" aria-live="polite">Прослушиваний: {plays} из {MAX_PLAYS}{plays >= MAX_PLAYS && !checked ? ' · теперь отвечай' : ''}</span></div>
      <div role="group" aria-label="Скорость" className="en-speeds">{[0.8, 0.9, 1].map((value) => <button key={value} type="button" aria-pressed={rate === value} onClick={() => setRate(value)}>{value}×</button>)}</div>
    </div> : <p className="en-banner" role="status">Озвучка недоступна в этом браузере. Открой запись BBC выше и ответь по ней.</p>}
    <form className="en-stack en-stack--tight" onSubmit={(event) => { event.preventDefault(); if (!checked) check() }}>
      <h3 className="en-sub">Вопросы 1–{listening.questions.length}: впиши не больше двух слов</h3>
      {listening.questions.map((q) => {
        const graded = byN.get(q.n)
        const answer = graded?.answer ?? q.answer
        const ok = graded ? graded.ok : answer !== undefined && (answers[String(q.n)] ?? '').trim().toLowerCase() === answer.toLowerCase()
        return <label key={q.n} className="en-q"><span className="en-q__n">{q.n}</span><span>{q.before}</span>
          <input value={graded?.given ?? answers[String(q.n)] ?? ''} disabled={checked} data-state={checked ? (ok ? 'ok' : 'bad') : undefined} aria-label={`Ответ ${q.n}`} autoComplete="off" maxLength={80} onChange={(event) => setAnswers({ ...answers, [String(q.n)]: event.target.value })} />
          <span>{q.after}</span>{checked && answer !== undefined && <span className={`en-q__ans ${ok ? 'is-ok' : 'is-bad'}`}>{ok ? '✓' : answer}</span>}</label>
      })}
      <div className="en-actions">
        {!checked && <button type="submit" className="en-btn en-btn--primary" disabled={en.busy || en.writeBlocked || !Object.values(answers).some((value) => value.trim())}>{en.busy ? 'Проверяем…' : 'Проверить ответы'}</button>}
        {checked && <button type="button" className="en-btn" aria-expanded={showScript} onClick={() => setShowScript(!showScript)}>{showScript ? 'Скрыть текст' : 'Показать текст аудио'}</button>}
      </div>
    </form>
    {checked && <div className="en-stack" aria-live="polite">
      {result && <div className="en-banner en-banner--warm"><strong>{result.score} из {result.total}.</strong> {result.feedback_ru}</div>}
      {!result && stored?.score !== undefined && <div className="en-banner en-banner--warm"><strong>{stored.score} из {stored.total ?? listening.questions.length}.</strong> {stored.feedback_ru}</div>}
      {listening.connected_speech.length > 0 && <div className="en-banner en-banner--purple">
        <strong>Шаг 4 · Слитная речь, 10 мин</strong>
        <span>Слушай фразу медленно, потом в темпе, и повтори вслух.</span>
        <ul className="en-drill">{listening.connected_speech.map((item, i) => <li key={item.phrase}>
          {speechSupported() && <button type="button" className="en-icon-btn" aria-label={`Послушать «${item.phrase}» медленно и в темпе`} aria-pressed={drilling === i} onClick={() => drill(i)}><Volume2 size={16} /></button>}
          <span><strong>{item.phrase}</strong> → «{item.sounds_like}» <small>{item.note_ru}</small></span></li>)}</ul>
      </div>}
      {showScript && <div className="en-script">{listening.script.map((line, i) => <p key={i}><strong>{line.speaker}:</strong> {line.text}</p>)}</div>}
    </div>}
  </section>
}
