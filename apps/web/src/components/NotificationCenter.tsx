import { useEffect, useRef, useState } from 'react'
import { Bell } from '../icons'
import { X } from 'lucide-react'
import type { Notification } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'
import './notification-center.css'

// SQLite's UTC timestamps may arrive without an offset; keep their instant.
function notificationDate(value: string) {
  return new Date(/^\d{4}-\d\d-\d\dT.*\d$/.test(value) && !/[+-]\d\d:\d\d$/.test(value) ? `${value}Z` : value)
}

function isToday(value: string) {
  const date = notificationDate(value)
  const now = new Date()
  return !Number.isNaN(date.getTime()) && date.toDateString() === now.toDateString()
}

function formatDate(value: string) {
  const date = notificationDate(value)
  if (Number.isNaN(date.getTime())) return ''
  return isToday(value)
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function NotificationCenter({ apiStatus, route }: { apiStatus: ApiStatus; route: string }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [items, setItems] = useState<readonly Notification[]>([])
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const client = getSharedApiClient()
        if (apiStatus === 'ready') await client.dispatchCalendarReminders()
        const records = await client.notifications()
        if (active) {
          setItems((current) => records.map((record) => {
            const previous = current.find((item) => item.id === record.id)
            return !record.read_at && previous?.read_at ? { ...record, read_at: previous.read_at } : record
          }))
          setNotice(apiStatus === 'ready' ? '' : 'Showing cached notifications. Reminder delivery resumes when connected.')
        }
      } catch { if (active) setNotice('Notifications unavailable. Check your session and connection.') }
    }
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load() }, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [apiStatus, route, open])

  useEffect(() => {
    if (!open) return
    const panel = dialog.current
    panel?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); return }
      if (event.key !== 'Tab' || !panel) return
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
      if (!controls.length) { event.preventDefault(); panel.focus(); return }
      const first = controls[0]!
      const last = controls[controls.length - 1]!
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    const outside = (event: PointerEvent) => {
      if (!panel?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', keydown)
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('keydown', keydown); document.removeEventListener('pointerdown', outside) }
  }, [open])

  const unread = items.filter((item) => !item.read_at).length
  const markRead = async (records: readonly Notification[]) => {
    if (!records.length || saving || apiStatus !== 'ready') return
    setSaving(true)
    const results = await Promise.allSettled(records.map((item) => getSharedApiClient().markNotificationRead(item.id, { queueOnOffline: false })))
    const saved = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    setItems((current) => current.map((item) => saved.find((record) => record.id === item.id) ?? item))
    setNotice(results.some((result) => result.status === 'rejected') ? 'Could not mark some notifications as read. Try again.' : '')
    setSaving(false)
  }
  const visible = filter === 'unread' ? items.filter((item) => !item.read_at) : items
  const groups = [
    { label: 'Today', items: visible.filter((item) => isToday(item.created_at)) },
    { label: 'Earlier', items: visible.filter((item) => !isToday(item.created_at)) },
  ].filter((group) => group.items.length)

  return <div className="notification-center" data-open={open || undefined}>
    <button ref={trigger} type="button" className="shell-btn shell-pill shell-pill--button notification-center__trigger" data-glass="" title="Notifications" aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Bell size={18} aria-hidden="true" />{unread > 0 && <span className="notification-center__badge" aria-hidden="true">{unread}</span>}
    </button>
    {open && <section ref={dialog} className="notification-center__dialog" role="dialog" aria-label="Notification center" aria-modal="true" tabIndex={-1}>
      <header className="notification-center__header"><div><h2>Notifications</h2><span className="notification-center__count">{unread} unread</span></div><button type="button" className="notification-center__read-all" disabled={!unread || saving || apiStatus !== 'ready'} onClick={() => void markRead(items.filter((item) => !item.read_at))}>Mark all as read</button><button type="button" className="notification-center__close" aria-label="Close notifications" onClick={() => { setOpen(false); trigger.current?.focus() }}><X size={18} /></button></header>
      <div className="notification-center__filters" aria-label="Filter notifications"><button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button><button type="button" aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>Unread{unread > 0 ? ` (${unread})` : ''}</button></div>
      {notice && <p className="notification-center__notice" role="status">{notice}</p>}
      <div className="notification-center__list">{groups.map((group) => <section key={group.label} aria-label={group.label}><h3>{group.label}</h3>{group.items.map((item) => <article key={item.id} className="notification-center__item" data-unread={!item.read_at || undefined}>
        <span className="notification-center__icon"><Bell size={17} aria-hidden="true" /></span><div className="notification-center__content"><div className="notification-center__title"><strong>{item.title}</strong><time dateTime={item.created_at}>{formatDate(item.created_at)}</time></div>{item.body && <p>{item.body}</p>}{!item.read_at && <button type="button" disabled={saving || apiStatus !== 'ready'} onClick={() => void markRead([item])}>Mark as read</button>}</div>{!item.read_at && <span className="notification-center__dot" aria-label="Unread" />}
      </article>)}</section>)}{groups.length === 0 && <p className="notification-center__empty">{filter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}</p>}</div>
    </section>}
  </div>
}
