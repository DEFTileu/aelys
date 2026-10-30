import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { ApiError, type MailAccount, type MailDraft, type MailMessage } from '@aelys/shared'
import { ApiStatusPill } from '../components/ApiStatusPill'
import { getSharedApiClient } from '../lib/api'
import './connected.css'
import './actual-mail-finance.css'
import type { ApiStatus } from '../types'

export function MailView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [messages, setMessages] = useState<readonly MailMessage[]>([])
  const [drafts, setDrafts] = useState<readonly MailDraft[]>([])
  const [accounts, setAccounts] = useState<readonly MailAccount[]>([])
  const [gmailConfigured, setGmailConfigured] = useState(false)
  const [gmailAccount, setGmailAccount] = useState('')
  const [nextPages, setNextPages] = useState<Record<string, string | null>>({})
  const [tab, setTab] = useState<'inbox' | 'drafts'>('inbox')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [editing, setEditing] = useState<MailDraft | null>(null)
  const [compose, setCompose] = useState(false)
  const [readerOpen, setReaderOpen] = useState(false)
  const [replyText, setReplyText] = useState<Record<string, string>>({})
  const [replyDrafts, setReplyDrafts] = useState<Record<string, MailDraft>>({})
  const [recipients, setRecipients] = useState('')
  const [subject, setSubject] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const upload = useRef<HTMLInputElement>(null)
  const load = useCallback(async () => {
    try {
      const client = getSharedApiClient()
      const [inbox, saved, connected, gmail] = await Promise.all([client.mailMessages(), client.mailDrafts(), client.mailAccounts(), client.gmailStatus()])
      setMessages(inbox); setDrafts(saved)
      setAccounts(connected); setGmailConfigured(gmail.configured)
      setGmailAccount((id) => connected.some((item) => item.id === id && item.connection_status === 'connected') ? id : connected.find((item) => item.provider === 'gmail' && item.connection_status === 'connected')?.id ?? '')
    } catch { setNotice('Could not load mail. Check the connection and owner session in Settings.') }
  }, [])
  useEffect(() => { void load() }, [load, apiStatus])
  const visible = useMemo(() => messages.filter((item) => `${item.sender} ${item.subject} ${item.body}`.toLowerCase().includes(query.toLowerCase())), [messages, query])
  const visibleDrafts = drafts.filter((item) => `${item.recipients.join(' ')} ${item.subject} ${item.content}`.toLowerCase().includes(query.toLowerCase()))
  const selected = messages.find((item) => item.id === selectedId) ?? visible[0]
  const edit = (draft?: MailDraft) => {
    setEditing(draft ?? null); setRecipients(draft?.recipients.join(', ') ?? ''); setSubject(draft?.subject ?? ''); setContent(draft?.content ?? ''); setCompose(true); setReaderOpen(true); setNotice('')
  }
  const report = (error: unknown) => setNotice(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Mail request failed. Your draft remains open; check the connection before retrying.')
  const save = async (event: FormEvent, toGmail = false) => {
    event.preventDefault(); if (busy || (toGmail && !gmailAccount)) return
    setBusy(true); setNotice('')
    try {
      const body = { recipients: recipients.split(',').map((value) => value.trim()).filter(Boolean), subject, content, account_id: editing?.account_id ?? null, thread_id: editing?.thread_id ?? selected?.thread_id ?? null }
      const client = getSharedApiClient()
      const saved = editing ? await client.updateMailDraft(editing.id, { ...body, version: editing.version }, { queueOnOffline: false }) : await client.createMailDraft(body, { queueOnOffline: false })
      setEditing(saved)
      if (toGmail) await client.publishGmailDraft(gmailAccount, saved.id, saved.version)
      await load(); setNotice(toGmail ? 'Draft saved in Gmail. No email was sent.' : 'Draft saved.'); setCompose(false); setTab('drafts')
    } catch (error) { report(error) }
    finally { setBusy(false) }
  }
  const saveReply = async (event: FormEvent, toGmail = false) => {
    event.preventDefault()
    if (!selected || busy || (toGmail && !gmailAccount)) return
    setBusy(true); setNotice('')
    try {
      const existing = replyDrafts[selected.id]
      const body = { recipients: [selected.sender.match(/<([^>]+)>/)?.[1] ?? selected.sender], subject: /^Re:/i.test(selected.subject) ? selected.subject : `Re: ${selected.subject}`, content: replyText[selected.id] ?? existing?.content ?? '', account_id: existing?.account_id ?? null, thread_id: selected.thread_id ?? null }
      const client = getSharedApiClient()
      const saved = existing ? await client.updateMailDraft(existing.id, { ...body, version: existing.version }, { queueOnOffline: false }) : await client.createMailDraft(body, { queueOnOffline: false })
      setReplyDrafts((values) => ({ ...values, [selected.id]: saved }))
      if (toGmail) await client.publishGmailDraft(gmailAccount, saved.id, saved.version)
      await load(); setNotice(toGmail ? 'Draft saved in Gmail. No email was sent.' : 'Draft saved.')
    } catch (error) { report(error) } finally { setBusy(false) }
  }
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
    if (file.size > 2 * 1024 * 1024) { setNotice('Choose an EML file up to 2 MB.'); return }
    setBusy(true); setNotice('')
    try { const item = await getSharedApiClient().importEml(file); await load(); setSelectedId(item.id); setTab('inbox'); setCompose(false); setNotice('Message imported. Importing the same file again keeps one copy.') }
    catch (error) { report(error) } finally { setBusy(false) }
  }
  const discard = async (draft: MailDraft) => {
    setBusy(true)
    try { await getSharedApiClient().deleteMailDraft(draft.id, draft.version, { queueOnOffline: false }); await load(); setCompose(false); setEditing(null); setNotice('Draft discarded.') }
    catch (error) { report(error) } finally { setBusy(false) }
  }
  const connect = async () => {
    setBusy(true)
    try { const result = await getSharedApiClient().connectGmail(); window.location.assign(result.authorization_url) }
    catch (error) { report(error); setBusy(false) }
  }
  const sync = async (more = false) => {
    if (!gmailAccount) return
    setBusy(true); setNotice('')
    try {
      const result = await getSharedApiClient().syncGmail(gmailAccount, more ? nextPages[gmailAccount] ?? undefined : undefined)
      setNextPages((pages) => ({ ...pages, [gmailAccount]: result.next_page_token }))
      await load(); setNotice(`Loaded ${result.imported} new Gmail messages.`)
    } catch (error) { report(error) } finally { setBusy(false) }
  }
  const loadGmailDrafts = async (more = false) => {
    if (!gmailAccount) return
    setBusy(true)
    const cursorKey = `${gmailAccount}:drafts`
    try {
      const result = await getSharedApiClient().importGmailDrafts(gmailAccount, more ? nextPages[cursorKey] ?? undefined : undefined)
      setNextPages((pages) => ({ ...pages, [cursorKey]: result.next_page_token }))
      await load(); setTab('drafts'); setCompose(false); setNotice(`Imported ${result.imported} Gmail drafts. Existing local edits were kept.`)
    } catch (error) { report(error) } finally { setBusy(false) }
  }
  const disconnect = async () => {
    if (!gmailAccount) return
    setBusy(true)
    try { const result = await getSharedApiClient().disconnectGmail(gmailAccount); await load(); setNotice(result.provider_revoked ? 'Gmail disconnected.' : 'Local Gmail access removed. Revoke Aelys access in your Google account to finish disconnecting.') }
    catch (error) { report(error) } finally { setBusy(false) }
  }
  return <div className="connected-workspace actual-workspace actual-mail">
    <div className="actual-topline"><ApiStatusPill status={apiStatus} /><button className="button button--quiet" disabled={busy} onClick={() => void load()}>Refresh</button><details className="actual-mail-tools"><summary>Mail tools</summary>    <div className="actual-actions"><button className="button button--quiet" disabled={busy || apiStatus !== 'ready' || !gmailConfigured} onClick={() => void connect()}>Connect Gmail</button><select aria-label="Gmail account" value={gmailAccount} onChange={(event) => setGmailAccount(event.target.value)}><option value="">Select connected Gmail</option>{accounts.filter((item) => item.provider === 'gmail' && item.connection_status === 'connected').map((item) => <option key={item.id} value={item.id}>{item.external_id}</option>)}</select><button className="button button--quiet" disabled={busy || !gmailAccount || apiStatus !== 'ready'} onClick={() => void sync()}>Load latest Gmail</button>{nextPages[gmailAccount] && <button className="button button--quiet" disabled={busy} onClick={() => void sync(true)}>Load older mail</button>}<button className="button button--quiet" disabled={busy || !gmailAccount || apiStatus !== 'ready'} onClick={() => void loadGmailDrafts()}>Load Gmail drafts</button>{nextPages[`${gmailAccount}:drafts`] && <button className="button button--quiet" disabled={busy} onClick={() => void loadGmailDrafts(true)}>Load older drafts</button>}<button className="button button--quiet" disabled={busy || !gmailAccount} onClick={() => void disconnect()}>Disconnect Gmail</button></div>
    <p className="connected-help">Gmail loads 25 messages per page into your Aelys store. Disconnecting removes access; loaded mail and local drafts stay here. Save replies locally or explicitly save a draft in Gmail. Sending is unavailable.</p>
    {!gmailConfigured && <p className="connected-help">Gmail needs server setup before you can connect your account. You can import EML files while it is being configured.</p>}
</details></div>
    <input ref={upload} type="file" accept=".eml,message/rfc822" aria-label="Import EML file" hidden onChange={(event) => void importFile(event)} />
    {notice && <p role="status">{notice}</p>}
    <div className={`actual-mail-grid ${readerOpen ? 'actual-reader-open' : ''}`}>
      <aside className="actual-panel actual-folders"><button className="button button--primary" disabled={busy} onClick={() => edit()}>Compose</button><button className="button button--quiet" disabled={busy || apiStatus !== 'ready'} onClick={() => upload.current?.click()}>Import .eml</button><div className="actual-folder-heading">Mailboxes</div><nav aria-label="Mail folders">{(['inbox', 'drafts'] as const).map((folder) => <button key={folder} type="button" aria-pressed={tab === folder} onClick={() => { setTab(folder); setCompose(false); setReaderOpen(false) }}>{folder === 'inbox' ? 'Inbox' : 'Drafts'} <span>{folder === 'inbox' ? messages.length : drafts.length}</span></button>)}</nav>{accounts.length > 0 && <><div className="actual-folder-heading">Accounts</div>{accounts.map((account) => <div className="actual-mail-account" key={account.id}><strong>{account.provider}</strong><span>{account.external_id}</span><small>{account.connection_status}</small></div>)}</>}<p className="actual-mail-policy">Aelys reads mail and prepares drafts. It never sends email.</p></aside>
      <section className="actual-panel actual-mail-list" aria-label={tab === 'inbox' ? 'Messages' : 'Drafts'}><div className="actual-mobile-mail-actions"><button className="button button--primary" disabled={busy} onClick={() => edit()}>Compose</button><button className="button button--quiet" disabled={busy || apiStatus !== 'ready'} onClick={() => upload.current?.click()}>Import .eml</button></div><div className="actual-mobile-folders" aria-label="Mail folders">{(['inbox', 'drafts'] as const).map((folder) => <button type="button" key={folder} aria-pressed={tab === folder} onClick={() => { setTab(folder); setCompose(false); setReaderOpen(false) }}>{folder === 'inbox' ? 'Inbox' : 'Drafts'}</button>)}</div><input aria-label="Search mail" placeholder="Search mail…" value={query} onChange={(event) => setQuery(event.target.value)} /><label className="actual-folder-select">Folder<select value={tab} onChange={(event) => { setTab(event.target.value as 'inbox' | 'drafts'); setCompose(false); setReaderOpen(false) }}><option value="inbox">Inbox</option><option value="drafts">Drafts</option></select></label>
        {tab === 'inbox' ? visible.map((item) => <button key={item.id} className="actual-mail-row" aria-pressed={selected?.id === item.id} disabled={busy} onClick={() => { setSelectedId(item.id); setCompose(false); setReaderOpen(true) }}><span className="actual-avatar" aria-hidden="true">{item.sender.charAt(0).toUpperCase()}</span><span className="actual-mail-row-text"><strong>{item.sender}</strong><span>{item.subject || '(No subject)'}</span><small>{item.body.replace(/\s+/g, ' ')}</small></span><time>{new Date(item.received_at).toLocaleDateString()}</time></button>) : visibleDrafts.map((draft) => <button key={draft.id} className="actual-mail-row" disabled={busy} onClick={() => edit(draft)}><span className="actual-avatar" aria-hidden="true">{(draft.recipients[0] || 'D').charAt(0).toUpperCase()}</span><span className="actual-mail-row-text"><strong>{draft.recipients.join(', ') || 'No recipient yet'}</strong><span>{draft.subject || '(No subject)'}</span><small>{draft.content}</small></span></button>)}
        {(tab === 'inbox' ? visible : visibleDrafts).length === 0 && <p className="actual-empty">{query ? 'No matches.' : tab === 'inbox' ? 'No imported messages.' : 'No drafts yet.'}</p>}
      </section>
      <section className="actual-panel actual-mail-reader"><button className="button button--quiet actual-back" onClick={() => setReaderOpen(false)}>Back to list</button>{compose ? <form className="settings-form" onSubmit={save}><h2>{editing ? 'Edit draft' : 'New draft'}</h2><label>To (comma separated)<input aria-label="Draft recipients" value={recipients} onChange={(event) => setRecipients(event.target.value)} /></label><label>Subject<input aria-label="Draft subject" value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label>Message<textarea aria-label="Draft message" rows={10} value={content} onChange={(event) => setContent(event.target.value)} /></label><div className="provider-actions"><button className="button button--primary" type="submit" disabled={busy || apiStatus !== 'ready'}>{busy ? 'Saving…' : 'Save draft'}</button><button className="button button--quiet" type="button" disabled={busy || !gmailAccount || apiStatus !== 'ready'} onClick={(event) => void save(event, true)}>Save to Gmail</button><button className="button button--quiet" type="button" disabled={busy} onClick={() => setCompose(false)}>Close</button>{editing && <button className="button button--quiet" type="button" disabled={busy || apiStatus !== 'ready'} onClick={() => void discard(editing)}>Discard local draft</button>}</div></form> : tab === 'inbox' && selected ? <article><h2>{selected.subject || '(No subject)'}</h2><div className="actual-sender"><span className="actual-avatar" aria-hidden="true">{selected.sender.charAt(0).toUpperCase()}</span><p><strong>{selected.sender}</strong><br/>To: {selected.recipients.join(', ')}</p></div><time>{new Date(selected.received_at).toLocaleString()}</time><div className="mail-body">{selected.body}</div><form className="actual-reply" onSubmit={saveReply}><div className="actual-reply-heading">↩ <strong>Reply draft</strong></div><textarea aria-label="Reply draft" rows={4} placeholder="Write a reply…" value={replyText[selected.id] ?? replyDrafts[selected.id]?.content ?? ''} onChange={(event) => setReplyText((values) => ({ ...values, [selected.id]: event.target.value }))}/><div className="actual-reply-actions"><span>Nothing is sent from Aelys.</span><button className="button button--quiet" type="submit" disabled={busy || apiStatus !== 'ready'}>Save draft</button>{gmailAccount && <button className="button button--primary" type="button" disabled={busy || apiStatus !== 'ready'} onClick={(event) => void saveReply(event, true)}>Put in Gmail drafts</button>}</div><button type="button" className="actual-reply-details" onClick={() => { edit(); setRecipients(selected.sender.match(/<([^>]+)>/)?.[1] ?? selected.sender); setSubject(/^Re:/i.test(selected.subject) ? selected.subject : `Re: ${selected.subject}`); setContent(replyText[selected.id] ?? '') }}>Edit reply details</button></form></article> : <p>{tab === 'drafts' ? 'Select a draft to edit it.' : 'Import an EML file to read your mail.'}</p>}</section>
    </div>
  </div>
}
