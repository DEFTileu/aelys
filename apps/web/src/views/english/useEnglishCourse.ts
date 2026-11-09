import { useCallback, useEffect, useRef, useState } from 'react'
import type { EnglishBlockKey, EnglishCourse, EnglishLesson, EnglishProfile } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'
import { localDay, toNotice, type Notice } from './useEnglish'

export type CourseHook = ReturnType<typeof useEnglishCourse>

/** Course + today's lesson. Block components call the client themselves through `run`, then `refresh`. */
export function useEnglishCourse(apiStatus: ApiStatus) {
  const [day] = useState(localDay)
  const [course, setCourse] = useState<EnglishCourse | null>(null)
  const [lesson, setLesson] = useState<EnglishLesson | null>(null)
  const [status, setStatus] = useState<ApiStatus>('loading')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const load = useCallback(async (forceRefresh = true) => {
    try {
      const client = getSharedApiClient()
      const next = await client.englishCourse(day, { forceRefresh })
      setCourse(next); setStatus('ready')
      // The lesson already exists when the course knows its id, so this call costs no AI run.
      if (next.today.id) await client.englishLessonToday(day).then(setLesson, () => undefined)
    } catch (error) { setNotice(toNotice(error)); setStatus(navigator.onLine ? 'error' : 'offline') }
  }, [day])
  useEffect(() => { void load(false) }, [load, apiStatus])

  /** Serialises mutations and turns failures into the visible notice. Returns false on failure. */
  const run = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    if (busyRef.current) return false
    busyRef.current = true; setBusy(true); setNotice(null)
    try { await action(); return true } catch (error) { setNotice(toNotice(error)); return false } finally { busyRef.current = false; setBusy(false) }
  }, [])

  /** Re-reads lesson and course after a block changed server state. */
  const refresh = useCallback(async () => {
    const client = getSharedApiClient()
    await Promise.all([
      client.englishLessonToday(day).then(setLesson, () => undefined),
      client.englishCourse(day, { forceRefresh: true }).then(setCourse, () => undefined),
    ])
  }, [day])

  const startLesson = () => run(async () => { setLesson(await getSharedApiClient().englishLessonToday(day)); await getSharedApiClient().englishCourse(day, { forceRefresh: true }).then(setCourse, () => undefined) })
  const markDone = (key: EnglishBlockKey) => run(async () => { if (lesson) setLesson(await getSharedApiClient().englishBlockDone(lesson.id, key)); await getSharedApiClient().englishCourse(day, { forceRefresh: true }).then(setCourse, () => undefined) })
  const saveProfile = (profile: Omit<EnglishProfile, 'course_started_on'>) => run(async () => {
    const saved = await getSharedApiClient().englishSaveProfile(profile)
    setCourse((prev) => prev && { ...prev, profile: saved })
    await getSharedApiClient().englishCourse(day, { forceRefresh: true }).then(setCourse, () => undefined)
  })
  const writeBlocked = apiStatus !== 'ready'
  return { day, course, lesson, status, notice, setNotice, busy, run, load, refresh, startLesson, markDone, saveProfile, writeBlocked }
}
