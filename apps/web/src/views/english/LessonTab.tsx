import { useState } from 'react'
import type { EnglishBlockKey, EnglishCourse, EnglishLesson } from '@aelys/shared'
import { ArrowRight, BookA, CircleCheck, Headphones, Mic, PenLine, Repeat, type AelysIconComponent } from '../../icons'
import type { useEnglish } from './useEnglish'
import type { CourseHook } from './useEnglishCourse'
import { ListeningBlock } from './blocks/ListeningBlock'
import { SpeakingBlock } from './blocks/SpeakingBlock'
import { VocabBlock } from './blocks/VocabBlock'
import { WarmupBlock } from './blocks/WarmupBlock'
import { WritingBlock } from './blocks/WritingBlock'

const ORDER: EnglishBlockKey[] = ['warmup', 'vocab', 'listening', 'speaking', 'writing']
const META: Record<EnglishBlockKey, { title: string; note: string; Icon: AelysIconComponent; tone: string }> = {
  warmup: { title: 'Разминка', note: 'Повторение в контексте', Icon: Repeat, tone: 'blue' },
  vocab: { title: 'Слова темы', note: 'Слова и свои предложения', Icon: BookA, tone: 'amber' },
  listening: { title: 'Listening', note: 'Живая речь + формат', Icon: Headphones, tone: 'purple' },
  speaking: { title: 'Speaking', note: '4/3/2 + Part 3', Icon: Mic, tone: 'coral' },
  writing: { title: 'Writing', note: 'Отчёт или Task 2', Icon: PenLine, tone: 'green' },
}

/** `active` is false while another top-level tab is shown: this tab stays mounted, so mic and speech must stop. */
export function LessonTab({ course, lesson, en, daily, active }: { course: EnglishCourse; lesson: EnglishLesson | null; en: CourseHook; daily: ReturnType<typeof useEnglish>; active: boolean }) {
  const isDone = (key: EnglishBlockKey) => lesson?.progress[key]?.done ?? course.today.blocks.find((block) => block.key === key)?.done ?? false
  const [blk, setBlk] = useState<EnglishBlockKey>(() => ORDER.find((key) => !isDone(key)) ?? 'warmup')
  const [visited, setVisited] = useState<ReadonlySet<EnglishBlockKey>>(() => new Set([blk]))
  const open = (key: EnglishBlockKey) => { setBlk(key); setVisited((prev) => new Set(prev).add(key)) }
  const next = (from: EnglishBlockKey) => open(ORDER[Math.min(ORDER.indexOf(from) + 1, ORDER.length - 1)]!)

  if (!lesson) return <section className="en-card en-start" aria-label="Урок дня">
    <h2 className="en-h">Урок {course.lesson_no}{course.plan.find((item) => item.status === 'now') ? ` · ${course.plan.find((item) => item.status === 'now')!.theme}` : ''}</h2>
    <p className="en-muted">Пять блоков: разминка, слова темы, Listening, Speaking и Writing — около {Math.round(course.profile.minutes_per_day / 60 * 10) / 10} ч, можно частями. Урок собирает AI под твой уровень и слабые места.</p>
    <button type="button" className="en-btn en-btn--primary" disabled={en.busy || en.writeBlocked} onClick={() => void en.startLesson()}>{en.busy ? 'Готовим урок…' : `Начать урок ${course.lesson_no}`} <ArrowRight size={16} /></button>
  </section>

  const doneCount = ORDER.filter(isDone).length
  const minutes = (key: EnglishBlockKey) => course.today.blocks.find((block) => block.key === key)?.minutes
  const hidden = (key: EnglishBlockKey) => blk !== key
  return <div className="en-lesson">
    <nav className="en-card en-nav" aria-label="Блоки урока">
      <div className="en-nav__head"><strong>Урок {lesson.lesson_no} · {lesson.theme}</strong>
        <span className="en-muted">{doneCount} из {ORDER.length} блоков · ~{Math.round(course.profile.minutes_per_day / 60 * 10) / 10} ч, можно частями</span></div>
      {ORDER.map((key) => { const { title, note, Icon, tone } = META[key]; const m = minutes(key)
        return <button key={key} type="button" className="en-nav__item" aria-current={blk === key ? 'step' : undefined} onClick={() => open(key)}>
          <span className="en-ico" data-tone={tone}><Icon size={18} /></span>
          <span className="en-nav__text"><strong>{title}</strong><small>{note}{m ? ` · ${m} мин` : ''}</small></span>
          {isDone(key) && <CircleCheck size={18} className="en-done" aria-label="Готово" />}</button> })}
    </nav>
    <div className="en-stack en-lesson__main">
      {visited.has('warmup') && <div hidden={hidden('warmup')}><WarmupBlock lesson={lesson} en={en} onNext={() => next('warmup')} /></div>}
      {visited.has('vocab') && <div hidden={hidden('vocab')}><VocabBlock lesson={lesson} en={en} onNext={() => next('vocab')} /></div>}
      {visited.has('listening') && <div hidden={hidden('listening')}><ListeningBlock lesson={lesson} en={en} active={active && blk === 'listening'} defaultRate={lesson.content.listening.tts_rate ?? 1} /></div>}
      {visited.has('speaking') && <div hidden={hidden('speaking')}><SpeakingBlock lesson={lesson} en={en} active={active && blk === 'speaking'} /></div>}
      {visited.has('writing') && <div hidden={hidden('writing')}><WritingBlock lesson={lesson} daily={daily} en={en} /></div>}
    </div>
  </div>
}
