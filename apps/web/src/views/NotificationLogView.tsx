import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FinanceAccount, FinanceCategory } from '@aelys/shared'
import { ApiError } from '@aelys/shared'
import { Bell, Check, ChevronLeft, EyeOff, Info, Lock, Search, Sliders, Trash2, Wallet } from '../icons'
import { getSharedApiClient } from '../lib/api'
import { isAndroidHost, mergePayments, notificationLog, type LogItem, type LogEntry, type LogSettings, type LogStatus } from '../lib/notificationLog'
import { navigate } from '../lib/router'
import type { ApiStatus } from '../types'
import { displayMoney } from './finance/useFinance'
import { decimalToUnits } from '../lib/money'
import './desktop/page-tokens.css'
import './notification-log.css'

type View = { kind: 'list' } | { kind: 'detail'; id: number } | { kind: 'settings' } | { kind: 'guide' }
const TINTS = [['#1F55B8', '#E4EEFD'], ['#B8402F', '#FDE6E1'], ['#0E7A57', '#DCF5EC'], ['#5132D6', '#EEE8FD'], ['#8A5A00', '#FDF1D9']] as const
const tintOf = (pkg: string) => TINTS[[...pkg].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % TINTS.length]!
const NOT_PAYMENT_KEY = 'aelys.notificationLog.notPayment.v1'
const AUTO_KEY = 'aelys.notificationLog.autoAdd.v1'
const readJson = <T,>(key: string, fallback: T): T => { try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback } catch { return fallback } }
const writeJson = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* optional */ } }
const time = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
function dayOf(ms: number) {
  const d = new Date(ms); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1)
  const label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  return d.toDateString() === today.toDateString() ? `Today · ${label}` : d.toDateString() === yesterday.toDateString() ? `Yesterday · ${label}` : label
}
const money = (amount: string, currency: string) => displayMoney(-decimalToUnits(amount), currency)

export function NotificationLogView({ apiStatus }: { apiStatus: ApiStatus }) {
  if (!isAndroidHost()) return <div className="nlog"><div className="nlog__empty"><Bell size={28} /><div className="nlog__empty-title">Only in the Android app</div><div>The notification log reads notifications on your phone and keeps them there.</div></div></div>
  return <NotificationLog apiStatus={apiStatus} />
}

function NotificationLog({ apiStatus }: { apiStatus: ApiStatus }) {
  const [status, setStatus] = useState<LogStatus | null>(null)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [failed, setFailed] = useState(false)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [query, setQuery] = useState('')
  const [app, setApp] = useState('all')
  const [accounts, setAccounts] = useState<readonly FinanceAccount[]>([])
  const [categories, setCategories] = useState<readonly FinanceCategory[]>([])
  const [notPayment, setNotPayment] = useState<number[]>(() => readJson(NOT_PAYMENT_KEY, []))
  const [auto, setAuto] = useState<{ on: boolean; since: number }>(() => readJson(AUTO_KEY, { on: false, since: 0 }))
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [icons, setIcons] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try { const [s, list] = await Promise.all([notificationLog.status(), notificationLog.list()]); setStatus(s); setEntries(list); setFailed(false) }
    catch { setFailed(true) }
  }, [])
  // Coming back from Android settings (access granted) or after new notifications arrived.
  useEffect(() => { void load(); const onShow = () => { if (document.visibilityState === 'visible') void load() }; document.addEventListener('visibilitychange', onShow); return () => document.removeEventListener('visibilitychange', onShow) }, [load])
  useEffect(() => {
    if (apiStatus !== 'ready') return
    const client = getSharedApiClient()
    Promise.all([client.financeAccounts(), client.financeCategories()]).then(([a, c]) => { setAccounts(a); setCategories(c) }).catch(() => undefined)
  }, [apiStatus])

  const items = useMemo(() => mergePayments(entries).map((item) => notPayment.includes(item.id) ? { ...item, payment: null } : item), [entries, notPayment])
  const apps = useMemo(() => [...new Map(items.map((i) => [i.pkg, i.app])).entries()], [items])
  const packages = useMemo(() => [...new Set([...apps.map(([pkg]) => pkg), ...(status?.settings.muted ?? [])])].slice(0, 200).join(' '), [apps, status])
  useEffect(() => { if (packages) notificationLog.icons(packages.split(' ')).then(setIcons).catch(() => undefined) }, [packages])
  const q = query.trim().toLowerCase()
  const shown = items.filter((i) => (app === 'all' || i.pkg === app) && (!q || [i.app, i.title, i.body, i.payment?.merchant, i.payment?.amount].join(' ').toLowerCase().includes(q)))
  const groups = useMemo(() => { const map = new Map<string, LogItem[]>(); for (const i of shown) map.set(dayOf(i.posted), [...(map.get(dayOf(i.posted)) ?? []), i]); return [...map.entries()] }, [shown])

  const accountFor = useCallback((currency: string) => accounts.find((a) => a.currency === currency), [accounts])
  const addToFinance = useCallback(async (item: LogItem, accountId: string, categoryId: string | null) => {
    if (!item.payment) return
    const key = `notification-log-${item.id}-${item.posted}`
    const tx = await getSharedApiClient().createFinanceTransaction({ account_id: accountId, category_id: categoryId, amount: item.payment.amount, currency: item.payment.currency, type: 'expense', occurred_at: new Date(item.posted).toISOString(), notes: [item.payment.merchant, item.app].filter(Boolean).join(' · '), idempotency_key: key }, { idempotencyKey: key })
    await notificationLog.setFinance(item.id, tx.id)
    setEntries((list) => list.map((e) => e.id === item.id ? { ...e, financeTx: tx.id } : e))
  }, [])

  // Auto-add only payments that arrived after it was turned on, never the backlog.
  useEffect(() => {
    if (!auto.on || apiStatus !== 'ready' || !accounts.length) return
    const pending = items.filter((i) => i.payment && !i.financeTx && i.posted >= auto.since && accountFor(i.payment.currency))
    if (!pending.length) return
    let cancelled = false
    void (async () => { for (const i of pending) { if (cancelled) return; try { await addToFinance(i, accountFor(i.payment!.currency)!.id, null) } catch { return } } })()
    return () => { cancelled = true }
  }, [auto, apiStatus, accounts, items, accountFor, addToFinance])

  const saveSettings = async (next: LogSettings) => { try { const saved = await notificationLog.setSettings(next); setStatus((s) => s && { ...s, settings: saved }); void load() } catch { setNotice('Could not save the setting. Try again.') } }

  if (failed) return <div className="nlog"><div className="nlog__empty"><Bell size={28} /><div className="nlog__empty-title">Can’t open the log</div><button type="button" className="nlog__btn" onClick={() => void load()}>Try again</button></div></div>
  if (!status) return <div className="nlog" aria-busy="true" />
  if (!status.access || view.kind === 'guide') return <Guide access={status.access} onAllow={() => { if (status.access) setView({ kind: 'list' }); else void notificationLog.openAccessSettings() }} />

  const item = view.kind === 'detail' ? items.find((i) => i.id === view.id) : undefined
  if (item) {
    return <Detail item={item} icon={icons[item.pkg]} accounts={accounts} categories={categories} accountFor={accountFor} busy={busy} apiReady={apiStatus === 'ready'} notice={notice}
      onBack={() => { setNotice(''); setView({ kind: 'list' }) }}
      onAdd={async (accountId, categoryId) => { setBusy(true); setNotice(''); try { await addToFinance(item, accountId, categoryId) } catch (error) { setNotice(error instanceof ApiError ? error.message : 'Could not add it to Finances. Check the connection and try again.') } finally { setBusy(false) } }}
      onNotPayment={() => { const next = [...notPayment, item.id]; setNotPayment(next); writeJson(NOT_PAYMENT_KEY, next); setView({ kind: 'list' }) }}
      onDelete={async () => { await notificationLog.remove(item.id).catch(() => undefined); setView({ kind: 'list' }); void load() }} />
  }

  if (view.kind === 'settings') {
    const s = status.settings
    return <div className="nlog">
      <button type="button" className="nlog__crumb" onClick={() => setView({ kind: 'list' })}><ChevronLeft size={18} />Notification log</button>
      {notice && <p className="nlog__notice" role="status">{notice}</p>}
      <div className="nlog__group-h">Log</div>
      <div className="nlog__card">
        <div className="nlog__srow"><div><b>Notification access</b><small>Allowed in Android settings</small></div><span className="nlog__tag nlog__tag--ok">On</span></div>
        <div className="nlog__srow"><div><b>Add payments to Finances</b><small>{accounts.length ? 'New payments go to the account in their currency' : 'Add an account in Finances first'}</small></div><Switch on={auto.on} label="Add payments to Finances" onChange={(on) => { const next = { on, since: on ? Date.now() : 0 }; setAuto(next); writeJson(AUTO_KEY, next) }} /></div>
        <div className="nlog__srow"><div><b>Hide one-time codes</b><small>The code text is not saved</small></div><Switch on={s.hideCodes} label="Hide one-time codes" onChange={(hideCodes) => void saveSettings({ ...s, hideCodes })} /></div>
        <div className="nlog__srow"><div><b>Keep notifications</b><small>Older ones are deleted</small></div>
          <select className="nlog__pill" aria-label="Keep notifications" value={s.keepDays} onChange={(e) => void saveSettings({ ...s, keepDays: Number(e.target.value) as LogSettings['keepDays'] })}>{[7, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select></div>
      </div>
      {(apps.length > 0 || s.muted.length > 0) && <><div className="nlog__group-h">Apps</div>
        <div className="nlog__card">{[...new Map([...apps, ...s.muted.map((p) => [p, p] as [string, string])]).entries()].map(([pkg, name]) => { const [c, soft] = tintOf(pkg); const on = !s.muted.includes(pkg)
          return <div key={pkg} className="nlog__srow"><AppTile name={name} color={c} soft={soft} icon={icons[pkg]} small /><span className="nlog__app-name">{name}</span>
            <Switch on={on} label={`Save notifications from ${name}`} onChange={(next) => void saveSettings({ ...s, muted: next ? s.muted.filter((p) => p !== pkg) : [...s.muted, pkg] })} /></div> })}</div></>}
      <p className="nlog__privacy"><Lock size={15} />Stored on this phone only. The server gets nothing except the payments you add to Finances.</p>
      <button type="button" className="nlog__btn nlog__btn--soft" onClick={() => setView({ kind: 'guide' })}><Info size={18} />How it works</button>
      {confirmClear
        ? <div className="nlog__confirm"><span>Delete every saved notification? This can’t be undone.</span><div><button type="button" className="nlog__btn nlog__btn--danger" onClick={async () => { setConfirmClear(false); await notificationLog.clear().catch(() => undefined); setView({ kind: 'list' }); void load() }}>Delete all</button><button type="button" className="nlog__btn nlog__btn--soft" onClick={() => setConfirmClear(false)}>Cancel</button></div></div>
        : <button type="button" className="nlog__btn nlog__btn--danger" onClick={() => setConfirmClear(true)}><Trash2 size={18} />Clear log</button>}
    </div>
  }

  return <div className="nlog">
    <div className="nlog__bar">
      <label className="nlog__search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notifications" aria-label="Search notifications" /></label>
      <button type="button" className="nlog__icon-btn" aria-label="Log settings" onClick={() => { setNotice(''); setView({ kind: 'settings' }) }}><Sliders size={18} /></button>
    </div>
    {apps.length > 1 && <div className="nlog__chips" role="group" aria-label="Filter by app">
      {[['all', 'All apps'] as [string, string], ...apps].map(([pkg, name]) => <button key={pkg} type="button" className="nlog__chip" aria-pressed={app === pkg} onClick={() => setApp(pkg)}>{name}</button>)}
    </div>}
    {groups.map(([day, rows]) => <section key={day} className="nlog__day">
      <h2 className="nlog__group-h">{day}</h2>
      <div className="nlog__card">{rows.map((i) => { const [c, soft] = tintOf(i.pkg)
        return <button key={i.id} type="button" className="nlog__row" onClick={() => { setNotice(''); setView({ kind: 'detail', id: i.id }) }}>
          <AppTile name={i.app} color={c} soft={soft} icon={icons[i.pkg]} />
          <span className="nlog__row-body">
            <span className="nlog__app">{i.app}</span>
            <span className={`nlog__title${i.payment ? ' is-pay' : ''}`}>{i.payment ? `${money(i.payment.amount, i.payment.currency)}${i.payment.merchant ? ` · ${i.payment.merchant}` : ''}` : i.title || i.app}</span>
            {i.kind === 'code' && !i.body ? <span className="nlog__text nlog__text--code"><EyeOff size={14} />Code hidden</span> : !i.payment && i.body && <span className="nlog__text">{i.body}</span>}
            {i.payment && <span className="nlog__tags">{i.financeTx ? <span className="nlog__tag nlog__tag--ok"><Check size={13} />In Finances</span> : <span className="nlog__tag nlog__tag--warn">Not in Finances</span>}{i.mergedWith.length > 0 && <span className="nlog__tag">Merged with {i.mergedWith.join(', ')}</span>}</span>}
          </span>
          <span className="nlog__time">{time(i.posted)}</span>
        </button> })}</div>
    </section>)}
    {shown.length === 0 && <div className="nlog__empty"><Bell size={28} /><div className="nlog__empty-title">{items.length ? 'Nothing here' : 'No notifications yet'}</div><div>{!items.length ? 'New notifications will show up here' : q ? `Nothing matches “${query.trim()}”` : 'No notifications from this app'}</div></div>}
  </div>
}

function AppTile({ name, color, soft, icon, small }: { name: string; color: string; soft: string; icon?: string; small?: boolean }) {
  const cls = `nlog__tile${small ? ' nlog__tile--sm' : ''}`
  if (icon) return <img className={`${cls} nlog__tile--img`} src={icon} alt="" />
  return <span className={cls} style={{ color, background: soft }}>{name.charAt(0).toUpperCase()}</span>
}

function Guide({ access, onAllow }: { access: boolean; onAllow: () => void }) {
  return <div className="nlog nlog--guide">
    <span className="nlog__hero-tile"><Bell size={26} /></span>
    <h2 className="nlog__guide-title">Keep every notification in one place</h2>
    <p className="nlog__guide-text">Aelys saves the notifications your phone receives, so a payment or a message is never lost when you swipe it away.</p>
    <ol className="nlog__steps">
      <li><span>1</span><div><b>Allow access</b><small>Turn on notification access for Aelys in Android settings.</small></div></li>
      <li><span>2</span><div><b>Keep</b><small>Each notification is saved on this phone. Nothing leaves it.</small></div></li>
      <li><span>3</span><div><b>Track payments</b><small>Aelys recognizes a payment so you can add it to Finances.</small><em className="nlog__tag nlog__tag--ok"><Wallet size={13} />4 280.00 ₸ · Magnum</em></div></li>
    </ol>
    <button type="button" className="nlog__btn nlog__btn--primary" onClick={onAllow}>{access ? 'Open the log' : 'Allow access'}</button>
    <p className="nlog__foot">Prefer to add expenses yourself? <button type="button" className="nlog__link" onClick={() => navigate('/finance')}>Open Finances</button></p>
  </div>
}

function Detail({ item, icon, accounts, categories, accountFor, busy, apiReady, notice, onBack, onAdd, onNotPayment, onDelete }: { item: LogItem; icon?: string; accounts: readonly FinanceAccount[]; categories: readonly FinanceCategory[]; accountFor: (currency: string) => FinanceAccount | undefined; busy: boolean; apiReady: boolean; notice: string; onBack: () => void; onAdd: (accountId: string, categoryId: string | null) => void; onNotPayment: () => void; onDelete: () => void }) {
  const [c, soft] = tintOf(item.pkg)
  const pay = item.payment
  const usable = pay ? accounts.filter((a) => a.currency === pay.currency) : []
  const [accountId, setAccountId] = useState(() => (pay && accountFor(pay.currency)?.id) ?? '')
  const [categoryId, setCategoryId] = useState('')
  useEffect(() => { if (!accountId && pay) setAccountId(accountFor(pay.currency)?.id ?? '') }, [accountId, accountFor, pay])
  const raw = item.kind === 'code' && !item.body ? 'Code hidden' : [item.title, item.body].filter(Boolean).join('\n')
  return <div className="nlog">
    <button type="button" className="nlog__crumb" onClick={onBack}><ChevronLeft size={18} />Notification log</button>
    <div className="nlog__card nlog__hero">
      <div className="nlog__src"><AppTile name={item.app} color={c} soft={soft} icon={icon} /><div><b>{item.app}</b><small>{dayOf(item.posted)} · {time(item.posted)}</small></div></div>
      {pay ? <><div className="nlog__amount">{money(pay.amount, pay.currency)}</div>{pay.merchant && <div className="nlog__merchant">{pay.merchant}</div>}</> : <div className="nlog__merchant">{item.title || item.app}</div>}
    </div>
    {pay && !item.financeTx && <div className="nlog__card">
      <label className="nlog__srow"><b>Account</b><select className="nlog__pill" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!usable.length}>{usable.length ? usable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>) : <option value="">No {pay.currency} account</option>}</select></label>
      <label className="nlog__srow"><b>Category</b><select className="nlog__pill" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">None</option>{categories.filter((k) => k.kind === 'expense').map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label>
    </div>}
    <div className="nlog__raw"><span>Original notification</span><p>{raw}</p></div>
    {notice && <p className="nlog__notice" role="alert">{notice}</p>}
    <div className="nlog__actions">
      {pay && (item.financeTx
        ? <div className="nlog__done"><Check size={18} />Added to Finances</div>
        : <button type="button" className="nlog__btn nlog__btn--primary" disabled={busy || !apiReady || !accountId} onClick={() => onAdd(accountId, categoryId || null)}>{busy ? 'Adding…' : 'Add to Finances'}</button>)}
      {pay && !item.financeTx && <button type="button" className="nlog__btn nlog__btn--soft" onClick={onNotPayment}>Not a payment</button>}
      {pay && !item.financeTx && !usable.length && <p className="nlog__hint">Add a {pay.currency} account in Finances to record this payment.</p>}
      <button type="button" className="nlog__btn nlog__btn--danger" onClick={onDelete}><Trash2 size={18} />Delete from log</button>
    </div>
  </div>
}

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="nlog__switch" onClick={() => onChange(!on)}><span /></button>
}
