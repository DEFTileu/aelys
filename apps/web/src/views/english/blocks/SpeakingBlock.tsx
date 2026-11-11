import { useEffect, useRef, useState } from 'react'
import type { EnglishLesson, EnglishStoredSpeakingRound } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { Check, Mic, RotateCcw, Sparkles, Square, Timer } from '../../../icons'
import { getSharedApiClient } from '../../../lib/api'
import { formatClock, recordingSupported, startRecording, type Recording } from '../speech'
import { wordCount } from '../useEnglish'
import type { CourseHook } from '../useEnglishCourse'

type Round = 4 | 3 | 2
const ROUNDS: Round[] = [4, 3, 2]
const MIN_TRANSCRIPT = 5
const MAX_TRANSCRIPT = 6000 // backend limit
type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'edit' | 'typed'
const TIP_ICON = { timing: Timer, vocab: Sparkles, good: Check }
const plural = (n: number, a: string, b: string, c: string) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c }

export function SpeakingBlock({ lesson, en, active }: { lesson: EnglishLesson; en: CourseHook; active: boolean }) {
  const { part2, part3, phrases } = lesson.content.speaking!
  const [round, setRound] = useState<Round>(4)
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [transcript, setTranscript] = useState('')
  const [fallback, setFallback] = useState('')
  const [results, setResults] = useState<Partial<Record<Round, EnglishStoredSpeakingRound>>>(() => Object.fromEntries(ROUNDS.filter((r) => lesson.progress.speaking?.rounds?.[String(r)]).map((r) => [r, lesson.progress.speaking!.rounds![String(r)]])))
  const recording = useRef<Recording | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const elapsedRef = useRef(0)
  const mounted = useRef(true)
  const starting = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const limit = round * 60
  const result = results[round]

  const clear = () => { window.clearInterval(timer.current); timer.current = undefined }
  const discard = () => { clear(); recording.current?.cancel(); recording.current = null }
  useEffect(() => { if (!active) { discard(); setPhase((p) => p === 'recording' ? 'idle' : p) } }, [active])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; discard() } }, [])
  const resetTimer = () => { elapsedRef.current = 0; setElapsed(0) } // typed answers must not inherit a previous recording's duration

  const toTyped = (reason: string) => { discard(); setFallback(reason); setPhase('typed') }
  const start = async () => {
    if (starting.current || recording.current) return // double tap while the permission prompt is open
    resetTimer()
    if (!recordingSupported()) return toTyped('Запись недоступна в этом браузере.')
    starting.current = true; setPhase('starting')
    let started: Recording
    try { started = await startRecording() } catch { starting.current = false; return mounted.current ? toTyped('Нет доступа к микрофону. Разреши его в настройках браузера или напечатай ответ.') : undefined }
    starting.current = false
    if (!mounted.current || recording.current || !activeRef.current) { started.cancel(); if (mounted.current && !recording.current) setPhase('idle'); return }
    recording.current = started
    setTranscript(''); setFallback(''); setPhase('recording')
    timer.current = window.setInterval(() => {
      elapsedRef.current += 1; setElapsed(elapsedRef.current)
      if (elapsedRef.current >= limit) void stop()
    }, 1000)
  }
  const stop = async () => {
    const current = recording.current
    if (!current) return
    clear(); recording.current = null; setPhase('transcribing')
    try {
      const { text } = await getSharedApiClient().englishTranscribe(await current.stop())
      setTranscript(text.slice(0, MAX_TRANSCRIPT)); setPhase('edit')
    } catch (error) {
      toTyped(error instanceof ApiError && error.code === 'TRANSCRIPTION_NOT_CONFIGURED' ? 'Расшифровка не настроена. Напечатай, что сказал.' : 'Не удалось расшифровать запись. Напечатай, что сказал.')
    }
  }
  const submit = () => void en.run(async () => {
    // Typed answers have no timer; estimate speaking time at ~130 words per minute.
    const duration = elapsedRef.current > 0 ? elapsedRef.current : Math.max(1, Math.round(wordCount(transcript) / 130 * 60))
    const saved = await getSharedApiClient().englishSpeaking(lesson.id, { round, transcript: transcript.trim(), duration_sec: duration })
    setResults((prev) => ({ ...prev, [round]: saved })); setPhase('idle'); setTranscript(''); resetTimer()
    await en.refresh()
  })
  const pick = (value: Round) => { discard(); resetTimer(); setRound(value); setPhase('idle'); setTranscript(''); setFallback('') }
  const state = phase === 'recording' ? `Идёт запись · говори до ${formatClock(limit)}` : phase === 'transcribing' ? 'Расшифровываем…' : phase === 'edit' ? 'Проверь расшифровку и отправь' : result && phase === 'idle' ? 'Раунд записан и проверен' : 'Подготовка: набросай 3–4 ключевых слова'
  const done = ROUNDS.filter((r) => results[r])

  return <section className="en-card" aria-label="Speaking">
    <div><h2 className="en-h">Speaking · 4/3/2</h2>
      <p className="en-muted">Одну тему рассказываешь три раза: за 4, 3 и 2 минуты. С каждым разом меньше пауз и больше связок — это и оценивают в Fluency.</p></div>
    <div className="en-seg" role="group" aria-label="Раунд">{ROUNDS.map((r) => <button key={r} type="button" aria-pressed={round === r} disabled={phase === 'recording' || phase === 'starting' || phase === 'transcribing'} onClick={() => pick(r)}>{r} мин{results[r] ? ' ✓' : ''}</button>)}</div>
    <div className="en-topic">
      <p className="en-topic__title">{part2.topic}</p>
      <p>You should say: {part2.bullets.join(' · ')}</p>
    </div>
    {phrases.length > 0 && <ul className="en-tags" aria-label="Полезные связки">{phrases.map((item) => <li key={item}>{item}</li>)}</ul>}
    {part3.length > 0 && <details className="en-details"><summary>Part 3: вопросы для обсуждения</summary><ol>{part3.map((item) => <li key={item}>{item}</li>)}</ol></details>}

    {phase !== 'typed' && phase !== 'edit' && <div className="en-rec">
      {phase === 'recording'
        ? <button type="button" className="en-rec__btn is-live" aria-label="Остановить запись" onClick={() => void stop()}><Square size={26} /></button>
        : <button type="button" className="en-rec__btn" aria-label="Начать запись" disabled={phase === 'starting' || phase === 'transcribing' || en.busy || en.writeBlocked} onClick={() => void start()}><Mic size={26} /></button>}
      <div><div className="en-rec__time" role="timer" aria-label="Осталось времени">{formatClock(phase === 'recording' ? limit - elapsed : limit)}</div>
        <p className="en-muted" role="status">{state}</p></div>
      {phase === 'idle' && <button type="button" className="en-link" onClick={() => { resetTimer(); toTyped('') }}>Напечатать вместо записи</button>}
    </div>}

    {(phase === 'edit' || phase === 'typed') && <div className="en-stack en-stack--tight">
      {fallback && <p className="en-banner" role="status">{fallback}</p>}
      <label htmlFor="en-transcript" className="en-label">{phase === 'edit' ? 'Расшифровка (можно поправить)' : 'Напечатай, что сказал'}</label>
      <textarea id="en-transcript" rows={8} maxLength={6000} value={transcript} onChange={(event) => setTranscript(event.target.value)} />
      <div className="en-row"><span className="en-muted" aria-live="polite">Слов: {wordCount(transcript)} · {transcript.length}/{MAX_TRANSCRIPT}</span>
        <span className="en-actions"><button type="button" className="en-btn" onClick={() => { discard(); resetTimer(); setPhase('idle'); setTranscript('') }}>Отмена</button>
          <button type="button" className="en-btn en-btn--primary" disabled={en.busy || en.writeBlocked || transcript.trim().length < MIN_TRANSCRIPT} onClick={submit}>{en.busy ? 'Проверяем…' : 'Отправить на проверку'}</button></span></div>
    </div>}

    {result && phase === 'idle' && <div className="en-stack" aria-live="polite">
      <div className="en-cmp">{done.map((r) => { const item = results[r]!, pauses = item.pauses ?? 0, linkers = item.linkers_used ?? 0; return <div key={r} data-last={r === 2 || undefined}><small>Раунд {r} мин</small><strong>{pauses} {plural(pauses, 'пауза', 'паузы', 'пауз')}</strong><small>{linkers} {plural(linkers, 'связка', 'связки', 'связок')}</small></div> })}</div>
      <p className="en-muted">Оценки ниже — по расшифровке, примерно. Произношение и интонация по тексту не видны, их не оцениваем.</p>
      <ul className="en-crit" aria-label={`Критерии, раунд ${round} мин`}>
        <li><strong>{result.criteria.fluency}</strong><span>Fluency & Coherence</span></li>
        <li><strong>{result.criteria.lexical}</strong><span>Lexical Resource</span></li>
        <li><strong>{result.criteria.grammar}</strong><span>Grammar Range & Accuracy</span></li></ul>
      {!!result.corrected_html_safe?.length && <p className="en-corrected">{result.corrected_html_safe.map((seg, i) => seg.type === 'del' ? <del key={i}>{seg.text}</del> : seg.type === 'ins' ? <ins key={i}>{seg.text}</ins> : <span key={i}>{seg.text}</span>)}</p>}
      {!!result.tips?.length && <ul className="en-tips">{result.tips.map((tip, i) => { const Icon = TIP_ICON[tip.kind] ?? Sparkles; return <li key={i} data-kind={tip.kind}><Icon size={16} /><span><strong>{tip.title_ru}</strong> {tip.detail_ru}</span></li> })}</ul>}
      <button type="button" className="en-btn" onClick={() => { resetTimer(); setResults((prev) => ({ ...prev, [round]: undefined })) }}><RotateCcw size={16} /> Ответить ещё раз с этими фразами</button>
    </div>}
  </section>
}
