import { useCallback, useEffect, useState } from 'react'
import { ApiError, type MailAccount, type TelegramStatus } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
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
  const load = useCallback(async () => {
    const client = getSharedApiClient()
    const [mail, gmail, tg] = await Promise.allSettled([client.mailAccounts(), client.gmailStatus(), client.telegramStatus()])
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
    try { const message = await action(); await load(); if (message) setNotice(message) } catch (error) { setNotice(fail(error)) } finally { setBusy(false) }
  }
  const online = apiStatus === 'ready'
  const connect = () => run(async () => { window.location.assign((await getSharedApiClient().connectGmail()).authorization_url) })
  const sync = (id: string) => run(async () => `Loaded ${(await getSharedApiClient().syncGmail(id)).imported} new Gmail messages.`)
  const drafts = (id: string) => run(async () => `Imported ${(await getSharedApiClient().importGmailDrafts(id)).imported} Gmail drafts. Existing local edits were kept.`)
  const disconnectGmail = (id: string) => run(async () => (await getSharedApiClient().disconnectGmail(id)).provider_revoked ? 'Gmail disconnected.' : 'Local Gmail access removed. Revoke Aelys access in your Google account to finish disconnecting.')
  const disconnectTelegram = () => run(async () => { await getSharedApiClient().disconnectTelegram(); return 'Telegram disconnected.' })
  return <>
    <Card>
      {accounts.map((account) => { const ok = account.connection_status === 'connected'; return <Row key={account.id} title="Gmail" hint={<><span className="st-dot" style={{ display: 'inline-block', marginRight: 6, background: ok ? undefined : 'var(--st-red)' }} />{ok ? 'Read & drafts' : account.connection_status} · {account.external_id ?? 'Gmail account'}</>} wrap>
        {ok && <button type="button" className="st-btn" disabled={busy || !online} onClick={() => void sync(account.id)}>Load latest</button>}
        {ok && <button type="button" className="st-btn" disabled={busy || !online} onClick={() => void drafts(account.id)}>Load drafts</button>}
        <button type="button" className="st-btn st-btn--danger" disabled={busy} onClick={() => void disconnectGmail(account.id)}>Disconnect</button>
      </Row> })}
      {loaded && !accounts.length && <Row title="Gmail" hint={gmailConfigured ? 'Not connected. Aelys reads mail and prepares drafts; it never sends.' : 'Gmail needs server setup before you can connect your account.'} wrap>
        <button type="button" className="st-btn" disabled={busy || !online || !gmailConfigured} onClick={() => void connect()}>Connect Gmail</button>
      </Row>}
      {accounts.length > 0 && <Row title="Add another Gmail account" tall={false}><button type="button" className="st-btn" disabled={busy || !online || !gmailConfigured} onClick={() => void connect()}>Connect Gmail</button></Row>}
      {loaded && (telegram?.configured
        ? <Row title="Telegram" hint={<><span className="st-dot" style={{ display: 'inline-block', marginRight: 6, background: telegram.enabled ? undefined : 'var(--st-red)' }} />{telegram.enabled ? 'Connected' : 'Paused'} · {telegram.bot_username ? `@${telegram.bot_username}` : telegram.bot_name ?? 'Bot'}</>} wrap>
          <button type="button" className="st-btn st-btn--danger" disabled={busy} onClick={() => void disconnectTelegram()}>Disconnect</button>
        </Row>
        : <Row title="Telegram" hint="Not connected." wrap><button type="button" className="st-btn" onClick={() => onGo('telegram')}>Set up</button></Row>)}
    </Card>
    {notice && <div className="st-note" role="status">{notice}</div>}
  </>
}
