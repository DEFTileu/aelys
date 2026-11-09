import { useState } from 'react'
import type { EnglishCourse, EnglishGoal, EnglishLevel, EnglishProfile, EnglishSkill } from '@aelys/shared'
import { Switch } from '../../components/Switch'
import type { useEnglish } from './useEnglish'
import type { CourseHook } from './useEnglishCourse'

type Draft = Omit<EnglishProfile, 'course_started_on'>
const GOALS: [EnglishGoal, string][] = [['ielts_academic', 'IELTS Academic'], ['ielts_general', 'IELTS General'], ['conversation', 'Разговорный']]
const BANDS = ['6.0', '6.5', '7.0', '7.5']
const LEVELS: [EnglishLevel, string][] = [['b1', 'B1'], ['b1b2', 'B1–B2'], ['b2', 'B2'], ['test', 'Не знаю — пройти тест']]
const WEAK: [EnglishSkill, string][] = [['speaking', 'Говорить'], ['listening', 'Понимать на слух'], ['writing', 'Писать'], ['reading', 'Читать']]
const MINUTES: [60 | 120 | 180, string][] = [[60, '1 ч · минимум'], [120, '2 ч · рекомендуем'], [180, '3 ч · максимум']]

function Chips<T extends string | number>({ legend, options, value, multi, onChange }: { legend: string; options: readonly (readonly [T, string])[]; value: readonly T[]; multi?: boolean; onChange: (next: T[]) => void }) {
  return <fieldset className="en-fieldset"><legend>{legend}</legend>
    <div className="en-chips">{options.map(([key, label]) => { const on = value.includes(key)
      return <button key={String(key)} type="button" aria-pressed={on} onClick={() => onChange(multi ? (on ? value.filter((item) => item !== key) : [...value, key]) : [key])}>{label}</button> })}</div></fieldset>
}

export function ProfileTab({ course, en, daily }: { course: EnglishCourse; en: CourseHook; daily: ReturnType<typeof useEnglish> }) {
  const { course_started_on: _started, ...initial } = course.profile
  const [draft, setDraft] = useState<Draft>(initial)
  const [saved, setSaved] = useState(false)
  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setSaved(false) }
  const save = () => void en.saveProfile(draft).then((ok) => setSaved(ok))
  return <div className="en-stack">
    <section className="en-card en-setup" aria-label="Настройка курса">
      <div><h2 className="en-h">Мой курс</h2><p className="en-muted">Курс пересобирается под эти ответы и под результаты каждого урока. Уже созданные уроки не меняются.</p></div>
      <Chips legend="Цель" options={GOALS} value={[draft.goal]} onChange={([goal]) => set({ goal: goal! })} />
      <Chips legend="Нужный балл" options={BANDS.map((band) => [band, band] as const)} value={[draft.target_band]} onChange={([target_band]) => set({ target_band: target_band! })} />
      <Chips legend="Уровень сейчас" options={LEVELS} value={[draft.level]} onChange={([level]) => set({ level: level! })} />
      <Chips legend="Что даётся труднее всего" options={WEAK} value={draft.weak_skills} multi onChange={(weak_skills) => set({ weak_skills })} />
      <Chips legend="Время в день" options={MINUTES} value={[draft.minutes_per_day]} onChange={([minutes_per_day]) => set({ minutes_per_day: minutes_per_day! })} />
      <label className="en-label en-date">Дата экзамена (необязательно)
        <input type="date" value={draft.exam_date ?? ''} onChange={(event) => set({ exam_date: event.target.value || null })} /></label>
      <div className="en-row">
        <span className="en-actions"><button type="button" className="en-btn en-btn--primary" disabled={en.busy || en.writeBlocked || !draft.weak_skills.length} onClick={save}>{en.busy ? 'Сохраняем…' : 'Сохранить и пересобрать план'}</button>
          {saved && <span className="en-muted" role="status">Сохранено</span>}</span>
        {course.lesson_no <= 1 && !course.today.id && <span className="en-muted">Первый урок начнётся с 15-минутной диагностики</span>}
      </div>
    </section>
    <section className="en-card en-reminder" aria-label="Напоминание">
      <span>Напоминание</span>
      <Switch label="Вечернее напоминание об отчёте" checked={daily.settings.reminder_enabled} pending={daily.savingSettings} disabled={daily.writeBlocked}
        onCheckedChange={(reminder_enabled) => void daily.saveSettings({ reminder_enabled })} />
      <input type="time" value={daily.settings.reminder_time} aria-label="Время напоминания" disabled={daily.writeBlocked || !daily.settings.reminder_enabled}
        onChange={(event) => event.target.value && void daily.saveSettings({ reminder_time: event.target.value }, true)} />
    </section>
  </div>
}
