import { RotateCcw } from '../../icons'
import { StateCard } from '../../components/StateCard'
import type { ApiStatus } from '../../types'
import { MODES, PRESETS, clock, duration, useTimer } from './useTimer'
import './timer-mobile.css'

// One column: the timer card with its start and stop controls sits above the session history.
export function TimerMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const { shown, locked, pickMode, writeBlocked, status, notice, linksNotice, tasks, taskId, setTaskId, active, paused, busy, primary, time, preset, setPreset, mode, breakStart, pendingStart, setBreakStart, setNotice, stop, projectName, todayTotal, todays, secondsOf, recent, taskTitle, breakRunning } = useTimer(apiStatus)
  return <div className="timer-m">
    <h1 className="timer-m-title">Focus</h1>
    {status === 'ready' && writeBlocked && <p className="timer-m-note" role="status">Cached focus history is available. Starting and stopping need a connection.</p>}
    {notice && <p className="timer-m-note" role="status">{notice}</p>}
    {status !== 'ready' ? <StateCard status={status} title={status === 'loading' ? 'Loading focus sessions' : 'Focus sessions unavailable'} description="Check your connection and owner session." /> : <>
      <section className="timer-m-card" aria-label="Timer">
        <div className="timer-m-modes" role="tablist" aria-label="Timer mode">{MODES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={shown === item.id} disabled={locked && shown !== item.id} onClick={() => pickMode(item.id)}>{item.label}</button>)}</div>
        <div className="timer-m-time" aria-label="Elapsed focus time">{clock(time)}</div>
        <p className="timer-m-status">{paused ? 'Paused' : active ? `Started ${new Date(active.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : breakRunning ? 'Break in progress' : 'Ready'}</p>
        {PRESETS[shown].length > 0 && <div className="timer-m-chips" role="radiogroup" aria-label="Duration">{PRESETS[shown].map((minutes) => <button key={minutes} type="button" role="radio" aria-checked={preset === minutes} disabled={locked} onClick={() => setPreset(minutes)}>{minutes}</button>)}</div>}
        {shown !== 'break' && <label className="timer-m-task"><span>Linked task</span>
          <select aria-label="Linked task" value={active?.task_id ?? taskId} disabled={locked} onChange={(event) => setTaskId(event.target.value)}>
            <option value="">No linked task</option>
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
          {projectName && <small>{projectName}</small>}</label>}
        {linksNotice && <p className="timer-m-note" role="status">{linksNotice}</p>}
        <div className="timer-m-actions">
          <button type="button" className="timer-m-primary" disabled={mode === 'break' ? false : busy || writeBlocked} onClick={() => void primary.run()}><primary.Icon size={18} aria-hidden="true" />{primary.label}</button>
          <button type="button" className="timer-m-reset" aria-label="Reset" disabled={busy || (!active && breakStart === null && !pendingStart.current)} onClick={() => { if (active) { void stop(); return } pendingStart.current = null; setBreakStart(null); setNotice('') }}><RotateCcw size={18} aria-hidden="true" /></button>
        </div>
      </section>
      <section className="timer-m-history" aria-label="Sessions">
        <div className="timer-m-history-head"><h2>Today</h2><span>{duration(todayTotal)}</span></div>
        <p className="timer-m-note">{todays.length ? `${todays.length} ${todays.length === 1 ? 'session' : 'sessions'} today` : 'No sessions yet today'}</p>
        {recent.length ? recent.map((session) => <div className="timer-m-session" key={session.id}>
          <span className="timer-m-dot" style={{ background: session.status === 'active' ? '#f06a58' : session.status === 'paused' ? '#e0a21b' : session.status === 'completed' ? '#14966c' : '#8c869a' }} />
          <div><strong>{taskTitle(session)}</strong><small>{new Date(session.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {session.status}</small></div>
          <span className="timer-m-dur">{duration(secondsOf(session))}</span></div>) : <p className="timer-m-note">No focus sessions yet. Start one to see it here.</p>}
      </section>
    </>}
  </div>
}
