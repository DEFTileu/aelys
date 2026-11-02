import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { type AIProvider, type TelegramBusinessMessage, type TelegramSettingsPatch, type TelegramStatus } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'
import { telegramErrorNotice as errorNotice } from '../lib/telegramMessages'
import { Checkbox } from '../components/controls/SelectionControls'
import { ChevronRight, MessageSquareText, Send } from '../icons'
import { navigate } from '../lib/router'
import { Card, Group, Row, SwitchRow } from './settings/ui'
import { ModelPicker } from '../components/ModelPicker'
import './connected.css'

export function TelegramSettings() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
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
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const applyStatus = (value: TelegramStatus) => {
    setStatus(value); setInstructions(value.instructions); setProvider(value.provider_id ?? ''); setModel(value.model ?? ''); setTimezone(value.timezone); setDigestTime(value.digest_time ?? ''); setReplyDelay(value.reply_delay_seconds)
    setDeadlineReminders(value.deadline_reminders ?? false); setQuietStart(value.quiet_start ?? ''); setQuietEnd(value.quiet_end ?? '')
  }
  const load = useCallback(async () => {
    const client = getSharedApiClient()
    try {
      const [next, items, ai] = await Promise.all([client.telegramStatus(), client.telegramMessages(), client.aiProviders()])
      applyStatus(next); setMessages(items); setProviders(ai.filter(item => item.kind !== 'transcription')); setLoadFailed(false)
    } catch (error) { setLoadFailed(true); setNotice(errorNotice(error)) }
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
  const connected = status?.connections.some((connection) => connection.enabled) ?? false

  const draftsReady = messages.filter((message) => !!message.draft_text).length
  const autoOff = !status?.auto_reply
  const state = !status?.configured ? 'Bot not set up' : !status.enabled ? 'Paused' : connected ? 'Connected to your Business account' : 'Telegram Business connection pending'
  const connectForm = <form className="st-form" onSubmit={connect}>
    <label className="st-field-label">Bot token<input className="st-input st-input--mono" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required /></label>
    <div className="st-actions"><button className="st-btn st-btn--primary" type="submit" disabled={busy || !token.trim()}>Connect bot</button></div>
  </form>

  return <>
    {notice && <div className="st-note" role="status">{notice}</div>}
    {status?.configured ? <div className="st-card st-bot">
      <span className="st-bot-icon"><Send size={20} aria-hidden="true" /></span>
      <div className="st-grow"><div className="st-label" style={{ fontWeight: 600 }}>{status.bot_username ? `@${status.bot_username}` : status.bot_name ?? 'Telegram bot'}</div><div className="st-bot-state"><span className="st-dot" style={connected && status.enabled ? undefined : { background: 'var(--st-faint)' }} />{state}</div></div>
      <button type="button" className="st-btn" disabled={busy || status.version == null} onClick={() => void action(() => update({ enabled: !status.enabled }))}>{status.enabled ? 'Pause' : 'Resume'}</button>
      <button type="button" className="st-btn st-btn--danger" disabled={busy} onClick={() => void action(async () => { await getSharedApiClient().disconnectTelegram(); setBinding(null); setMessages([]); await load() })}>Disconnect</button>
    </div> : <Group title="Connect your bot">
      <Card>
        <details className="st-pad st-steps"><summary>How to connect the bot</summary><ol>
          <li>Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">BotFather</a> and enter its token.</li>
          <li>In BotFather, turn on Secretary Mode (Business Mode). <a href="https://core.telegram.org/bots/features#business-bots" target="_blank" rel="noreferrer">Telegram guide</a></li>
          <li>Create a one-time link and open it in Telegram as the owner.</li>
          <li>In Telegram Business settings, add the bot under chatbots and allow the chats you need. <a href="https://core.telegram.org/api/business" target="_blank" rel="noreferrer">Telegram Business</a></li>
        </ol>
        <p>Local Telegram polling needs the Aelys backend to be running; no public URL is required.</p>
        <p>Messages are stored encrypted for up to 7 days. Disconnecting the bot deletes them.</p></details>
        {status ? connectForm : null}
        <div className="st-msg">{status ? state : loadFailed ? <>Could not load Telegram status. <button type="button" className="st-btn" onClick={() => { setLoadFailed(false); setNotice(''); void load() }}>Retry</button></> : 'Checking Telegram…'}</div>
      </Card>
    </Group>}
    {status?.configured && <>
      <Card>
        <SwitchRow title="Auto-reply" hint="Read incoming messages and draft replies in allowed chats" checked={status.auto_reply} disabled={busy || status.version == null} onChange={(enabled) => { void action(() => update(enabled ? { auto_reply: true, provider_id: provider || null, model: model.trim() || null, instructions } : { auto_reply: false })) }} />
        <div className="st-row st-row--wrap" style={{ opacity: autoOff ? .5 : 1 }}>
          <div className="st-grow"><div className="st-label">Reply with</div><div className="st-hint">Provider and model for drafts</div></div>
          <ModelPicker compact label="Reply with" providers={providers} value={{ providerId: provider, model }} onChange={(choice) => { setProvider(choice.providerId); setModel(choice.model) }} />
        </div>
        <form className="st-pad" style={{ opacity: autoOff ? .5 : 1 }} onSubmit={(event) => { event.preventDefault(); void action(() => update({ instructions, provider_id: provider || null, model: model.trim() || null })) }}>
          <label className="st-field-label" htmlFor="telegram-instructions">Instructions</label>
          <div className="st-hint" style={{ marginBottom: 10 }}>How the assistant writes on your behalf</div>
          <textarea id="telegram-instructions" className="st-textarea" maxLength={10000} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
          <div className="st-counter">{instructions.length.toLocaleString('en-US')} / 10,000</div>
          <div className="st-actions" style={{ marginTop: 10 }}><button className="st-btn st-btn--primary" disabled={busy || status.version == null} type="submit">Save settings</button></div>
        </form>
      </Card>

      <button type="button" className="st-link" onClick={() => navigate('/messages')}>
        <span className="st-pin"><MessageSquareText size={14} aria-hidden="true" /></span>
        <span className="st-grow"><span className="st-label" style={{ display: 'block' }}>Conversations and drafts</span><span className="st-hint" style={{ display: 'block' }}>Open the Messages app</span></span>
        {draftsReady > 0 && <span className="st-chip st-chip--count">{draftsReady} {draftsReady === 1 ? 'draft' : 'drafts'}</span>}
        <ChevronRight size={14} aria-hidden="true" style={{ color: 'var(--st-mute)' }} />
      </button>

      <Group title="Connection">
        <Card>
          <Row title="Owner link" hint={status.owner_telegram_id ? `Linked to Telegram ID ${status.owner_telegram_id}` : 'Open the one-time link in Telegram to link the owner'} wrap>
            <button type="button" className="st-btn" disabled={busy} onClick={() => void action(async () => { setBinding(await getSharedApiClient().telegramBinding()) })}>Create owner link</button>
          </Row>
          {binding && <div className="st-msg"><a href={binding.url} target="_blank" rel="noreferrer">Open one-time owner link</a> · valid until {binding.expires_at}</div>}
          <Row title="Business mode" hint={`${status.business_capable ? 'Available' : 'Not enabled'} · ${status.enabled ? 'active' : 'paused'}${status.last_polled_at ? ` · last check ${status.last_polled_at}` : ''}`} wrap>
            <button type="button" className="st-btn" disabled={busy || !status.configured} onClick={() => void action(async () => { const result = await getSharedApiClient().syncTelegram(); await load(); setNotice(`Check complete. Processed: ${result.processed}.`) })}>Check connection</button>
          </Row>
          <details className="st-pad st-steps"><summary>Business connections</summary>
            {status.connections.length === 0 ? <p>No connections yet.</p> : status.connections.map((connection) => <p key={connection.id}>ID {connection.telegram_user_id} · {connection.enabled ? 'active' : 'disabled'} · {connection.can_reply ? 'replies allowed' : 'replies blocked'}</p>)}
            {status.last_error_code && <p>The check failed. Refresh the connection status.</p>}</details>
          {connectForm}
        </Card>
      </Group>

      <Group title="Personal commands and digest">
        <Card>
          <div className="st-pad st-hint">One Aelys bot: /task, /note, /today, /remind 18:00 text, /busy 18:00 text, /free, /help. Use a bot separate from MySDU. The digest uses no AI and is off by default. Leave the time empty to turn it off. Status: {status.status_text ?? 'not set'}{status.status_until ? ` · until ${status.status_until}` : ''}</div>
          <form className="st-form" onSubmit={event => { event.preventDefault(); void action(() => update({ timezone, digest_time: digestTime || null, reply_delay_seconds: replyDelay, deadline_reminders: deadlineReminders, quiet_start: quietStart || null, quiet_end: quietEnd || null })) }}>
            <label className="st-field-label">Time zone<input className="st-input" required maxLength={64} value={timezone} onChange={event => setTimezone(event.target.value)} /></label>
            <label className="st-field-label">Digest time<input className="st-input" type="time" value={digestTime} onChange={event => setDigestTime(event.target.value)} /></label>
            <label className="st-field-label">Reply delay (seconds)<input className="st-input" type="number" min={0} max={900} required value={replyDelay} onChange={event => setReplyDelay(Number(event.target.value))} /></label>
            <Checkbox label="Deadline reminders" checked={deadlineReminders} disabled={busy || status.version == null} onChange={setDeadlineReminders} />
            <div className="st-hint">Remind me in Telegram 5 hours and 10 minutes before an unfinished task is due.</div>
            <label className="st-field-label">Quiet hours start<input className="st-input" type="time" required={!!quietEnd} disabled={busy || status.version == null} value={quietStart} onChange={event => setQuietStart(event.target.value)} aria-describedby="telegram-quiet-hours-help" /></label>
            <label className="st-field-label">Quiet hours end<input className="st-input" type="time" required={!!quietStart} disabled={busy || status.version == null} value={quietEnd} onChange={event => setQuietEnd(event.target.value)} aria-describedby="telegram-quiet-hours-help" /></label>
            <div className="st-hint" id="telegram-quiet-hours-help">Set both times in your time zone, or leave both empty to turn quiet hours off. Reminders wait until quiet hours end, including urgent reminders.</div>
            <div className="st-actions"><button className="st-btn st-btn--primary" type="submit" disabled={busy || status.version == null}>Save personal settings</button></div>
          </form>
        </Card>
      </Group>
    </>}
  </>
}
