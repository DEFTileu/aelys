import { useEffect, useState } from 'react'
import { getSharedApiClient } from './api'
import { usePrefs } from './prefs'
import type { ApiStatus } from '../types'

export type Owner = { name: string | null; email: string | null }
const NONE: Owner = { name: null, email: null }

/** "tile.uzhan@example.com" -> "Tile Uzhan". Anything that is not plainly a name (digits, ids) yields null. */
export function displayNameFromEmail(email: string | null | undefined): string | null {
  const local = email?.split('@')[0]?.trim()
  if (!local) return null
  const words = local.split(/[._-]+/).filter(Boolean)
  if (!words.length || !words.every((word) => /^\p{L}[\p{L}\p{M}']*$/u.test(word))) return null
  return words.map((word) => word[0]!.toLocaleUpperCase() + word.slice(1)).join(' ')
}

/** The signed-in owner from GET /api/v1/me. The API has no display name yet, so the name is derived from the email unless the owner set one in Settings. */
export function useOwner(apiStatus: ApiStatus): Owner {
  const [owner, setOwner] = useState<Owner>(NONE)
  const { name } = usePrefs()
  useEffect(() => {
    if (apiStatus !== 'ready') return
    let active = true
    Promise.resolve().then(() => getSharedApiClient().me()).then((me) => {
      if (active) setOwner({ name: displayNameFromEmail(me.email), email: me.email })
    }).catch(() => undefined)
    return () => { active = false }
  }, [apiStatus])
  // A name chosen in Settings > Profile replaces the one derived from the email.
  return name.trim() ? { ...owner, name: name.trim() } : owner
}
