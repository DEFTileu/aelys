import { useEffect, useState } from 'react'
import { useOwner } from '../../lib/owner'
import { Bell, Calendar, CloudSun, Info, Mail, Paintbrush, Send, Shield, Smartphone, Sparkles, User, Wifi, type AelysIconComponent } from '../../icons'
import type { ApiStatus } from '../../types'

export type PanelId = 'profile' | 'notifications' | 'appearance' | 'weather' | 'calendar' | 'ai' | 'memory' | 'telegram' | 'accounts' | 'connection' | 'devices' | 'security' | 'about'
export type Section = { id: PanelId; title: string; desc: string; icon: AelysIconComponent; tone: string }

// Groups, titles, descriptions and tile colors are the design's. Memory and Google Calendar are Aelys sections the design lacks.
export const GROUPS: readonly { title: string; items: readonly Section[] }[] = [
  { title: 'Account', items: [
    { id: 'profile', title: 'Profile', desc: 'Name and how Aelys addresses you', icon: User, tone: 'profile' },
    { id: 'notifications', title: 'Notifications', desc: 'What can interrupt you, and when', icon: Bell, tone: 'alert' },
  ] },
  { title: 'General', items: [
    { id: 'appearance', title: 'Appearance', desc: 'Theme, accent and motion', icon: Paintbrush, tone: 'violet' },
    { id: 'weather', title: 'Weather & location', desc: 'City and units', icon: CloudSun, tone: 'blue' },
    { id: 'calendar', title: 'Google Calendar', desc: 'Read-only event import', icon: Calendar, tone: 'blue' },
  ] },
  { title: 'Assistant', items: [
    { id: 'ai', title: 'AI & models', desc: 'Providers and the models Aelys uses', icon: Sparkles, tone: 'violet' },
    { id: 'memory', title: 'Memory', desc: 'Saved facts and preferences', icon: Sparkles, tone: 'violet' },
    { id: 'telegram', title: 'Telegram', desc: 'Connection, auto-reply and instructions', icon: Send, tone: 'blue' },
  ] },
  { title: 'System', items: [
    { id: 'accounts', title: 'Connected accounts', desc: 'Gmail and Telegram', icon: Mail, tone: 'blue' },
    { id: 'connection', title: 'Connection', desc: 'Backend address and your session', icon: Wifi, tone: 'green' },
    { id: 'devices', title: 'Devices', desc: 'Companions paired with Aelys', icon: Smartphone, tone: 'violet' },
    { id: 'security', title: 'Security', desc: 'Touch ID and session unlock', icon: Shield, tone: 'coral' },
    { id: 'about', title: 'Data & about', desc: 'Version and sync', icon: Info, tone: 'gray' },
  ] },
]
export const ALL = GROUPS.flatMap((group) => group.items)

export function useSettings(apiStatus: ApiStatus) {
  const owner = useOwner(apiStatus)
  const [query, setQuery] = useState('')
  const sectionFromUrl = () => ALL.find((item) => item.id === new URLSearchParams(window.location.search).get('section'))?.id
  const initial = sectionFromUrl()
  const [panel, setPanel] = useState<PanelId>(initial ?? 'profile')
  // On a phone the list and the panel take turns, as in the design's compact layout. The open panel lives in the URL,
  // so the shell's back button can step from a panel to the list.
  const [open, setOpen] = useState(!!initial)
  useEffect(() => {
    const onPopState = () => { const id = sectionFromUrl(); if (id) setPanel(id); setOpen(!!id) }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const q = query.trim().toLocaleLowerCase()
  const groups = GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => !q || `${item.title} ${item.desc}`.toLocaleLowerCase().includes(q)) })).filter((group) => group.items.length)
  const go = (id: PanelId) => { setPanel(id); setOpen(true); window.history.pushState({}, '', `?section=${id}`); window.dispatchEvent(new PopStateEvent('popstate')) }
  const current = ALL.find((item) => item.id === panel)!

  return { owner, open, query, setQuery, groups, panel, go, current }
}
