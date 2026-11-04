import { useEffect, useRef, useState } from 'react'
import { ApiError, type GoogleCalendarStatus } from '@aelys/shared'
import { connectGoogleCalendarAccount, getSharedApiClient } from '../lib/api'

export function GoogleCalendarSettings() {
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [message, setMessage] = useState('')
  const attempt = useRef<{ baseline: string; started: number } | null>(null)
  const load = async () => setStatus(await getSharedApiClient().googleCalendarStatus({ forceRefresh: true }))
  useEffect(() => {
    let active = true
    void getSharedApiClient().googleCalendarStatus().then(value => { if (active) setStatus(value) }).catch(() => { if (active) setMessage('Could not load Google Calendar status.') })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!connecting) return
    let active = true
    let checking = false
    const check = async () => {
      if (checking || !attempt.current || document.visibilityState === 'hidden') return
      if (Date.now() - attempt.current.started >= 600_000) {
        attempt.current = null; setConnecting(false); setMessage('The Calendar connection expired. Connect Google Calendar again to retry.'); return
      }
      checking = true
      try {
        const client = getSharedApiClient()
        const current = await client.googleCalendarStatus({ forceRefresh: true, allowCacheFallback: false })
        if (!active || !attempt.current) return
        setStatus(current)
        const connection = current.connection
        if (connection?.status === 'connected' && `${connection.id}:${connection.version}` !== attempt.current.baseline) {
          client.clearReadCache(); attempt.current = null; setConnecting(false)
          setMessage('Google Calendar connected. Choose Import now to load events.')
        }
      } catch (error) {
        if (active && error instanceof ApiError && [401, 403].includes(error.status)) {
          attempt.current = null; setConnecting(false); setStatus(null); setMessage(`${error.code}: ${error.message}`)
        }
      } finally { checking = false }
    }
    const resume = () => { void check() }
    const timer = window.setInterval(resume, 3000)
    window.addEventListener('focus', resume); window.addEventListener('online', resume)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', resume); window.removeEventListener('online', resume) }
  }, [connecting])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setMessage('')
    try { await action() }
    catch (error) { setMessage(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Could not update Google Calendar. Try again.') }
    finally { setBusy(false) }
  }
  const connect = () => run(async () => {
    const connection = status?.connection
    attempt.current = { baseline: connection ? `${connection.id}:${connection.version}` : '', started: Date.now() }
    try {
      await connectGoogleCalendarAccount(); setConnecting(true)
      setMessage('Complete the Google connection in your browser, then return to Aelys.')
    } catch (error) { attempt.current = null; setConnecting(false); throw error }
  })
  return <section className="settings-card">
    <div className="settings-card__header"><div><h2>Google Calendar</h2><p>One-way, read-only import</p></div></div>
    <div className="settings-form">
      <p>Import your primary calendar into Aelys. Changes in Aelys are never sent to Google. Connected calendars refresh every 15 minutes.</p>
      {!status && !message && <p role="status">Loading connection…</p>}
      {status && !status.configured && <p>Google Calendar is not configured on this server.</p>}
      {status?.connection && <>
        <p>Connection: {status.connection.status}{status.connection.last_error_code ? ` · ${status.connection.last_error_code}` : ''}</p>
        <p>Last import: {status.connection.last_synced_at ? new Date(status.connection.last_synced_at).toLocaleString() : 'Not imported yet'}</p>
        <button className="button button--primary" type="button" disabled={busy || connecting} onClick={() => void run(async () => { const result = await getSharedApiClient().syncGoogleCalendar(); await load(); setMessage(`${result.imported} imported, ${result.deleted} removed.`) })}>Import now</button>
        <p>Disconnecting removes imported events from Aelys and clears the connection tokens. Your Google calendar stays unchanged.</p>
        <button className="button button--quiet" type="button" disabled={busy || connecting} onClick={() => void run(async () => { await getSharedApiClient().disconnectGoogleCalendar(); await load(); setMessage('Disconnected. Imported events removed from Aelys.') })}>Disconnect</button>
      </>}
      <button className="button button--quiet" type="button" disabled={busy || connecting || !status?.configured} onClick={() => void connect()}>{status?.connection ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}</button>
      {message && <p role="status">{message}</p>}
    </div>
  </section>
}
