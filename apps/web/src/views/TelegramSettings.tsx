import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError as SharedApiError, type AIProvider, type TelegramBusinessMessage, type TelegramSettingsPatch, type TelegramStatus } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'
import './connected.css'

// API messages and provider text can contain secrets; only display a constrained error code.
function errorNotice(error: unknown): string {
  const messages: Record<string, string> = {
    TELEGRAM_PROVIDER_REQUIRED: 'Выберите AI-провайдер с сохранённым API-ключом для автоматических ответов.',
    TELEGRAM_BINDING_REQUIRED: 'Привяжите владельца и подключите бота к Telegram Business.',
    TELEGRAM_INSTRUCTIONS_REQUIRED: 'Введите инструкции для помощника перед включением автоматических ответов.',
    TELEGRAM_WEBHOOK_CONFLICT: 'У бота настроен webhook. Отключите его в Telegram перед подключением.',
    TELEGRAM_TOKEN_INVALID: 'Токен бота недействителен. Проверьте токен в BotFather.',
    TELEGRAM_VERSION_CONFLICT: 'Настройки изменились. Обновите данные и повторите действие.',
    TELEGRAM_DELIVERY_UNKNOWN: 'Результат отправки неизвестен. Проверьте чат Telegram перед повторной отправкой.',
    PROVIDER_REQUIRED: 'Выберите AI-провайдер с сохранённым API-ключом для автоматических ответов.',
    BINDING_REQUIRED: 'Привяжите владельца и подключите бота к Telegram Business.',
    INSTRUCTIONS_REQUIRED: 'Введите инструкции для помощника перед включением автоматических ответов.',
    WEBHOOK_CONFLICT: 'У бота настроен webhook. Отключите его в Telegram перед подключением.',
    TOKEN_INVALID: 'Токен бота недействителен. Проверьте токен в BotFather.',
    VERSION_CONFLICT: 'Настройки изменились. Обновите данные и повторите действие.',
    DELIVERY_UNKNOWN: 'Результат отправки неизвестен. Проверьте чат Telegram перед повторной отправкой.',
  }
  if (error instanceof SharedApiError && Object.hasOwn(messages, error.code)) return messages[error.code]
  return 'Не удалось выполнить запрос. Проверьте подключение и повторите попытку.'
}

export function TelegramSettings() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [providers, setProviders] = useState<readonly AIProvider[]>([])
  const [messages, setMessages] = useState<readonly TelegramBusinessMessage[]>([])
  const [token, setToken] = useState('')
  const [binding, setBinding] = useState<{ url: string; expires_at: string } | null>(null)
  const [instructions, setInstructions] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const sendKeys = useRef<Record<string, { signature: string; key: string }>>({})

  const applyStatus = (value: TelegramStatus) => {
    setStatus(value); setInstructions(value.instructions); setProvider(value.provider_id ?? ''); setModel(value.model ?? '')
  }
  const load = useCallback(async () => {
    const client = getSharedApiClient()
    try {
      const [next, items, ai] = await Promise.all([client.telegramStatus(), client.telegramMessages(), client.aiProviders()])
      applyStatus(next); setMessages(items); setProviders(ai)
    } catch (error) { setNotice(errorNotice(error)) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!status?.configured) return
    let active = true
    const refresh = async () => {
      try {
        const client = getSharedApiClient()
        const [next, items] = await Promise.all([client.telegramStatus(), client.telegramMessages()])
        if (active) { setStatus(next); setMessages(items) }
      } catch (error) { if (active) setNotice(errorNotice(error)) }
    }
    const timer = window.setInterval(() => { void refresh() }, 10_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [status?.configured])

  const action = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setNotice('')
    try { await work() } catch (error) { setNotice(errorNotice(error)) } finally { setBusy(false) }
  }
  const update = async (patch: Omit<TelegramSettingsPatch, 'version'>) => {
    if (status?.version == null) return
    applyStatus(await getSharedApiClient().updateTelegramSettings({ version: status.version, ...patch }))
  }
  const connect = (event: FormEvent) => {
    event.preventDefault()
    void action(async () => { const next = await getSharedApiClient().connectTelegram({ bot_token: token }); setToken(''); setBinding(null); applyStatus(next) })
  }
  const replaceMessage = (item: TelegramBusinessMessage) => {
    setMessages((current) => current.map((message) => message.id === item.id ? item : message))
    setDrafts((current) => ({ ...current, [item.id]: item.draft_text ?? '' }))
  }
  const send = (message: TelegramBusinessMessage) => {
    const text = drafts[message.id] ?? message.draft_text ?? ''
    if (!text.trim()) return
    const signature = JSON.stringify([message.version, text])
    let entry = sendKeys.current[message.id]
    if (!entry || entry.signature !== signature) {
      entry = { signature, key: globalThis.crypto.randomUUID() }; sendKeys.current[message.id] = entry
    }
    void action(async () => {
      replaceMessage(await getSharedApiClient().sendTelegramMessage(message.id, { version: message.version, text }, { idempotencyKey: entry.key }))
      delete sendKeys.current[message.id]; setNotice('Сообщение отправлено.')
    })
  }
  const connected = status?.connections.some((connection) => connection.enabled) ?? false

  return <div className="page page--settings"><div className="settings-grid">
    <section className="settings-card">
      <div className="settings-card__header"><div><h2>Telegram Business</h2><p>Ассистент читает входящие и отвечает от вашего имени в разрешённых чатах.</p></div></div>
      {notice && <p role="status">{notice}</p>}
      <ol>
        <li>Создайте бота через <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">BotFather</a> и введите его токен.</li>
        <li>В BotFather включите «Режим секретаря» (Secretary Mode или Business Mode). <a href="https://core.telegram.org/bots/features#business-bots" target="_blank" rel="noreferrer">Инструкция Telegram</a></li>
        <li>Создайте одноразовую ссылку и откройте её в Telegram от имени владельца.</li>
        <li>В настройках Telegram Business подключите бота в разделе чат-ботов и разрешите нужные чаты. <a href="https://core.telegram.org/api/business" target="_blank" rel="noreferrer">Telegram Business</a></li>
      </ol>
      <p className="connected-help">Локальный опрос Telegram требует запущенного backend Aelys; публичный URL не нужен.</p>
      <p className="connected-help">Сообщения хранятся в зашифрованном виде до 7 дней. При отключении бота сообщения удаляются.</p>
      <form className="settings-form" onSubmit={connect}>
        <label>Токен бота<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required /></label>
        <button className="button button--primary" type="submit" disabled={busy || !token.trim()}>Подключить бота</button>
      </form>
      {status && <>
        <p><strong>{!status.configured ? 'Бот не настроен' : connected ? 'Telegram Business подключён' : 'Бот настроен; подключение Telegram Business ожидается'}</strong>{status.bot_username ? ` · @${status.bot_username}` : ''}</p>
        {status.configured && <>
          <p>Режим Business: {status.business_capable ? 'доступен' : 'не включён'} · Владелец: {status.owner_telegram_id ?? 'не привязан'} · {status.enabled ? 'активно' : 'на паузе'}</p>
          <div className="provider-actions">
            <button className="button button--quiet" disabled={busy} onClick={() => void action(async () => { setBinding(await getSharedApiClient().telegramBinding()) })}>Создать ссылку владельца</button>
            <button className="button button--quiet" disabled={busy || status.version == null} onClick={() => void action(() => update({ enabled: !status.enabled }))}>{status.enabled ? 'Пауза' : 'Возобновить'}</button>
            <button className="button button--quiet" disabled={busy} onClick={() => void action(async () => { await getSharedApiClient().disconnectTelegram(); setBinding(null); setMessages([]); await load() })}>Отключить бота</button>
          </div>
          {binding && <p><a href={binding.url} target="_blank" rel="noreferrer">Открыть одноразовую ссылку владельца</a> · действует до {binding.expires_at}</p>}
          <h3>Подключения Business</h3>
          {status.connections.length === 0 ? <p>Подключений пока нет.</p> : status.connections.map((connection) => <p key={connection.id}>ID {connection.telegram_user_id} · {connection.enabled ? 'активно' : 'отключено'} · {connection.can_reply ? 'ответы разрешены' : 'ответы запрещены'}</p>)}
          {status.last_polled_at && <p>Последняя проверка: {status.last_polled_at}</p>}
          {status.last_error_code && <p>При проверке произошла ошибка. Обновите состояние подключения.</p>}
        </>}
      </>}
      <div className="provider-actions"><button className="button button--quiet" disabled={busy} onClick={() => void action(load)}>Обновить</button>
        <button className="button button--quiet" disabled={busy || !status?.configured} onClick={() => void action(async () => { const result = await getSharedApiClient().syncTelegram(); await load(); setNotice(`Проверка завершена. Обработано: ${result.processed}.`) })}>Проверить подключение</button></div>
    </section>
    {status?.configured && <section className="settings-card">
      <h2>Читать и отвечать автоматически</h2>
      <p>Когда режим включён, бот читает входящие сообщения в выбранных чатах Telegram Business и автоматически отвечает от вашего имени. Для этого подключите бота к нужным чатам и разрешите ответы в Telegram.</p>
      <p>Для автоматических ответов выберите внешний AI-провайдер с сохранённым API-ключом, укажите модель и задайте инструкции для помощника. Сообщения передаются выбранному AI-провайдеру для подготовки ответа.</p>
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void action(() => update({ instructions, provider_id: provider || null, model: model.trim() || null })) }}>
        <label><input type="checkbox" checked={status.auto_reply} disabled={busy || status.version == null} onChange={(event) => { const enabled = event.target.checked; void action(() => update(enabled ? { auto_reply: true, provider_id: provider || null, model: model.trim() || null, instructions } : { auto_reply: false })) }} /> Читать и отвечать автоматически</label>
        <label>Инструкции для помощника<textarea maxLength={10000} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
        <label>AI-провайдер<select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="">Не выбран</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.kind} · {item.id}</option>)}</select></label>
        <label>Модель<input maxLength={200} value={model} onChange={(event) => setModel(event.target.value)} /></label>
        <button className="button button--primary" disabled={busy || status.version == null} type="submit">Сохранить настройки</button>
      </form>
    </section>}
    {status?.configured && <section className="settings-card">
      <h2>Сообщения и ручные ответы</h2>
      <p>Если автоматический режим выключен, можно подготовить черновик, проверить его и отправить ответ вручную.</p>
      {messages.length === 0 && <p>Сообщений пока нет.</p>}
      {messages.map((message) => <article className="provider-row" key={message.id}>
        <strong>{message.chat_title} · {message.direction}</strong><p>{message.sent_at}{message.deleted_at ? ' · удалено' : ''}</p>
        <div className="mail-body">{message.text}</div>
        <p>Черновик: {message.draft_status}{message.draft_error_code ? ' · ошибка создания' : ''}</p>
        <div className="settings-form"><label>Текст ответа<textarea value={drafts[message.id] ?? message.draft_text ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [message.id]: event.target.value }))} /></label>
          <div className="provider-actions"><button className="button button--quiet" disabled={busy || !!message.deleted_at} onClick={() => void action(async () => replaceMessage(await getSharedApiClient().draftTelegramMessage(message.id, { version: message.version })))}>Создать черновик</button>
            <button className="button button--primary" disabled={busy || !!message.deleted_at || !(drafts[message.id] ?? message.draft_text ?? '').trim()} onClick={() => send(message)}>Отправить ответ</button></div></div>
      </article>)}
    </section>}
  </div></div>
}
