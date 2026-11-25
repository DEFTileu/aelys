import { useCallback, useEffect, useRef, useState } from 'react'
import type { SystemEvent, SystemStatus } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'
import './status-panel.css'

const REFRESH_MS = 30_000
type Check<T> = { value: T; error: '' } | { value: null; error: string }

function errorKind(error: unknown): 'unsupported' | 'unavailable' {
  const value = error as { status?: number; code?: string }
  return value?.status === 404 || value?.status === 501 || value?.code === 'NOT_SUPPORTED' ? 'unsupported' : 'unavailable'
}

function formatUptime(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days) return `${days} д ${hours} ч`
  if (hours) return `${hours} ч ${minutes} мин`
  return `${minutes} мин`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function LiveRow({ label, value, healthy }: { label: string; value: string; healthy?: boolean }) {
  return <div className="st-row st-row--56"><span className="st-grow st-label">{label}</span><span className="sys-value" data-healthy={healthy}>{value}</span></div>
}

export function StatusPanel({ apiStatus }: { apiStatus: ApiStatus }) {
  const [server, setServer] = useState<SystemStatus | null>(null)
  const [events, setEvents] = useState<readonly SystemEvent[] | null>(null)
  const [sync, setSync] = useState<Check<Awaited<ReturnType<ReturnType<typeof getSharedApiClient>['syncStatus']>>>>({ value: null, error: '' })
  const [devices, setDevices] = useState<Check<number>>({ value: null, error: '' })
  const [statusError, setStatusError] = useState(false)
  const [eventsError, setEventsError] = useState(false)
  const [filter, setFilter] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const requestId = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    // Keep the shell's shared connectivity indicator in step with the live server check.
    window.dispatchEvent(new Event('aelys:check-api'))
    if (inFlight.current) return
    inFlight.current = true
    const id = ++requestId.current
    const abort = new AbortController()
    controller.current?.abort()
    controller.current = abort
    setRefreshing(true)
    const client = getSharedApiClient()
    const opts = { signal: abort.signal, forceRefresh: true, allowCacheFallback: false }
    const [systemResult, eventsResult, syncResult, devicesResult] = await Promise.allSettled([
      client.getSystemStatus(opts), client.getSystemEvents(50, opts), client.syncStatus(opts), client.devices(opts),
    ])
    if (alive.current && id === requestId.current && !abort.signal.aborted) {
      if (systemResult.status === 'fulfilled') { setServer(systemResult.value); setStatusError(false) }
      else { setServer(null); setStatusError(true) }
      if (eventsResult.status === 'fulfilled') { setEvents(eventsResult.value.items); setEventsError(false) }
      else { setEvents(null); setEventsError(true) }
      if (syncResult.status === 'fulfilled') setSync({ value: syncResult.value, error: '' })
      else setSync({ value: null, error: errorKind(syncResult.reason) })
      if (devicesResult.status === 'fulfilled') setDevices({ value: devicesResult.value.filter(device => !device.revoked_at).length, error: '' })
      else setDevices({ value: null, error: errorKind(devicesResult.reason) })
    }
    if (alive.current && id === requestId.current) setRefreshing(false)
    if (id === requestId.current) inFlight.current = false
  }, [])

  useEffect(() => {
    alive.current = true
    if (document.visibilityState === 'visible') void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && !inFlight.current) void refresh() }, REFRESH_MS)
    const onVisibility = () => { if (document.visibilityState === 'visible' && !inFlight.current) void refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive.current = false
      requestId.current++
      inFlight.current = false
      controller.current?.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  useEffect(() => { if (apiStatus === 'offline') { setServer(null); setStatusError(true) } }, [apiStatus])

  const filtered = (events ?? []).filter(event => `${event.action} ${event.decision} ${event.outcome} ${event.created_at}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const connection = apiStatus === 'ready' ? 'Подключено' : apiStatus === 'offline' ? 'Нет соединения' : apiStatus === 'loading' ? 'Проверка…' : apiStatus === 'empty' ? 'Не настроено' : 'Недоступно'
  const cursorConfirmed = !!sync.value && sync.value.latest_cursor === sync.value.acknowledged_cursor

  return <div className="sys-panel">
    <div className="sys-toolbar">
      <p className="st-hint">Данные сервера и журнал запрашиваются напрямую. Локальный кеш здесь не используется.</p>
      <button type="button" className="st-btn st-btn--ghost" aria-label="Обновить статус" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Обновление…' : 'Обновить'}</button>
    </div>

    <section className="st-group" aria-labelledby="sys-health-title">
      <h3 className="st-group-title" id="sys-health-title">Состояние системы</h3>
      <div className="st-card st-list">
        <LiveRow label="Последняя фоновая проверка API" value={connection} healthy={apiStatus === 'ready'} />
        {apiStatus === 'offline' || !server ? <div className="st-error" role="alert">{statusError ? 'Не удалось получить живой статус сервера.' : 'Загружаем живой статус сервера…'}</div> : <>
          <LiveRow label="Сервер / API" value={server.api === 'ok' ? 'Работает' : 'Недоступен'} healthy={server.api === 'ok'} />
          <LiveRow label="База данных" value={server.database === 'ok' ? 'Работает' : 'Недоступна'} healthy={server.database === 'ok'} />
          <LiveRow label="Последняя проверка" value={formatDate(server.checked_at)} />
          <LiveRow label="Время работы сервера" value={formatUptime(server.uptime_seconds)} />
        </>}
      </div>
    </section>

    <section className="st-group" aria-labelledby="sys-device-title">
      <h3 className="st-group-title" id="sys-device-title">Синхронизация и устройства</h3>
      <div className="st-card st-list">
        <div className="st-row"><div className="st-grow"><div className="st-label">Состояние синхронизации</div><div className="st-hint">Проверяется подтверждение серверных изменений. Локальная очередь здесь не проверяется.</div></div>
          <span className="sys-value">{sync.value ? cursorConfirmed ? 'Серверные изменения подтверждены' : 'Есть неподтверждённые серверные изменения' : sync.error === 'unsupported' ? 'Синхронизация не поддерживается' : sync.error ? 'Статус синхронизации недоступен' : 'Загрузка…'}</span>
        </div>
        <LiveRow label="Зарегистрированные устройства" value={devices.value === null ? devices.error === 'unsupported' ? 'Не поддерживается' : devices.error ? 'Не удалось загрузить устройства' : 'Загрузка…' : String(devices.value)} />
      </div>
    </section>

    <section className="st-group" aria-labelledby="sys-events-title">
      <h3 className="st-group-title" id="sys-events-title">События безопасности и доступа</h3>
      <div className="st-card">
        <div className="sys-events-toolbar">
          <input className="st-input" aria-label="Фильтр событий" placeholder="Фильтр событий" value={filter} onChange={event => setFilter(event.target.value)} />
        </div>
        {eventsError ? <div className="st-error" role="alert">Не удалось загрузить журнал событий.</div> : events === null ? <div className="st-msg">Загрузка событий…</div> : events.length === 0 ? <div className="st-msg">Событий пока нет.</div> : filtered.length === 0 ? <div className="st-msg">События не найдены.</div> : <div className="sys-events-scroll"><table className="sys-events"><thead><tr><th>Время</th><th>Действие</th><th>Решение</th><th>Результат</th></tr></thead><tbody>
          {filtered.map(event => <tr key={event.id}><td>{formatDate(event.created_at)}</td><td>{event.action}</td><td>{event.decision}</td><td>{event.outcome}</td></tr>)}
        </tbody></table></div>}
      </div>
    </section>
  </div>
}
