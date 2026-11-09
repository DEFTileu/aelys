import { useState } from 'react'
import type { EnglishCourse, EnglishSkill } from '@aelys/shared'
import { ArrowRight, ArrowUpRight, BookA, ClipboardList, Gauge, Headphones, Lightbulb, Mic, PenLine, Route, TrendingUp, TriangleAlert, type AelysIconComponent } from '../../icons'
import { getSharedApiClient } from '../../lib/api'
import type { CourseHook } from './useEnglishCourse'

export const SKILL_LABEL: Record<EnglishSkill, string> = { listening: 'Listening', reading: 'Reading', writing: 'Writing', speaking: 'Speaking' }
const ADAPT_ICON: Record<string, AelysIconComponent> = { headphones: Headphones, mic: Mic, 'pen-line': PenLine, 'book-a': BookA, 'trending-up': TrendingUp, 'triangle-alert': TriangleAlert, gauge: Gauge, lightbulb: Lightbulb, route: Route }
const ADAPT_TONE: Record<string, string> = { listening: 'purple', speaking: 'coral', writing: 'green', reading: 'blue' }
const BANDS = ['3.0', '3.5', '4.0', '4.5', '5.0', '5.5', '6.0', '6.5', '7.0', '7.5', '8.0', '8.5', '9.0']
const trendMark = (trend: string | null) => trend === null ? '' : trend.startsWith('+') ? `↑${trend.slice(1)}` : trend.startsWith('-') ? `↓${trend.slice(1)}` : '→'

// AI-derived bands come as "≈6.0"; mock and listening bands are plain.
const bandValue = (band: string) => Number(band.replace('≈', ''))
const average = (course: EnglishCourse) => {
  const bands = course.skills.flatMap((item) => item.band === null ? [] : [bandValue(item.band)]).filter(Number.isFinite)
  return bands.length ? (Math.round(bands.reduce((a, b) => a + b, 0) / bands.length * 2) / 2).toFixed(1) : null
}
const dateRu = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
const hoursText = (value: number) => String(Math.round(value * 10) / 10).replace('.', ',')

function MockCard({ en, saved, onSaved }: { en: CourseHook; saved: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [bands, setBands] = useState<Record<EnglishSkill, string>>({ listening: '', reading: '', writing: '', speaking: '' })
  const filled = Object.values(bands).some(Boolean)
  const save = () => void en.run(async () => {
    const body = Object.fromEntries(Object.entries(bands).filter(([, value]) => value))
    await getSharedApiClient().englishCreateMock({ day: en.day, ...body })
    onSaved(); setOpen(false); await en.refresh()
  })
  return <section className="en-card" aria-label="Пробный тест">
    <div className="en-head"><span className="en-ico" data-tone="amber"><ClipboardList size={18} /></span>
      <div><strong>Воскресенье: пробный тест</strong><p className="en-muted">Официальный бесплатный тест, с 3-й недели — каждую неделю</p></div></div>
    <p className="en-small">Listening и Reading проходишь на сайте British Council с живыми акцентами, сюда вносишь результат. Speaking и Writing — здесь, по таймеру. Затем разбор: столько же времени, сколько шёл тест.</p>
    {saved && <p className="en-muted" role="status">Результат сохранён.</p>}
    <div className="en-actions">
      <a className="en-link-btn" href="https://takeielts.britishcouncil.org/prepare/ielts-ready" target="_blank" rel="noreferrer noopener">IELTS Ready <ArrowUpRight size={14} /></a>
      <button type="button" className="en-btn en-btn--dark" aria-expanded={open} onClick={() => setOpen(!open)}>Внести результат</button>
    </div>
    {open && <form className="en-mock" onSubmit={(event) => { event.preventDefault(); save() }}>
      {(Object.keys(bands) as EnglishSkill[]).map((skill) => <label key={skill}><span>{SKILL_LABEL[skill]}</span>
        <select value={bands[skill]} onChange={(event) => setBands({ ...bands, [skill]: event.target.value })}><option value="">—</option>{BANDS.map((band) => <option key={band} value={band}>{band}</option>)}</select></label>)}
      <button type="submit" className="en-btn en-btn--primary" disabled={en.busy || en.writeBlocked || !filled}>Сохранить результат</button>
    </form>}
  </section>
}

export function CourseTab({ course, en, onStart }: { course: EnglishCourse; en: CourseHook; onStart: () => void }) {
  const { profile, week_stats: stats } = course
  const [mockSaved, setMockSaved] = useState(false)
  const target = Number(profile.target_band)
  const now = average(course)
  const blocks = course.today.blocks
  const total = blocks.reduce((sum, block) => sum + block.minutes, 0)
  const weakMinutes = blocks.filter((block) => (profile.weak_skills as readonly string[]).includes(block.key)).reduce((sum, block) => sum + block.minutes, 0)
  const weakNames = profile.weak_skills.map((skill) => SKILL_LABEL[skill]).join(' и ')
  const perDay = profile.minutes_per_day / 60
  const projected = course.days_to_exam === null ? null : course.hours_done + course.days_to_exam * perDay
  const tiles: [string, string, string?][] = [[String(stats.speaking_rounds), 'раундов Speaking'], [String(stats.new_words), 'новых слов'], [stats.listening_pct === null ? '—' : `${stats.listening_pct}%`, 'верно в Listening', stats.listening_pct !== null && stats.listening_pct < 70 ? 'warn' : undefined], [String(stats.streak), 'дней подряд', stats.streak > 0 ? 'ok' : undefined]]
  return <div className="en-stack">
    <section className="en-hero" aria-label="Твой курс">
      <div className="en-stack en-stack--tight">
        <span className="en-eyebrow">Твой курс · неделя {course.week} из 10</span>
        <h2 className="en-hero__title">{now ? `Сейчас ≈ ${now}. ` : 'Пока без оценки. '}Цель — {profile.target_band}{profile.exam_date ? ` к ${dateRu(profile.exam_date)}` : ''}.</h2>
        {weakNames && <p className="en-hero__text">Главный упор — {weakNames}.{total > 0 && weakMinutes > 0 ? ` На них в уроке отведено ${weakMinutes} минут из ${total}.` : ''}</p>}
        <p className="en-hero__note"><Gauge size={16} /><span><strong>{hoursText(course.hours_done)} ч из ~{course.hours_target}</strong> — обычно столько нужно на +1 балл. Сейчас {hoursText(perDay)} ч в день{projected !== null && projected < course.hours_target ? `, к экзамену наберётся ~${Math.round(projected)} ч — цель под риском` : projected !== null ? `, к экзамену наберётся ~${Math.round(projected)} ч` : ''}.</span></p>
        <button type="button" className="en-btn en-btn--primary en-hero__cta" onClick={onStart}>{course.today.id ? 'Продолжить урок' : 'Начать урок'} {course.lesson_no} <ArrowRight size={16} /></button>
      </div>
      <div className="en-skills" role="img" aria-label={`Оценка по навыкам: ${course.skills.map((item) => `${SKILL_LABEL[item.skill]} ${item.band ?? 'нет оценки'}`).join(', ')}, цель ${profile.target_band}`}>
        {course.skills.map((item) => { const band = item.band === null ? null : bandValue(item.band)
          return <div key={item.skill}><div className="en-skills__row"><span>{SKILL_LABEL[item.skill]}</span>
            <span>{item.band ?? '—'} <span className={item.trend?.startsWith('-') ? 'is-down' : 'is-up'}>{trendMark(item.trend)}</span> · цель {profile.target_band}</span></div>
            <div className="en-skills__bar"><div data-gap={band === null ? 'none' : band >= target ? 'met' : band >= target - 0.5 ? 'near' : 'far'} style={{ width: `${band === null ? 0 : Math.round(band / 9 * 100)}%` }} /><span style={{ left: `${Math.round(target / 9 * 100)}%` }} /></div></div> })}
      </div>
    </section>

    <div className="en-cols">
      <section className="en-card" aria-label="План курса">
        <div className="en-row"><h2 className="en-h">План на 10 недель</h2><span className="en-muted">темы IELTS · грамматика из твоих ошибок</span></div>
        <ol className="en-plan">{course.plan.map((item) => <li key={item.week} data-status={item.status} aria-current={item.status === 'now' ? 'step' : undefined}>
          <span className="en-plan__dot">{item.status === 'done' ? '✓' : item.week}</span>
          <span className="en-plan__text"><strong>{item.theme}</strong><small>{item.grammar}</small></span>
          <span className="en-plan__state">{item.status === 'done' ? 'пройдено' : item.status === 'now' ? `урок ${course.lesson_no}` : ''}</span></li>)}</ol>
      </section>
      <div className="en-stack">
        <section className="en-card en-card--accent" aria-label="Как курс подстроился">
          <div className="en-head"><span className="en-ico" data-tone="purple"><Route size={18} /></span><strong>Курс подстроился</strong></div>
          {course.adaptations.length ? course.adaptations.map((item, i) => { const Icon = ADAPT_ICON[item.icon] ?? Lightbulb
            return <p key={i} className="en-adapt"><Icon size={16} data-tone={ADAPT_TONE[item.skill] ?? 'amber'} /><span><strong>{item.title}</strong> {item.detail}</span></p> })
            : <p className="en-muted">После первых уроков курс покажет, где подстроился под твои результаты.</p>}
        </section>
        {(course.mock_due || mockSaved) && <MockCard en={en} saved={mockSaved} onSaved={() => setMockSaved(true)} />}
        <section className="en-card" aria-label="Неделя в цифрах">
          <strong>Неделя {course.week} в цифрах</strong>
          <div className="en-tiles">{tiles.map(([value, label, tone]) => <div key={label} data-tone={tone}><strong>{value}</strong><span>{label}</span></div>)}</div>
        </section>
      </div>
    </div>
  </div>
}
