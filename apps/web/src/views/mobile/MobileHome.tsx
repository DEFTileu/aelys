import { Bell, Check, ChevronRight, CloudRain, CloudSun, LayoutGrid, MapPin, Pause, Play, Search, Square } from 'lucide-react'
import { CALENDAR_TODAY, EVENT_TINT, FOCUS_SESSION_SECONDS, TODAY_TASKS, accentOf } from '../../data/desktop/home'
import { FIN_BARS, FIN_SPEND, MOBILE_CATALOG, MOBILE_FORECAST, MOBILE_GOALS, MOBILE_MAIL, MOBILE_NOTES, MOBILE_PROJECTS, ROWS, type MobileWidget, type MobileWidgetId, type WidgetSize } from '../../data/mobile'
import { toggleTask, useDesktopState } from '../../lib/desktopStore'
import { useFocusTimer, type FocusTimer } from '../desktop/homeWidgets'

const pad = (value: number) => String(value).padStart(2, '0')

function rowsFor<T>(id: MobileWidgetId, size: WidgetSize, data: T[]): T[] {
  return data.slice(0, ROWS[id]?.[size] ?? 2)
}

function WidgetBody({ id, size, wide, done, focus }: { id: MobileWidgetId; size: WidgetSize; wide: boolean; done: boolean[]; focus: FocusTimer }) {
  switch (id) {
    case 'today':
      return <>{rowsFor(id, size, TODAY_TASKS).map((task, i) => {
        const on = done[i]
        return <button key={task.title} type="button" role="checkbox" aria-checked={on} className="m-btn" onClick={() => toggleTask(i)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, height: 40 }}>
          <span className="m-tile" style={{ width: 22, height: 22, borderRadius: '50%', border: on ? 'none' : '2px solid #BDB7C2', background: on ? '#6A4CF2' : 'transparent', color: '#fff' }}>{on && <Check size={13} aria-hidden="true" />}</span>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: on ? '#625D69' : '#1C1B22', textDecoration: on ? 'line-through' : 'none' }}>{task.title}</span>
          <span className="m-meta">{task.time}</span>
        </button>
      })}</>
    case 'cal':
      return <>
        <div className="m-sub" style={{ margin: '-6px 0 8px' }}>Today, {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{rowsFor(id, size, CALENDAR_TODAY).map((event) => <div key={event.title} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="m-meta" style={{ width: 44, flex: 'none' }}>{event.time}</span>
          <div style={{ flex: 1, minWidth: 0, padding: '6px 12px', borderRadius: 12, background: EVENT_TINT[event.tint][0], borderLeft: `3px solid ${EVENT_TINT[event.tint][1]}` }}>
            <div style={{ fontSize: 14, lineHeight: '20px', fontWeight: 500 }}>{event.title}</div>
            <div style={{ fontSize: 12, lineHeight: '16px', color: '#4F4A56' }}>{event.time} – {event.end}</div>
          </div>
        </div>)}</div>
      </>
    case 'focus': {
      const pct = Math.round((1 - focus.left / FOCUS_SESSION_SECONDS) * 100)
      return <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexDirection: wide ? 'row' : 'column' }}>
        <div style={{ width: 108, height: 108, flex: 'none', borderRadius: '50%', background: `conic-gradient(#F9C29A,#F06A58 ${pct}%,#ECE5DF ${pct}%)`, padding: 7 }}>
          <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: '#FDFBFA', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <b style={{ fontSize: 20, lineHeight: '28px', fontWeight: 700 }}>{pad(Math.floor(focus.left / 60))}:{pad(focus.left % 60)}</b>
            <span className="m-sub">Deep work</span>
          </div>
        </div>
        {wide && <div style={{ flex: 1 }}><div style={{ fontWeight: 500 }}>Aelys · AI Chat block</div><div className="m-sub">Session 2 of 4 · ends 19:00</div></div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="m-btn m-tile" aria-label={focus.running ? 'Pause' : 'Start'} onClick={focus.toggle} style={{ width: 36, height: 36, borderRadius: '50%', background: '#FDE3DC', color: '#D63F2C' }}>{focus.running ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}</button>
          <button type="button" className="m-btn m-tile" aria-label="Stop" onClick={focus.reset} style={{ width: 36, height: 36, borderRadius: '50%', background: '#fff', border: '1px solid #E7E2DE' }}><Square size={14} aria-hidden="true" /></button>
        </div>
      </div>
    }
    case 'weather':
      return <div style={{ textShadow: '0 1px 8px rgba(0,0,0,.35)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><CloudRain size={36} aria-hidden="true" /><div><div style={{ fontSize: 26, lineHeight: '32px', fontWeight: 700 }}>+14°</div><div style={{ fontSize: 12, lineHeight: '16px' }}>Rain tonight</div></div></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 12, fontSize: 12, lineHeight: '16px' }}><MapPin size={14} aria-hidden="true" /><span style={{ flex: 1 }}>Almaty</span><span>↑16° ↓8°</span></div>
        {wide && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4, marginTop: 12, textAlign: 'center', fontSize: 12, lineHeight: '16px' }}>
          {MOBILE_FORECAST.map(({ hour, icon: Icon, temp }) => <div key={hour} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}><span>{hour}</span><Icon size={18} aria-hidden="true" /><b style={{ fontWeight: 600 }}>{temp}</b></div>)}
        </div>}
      </div>
    case 'mail':
      return <>{rowsFor(id, size, MOBILE_MAIL).map((mail) => <div key={mail.from} style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 48 }}>
        <span className="m-tile" style={{ width: 36, height: 36, borderRadius: 10, background: mail.bg, color: '#fff', fontWeight: 700 }}>{mail.letter}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, lineHeight: '20px', fontWeight: 600 }}><span style={{ flex: 1 }}>{mail.from}</span><span className="m-meta">{mail.when}</span></div>
          <div className="m-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{mail.subject}</div>
        </div>
        <span style={{ width: 8, height: 8, flex: 'none', borderRadius: '50%', background: '#2F6FE4' }} />
      </div>)}</>
    case 'proj':
      return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{rowsFor(id, size, MOBILE_PROJECTS).map(({ title, sub, pct, color, icon: Icon }) => {
        const { c, soft } = accentOf(color)
        return <div key={title} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="m-tile" style={{ width: 36, height: 36, borderRadius: 12, background: soft, color: c }}><Icon size={18} aria-hidden="true" /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', lineHeight: '20px', fontWeight: 500 }}><span style={{ flex: 1 }}>{title}</span><span className="m-meta">{pct}%</span></div>
            <div className="m-sub">{sub}</div>
            <div style={{ height: 4, borderRadius: 2, background: '#ECE7E3', marginTop: 4 }}><div style={{ height: '100%', borderRadius: 2, width: `${pct}%`, background: c }} /></div>
          </div>
        </div>
      })}</div>
    case 'notes':
      return <>{rowsFor(id, size, MOBILE_NOTES).map((note) => <div key={note.title} style={{ padding: '4px 0 8px' }}>
        <div style={{ display: 'flex', gap: 8, lineHeight: '20px', fontWeight: 600 }}><span style={{ flex: 1, minWidth: 0 }}>{note.title}</span><span className="m-meta" style={{ fontWeight: 400 }}>{note.when}</span></div>
        <div className="m-sub" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{note.text}</div>
      </div>)}</>
    case 'fin':
      return <>
        <div style={{ fontSize: 20, lineHeight: '28px', fontWeight: 700 }}>48 250 ₸</div>
        <div style={{ fontSize: 12, lineHeight: '16px', color: '#0E7A57', fontWeight: 600 }}>+12% this month</div>
        {wide
          ? <div style={{ marginTop: 8 }}>{FIN_SPEND.map((row) => <div key={row.title} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 36, borderTop: '1px solid #EFEAE6' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: row.color }} /><span style={{ flex: 1 }}>{row.title}</span><span style={{ fontWeight: 500 }}>{row.value}</span></div>)}</div>
          : <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 32, marginTop: 12 }}>{FIN_BARS.map((h, i) => <span key={i} style={{ flex: 1, borderRadius: 3, background: '#2BC48F', height: h }} />)}</div>}
      </>
    case 'goals':
      return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{rowsFor(id, size, MOBILE_GOALS).map((goal) => <div key={goal.title}>
        <div style={{ display: 'flex', lineHeight: '20px' }}><span style={{ flex: 1, minWidth: 0 }}>{goal.title}</span><span className="m-meta">{goal.pct}%</span></div>
        <div style={{ height: 6, borderRadius: 3, background: '#ECE7E3', marginTop: 6 }}><div style={{ height: '100%', borderRadius: 3, width: `${goal.pct}%`, background: '#6A4CF2' }} /></div>
      </div>)}</div>
  }
}

export function MobileHome({ widgets, wallpaper, onCustomize, onSearch }: { widgets: MobileWidget[]; wallpaper: string; onCustomize: () => void; onSearch: () => void }) {
  const { done } = useDesktopState()
  const focus = useFocusTimer()
  const remaining = TODAY_TASKS.filter((_, i) => !done[i]).length
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return <>
    <div className="m-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="m-logo" aria-hidden="true">Λ</div>
        <span style={{ fontSize: 18, lineHeight: '26px', fontWeight: 700, flex: 1, marginLeft: 4, textShadow: '0 1px 10px rgba(20,20,45,.4)' }}>Aelys</span>
        <button type="button" className="m-btn m-round" aria-label="Search" onClick={onSearch}><Search size={18} aria-hidden="true" /></button>
        <button type="button" className="m-btn m-round" aria-label="Notifications" style={{ position: 'relative' }}><Bell size={18} aria-hidden="true" /><span style={{ position: 'absolute', top: 13, right: 14, width: 8, height: 8, borderRadius: '50%', background: '#E5484D', border: '1.5px solid #fff' }} /></button>
        <span className="m-avatar" aria-label="Profile" role="img" />
      </div>
      <div className="m-shadow">
        <div style={{ marginTop: 24 }}>{date}</div>
        <h1 style={{ margin: '4px 0 0', fontSize: 26, lineHeight: '32px', fontWeight: 700, letterSpacing: '-.02em' }}>Good morning,<br />Tileuzhan</h1>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 6 }}>
          <div style={{ flex: 1 }}>A calm day creates bigger results.</div>
          <div title="Rain tonight" style={{ flex: 'none', height: 32, padding: '0 12px', borderRadius: 18, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, background: 'rgba(255,255,255,.22)', backdropFilter: 'blur(16px) saturate(1.6)', WebkitBackdropFilter: 'blur(16px) saturate(1.6)', border: '1px solid rgba(255,255,255,.45)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.5),0 4px 14px rgba(20,20,45,.18)' }}><CloudSun size={18} color="#FFD27A" aria-hidden="true" />+14°</div>
        </div>
      </div>
    </div>

    <section aria-label="Widgets" style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12, padding: '24px 16px 0' }}>
      {widgets.map(([id, size]) => {
        const wide = size !== 'S'
        const dark = id === 'weather'
        const badge = id === 'mail' ? '12' : id === 'today' ? String(remaining) : ''
        return <div key={id} className="m-card" style={{ gridColumn: `span ${wide ? 2 : 1}`, background: dark ? `linear-gradient(180deg,rgba(30,34,60,.30),rgba(20,22,40,.72)),url('${wallpaper}') 85% 40%/auto 340px` : undefined, color: dark ? '#fff' : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, marginBottom: 8 }}>
            <span className="m-card-title" style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{MOBILE_CATALOG[id].title}</span>
            {badge && <span style={{ height: 22, padding: '0 8px', borderRadius: 11, background: id === 'mail' ? '#FDE3E1' : '#F1EDEA', color: id === 'mail' ? '#C9302C' : '#3A3640', fontSize: 13, lineHeight: '22px', fontWeight: 600 }}>{badge}</span>}
            <ChevronRight size={20} aria-hidden="true" style={{ opacity: .8 }} />
          </div>
          <WidgetBody id={id} size={size} wide={wide} done={done} focus={focus} />
        </div>
      })}
      <button type="button" className="m-btn" onClick={onCustomize} style={{ gridColumn: 'span 2', height: 40, borderRadius: 20, border: '1.5px dashed #CFC9D4', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontWeight: 500, color: '#4F4A56' }}><LayoutGrid size={18} aria-hidden="true" />Customize home</button>
    </section>
  </>
}
