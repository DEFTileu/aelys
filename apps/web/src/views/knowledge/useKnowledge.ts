import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteOut, ProjectResponse } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'

export const updatedLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export function useKnowledge(apiStatus: ApiStatus) {
  const [notes, setNotes] = useState<readonly NoteOut[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [query, setQuery] = useState('')
  const [managing, setManaging] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [question, setQuestion] = useState('')
  const [askScope, setAskScope] = useState('document')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('note'))
  const [reading, setReading] = useState(false)
  const requestSequence = useRef(0)

  const load = useCallback(async (forceRefresh = true) => {
    const request = ++requestSequence.current
    if (apiStatus !== 'ready') { setStatus(apiStatus); return }
    setStatus('loading')
    try {
      const result = await getSharedApiClient().notes({ forceRefresh })
      if (request !== requestSequence.current) return
      setNotes(result)
      void Promise.resolve().then(() => getSharedApiClient().projects({ forceRefresh })).then((value) => { if (request === requestSequence.current) setProjects(value) }).catch(() => { if (request === requestSequence.current) setProjects([]) })
      setSelectedId((current) => result.some((note) => note.id === current) ? current : result[0]?.id ?? null)
      setStatus('ready')
    } catch {
      if (request !== requestSequence.current) return
      setStatus(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
    }
  }, [apiStatus])
  useEffect(() => { void load(); return () => { requestSequence.current += 1 } }, [load])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return notes.filter((note) => (managing || note.knowledge_enabled) && (!projectId || note.project_id === projectId) && (!needle || `${note.title} ${note.markdown_body}`.toLowerCase().includes(needle)))
  }, [notes, query, managing, projectId])
  const groups = useMemo(() => {
    const parents = new Map(notes.map((note) => [note.id, note.title]))
    const projectNames = new Map(projects.map((project) => [project.id, project.name]))
    const result = new Map<string, { label: string; items: NoteOut[] }>()
    for (const note of visible) {
      const parent = note.parent_id && parents.get(note.parent_id)
      const project = note.project_id && projectNames.get(note.project_id)
      const key = parent ? `parent:${note.parent_id}` : project ? `project:${note.project_id}` : 'documents'
      const group = result.get(key) ?? { label: parent || project || 'Documents', items: [] }
      group.items.push(note); result.set(key, group)
    }
    return [...result.entries()]
  }, [notes, visible, projects])
  const selected = visible.find((note) => note.id === selectedId) ?? visible[0]
  const selectedGroup = groups.find(([, group]) => group.items.some((note) => note.id === selected?.id))?.[0] ?? 'documents'
  const toggleSource = async (note: NoteOut) => {
    if (busy) return
    setBusy(true); setNotice('')
    try {
      const saved = await getSharedApiClient().updateNote(note.id, { title: note.title, markdown_body: note.markdown_body, project_id: note.project_id, parent_id: note.parent_id, folder: note.folder, tags: note.tags, knowledge_enabled: !note.knowledge_enabled }, { query: { version: note.version }, queueOnOffline: false })
      setNotes(current => current.map(item => item.id === saved.id ? saved : item))
      setNotice(saved.knowledge_enabled ? 'Source enabled. Questions may send excerpts to your selected AI provider.' : 'Source removed from future AI retrieval. Previous chat answers are retained.')
    } catch { setNotice('Could not update the source. Refresh before retrying; it may have changed elsewhere.') }
    finally { setBusy(false) }
  }
  const edit = (id: string) => {
    window.history.pushState({}, '', `/notes?note=${encodeURIComponent(id)}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  return { reading, managing, setManaging, projectId, setProjectId, projects, notice, status, notes, load, query, setQuery, groups, selected, setSelectedId, setReading, visible, selectedGroup, busy, toggleSource, edit, askScope, setAskScope, question, setQuestion }
}
