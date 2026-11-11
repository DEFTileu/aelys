import { useState } from 'react'
import type { EnglishGrammarLesson, EnglishLesson, EnglishReadingPassage, EnglishTask, EnglishTasksResult } from '@aelys/shared'
import { Lightbulb } from '../../../icons'
import { getSharedApiClient } from '../../../lib/api'
import type { CourseHook } from '../useEnglishCourse'

const HINT: Record<EnglishTask['type'], string> = { gap: 'Впиши пропущенное', choice: 'Выбери вариант', fix: 'Исправь ошибку и перепиши предложение', tfng: 'TRUE / FALSE / NOT GIVEN', mcq: 'Выбери ответ', heading: 'Выбери заголовок абзаца', }

function Task({ task, n, value, onChange, graded }: { task: EnglishTask; n: number; value: string; onChange: (value: string) => void; graded: EnglishTasksResult['results'][number] | undefined }) {
  const state = graded ? (graded.ok ? 'ok' : 'bad') : undefined
  return <div className="en-task" data-state={state}>
    <p className="en-task__prompt"><span className="en-q__n">{n}</span><span><small className="en-muted">{HINT[task.type]}</small><br />{task.prompt}</span></p>
    {task.options ? <div role="radiogroup" aria-label={`Ответ ${n}`} className="en-options">{task.options.map((option) =>
      <button key={option} type="button" role="radio" aria-checked={(graded?.given ?? value) === option} disabled={!!graded}
        data-state={graded && option === graded.answer ? 'ok' : graded && option === graded.given ? 'bad' : undefined} onClick={() => onChange(option)}>{option}</button>)}</div>
      : <input value={graded?.given ?? value} disabled={!!graded} data-state={state} aria-label={`Ответ ${n}`} autoComplete="off" maxLength={300} onChange={(event) => onChange(event.target.value)} />}
    {graded && <p className="en-task__explain">{graded.ok ? '✓ ' : <><strong>Правильно: {graded.answer.replace(/[.!?]$/, '')}.</strong> </>}{graded.explain_ru}</p>}
  </div>
}

/** Hand-written grammar lesson or reading passage; answers are graded on the server and the first check is final. */
export function TasksBlock({ lesson, en, kind, onNext }: { lesson: EnglishLesson; en: CourseHook; kind: 'grammar' | 'reading'; onNext: () => void }) {
  const item = (kind === 'grammar' ? lesson.content.grammar : lesson.content.reading)!
  const tasks = 'exercises' in item ? item.exercises : item.questions
  const stored = lesson.progress[kind]
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<EnglishTasksResult | null>(null)
  const results = (result?.results ?? (stored?.done ? stored.results : undefined)) as EnglishTasksResult['results'] | undefined
  const byN = new Map((results ?? []).map((r) => [r.n, r]))
  const check = () => void en.run(async () => { setResult(await getSharedApiClient().englishTasks(lesson.id, kind, answers)); await en.refresh() })
  const score = result ?? (stored?.done ? { score: stored.score ?? 0, total: stored.total ?? tasks.length } : null)

  return <section className="en-card" aria-label={kind === 'grammar' ? 'Грамматика' : 'Чтение'}>
    <div><h2 className="en-h">{kind === 'grammar' ? `Грамматика: ${item.title}` : `Reading: ${item.title}`}</h2>
      <p className="en-muted">{kind === 'grammar' ? 'Правило, примеры и упражнения. Ответы проверяются сразу все, один раз.' : 'Текст в формате IELTS Academic. Читай сначала вопросы, потом ищи ответ в тексте — без словаря.'}</p></div>
    {kind === 'grammar' && 'rule_ru' in item && <Rule lesson={item} />}
    {'paragraphs' in item && <Passage passage={item} />}
    <form className="en-stack en-stack--tight" onSubmit={(event) => { event.preventDefault(); if (!score) check() }}>
      <h3 className="en-sub">{kind === 'grammar' ? 'Упражнения' : 'Вопросы'} 1–{tasks.length}</h3>
      {tasks.map((task, i) => <Task key={i} task={task} n={i + 1} value={answers[String(i + 1)] ?? ''} graded={byN.get(i + 1)} onChange={(value) => setAnswers({ ...answers, [String(i + 1)]: value })} />)}
      <div className="en-actions">
        {!score && <button type="submit" className="en-btn en-btn--primary" disabled={en.busy || en.writeBlocked || !Object.values(answers).some((value) => value.trim())}>{en.busy ? 'Проверяем…' : 'Проверить ответы'}</button>}
        {score && <><div className="en-banner en-banner--warm" role="status"><strong>{score.score} из {score.total}.</strong> {score.score / score.total >= 0.8 ? 'Отлично, тема держится.' : 'Разбери пояснения к ошибкам — эта тема вернётся в повторении.'}</div>
          <button type="button" className="en-btn en-btn--primary" onClick={onNext}>Дальше</button></>}
      </div>
    </form>
  </section>
}

function Rule({ lesson }: { lesson: EnglishGrammarLesson }) {
  return <div className="en-stack en-stack--tight">
    <div className="en-rule">{lesson.rule_ru.map((text, i) => <p key={i}>{i === 0 && <Lightbulb size={16} />} {text}</p>)}</div>
    <ul className="en-examples">{lesson.examples.map((example) => <li key={example.en}><strong>{example.en}</strong><span className="en-muted">{example.ru}</span></li>)}</ul>
  </div>
}

function Passage({ passage }: { passage: EnglishReadingPassage }) {
  return <article className="en-passage">{passage.paragraphs.map((paragraph) => <p key={paragraph.label}><span className="en-passage__label">{paragraph.label}</span>{paragraph.text}</p>)}</article>
}
