import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type MailAccount, type TelegramStatus } from '@aelys/shared'
import { connectGmailAccount, getSharedApiClient } from '../../lib/api'
import type { ApiStatus } from '../../types'
import { Card, Row } from './ui'

const fail = (error: unknown) => error instanceof ApiError ? `${error.code}: ${error.message}` : 'Request failed. Check the connection and try again.'

// Gmail connect/sync/import/disconnect moved here from Mail; Telegram is set up in its own section.
export function AccountsPanel({ apiStatus, onGo }: { apiStatus: ApiStatus; onGo: (id: 'telegram') => void }) {
  const [accounts, setAccounts] = useState<readonly MailAccount[]>([])
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null)
  const [gmailConfigured, setGmailConfigured] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [connecting, setConnecting] = useState(false)
  const attempt = useRef<{ baseline: Set<string>; started: number } | null>(null)
  const load = useCallback(async (forceRefresh = false) => {
    const client = getSharedApiClient()
    const [mail, gmail, tg] = await Promise.allSettled([client.mailAccounts({ forceRefresh }), client.gmailStatus(), client.telegramStatus()])
    if (mail.status === 'fulfilled') setAccounts(mail.value.filter((item) => item.provider === 'gmail'))
    if (gmail.status === 'fulfilled') setGmailConfigured(gmail.value.configured)
    if (tg.status === 'fulfilled') setTelegram(tg.value)
    if (mail.status === 'rejected') setNotice('Could not load your accounts. Open Connection to check your session.')
    setLoaded(true)
  }, [])
  useEffect(() => { void load() }, [load, apiStatus])
  const run = async (action: () => Promise<string | void>) => {
    if (busy) return
    setBusy(true); setNotice('')
    try { const message = await action(); await load(true); if (message) setNotice(message) } catch (error) { setNotice(fail(error)) } finally { setBusy(false) }
  }
  const online = apiStatus === 'ready'
  const connect = () => run(async () => {
    attempt.current = { baseline: new Set(accounts.map(account => `${account.id}:${account.version}`)), started: Date.now() }
    try { await connectGmailAccount(); setConnecting(true); return 'Complete the Google connection in your browser, then return to Aelys.' }
    catch (error) { attempt.current = null; setConnecting(false); throw error }
  })
  useEffect(() => {
    if (!connecting || apiStatus !== 'ready') return
    let active = true
    let checking = false
    const check = async () => {
      if (checking || !attempt.current || document.visibilityState === 'hidden') return
      if (Date.now() - attempt.current.started >= 600_000) { setConnecting(false); setNotice('The Gmail connection expired. Connect Gmail again to retry.'); return }
      checking = true
      try {
        const client = getSharedApiClient()
        const current = await client.mailAccounts({ forceRefresh: true, allowCacheFallback: false })
        if (!active) return
        setAccounts(current.filter(account => account.provider === 'gmail'))
        if (current.some(account => account.provider === 'gmail' && account.connection_status === 'connected' && !attempt.current!.baseline.has(`${account.id}:${account.version}`))) {
          client.clearReadCache(); attempt.current = null; setConnecting(false)
          setNotice('Gmail connected. Choose Load latest to import messages, or Load drafts to import drafts.')
        }
      } catch (error) {
        if (active && error instanceof ApiError && [401, 403].includes(error.status)) { setConnecting(false); setAccounts([]); setTelegram(null); setGmailConfigured(false); setNotice(fail(error)) }
      } finally { checking = false }
    }
    const resume = () => { void check() }
    const timer = window.setInterval(resume, 3000)
    window.addEventListener('focus', resume); window.addEventListener('online', resume)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', resume); window.removeEventListener('online', resume) }
  }, [connecting, apiStatus])
  const sync = (id: string) => run(async () => `Loaded ${(await getSharedApiClient().syncGmail(id)).imported} new Gmail messages.`)
  const drafts = (id: string) => run(async () => `Imported ${(await getSharedApiClient().importGmailDrafts(id)).imported} Gmail drafts. Existing local edits were kept.`)
  const disconnectGmail = (id: string) => run(async () => (await getSharedApiClient().disconnectGmail(id)).provider_revoked ? 'Gmail disconnected.' : 'Local Gmail access removed. Revoke Aelys access in your Google account to finish disconnecting.')
  const disconnectTelegram = () => run(async () => { await getSharedApiClient().disconnectTelegram(); return 'Telegram disconnected.' })
  return <>
    <Card>
      {accounts.map((account) => { const ok = account.connection_status === 'connected'; return <Row key={account.id} title="Gmail" hint={<><span className="st-dot" style={{ display: 'inline-block', marginRight: 6, background: ok ? undefined : 'var(--st-red)' }} />{ok ? 'Read & drafts' : account.connection_status} · {account.external_id ?? 'Gmail account'}</>} wrap>
        {ok && <button type="button" className="st-btn" disabled={busy || !online} onClick={() => void sync(account.id)}>Load latest</button>}
        {ok && <button type="button" className="st-btn" disabled={busy || !online} onClick={() => void drafts(account.id)}>Load drafts</button>}
        {!ok && <button type="button" className="st-btn" disabled={busy || connecting || !online || !gmailConfigured} onClick={() => void connect()}>Reconnect Gmail</button>}
        <button type="button" className="st-btn st-btn--danger" disabled={busy} onClick={() => void disconnectGmail(account.id)}>Disconnect</button>
      </Row> })}
      {loaded && !accounts.length && <Row title="Gmail" hint={gmailConfigured ? 'Not connected. Aelys reads mail and prepares drafts; it never sends.' : 'Gmail needs server setup before you can connect your account.'} wrap>
        <button type="button" className="st-btn" disabled={busy || connecting || !online || !gmailConfigured} onClick={() => void connect()}>Connect Gmail</button>
      </Row>}
      {accounts.length > 0 && <Row title="Add another Gmail account" tall={false}><button type="button" className="st-btn" disabled={busy || connecting || !online || !gmailConfigured} onClick={() => void connect()}>Connect Gmail</button></Row>}
      {loaded && (telegram?.configured
        ? <Row title="Telegram" hint={<><span className="st-dot" style={{ display: 'inline-block', marginRight: 6, background: telegram.enabled ? undefined : 'var(--st-red)' }} />{telegram.enabled ? 'Connected' : 'Paused'} · {telegram.bot_username ? `@${telegram.bot_username}` : telegram.bot_name ?? 'Bot'}</>} wrap>
          <button type="button" className="st-btn st-btn--danger" disabled={busy} onClick={() => void disconnectTelegram()}>Disconnect</button>
        </Row>
        : <Row title="Telegram" hint="Not connected." wrap><button type="button" className="st-btn" onClick={() => onGo('telegram')}>Set up</button></Row>)}
    </Card>
    {notice && <div className="st-note" role="status">{notice}</div>}
  </>
}
