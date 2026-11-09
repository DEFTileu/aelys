import { useState } from 'react'
import { StateCard } from '../components/StateCard'
import { CalendarClock, Route, Settings, Play, type AelysIconComponent } from '../icons'
import { navigate } from '../lib/router'
import type { ApiStatus, RoutePath } from '../types'
import { CourseTab } from './english/CourseTab'
import { LessonTab } from './english/LessonTab'
import { ProfileTab } from './english/ProfileTab'
import { useEnglish } from './english/useEnglish'
import { useEnglishCourse } from './english/useEnglishCourse'
import './english/english.css'

type Tab = 'course' | 'lesson' | 'profile'
const TABS: [Tab, string, AelysIconComponent][] = [['course', 'Курс', Route], ['lesson', 'Урок дня', Play], ['profile', 'Мой курс', Settings]]
const GOAL_RU = { ielts_academic: 'IELTS Academic', ielts_general: 'IELTS General', conversation: 'Разговорный' } as const

export function EnglishView({ apiStatus }: { apiStatus: ApiStatus }) {
  const en = useEnglishCourse(apiStatus)
  const daily = useEnglish(apiStatus)
  const [tab, setTab] = useState<Tab>('course')
  const [lessonSeen, setLessonSeen] = useState(false) // keep typed answers and recordings when switching tabs
  const open = (next: Tab) => { setTab(next); if (next === 'lesson') setLessonSeen(true) }
  const { course, notice, status, writeBlocked } = en
  const shownNotice = notice ?? daily.notice
  if (status !== 'ready' || !course) return <div className="en">
    <StateCard status={status} title={status === 'loading' ? 'Загружаем курс' : 'English недоступен'} description={notice?.text ?? 'Проверьте соединение и вход в аккаунт.'} />
  </div>
  const { profile } = course
  return <div className="en">
    <div className="en-top">
      <nav className="en-tabs" aria-label="Раздел">{TABS.map(([id, label, Icon]) =>
        <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => open(id)}><Icon size={16} />{label}</button>)}</nav>
      <p className="en-muted en-top__info"><CalendarClock size={16} />{GOAL_RU[profile.goal]}{course.days_to_exam !== null && <> · экзамен через <strong>{course.days_to_exam} дн.</strong></>} · {profile.minutes_per_day / 60} ч в день</p>
    </div>
    {shownNotice && <div className="en-notice" role="alert">
      <p>{shownNotice.text}</p>
      {shownNotice.code === 'AI_UNAVAILABLE' && <button type="button" onClick={() => navigate('/settings?section=ai' as RoutePath)}>Настройки AI</button>}
    </div>}
    {writeBlocked && <p className="en-muted" role="status">Нет соединения: курс доступен только для чтения.</p>}
    {tab === 'course' && <CourseTab course={course} en={en} onStart={() => open('lesson')} />}
    {lessonSeen && <div hidden={tab !== 'lesson'}><LessonTab course={course} lesson={en.lesson} en={en} daily={daily} active={tab === 'lesson'} /></div>}
    {tab === 'profile' && <ProfileTab course={course} en={en} daily={daily} />}
  </div>
}
