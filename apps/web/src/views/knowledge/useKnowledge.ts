import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteOut, ProjectResponse } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'

// All knowledge state and handlers; the desktop and mobile compositions only differ in markup.
export function useKnowledge(apiStatus: ApiStatus) {
  const [notes, setNotes] = useState<readonly NoteOut[]>([])
  const [projects, setProjects] = useState<readonly ProjectResponse[]>([])
  const [status, setStatus] = useState<ApiStatus>(apiStatus === 'ready' ? 'loading' : apiStatus)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const requestSequence = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestSequence.current
    if (apiStatus !== 'ready') { setStatus(apiStatus); return }
    setStatus('loading')
    try {
      const result = await getSharedApiClient().notes()
      if (request !== requestSequence.current) return
      setNotes(result)
      void Promise.resolve().then(() => getSharedApiClient().projects()).then((value) => { if (request === requestSequence.current) setProjects(value) }).catch(() => { if (request === requestSequence.current) setProjects([]) })
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
    return notes.filter((note) => !needle || `${note.title} ${note.markdown_body}`.toLowerCase().includes(needle))
  }, [notes, query])
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
  const edit = (id: string) => {
    window.history.pushState({}, '', `/notes?note=${encodeURIComponent(id)}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  return { apiStatus, status, notes, query, setQuery, selectedId, setSelectedId, reading, setReading, load, visible, groups, selected, selectedGroup, edit }
}

export type KnowledgeHook = ReturnType<typeof useKnowledge>
