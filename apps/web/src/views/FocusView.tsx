import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusApp, FocusOverview, FocusRequestRow, FocusUnlockResult } from '@aelys/shared'
import { ApiError, OfflineWriteUnavailableError } from '@aelys/shared'
import { Shield, TriangleAlert } from '../icons'
import { StateCard } from '../components/StateCard'
import { getSharedApiClient } from '../lib/api'
import { focusGuard, localDay, syncGuard, type AppUsage, type GuardStatus, type InstalledApp } from '../lib/focusGuard'
import { isAndroidHost } from '../lib/notificationLog'
import type { ApiStatus } from '../types'
import './desktop/page-tokens.css'
import './notification-log.css'
import './focus.css'

const DEFAULTS: readonly FocusApp[] = [
  { id: 'instagram', label: 'Instagram', packages: ['com.instagram.android'], limit_minutes: 60 },
  { id: 'tiktok', label: 'TikTok', packages: ['com.zhiliaoapp.musically', 'com.ss.android.ugc.trill'], limit_minutes: 60 },
  { id: 'pinduoduo', label: 'Pinduoduo', packages: ['com.xunmeng.pinduoduo'], limit_minutes: 60 },
]
const RULE = 'Lowering a limit applies now. Raising it or removing an app applies tomorrow.'
const validLimit = (minutes: number) => Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
const sameApps = (a: readonly FocusApp[], b: readonly FocusApp[]) => JSON.stringify(a) === JSON.stringify(b)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const stamp = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function slug(label: string, taken: ReadonlySet<string>) {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'app'
  let id = base
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`
  return id
}

function saveError(error: unknown) {
  if (error instanceof OfflineWriteUnavailableError) return 'You are offline. Limits can be changed when you are back online.'
  if (error instanceof ApiError && error.code === 'FOCUS_LIMIT') return error.message
  if (error instanceof ApiError && error.code === 'BAD_DAY') return 'The date on this phone does not match the server. Fix the date and time settings, then reload.'
  return 'Could not save the limits. Try again.'
}

export function FocusView({ apiStatus }: { apiStatus: ApiStatus }) {
  if (!isAndroidHost()) return <div className="nlog"><div className="nlog__empty"><Shield size={28} /><div className="nlog__empty-title">Available in the Android app</div><div>App limits watch your apps on the phone, so they only work in the Android app.</div></div></div>
  return <FocusScreen apiStatus={apiStatus} />
}

function FocusScreen({ apiStatus }: { apiStatus: ApiStatus }) {
  const [overview, setOverview] = useState<FocusOverview | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [status, setStatus] = useState<GuardStatus | null>(null)
  const [usage, setUsage] = useState<Record<string, AppUsage> | null>(null)
  const [requests, setRequests] = useState<readonly FocusRequestRow[] | null>(null)
  const [draft, setDraft] = useState<FocusApp[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [online, setOnline] = useState(() => navigator.onLine)
  const [installed, setInstalled] = useState<InstalledApp[] | null>(null)
  const [pick, setPick] = useState('')
  const [unlockApp, setUnlockApp] = useState<string | null>(null)

  const running = useRef(false)
  const queued = useRef(false)
  const run = useCallback(async () => {
    const day = localDay()
    let loaded: FocusOverview
    try { loaded = await getSharedApiClient().focusOverview(day) }
    catch { setLoadState('error'); const waiting = await focusGuard.takePendingUnlock().catch(() => null); if (waiting) setUnlockApp(waiting); return }
    setOverview(loaded); setLoadState('ready')
    // Only a loaded overview ever reaches the phone; a failed load leaves its state untouched.
    try { await syncGuard(loaded, day); setNotice('') } catch { setNotice('Could not update protection on this phone. Reopen the screen to retry.') }
    const [s, u, r] = await Promise.all([focusGuard.status().catch(() => null), focusGuard.usage().catch(() => null), getSharedApiClient().focusRequests(20).catch(() => null)])
    setStatus(s); setUsage(u); setRequests(r && [...r].sort((a, b) => b.created_at.localeCompare(a.created_at)))
    const pending = await focusGuard.takePendingUnlock().catch(() => null)
    if (pending) setUnlockApp(pending)
  }, [])
  // A load asked for while one runs is coalesced into one more run, so the last request always wins.
  const load = useCallback(async () => {
    if (running.current) { queued.current = true; return }
    running.current = true
    try { do { queued.current = false; await run() } while (queued.current) } finally { running.current = false }
  }, [run])

  useEffect(() => {
    void load()
    const again = () => { if (document.visibilityState !== 'hidden') void load() }
    const setOn = () => setOnline(true); const setOff = () => setOnline(false)
    document.addEventListener('visibilitychange', again); window.addEventListener('focus', again)
    window.addEventListener('online', setOn); window.addEventListener('offline', setOff)
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again); window.removeEventListener('online', setOn); window.removeEventListener('offline', setOff) }
  }, [load])

  const effective = overview?.config.effective.apps ?? []
  const pending = overview?.config.pending ?? null
  const canWrite = apiStatus === 'ready' && online
  const apps = draft ?? effective
  const dirty = draft !== null && !sameApps(draft, effective)
  const valid = apps.every((a) => validLimit(a.limit_minutes))
  const labelOf = (id: string) => effective.find((a) => a.id === id)?.label ?? id

  const save = async (next: readonly FocusApp[]) => {
    setBusy(true); setNotice('')
    try { await getSharedApiClient().saveFocusConfig({ apps: [...next] }, localDay()); setDraft(null); await load() }
    catch (error) { setNotice(saveError(error)) }
    finally { setBusy(false) }
  }
  const edit = (id: string, limit: number) => setDraft(apps.map((a) => a.id === id ? { ...a, limit_minutes: limit } : a))
  const openPicker = async () => { if (!installed) setInstalled(await focusGuard.installedApps().catch(() => { setNotice('Could not read the apps on this phone.'); return [] })) }
  const add = () => {
    const found = installed?.find((p) => p.pkg === pick)
    if (!found) return
    setDraft([...apps, { id: slug(found.label, new Set(apps.map((a) => a.id))), label: found.label.slice(0, 60), packages: [found.pkg], limit_minutes: 60 }]); setPick('')
  }
  const taken = new Set(apps.flatMap((a) => a.packages))

  if (loadState === 'loading') return <div className="nlog" aria-busy="true"><StateCard status="loading" title="Loading app limits" description="Loading your limits from the server." /></div>
  const protectionOff = status !== null && (!status.usageAccess || !status.accessibility)

  return <div className="nlog fg">
    {protectionOff && <div className="fg__banner fg__banner--off" role="alert"><TriangleAlert size={18} aria-hidden="true" /><div><b>Protection is off</b><p>Apps are not blocked until usage access and the accessibility service are both on.</p></div></div>}
    {notice && <p className="nlog__notice" role="status">{notice}</p>}
    {unlockApp && <Unlock key={unlockApp} appId={unlockApp} label={labelOf(unlockApp)} aiLeft={overview?.ai_grants_left} ready={loadState === 'ready' && canWrite} onClose={() => setUnlockApp(null)} onDone={() => void load()} />}
    {loadState === 'error' && !overview && <StateCard status={online ? 'error' : 'offline'} title={online ? 'Could not load app limits' : 'You are offline'} description="Your phone keeps the limits it already has. Check the connection and try again."
      action={<button type="button" className="nlog__btn nlog__btn--soft" onClick={() => void load()}>Try again</button>} />}
    {overview && <>
      {loadState === 'error' && <p className="nlog__notice" role="alert">Could not refresh. Showing what was loaded earlier.</p>}
      {pending && <div className="fg__banner fg__banner--warn"><div><b>Pending change</b>
        <p>Starts on {overview.config.effective_from}: {pending.apps.length ? pending.apps.map((a) => `${a.label} ${a.limit_minutes} min`).join(', ') : 'no apps guarded'}. Until then the limits below stay active.</p>
        <button type="button" className="nlog__btn nlog__btn--soft" disabled={busy || !canWrite} onClick={() => void save(effective)}>Cancel pending change</button></div></div>}

      {status && <><h2 className="nlog__group-h">Setup</h2>
        <div className="nlog__card">
          <div className="nlog__srow"><div><b>Usage access</b><small>Lets Aelys count the time spent in each app</small></div>
            {status.usageAccess ? <span className="nlog__tag nlog__tag--ok">On</span> : <button type="button" className="fg__go" onClick={() => void focusGuard.openSettings('usage')}>Grant usage access</button>}</div>
          <div className="nlog__srow"><div><b>Accessibility service</b><small>Lets Aelys block an app once its limit is used</small></div>
            {status.accessibility ? <span className="nlog__tag nlog__tag--ok">On</span> : <button type="button" className="fg__go" onClick={() => void focusGuard.openSettings('accessibility')}>Open accessibility settings</button>}</div>
        </div>
        {!status.accessibility && <p className="nlog__hint">If Android will not let you switch the service on, open App info and choose Allow restricted settings first (needed for apps installed outside the Play Store).
          {' '}<button type="button" className="nlog__link" onClick={() => void focusGuard.openSettings('app')}>Open app settings</button></p>}</>}

      <h2 className="nlog__group-h">Apps{overview.day_unlocked ? ' · unlocked for today' : ''}</h2>
      {effective.length === 0 && apps.length === 0 && !pending && <div className="nlog__empty"><div className="nlog__empty-title">No apps are limited</div>
        <button type="button" className="nlog__btn nlog__btn--primary fg__wide" disabled={busy || !canWrite} onClick={() => void save(DEFAULTS)}>Enable default limits</button>
        <small>Instagram, TikTok and Pinduoduo, 60 minutes a day each.</small></div>}
      {apps.length > 0 && <div className="nlog__card">{apps.map((a) => <div key={a.id} className="fg__app">
        <div className="fg__app-head"><span className="nlog__app-name">{a.label}</span>
          <label className="fg__limit"><input type="number" inputMode="numeric" min={1} max={1440} step={1} aria-label={`Daily limit for ${a.label} in minutes`} aria-invalid={!validLimit(a.limit_minutes)} value={a.limit_minutes || ''} onChange={(e) => edit(a.id, e.target.value === '' ? 0 : Number(e.target.value))} />min</label>
          <button type="button" className="nlog__link" onClick={() => setDraft(apps.filter((x) => x.id !== a.id))}>Remove</button></div>
        {effective.some((e) => e.id === a.id) && <Bar app={effective.find((e) => e.id === a.id)!} status={status} usage={usage} />}
      </div>)}</div>}
      {!valid && <p className="nlog__notice" role="status">Each limit must be a whole number from 1 to 1440 minutes.</p>}
      <p className="nlog__hint">{RULE}</p>
      <div className="fg__add">
        <select aria-label="Add an app" value={pick} onFocus={() => void openPicker()} onChange={(e) => setPick(e.target.value)}>
          <option value="">{installed ? 'Choose an app to add' : 'Add an app...'}</option>
          {installed?.filter((p) => !taken.has(p.pkg)).map((p) => <option key={p.pkg} value={p.pkg}>{p.label}</option>)}</select>
        <button type="button" className="nlog__btn nlog__btn--soft" disabled={!pick} onClick={add}>Add</button></div>
      <button type="button" className="nlog__btn nlog__btn--primary" disabled={!dirty || !valid || busy || !canWrite} onClick={() => void save(apps)}>Save</button>

      {requests && requests.length > 0 && <><h2 className="nlog__group-h">Unlock requests</h2>
        <div className="nlog__card">{requests.map((r) => <div key={r.id} className="fg__req">
          <div className="fg__req-head"><b>{labelOf(r.app_id)}</b><span className={`nlog__tag${r.granted ? ' nlog__tag--ok' : ''}`}>{r.granted ? `Granted ${r.minutes} min` : 'Refused'}</span><span className="nlog__time">{stamp(r.created_at)}</span></div>
          <p className="fg__reason">{r.reason}</p></div>)}</div></>}
    </>}
  </div>
}

function Bar({ app, status, usage }: { app: FocusApp; status: GuardStatus | null; usage: Record<string, AppUsage> | null }) {
  // The plugin reports zero use without usage access; that is not a fact, so say so instead of "0 min".
  if (!status?.usageAccess) return <small className="fg__usage">No usage access yet · limit {app.limit_minutes} min</small>
  if (!usage) return <small className="fg__usage">Usage is not available right now</small>
  const u = usage[app.id] ?? { usedSeconds: 0, limitSeconds: app.limit_minutes * 60, grantedSeconds: 0 }
  const total = u.limitSeconds + u.grantedSeconds
  const used = Math.floor(u.usedSeconds / 60)
  return <><div className="fg__track" role="progressbar" aria-label={`${app.label} used today`} aria-valuemin={0} aria-valuemax={Math.round(total / 60)} aria-valuenow={used}><span className={u.usedSeconds >= total ? 'is-full' : ''} style={{ width: `${total > 0 ? Math.min(100, (u.usedSeconds / total) * 100) : 100}%` }} /></div>
    <small className="fg__usage">{used} min of {Math.round(total / 60)} min{u.usedSeconds >= total ? ' · limit reached' : ''}</small></>
}

function Unlock({ appId, label, aiLeft, ready, onClose, onDone }: { appId: string; label: string; aiLeft: number | undefined; ready: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FocusUnlockResult | null>(null)
  const [applyFailed, setApplyFailed] = useState(false)
  const [error, setError] = useState('')
  const day = useRef(localDay())

  const apply = async (minutes: number) => {
    try { await focusGuard.applyGrant(appId, minutes * 60, day.current); setApplyFailed(false) } catch { setApplyFailed(true) }
  }
  const submit = async () => {
    setBusy(true); setError(''); setResult(null); day.current = localDay()
    try {
      const answer = await getSharedApiClient().focusUnlock({ day: day.current, app_id: appId, reason: reason.trim() })
      setResult(answer)
      if (answer.granted) await apply(answer.minutes)
      onDone()
    } catch (e) {
      setError(e instanceof OfflineWriteUnavailableError ? 'You are offline. Unlocking needs a connection.' : e instanceof ApiError && e.code === 'NOT_FOUND' ? 'That app is no longer in your list.' : 'Could not ask for time. Try again.')
    } finally { setBusy(false) }
  }
  const left = result?.ai_grants_left ?? aiLeft
  return <section className="fg__unlock" aria-label={`Unlock ${label}`}>
    <h2>Need more time on {label}?</h2>
    <p>Write why. A short, honest reason works best. Each approval gives up to 10 minutes.</p>
    <textarea aria-label="Reason" maxLength={300} rows={3} value={reason} disabled={busy || result?.granted === true} onChange={(e) => setReason(e.target.value)} placeholder="Why do you need this app right now?" />
    <small className="fg__count">{reason.length}/300</small>
    {!ready && <p className="nlog__hint">You are offline or the server is not reachable. Unlocking needs a connection.</p>}
    {error && <p className="nlog__notice" role="alert">{error}</p>}
    {result && <p className={`fg__answer${result.granted ? ' is-ok' : ''}`} role="status">{result.message}</p>}
    {result?.granted && !applyFailed && <div className="nlog__done">You can open {label} for {result.minutes} minutes</div>}
    {result?.granted && applyFailed && <div className="nlog__notice" role="alert">Approved, but this phone did not take the grant. <button type="button" className="nlog__link" onClick={() => void apply(result.minutes)}>Try again</button></div>}
    {left !== undefined && <small className="fg__count">{plural(left, 'AI unlock', 'AI unlocks')} left today</small>}
    <div className="fg__actions">
      {!result?.granted && <button type="button" className="nlog__btn nlog__btn--primary" disabled={!reason.trim() || busy || !ready} onClick={() => void submit()}>Ask for time</button>}
      <button type="button" className="nlog__btn nlog__btn--soft" onClick={onClose}>{result?.granted ? 'Done' : 'Close'}</button></div>
  </section>
}
