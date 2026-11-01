import { useEffect, useState } from 'react'
import { ApiError, type GoogleCalendarStatus } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'

export function GoogleCalendarSettings() {
  const [status,setStatus]=useState<GoogleCalendarStatus|null>(null)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  const load=async()=>setStatus(await getSharedApiClient().googleCalendarStatus())
  useEffect(()=>{let active=true;void getSharedApiClient().googleCalendarStatus().then(value=>{if(active)setStatus(value)}).catch(()=>{if(active)setMessage('Could not load Google Calendar status.')});return()=>{active=false}},[])
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setMessage('');try{await action()}catch(error){setMessage(error instanceof ApiError ? `${error.code}: ${error.message}`:'Could not update Google Calendar. Try again.')}finally{setBusy(false)}}
  return <section className="settings-card">
    <div className="settings-card__header"><div><h2>Google Calendar</h2><p>One-way, read-only import</p></div></div>
    <div className="settings-form">
      <p>Import your primary calendar into Aelys. Changes in Aelys are never sent to Google. Connected calendars refresh every 15 minutes.</p>
      {!status && !message && <p role="status">Loading connection…</p>}
      {status && !status.configured && <p>Google Calendar is not configured on this server.</p>}
      {status?.connection && <>
        <p>Connection: {status.connection.status}{status.connection.last_error_code ? ` · ${status.connection.last_error_code}` : ''}</p>
        <p>Last import: {status.connection.last_synced_at ? new Date(status.connection.last_synced_at).toLocaleString():'Not imported yet'}</p>
        <button className="button button--primary" type="button" disabled={busy} onClick={()=>void run(async()=>{const result=await getSharedApiClient().syncGoogleCalendar();await load();setMessage(`${result.imported} imported, ${result.deleted} removed.`)})}>Import now</button>
        <p>Disconnecting removes imported events from Aelys and clears the connection tokens. Your Google calendar stays unchanged.</p>
        <button className="button button--quiet" type="button" disabled={busy} onClick={()=>void run(async()=>{await getSharedApiClient().disconnectGoogleCalendar();await load();setMessage('Disconnected. Imported events removed from Aelys.')})}>Disconnect</button>
      </>}
      <button className="button button--quiet" type="button" disabled={busy || !status?.configured} onClick={()=>void run(async()=>{const result=await getSharedApiClient().connectGoogleCalendar();window.location.assign(result.authorization_url)})}>{status?.connection ? 'Reconnect Google Calendar':'Connect Google Calendar'}</button>
      {message && <p role="status">{message}</p>}
    </div>
  </section>
}
