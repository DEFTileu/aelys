import { useEffect, useState, type CSSProperties } from 'react'
import { getSharedApiClient } from '../lib/api'

const HIT_TTL = 6 * 3600_000
const MISS_TTL = 3600_000
// One picture per chat for the whole session; the server also keeps it in memory for a few hours.
const cache = new Map<number, { url?: string; until: number }>()
const pending = new Map<number, Promise<string | undefined>>()

function avatarUrl(chatId: number): Promise<string | undefined> {
  const hit = cache.get(chatId)
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.url)
  const running = pending.get(chatId)
  if (running) return running
  const job = Promise.resolve().then(() => getSharedApiClient().telegramChatAvatar(chatId)).then(
    (blob) => {
      const url = URL.createObjectURL(blob)
      if (hit?.url) URL.revokeObjectURL(hit.url)
      cache.set(chatId, { url, until: Date.now() + HIT_TTL })
      return url
    },
    () => { cache.set(chatId, { until: Date.now() + MISS_TTL }); return undefined },
  ).finally(() => { pending.delete(chatId) })
  pending.set(chatId, job)
  return job
}

/** Telegram profile picture with the initial as fallback while loading or when there is none. */
export function ChatAvatar({ chatId, initial, className, style }: { chatId: number; initial: string; className: string; style?: CSSProperties }) {
  const [url, setUrl] = useState<string | undefined>(() => cache.get(chatId)?.url)
  useEffect(() => {
    let active = true
    void avatarUrl(chatId).then((value) => { if (active) setUrl(value) })
    return () => { active = false }
  }, [chatId])
  return <span className={className} style={style}>{url ? <img src={url} alt="" style={{ width: '100%', height: '100%', borderRadius: 'inherit', objectFit: 'cover', display: 'block' }} /> : initial}</span>
}
