import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError as SharedApiError, type AIProvider, type TelegramBusinessMessage, type TelegramSettingsPatch, type TelegramStatus } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'
import { Checkbox, SelectField } from '../components/controls/SelectionControls'
import './connected.css'

// API messages and provider text can contain secrets; only display a constrained error code.
function errorNotice(error: unknown): string {
  const messages: Record<string, string> = {
    TELEGRAM_MESSAGE_UNAVAILABLE: 'Replies are available only for incoming messages. Select a message from the other person; the connection must be active.',
    TELEGRAM_REPLY_DENIED: 'The bot cannot reply in this chat. Check the connection and reply permissions in Telegram Business settings.',
    TELEGRAM_REPLY_WINDOW_EXPIRED: 'The Telegram reply window (24 hours) has expired. Wait for a new message from the other person.',
    TELEGRAM_PAUSED: 'The connection is paused. Resume it before drafting or sending a reply.',
    TELEGRAM_RATE_LIMITED: 'Telegram is limiting requests. Wait before trying again.',
    ALREADY_SENT: 'A reply has already been sent to this message. Select a new incoming message.',
    TELEGRAM_PROVIDER_REQUIRED: 'Choose an AI provider with a saved API key for automatic replies.',
    TELEGRAM_BINDING_REQUIRED: 'Link the owner and connect the bot to Telegram Business.',
    TELEGRAM_INSTRUCTIONS_REQUIRED: 'Enter assistant instructions before turning on automatic replies.',
    TELEGRAM_WEBHOOK_CONFLICT: 'The bot has a webhook configured. Remove it in Telegram before connecting.',
    TELEGRAM_TOKEN_INVALID: 'The bot token is invalid. Check the token in BotFather.',
    TELEGRAM_VERSION_CONFLICT: 'Settings changed. Refresh and try again.',
    TELEGRAM_DELIVERY_UNKNOWN: 'The send result is unknown. Check the Telegram chat before sending again.',
    PROVIDER_REQUIRED: 'Choose an AI provider with a saved API key for automatic replies.',
    BINDING_REQUIRED: 'Link the owner and connect the bot to Telegram Business.',
    INSTRUCTIONS_REQUIRED: 'Enter assistant instructions before turning on automatic replies.',
    WEBHOOK_CONFLICT: 'The bot has a webhook configured. Remove it in Telegram before connecting.',
    TOKEN_INVALID: 'The bot token is invalid. Check the token in BotFather.',
    VERSION_CONFLICT: 'Settings changed. Refresh and try again.',
    DELIVERY_UNKNOWN: 'The send result is unknown. Check the Telegram chat before sending again.',
  }
  if (error instanceof SharedApiError && Object.hasOwn(messages, error.code)) return messages[error.code]
  return 'The request failed. Check your connection and try again.'
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
  const [timezone, setTimezone] = useState('UTC')
  const [digestTime, setDigestTime] = useState('')
  const [replyDelay, setReplyDelay] = useState(90)
  const [deadlineReminders, setDeadlineReminders] = useState(false)
  const [quietStart, setQuietStart] = useState('')
  const [quietEnd, setQuietEnd] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const sendKeys = useRef<Record<string, { signature: string; key: string }>>({})

  const applyStatus = (value: TelegramStatus) => {
    setStatus(value); setInstructions(value.instructions); setProvider(value.provider_id ?? ''); setModel(value.model ?? ''); setTimezone(value.timezone); setDigestTime(value.digest_time ?? ''); setReplyDelay(value.reply_delay_seconds)
    setDeadlineReminders(value.deadline_reminders ?? false); setQuietStart(value.quiet_start ?? ''); setQuietEnd(value.quiet_end ?? '')
  }
  const load = useCallback(async () => {
    const client = getSharedApiClient()
    try {
      const [next, items, ai] = await Promise.all([client.telegramStatus(), client.telegramMessages(), client.aiProviders()])
      applyStatus(next); setMessages(items); setProviders(ai.filter(item => item.kind !== 'transcription'))
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
    if (message.direction !== 'inbound' || message.deleted_at) return
    const text = drafts[message.id] ?? message.draft_text ?? ''
    if (!text.trim()) return
    const signature = JSON.stringify([message.version, text])
    let entry = sendKeys.current[message.id]
    if (!entry || entry.signature !== signature) {
      entry = { signature, key: globalThis.crypto.randomUUID() }; sendKeys.current[message.id] = entry
    }
    void action(async () => {
      replaceMessage(await getSharedApiClient().sendTelegramMessage(message.id, { version: message.version, text }, { idempotencyKey: entry.key }))
      delete sendKeys.current[message.id]; setNotice('Message sent.')
    })
  }
  const connected = status?.connections.some((connection) => connection.enabled) ?? false

  return <div className="page page--settings actual-settings-forms"><div className="settings-grid">
    <section className="settings-card">
      <div className="settings-card__header"><div><h2>Telegram Business</h2><p>The assistant reads incoming messages and replies on your behalf in allowed chats.</p></div></div>
      {notice && <p role="status">{notice}</p>}
      <details className="actual-settings-disclosure"><summary>How to connect the bot</summary><ol>
        <li>Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">BotFather</a> and enter its token.</li>
        <li>In BotFather, turn on Secretary Mode (Business Mode). <a href="https://core.telegram.org/bots/features#business-bots" target="_blank" rel="noreferrer">Telegram guide</a></li>
        <li>Create a one-time link and open it in Telegram as the owner.</li>
        <li>In Telegram Business settings, add the bot under chatbots and allow the chats you need. <a href="https://core.telegram.org/api/business" target="_blank" rel="noreferrer">Telegram Business</a></li>
      </ol>
      <p className="connected-help">Local Telegram polling needs the Aelys backend to be running; no public URL is required.</p>
      <p className="connected-help">Messages are stored encrypted for up to 7 days. Disconnecting the bot deletes them.</p></details>
      <form className="settings-form" onSubmit={connect}>
        <label>Bot token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required /></label>
        <button className="button button--primary" type="submit" disabled={busy || !token.trim()}>Connect bot</button>
      </form>
      {status && <>
        <p><strong>{!status.configured ? 'Bot not set up' : connected ? 'Telegram Business connected' : 'Bot is set up; Telegram Business connection pending'}</strong>{status.bot_username ? ` · @${status.bot_username}` : ''}</p>
        {status.configured && <>
          <p>Business mode: {status.business_capable ? 'available' : 'not enabled'} · Owner: {status.owner_telegram_id ?? 'not linked'} · {status.enabled ? 'active' : 'paused'}</p>
          <div className="provider-actions">
            <button className="button button--quiet" disabled={busy} onClick={() => void action(async () => { setBinding(await getSharedApiClient().telegramBinding()) })}>Create owner link</button>
            <button className="button button--quiet" disabled={busy || status.version == null} onClick={() => void action(() => update({ enabled: !status.enabled }))}>{status.enabled ? 'Pause' : 'Resume'}</button>
            <button className="button button--quiet" disabled={busy} onClick={() => void action(async () => { await getSharedApiClient().disconnectTelegram(); setBinding(null); setMessages([]); await load() })}>Disconnect bot</button>
          </div>
          {binding && <p><a href={binding.url} target="_blank" rel="noreferrer">Open one-time owner link</a> · valid until {binding.expires_at}</p>}
          <details className="actual-settings-disclosure"><summary>Business connections</summary>
          {status.connections.length === 0 ? <p>No connections yet.</p> : status.connections.map((connection) => <p key={connection.id}>ID {connection.telegram_user_id} · {connection.enabled ? 'active' : 'disabled'} · {connection.can_reply ? 'replies allowed' : 'replies blocked'}</p>)}
          {status.last_polled_at && <p>Last check: {status.last_polled_at}</p>}
          {status.last_error_code && <p>The check failed. Refresh the connection status.</p>}</details>
        </>}
      </>}
      <div className="provider-actions"><button className="button button--quiet" disabled={busy} onClick={() => void action(load)}>Refresh</button>
        <button className="button button--quiet" disabled={busy || !status?.configured} onClick={() => void action(async () => { const result = await getSharedApiClient().syncTelegram(); await load(); setNotice(`Check complete. Processed: ${result.processed}.`) })}>Check connection</button></div>
    </section>
    {status?.configured && <section className="settings-card">
      <h2>Personal commands and digest</h2>
      <p>One Aelys bot: /task, /note, /today, /remind 18:00 text, /busy 18:00 text, /free, /help. Use a bot separate from MySDU.</p>
      <p>The digest uses no AI and is off by default. Leave the time empty to turn it off.</p>
      <p>Status: {status.status_text ?? 'not set'}{status.status_until ? ` · until ${status.status_until}` : ''}</p>
      <form className="settings-form" onSubmit={event => { event.preventDefault(); void action(() => update({ timezone, digest_time: digestTime || null, reply_delay_seconds: replyDelay, deadline_reminders: deadlineReminders, quiet_start: quietStart || null, quiet_end: quietEnd || null })) }}>
        <label>Time zone<input required maxLength={64} value={timezone} onChange={event => setTimezone(event.target.value)} /></label>
        <label>Digest time<input type="time" value={digestTime} onChange={event => setDigestTime(event.target.value)} /></label>
        <label>Reply delay (seconds)<input type="number" min={0} max={900} required value={replyDelay} onChange={event => setReplyDelay(Number(event.target.value))} /></label>
        <Checkbox label="Deadline reminders" checked={deadlineReminders} disabled={busy || status.version == null} onChange={setDeadlineReminders} />
        <p>Remind me in Telegram 5 hours and 10 minutes before an unfinished task is due.</p>
        <label>Quiet hours start<input type="time" required={!!quietEnd} disabled={busy || status.version == null} value={quietStart} onChange={event => setQuietStart(event.target.value)} aria-describedby="telegram-quiet-hours-help" /></label>
        <label>Quiet hours end<input type="time" required={!!quietStart} disabled={busy || status.version == null} value={quietEnd} onChange={event => setQuietEnd(event.target.value)} aria-describedby="telegram-quiet-hours-help" /></label>
        <p id="telegram-quiet-hours-help">Set both times in your time zone, or leave both empty to turn quiet hours off. Reminders wait until quiet hours end, including urgent reminders.</p>
        <button className="button button--primary" type="submit" disabled={busy || status.version == null}>Save personal settings</button>
      </form>
    </section>}
    {status?.configured && <section className="settings-card">
      <h2>Read and reply automatically</h2>
      <p>When this mode is on, the bot reads incoming messages in the selected Telegram Business chats and replies automatically on your behalf. Connect the bot to the chats you need and allow replies in Telegram.</p>
      <p>For automatic replies, choose an external AI provider with a saved API key, set a model and write instructions for the assistant. Messages are sent to the chosen AI provider to prepare the reply.</p>
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void action(() => update({ instructions, provider_id: provider || null, model: model.trim() || null })) }}>
        <Checkbox label="Read and reply automatically" checked={status.auto_reply} disabled={busy || status.version == null} onChange={(enabled) => { void action(() => update(enabled ? { auto_reply: true, provider_id: provider || null, model: model.trim() || null, instructions } : { auto_reply: false })) }} />
        <label>Assistant instructions<textarea maxLength={10000} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
        <SelectField label="AI provider" value={provider} onChange={setProvider} options={[{ value: '', label: 'Not selected' }, ...providers.map((item) => ({ value: item.id, label: `${item.kind} · ${item.id}` }))]} />
        <label>Model<input maxLength={200} value={model} onChange={(event) => setModel(event.target.value)} /></label>
        <button className="button button--primary" disabled={busy || status.version == null} type="submit">Save settings</button>
      </form>
    </section>}
    {status?.configured && <section className="settings-card">
      <h2>Messages and manual replies</h2>
      <p>When automatic mode is off, you can draft a reply, review it and send it manually.</p>
      {messages.length === 0 && <p>No messages yet.</p>}
      {messages.map((message) => <details className="provider-row actual-settings-disclosure" key={message.id}>
        <summary>{message.chat_title} · {message.direction}</summary><p>{message.sent_at}{message.deleted_at ? ' · deleted' : ''}</p>
        <div className="mail-body">{message.text || (message.direction === 'owner' ? 'Message without text' : '')}</div>
        {message.direction === 'owner' && <p>Your outgoing message. Select an incoming message from the other person to reply.</p>}
        {message.direction === 'inbound' && <>
          <p>Draft: {message.draft_status}{message.draft_error_code ? ' · draft failed' : ''}</p>
          {message.owner_note && <p>For the owner: {message.owner_note}</p>}
          <div className="settings-form"><label>Reply text<textarea value={drafts[message.id] ?? message.draft_text ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [message.id]: event.target.value }))} /></label>
            <div className="provider-actions"><button className="button button--quiet" disabled={busy || !!message.deleted_at} onClick={() => void action(async () => replaceMessage(await getSharedApiClient().draftTelegramMessage(message.id, { version: message.version })))}>Create draft</button>
              <button className="button button--primary" disabled={busy || !!message.deleted_at || !(drafts[message.id] ?? message.draft_text ?? '').trim()} onClick={() => send(message)}>Send reply</button></div></div>
        </>}
      </details>)}
    </section>}
  </div></div>
}
