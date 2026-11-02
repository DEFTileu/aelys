import { RotateCcw, SquareCheck } from '../../icons'
import { StateCard } from '../../components/StateCard'
import type { ApiStatus } from '../../types'
import '../connected.css'
import '../tools.css'
import { MODES, PRESETS, clock, duration, useTimer } from './useTimer'

export function TimerDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const { shown, locked, pickMode, writeBlocked, status, notice, linksNotice, tasks, taskId, setTaskId, active, paused, busy, primary, time, filled, preset, setPreset, mode, breakStart, pendingStart, setBreakStart, setNotice, stop, projectName, todayTotal, todays, secondsOf, recent, taskTitle, week, weekMax, todayIndex, breakRunning } = useTimer(apiStatus)
  return <div className="tl connected-workspace">
    <div className="tl-row"><div style={{ flex: 1 }}>{status === 'ready' && writeBlocked && <p className="tl-note" role="status">Cached focus history is available when previously loaded. Starting and stopping require a connection (OFFLINE_WRITE_UNAVAILABLE).</p>}</div>
      <div className="tl-seg" role="tablist" aria-label="Timer mode">{MODES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={shown === item.id} disabled={locked && shown !== item.id} onClick={() => pickMode(item.id)}>{item.label}</button>)}</div></div>
    {notice && <p className="tl-note" role="status">{notice}</p>}
    {status !== 'ready' ? <StateCard status={status} title={status === 'loading' ? 'Loading focus sessions' : 'Focus sessions unavailable'} description="Check your connection and owner session."/> : <div className="tl-split">
      <section className="tl-card tl-ring-card" aria-label="Timer">
        <div className="tl-ring" style={{ background: `conic-gradient(#f06a58 ${filled}%, #efe9e4 0)` }}><div>
          <span className="tl-ring__phase">{MODES.find((item) => item.id === shown)?.label}</span>
          <span className="tl-ring__time" aria-label="Elapsed focus time">{clock(time)}</span>
          <span className="tl-muted">{paused ? 'Paused' : active ? `Started ${new Date(active.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : breakRunning ? 'Break in progress' : 'Ready'}</span>
        </div></div>
        {PRESETS[shown].length > 0 && <div className="tl-chips" role="radiogroup" aria-label="Duration">{PRESETS[shown].map((minutes) => <button key={minutes} type="button" role="radio" aria-checked={preset === minutes} disabled={locked} onClick={() => setPreset(minutes)}>{minutes}</button>)}</div>}
        {shown !== 'break' && <label className="tl-task"><SquareCheck size={18} aria-hidden="true" />
          <select aria-label="Linked task" value={active?.task_id ?? taskId} disabled={locked} onChange={(event) => setTaskId(event.target.value)}>
            <option value="">No linked task</option>
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
          {projectName && <span className="tl-muted">{projectName}</span>}</label>}
        {linksNotice && <p className="tl-note" role="status">{linksNotice}</p>}
        <div className="tl-actions">
          <button type="button" className="tl-primary" disabled={mode === 'break' ? false : busy || writeBlocked} onClick={() => void primary.run()}><primary.Icon size={18} aria-hidden="true" />{primary.label}</button>
          <button type="button" className="tl-icon-btn" aria-label="Reset" disabled={busy || (!active && breakStart === null && !pendingStart.current)} onClick={() => { if (active) { void stop(); return } pendingStart.current = null; setBreakStart(null); setNotice('') }}><RotateCcw size={18} aria-hidden="true" /></button>
        </div>
      </section>
      <div className="tl-stack">
        <section className="tl-card" aria-label="Today">
          <div className="tl-total"><span>Today</span><span>{duration(todayTotal)}</span></div>
          {todays.length > 0 && <div className="tl-bars">{todays.map((session) => <span key={session.id} style={{ flex: Math.max(secondsOf(session), 60) }} />)}</div>}
          <div className="tl-muted" style={{ marginTop: 8 }}>{todays.length ? `${todays.length} ${todays.length === 1 ? 'session' : 'sessions'}` : 'No sessions yet today'}</div>
        </section>
        <section className="tl-card" aria-label="Sessions"><h2>Sessions</h2>
          {recent.length ? recent.map((session) => <div className="tl-sess" key={session.id}>
            <span className="tl-dot" style={{ background: session.status === 'active' ? '#f06a58' : session.status === 'paused' ? '#e0a21b' : session.status === 'completed' ? '#14966c' : '#8c869a' }} />
            <div className="tl-sess__body"><div className="tl-sess__title">{taskTitle(session)}</div><div className="tl-muted">{new Date(session.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {session.status}</div></div>
            <span className="tl-sess__dur">{duration(secondsOf(session))}</span></div>) : <p className="tl-note">No focus sessions yet. Start one to see it here.</p>}
        </section>
        <section className="tl-card" aria-label="This week">
          <div className="tl-total"><span>This week</span><span className="tl-muted" style={{ fontSize: 13, fontWeight: 400 }}>{duration(week.reduce((a, b) => a + b, 0))}</span></div>
          <div className="tl-week">{week.map((seconds, day) => <div key={day}><i style={{ height: `${Math.max((seconds / weekMax) * 100, 4)}%`, background: day === todayIndex ? '#f06a58' : '#f9c9bf' }} /><span>{'MTWTFSS'[day]}</span></div>)}</div>
        </section>
      </div>
    </div>}
  </div>
}
