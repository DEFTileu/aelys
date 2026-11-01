import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { CalendarView } from '../views/CalendarView'
const client=vi.hoisted(()=>({calendarOccurrences:vi.fn(),calendarReminders:vi.fn(),updateCalendarEvent:vi.fn(),deleteCalendarEvent:vi.fn()}))
vi.mock('../lib/api',()=>({getSharedApiClient:()=>client}))
let root:ReturnType<typeof createRoot>
afterEach(()=>{if(root)act(()=>root.unmount());document.body.innerHTML='';vi.resetAllMocks()})
it('shows imported details without write controls',async()=>{
 const start=new Date();start.setDate(start.getDate()-((start.getDay()+6)%7));start.setHours(10,0,0,0);const end=new Date(start.getTime()+3600000)
 client.calendarOccurrences.mockResolvedValue([{id:'imported',version:1,title:'Imported meeting',description:'External details',starts_at:start.toISOString(),ends_at:end.toISOString(),series_starts_at:start.toISOString(),series_ends_at:end.toISOString(),occurrence_id:'imported:instance',timezone:'UTC',all_day:false,rrule:null,project_id:null,linked_task_id:null,external_source:'google_calendar:test',external_id:'remote'}])
 const host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);await act(async()=>root.render(<CalendarView apiStatus="ready"/>))
 await act(async()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent?.includes('Imported meeting'))!.click())
 expect(host.querySelector('[aria-label="Imported event"]')!.textContent).toContain('Read-only event from Google Calendar')
 expect(host.querySelector('[aria-label="Event editor"]')).toBeNull();expect(host.textContent).not.toContain('Delete event');expect(client.calendarReminders).not.toHaveBeenCalled()
 expect(client.updateCalendarEvent).not.toHaveBeenCalled();expect(client.deleteCalendarEvent).not.toHaveBeenCalled()
})
