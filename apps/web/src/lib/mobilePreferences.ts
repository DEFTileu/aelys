import { useSyncExternalStore } from 'react'
import { Calendar, CalendarCheck, ChartColumn, CircleDot, Sparkles } from '../icons'
const KEY = 'aelys.mobile.actions.v1'
export const MOBILE_ACTIONS = [
  { label:'Find a task', icon:CircleDot, color:'#D93636', prompt:'Find a task in my workspace.' },
  { label:'Schedule', icon:Calendar, color:'#2F6FE4', prompt:'Help schedule an event in my calendar.' },
  { label:'Sort inbox', icon:Sparkles, color:'#6A4CF2', prompt:'Help organize my mail inbox.' },
  { label:'Plan my day', icon:CalendarCheck, color:'#D97706', prompt:'Plan my day from my tasks and calendar.' },
  { label:'Analyze data', icon:ChartColumn, color:'#14966C', prompt:'Help analyze my workspace data.' },
] as const
function read(): boolean[] { try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (Array.isArray(v) && v.length === MOBILE_ACTIONS.length && v.every(x=>typeof x === 'boolean')) return v } catch { /* Use defaults without overwriting unreadable storage. */ } return [true,true,true,true,false] }
let actions = read()
const listeners = new Set<() => void>()
export function setMobileAction(index:number, enabled:boolean) { const next = actions.map((v,i)=>i===index ? enabled : v); try { localStorage.setItem(KEY,JSON.stringify(next)) } catch { return false } actions=next; listeners.forEach(fn=>fn()); return true }
export function useMobileActions() { return useSyncExternalStore(listener=>{listeners.add(listener); return ()=>listeners.delete(listener)},()=>actions) }
