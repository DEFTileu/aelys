import { useEffect, useState } from 'react'
import { Bell } from '../icons'
import type { Notification } from '@aelys/shared'
import { getAccessToken, getSharedApiClient } from '../lib/api'
import type { ApiStatus } from '../types'

export function NotificationCenter({ apiStatus, route }: { apiStatus: ApiStatus; route: string }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<readonly Notification[]>([])
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    const load = async () => {
      if (!getAccessToken()) { if (active) setItems([]); return }
      try {
        const client = getSharedApiClient()
        if (apiStatus === 'ready') await client.dispatchCalendarReminders()
        const records = await client.notifications()
        if (active) { setItems(records); setNotice(apiStatus === 'ready' ? '' : 'Showing cached notifications. Reminder delivery resumes when connected.') }
      } catch { if (active) setNotice('Notifications unavailable. Check your session and connection.') }
    }
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load() }, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [apiStatus, route, open])
  const unread = items.filter((item) => !item.read_at).length
  const markRead = async (item: Notification) => {
    try { const saved = await getSharedApiClient().markNotificationRead(item.id, { queueOnOffline: false }); setItems((current) => current.map((row) => row.id === saved.id ? saved : row)) }
    catch { setNotice('Could not mark notification as read.') }
  }
  return <div style={{ position: 'relative' }}><button type="button" className="shell-btn shell-pill shell-pill--button" data-glass="" title="Notifications" aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'} aria-expanded={open} onClick={() => setOpen((value) => !value)} style={{ width: 40, justifyContent: 'center', borderRadius: '50%', padding: 0 }}><Bell size={18} aria-hidden="true" />{unread > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 9, right: 10, width: 8, height: 8, borderRadius: '50%', background: '#E5484D' }}/>}</button>{open && <section aria-label="Notification center" style={{ position: 'absolute', right: 0, top: 48, width: 340, maxWidth: '85vw', maxHeight: '70vh', overflow: 'auto', padding: 16, background: '#fff', color: '#1C1B22', borderRadius: 16, boxShadow: '0 10px 35px #0003', zIndex: 20 }}><h2>Notifications</h2><p>Scheduled reminders are delivered while Aelys is open and connected.</p>{notice && <p role="status">{notice}</p>}{items.length === 0 && <p>No notifications yet.</p>}{items.map((item) => <article key={item.id} style={{ paddingBlock: 10, borderTop: '1px solid #eee' }}><strong>{item.title}</strong><p>{item.body}</p>{!item.read_at && <button type="button" disabled={apiStatus !== 'ready'} onClick={() => void markRead(item)}>Mark as read</button>}</article>)}</section>}</div>
}
