import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleCalendarSettings } from '../views/GoogleCalendarSettings'
const client=vi.hoisted(()=>({googleCalendarStatus:vi.fn(),syncGoogleCalendar:vi.fn(),disconnectGoogleCalendar:vi.fn(),connectGoogleCalendar:vi.fn(),clearReadCache:vi.fn()}))
const connect = vi.hoisted(() => vi.fn())
vi.mock('../lib/api',()=>({getSharedApiClient:()=>client, connectGoogleCalendarAccount:connect}))
let root:ReturnType<typeof createRoot>
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true) })
afterEach(()=>{if(root)act(()=>root.unmount());document.body.innerHTML='';vi.resetAllMocks();vi.unstubAllGlobals()})
async function mount(){const host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);await act(async()=>root.render(<GoogleCalendarSettings/>));return host}
const connection={id:'calendar',version:1,calendar_id:'primary',status:'connected',last_synced_at:null,last_error_code:null}
describe('Google Calendar read-only connection',()=>{
 it('honestly disables connection when server OAuth is unavailable',async()=>{
  client.googleCalendarStatus.mockResolvedValue({configured:false,connection:null});const host=await mount()
  expect(host.textContent).toContain('not configured');expect(Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Connect Google Calendar')!.disabled).toBe(true)
  expect(client.connectGoogleCalendar).not.toHaveBeenCalled();expect(host.textContent).toContain('read-only')
 })
 it('imports manually and disconnects imported events',async()=>{
  client.googleCalendarStatus.mockResolvedValue({configured:true,connection});client.syncGoogleCalendar.mockResolvedValue({imported:2,deleted:1,full_sync:false});client.disconnectGoogleCalendar.mockResolvedValue({disconnected:true})
  const host=await mount();await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Import now')!.click());expect(client.syncGoogleCalendar).toHaveBeenCalledOnce();expect(host.textContent).toContain('2 imported')
  client.googleCalendarStatus.mockResolvedValue({configured:true,connection:null});await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Disconnect')!.click());expect(client.disconnectGoogleCalendar).toHaveBeenCalledOnce();expect(host.textContent).toContain('Disconnected')
 })
})

// Imported event details never expose an editor or a deletion action.

it.each([false,true])('refreshes Calendar on browser return without importing automatically (reconnect=%s)', async reconnect => {
 client.googleCalendarStatus.mockResolvedValue({configured:true,connection:reconnect?connection:null})
 connect.mockResolvedValue(undefined)
 const host=await mount()
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===(reconnect?'Reconnect Google Calendar':'Connect Google Calendar'))!.click())
 expect(connect).toHaveBeenCalledOnce()
 expect(client.connectGoogleCalendar).not.toHaveBeenCalled()
 expect(host.textContent).toContain('Complete the Google connection in your browser')
 client.googleCalendarStatus.mockResolvedValue({configured:true,connection:{...connection,version:reconnect?2:1}})
 await act(async()=>window.dispatchEvent(new Event('focus')))
 expect(client.googleCalendarStatus).toHaveBeenLastCalledWith({forceRefresh:true,allowCacheFallback:false})
 expect(host.textContent).toContain('Google Calendar connected.')
 expect(client.syncGoogleCalendar).not.toHaveBeenCalled()
})

it('clears Calendar account details after an expired native session', async()=>{
 const {ApiError}=await import('@aelys/shared')
 client.googleCalendarStatus.mockResolvedValue({configured:true,connection});connect.mockResolvedValue(undefined)
 const host=await mount()
 await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Reconnect Google Calendar')!.click())
 client.googleCalendarStatus.mockRejectedValue(new ApiError(401,'UNAUTHORIZED','Sign in again.'))
 await act(async()=>window.dispatchEvent(new Event('focus')))
 expect(host.textContent).toContain('Sign in again.')
 expect(host.textContent).not.toContain('Connection: connected')
})
