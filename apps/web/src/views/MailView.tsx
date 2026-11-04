import { StyledSelect } from '../components/controls/StyledSelect'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { ApiError, type MailAccount, type MailDraft, type MailMessage } from '@aelys/shared'
import { PageSkeleton } from '../components/PageSkeleton'
import { getSharedApiClient } from '../lib/api'
import { useDebouncedQuery, usePagedCollection } from '../lib/usePagedCollection'
import './connected.css'
import './actual-mail-finance.css'
import './desktop/page-tokens.css'
import './desktop/mail.css'
import { Ellipsis, FileUp, Inbox, Search, SquarePen, Mail, MailOpen, Reply, Save, ShieldCheck, Upload, ArrowLeft } from '../icons'
import { navigate } from '../lib/router'
import { MobileHeader } from '../components/MobileHeader'
import type { ApiStatus, RoutePath } from '../types'

const senderName = (sender: string) => sender.replace(/\s*<[^>]*>\s*$/, '').trim() || sender
const senderEmail = (sender: string) => sender.match(/<([^>]+)>/)?.[1] ?? (sender.includes('@') ? sender : '')
// Design wording: today shows the time, the last week the weekday, older mail "Oct 26".
function mailWhen(iso: string): string {
  const date = new Date(iso), now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 864e5)
  if (days === 0) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return days > 0 && days < 7 ? date.toLocaleDateString('en-US', { weekday: 'short' }) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
export function MailView({ apiStatus }: { apiStatus: ApiStatus }) {
  const [drafts, setDrafts] = useState<readonly MailDraft[]>([])
  const [accounts, setAccounts] = useState<readonly MailAccount[]>([])
  const [gmailAccount, setGmailAccount] = useState('')
  const [nextPages, setNextPages] = useState<Record<string, string | null>>({})
  const [tab, setTab] = useState<'inbox' | 'drafts'>('inbox')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [editing, setEditing] = useState<MailDraft | null>(null)
  const [composeThreadId, setComposeThreadId] = useState<string | null>(null)
  const [compose, setCompose] = useState(false)
  const [readerOpen, setReaderOpen] = useState(false)
  const [replyText, setReplyText] = useState<Record<string, string>>({})
  const [replyDrafts, setReplyDrafts] = useState<Record<string, MailDraft>>({})
  const [recipients, setRecipients] = useState('')
  const [subject, setSubject] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [metadataPhase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const searchQuery = useDebouncedQuery(query)
  const readPage = useCallback((...args: Parameters<ReturnType<typeof getSharedApiClient>['mailPage']>) => getSharedApiClient().mailPage(...args), [])
  const collection = usePagedCollection(apiStatus, { q: searchQuery }, readPage)
  const messages = collection.items
  const phase = collection.source === 'auth' ? 'error' : metadataPhase === 'ready' && collection.source === 'loading' ? 'loading' : metadataPhase
  const upload = useRef<HTMLInputElement>(null)
  const load = useCallback(async (forceRefresh = true) => {
    try {
      const client = getSharedApiClient()
      const [saved, connected] = await Promise.all([client.mailDrafts({ forceRefresh }), client.mailAccounts({ forceRefresh }), ...(forceRefresh ? [collection.refresh(true)] : [])])
      setDrafts(saved)
      setAccounts(connected)
      setPhase('ready')
      setGmailAccount((id) => connected.some((item) => item.id === id && item.connection_status === 'connected') ? id : connected.find((item) => item.provider === 'gmail' && item.connection_status === 'connected')?.id ?? '')
    } catch { setPhase('error'); setNotice('Could not load mail. Check the connection and owner session in Settings.') }
  }, [])
  useEffect(() => { void load(false) }, [load, apiStatus])
  const visible = useMemo(() => messages.filter((item) => `${item.sender} ${item.subject} ${item.body}`.toLowerCase().includes(query.toLowerCase())), [messages, query])
  const visibleDrafts = drafts.filter((item) => `${item.recipients.join(' ')} ${item.subject} ${item.content}`.toLowerCase().includes(query.toLowerCase()))
  const [linkedMessage, setLinkedMessage] = useState<MailMessage | null>(null)
  const selected = selectedId ? messages.find((item) => item.id === selectedId) ?? (linkedMessage?.id === selectedId && collection.source !== 'auth' ? linkedMessage : undefined) : visible[0]
  useEffect(() => {
    if (!selectedId || collection.source !== 'live' || messages.some(item => item.id === selectedId)) return
    let active = true
    void getSharedApiClient().mailMessage(selectedId).then(value => { if (active) setLinkedMessage(value) }).catch(() => {})
    return () => { active = false }
  }, [selectedId, messages, collection.source])
  useEffect(() => { if (collection.source === 'auth') { setDrafts([]); setAccounts([]); setLinkedMessage(null); setNotice('Sign in again to read mail.') } }, [collection.source])
  useEffect(() => {
    const readIntent = () => {
      if (window.location.pathname !== '/mail') return
      const id = new URLSearchParams(window.location.search).get('mail')
      if (!id) return
      setSelectedId(id); setTab('inbox'); setQuery(''); setCompose(false); setReaderOpen(true)
    }
    readIntent()
    window.addEventListener('popstate', readIntent)
    return () => window.removeEventListener('popstate', readIntent)
  }, [])
  const edit = (draft?: MailDraft) => {
    setEditing(draft ?? null); setComposeThreadId(draft?.thread_id ?? selected?.thread_id ?? null); setRecipients(draft?.recipients.join(', ') ?? ''); setSubject(draft?.subject ?? ''); setContent(draft?.content ?? ''); setCompose(true); setReaderOpen(true); setNotice('')
  }
  const report = (error: unknown) => setNotice(error instanceof ApiError ? `${error.code}: ${error.message}` : 'Mail request failed. Your draft remains open; check the connection before retrying.')
  const save = async (event: FormEvent, toGmail = false) => {
    event.preventDefault(); if (busy || (toGmail && !gmailAccount)) return
    setBusy(true); setNotice('')
    try {
      const body = { recipients: recipients.split(',').map((value) => value.trim()).filter(Boolean), subject, content, account_id: editing?.account_id ?? null, thread_id: editing?.thread_id ?? composeThreadId }
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
  const sync = async (more = false) => {
    if (!gmailAccount) return
    setBusy(true); setNotice('')
    try {
      const result = await getSharedApiClient().syncGmail(gmailAccount, more ? nextPages[gmailAccount] ?? undefined : undefined)
      setNextPages((pages) => ({ ...pages, [gmailAccount]: result.next_page_token }))
      await load(); setNotice(`Loaded ${result.imported} new Gmail messages.`)
    } catch (error) { report(error) } finally { setBusy(false) }
  }
  const closeMenu = (event: { currentTarget: Element }) => { const d = event.currentTarget.closest('details'); if (d) d.open = false }
  const moreMenu = <details className="actual-more"><summary aria-label="More mail actions" title="More"><Ellipsis size={18} /></summary><div className="actual-more-menu">
    <button type="button" disabled={busy || apiStatus !== 'ready'} onClick={(event) => { closeMenu(event); upload.current?.click() }}><FileUp size={15} />Import .eml</button>
    {gmailAccount && <button type="button" disabled={busy || apiStatus !== 'ready'} onClick={(event) => { closeMenu(event); void sync() }}>Load latest Gmail</button>}
    {nextPages[gmailAccount] && <button type="button" disabled={busy} onClick={(event) => { closeMenu(event); void sync(true) }}>Load older mail</button>}
    <button type="button" disabled={collection.refreshing} onClick={() => void load()}>Refresh mail</button>
    <button type="button" onClick={() => navigate('/settings?section=accounts' as RoutePath)}>Manage accounts</button>
  </div></details>
  return <div className="connected-workspace actual-workspace actual-mail">

    <input ref={upload} type="file" accept=".eml,message/rfc822" aria-label="Import EML file" hidden onChange={(event) => void importFile(event)} />
    {collection.source === 'cached' && <p role="status">Saved on this device. Connect to verify the latest version.</p>}
    {notice && <p role="status">{notice}</p>}
    {!compose && (recipients || subject || content) && <p role="status">Compose draft kept. <button type="button" onClick={() => { setCompose(true); setReaderOpen(true) }}>Resume draft</button></p>}
    {phase !== 'ready' && !messages.length && !drafts.length && <PageSkeleton kind="split" label="mail" phase={phase === 'error' ? 'error' : 'loading'} onRetry={() => { setPhase('loading'); setNotice(''); void load() }} />}
    <div hidden={phase !== 'ready' && !messages.length && !drafts.length} className={`actual-mail-grid ${readerOpen ? 'actual-reader-open' : ''}`}>
      {!compose && <button type="button" className="actual-fab" aria-label="Compose" disabled={busy} onClick={() => edit()}><SquarePen size={24} /></button>}
      <aside className="actual-panel actual-folders"><div className="actual-compose-row"><button type="button" className="button button--primary actual-compose" disabled={busy} onClick={() => edit()}><SquarePen size={16} />Compose</button>{moreMenu}</div><div className="actual-folder-heading">Mailboxes</div><nav aria-label="Mail folders">{(['inbox', 'drafts'] as const).map((folder) => { const count = folder === 'inbox' ? messages.filter((item) => item.is_read === false).length : drafts.length; return <button key={folder} type="button" aria-pressed={tab === folder} onClick={() => { setTab(folder); setCompose(false); setReaderOpen(false) }}>{folder === 'inbox' ? <Inbox size={16} /> : <Save size={16} />}<span className="actual-folder-name">{folder === 'inbox' ? 'Inbox' : 'Drafts'}</span><span>{count || ''}</span></button> })}</nav><p className="actual-mail-policy"><ShieldCheck size={14} />Aelys reads mail and prepares drafts. It never sends email.</p></aside>
      <section className="actual-panel actual-mail-list" aria-label={tab === 'inbox' ? 'Messages' : 'Drafts'}><MobileHeader sub={`${messages.filter((item) => item.is_read === false).length} unread · Gmail`} action={moreMenu} /><div className="actual-mobile-mail-actions">{moreMenu}</div><div className="actual-mobile-folders" aria-label="Mail folders">{(['inbox', 'drafts'] as const).map((folder) => <button type="button" key={folder} aria-pressed={tab === folder} onClick={() => { setTab(folder); setCompose(false); setReaderOpen(false) }}>{folder === 'inbox' ? 'Inbox' : 'Drafts'}</button>)}</div><label className="actual-search"><Search size={16} /><input aria-label="Search mail" placeholder="Search mail" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" className="actual-compose-icon" aria-label="Compose" title="Compose a new draft" disabled={busy} onClick={() => edit()}><SquarePen size={16} /></button></label><div className="actual-folder-select">Folder<StyledSelect aria-label="Mail folder" value={tab} onChange={(event) => { setTab(event.target.value as 'inbox' | 'drafts'); setCompose(false); setReaderOpen(false) }}><option value="inbox">Inbox</option><option value="drafts">Drafts</option></StyledSelect></div>
        <div className="actual-mail-rows">{tab === 'inbox' ? visible.map((item) => { const unread = item.is_read === false; return <button key={item.id} className={`actual-mail-row${unread ? ' actual-mail-row--unread' : ''}`} aria-pressed={selected?.id === item.id} disabled={busy} onClick={() => { setSelectedId(item.id); setCompose(false); setReaderOpen(true) }}><span className="actual-avatar" aria-hidden="true">{senderName(item.sender).charAt(0).toUpperCase()}</span><span className="actual-mail-row-text"><span className="actual-row-top">{unread && <i className="actual-unread-dot" />}<strong>{senderName(item.sender)}</strong><time>{mailWhen(item.received_at)}</time></span><span className="actual-row-subject">{item.subject || '(No subject)'}</span><span className="actual-row-snippet">{item.thread_id && drafts.some((draft) => draft.thread_id === item.thread_id) && <em>Draft</em>}<small>{item.body.replace(/\s+/g, ' ')}</small></span></span></button> }) : visibleDrafts.map((draft) => <button key={draft.id} className="actual-mail-row" disabled={busy} onClick={() => edit(draft)}><span className="actual-avatar" aria-hidden="true">{(draft.recipients[0] || 'D').charAt(0).toUpperCase()}</span><span className="actual-mail-row-text"><strong>{draft.recipients.join(', ') || 'No recipient yet'}</strong><span>{draft.subject || '(No subject)'}</span><small>{draft.content}</small></span></button>)}
        {tab === 'inbox' && collection.nextCursor && <button type="button" disabled={collection.refreshing} onClick={() => void collection.loadMore()}>Load more messages</button>}
        {(tab === 'inbox' ? visible : visibleDrafts).length === 0 && <p className="actual-empty">{query ? 'No mail matches. Try another folder or search.' : tab === 'inbox' ? 'No imported messages.' : 'No drafts yet.'}</p>}</div>
      </section>
      <section className="actual-panel actual-mail-reader"><button className="button button--quiet actual-back" onClick={() => setReaderOpen(false)}><ArrowLeft size={16} />Back to list</button>{compose ? <form className="settings-form" onSubmit={save}><h2>{editing ? 'Edit draft' : 'New draft'}</h2><label>To (comma separated)<input aria-label="Draft recipients" value={recipients} onChange={(event) => setRecipients(event.target.value)} /></label><label>Subject<input aria-label="Draft subject" value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label>Message<textarea aria-label="Draft message" rows={10} value={content} onChange={(event) => setContent(event.target.value)} /></label><div className="provider-actions"><button className="button button--primary" type="submit" disabled={busy || apiStatus !== 'ready'}>{busy ? 'Saving…' : 'Save draft'}</button><button className="button button--quiet" type="button" disabled={busy || !gmailAccount || apiStatus !== 'ready'} onClick={(event) => void save(event, true)}>Save to Gmail</button><button className="button button--quiet" type="button" disabled={busy} onClick={() => setCompose(false)}>Close</button>{editing && <button className="button button--quiet" type="button" disabled={busy || apiStatus !== 'ready'} onClick={() => void discard(editing)}>Discard local draft</button>}</div></form> : tab === 'inbox' && selected ? <article><div className="actual-reader-head"><h2>{selected.subject || '(No subject)'}</h2><div className="actual-sender"><span className="actual-avatar" aria-hidden="true">{senderName(selected.sender).charAt(0).toUpperCase()}</span><p><strong>{senderName(selected.sender)}</strong><span>{senderEmail(selected.sender) || `To: ${selected.recipients.join(', ')}`}</span></p><span className="actual-acc-chip">{accounts.find((account) => account.id === selected.account_id)?.provider === 'gmail' ? 'Gmail' : 'Imported'}</span><time>{mailWhen(selected.received_at)}</time></div></div><div className="mail-body">{selected.body}</div><form className="actual-reply" onSubmit={saveReply}><div className="actual-reply-heading"><Reply size={16} /><strong>Reply draft</strong><em data-state={replyDrafts[selected.id] ? 'saved' : 'none'}>{replyDrafts[selected.id] ? 'Saved' : 'No draft'}</em><button type="button" className="actual-reply-details" onClick={() => { edit(); setRecipients(selected.sender.match(/<([^>]+)>/)?.[1] ?? selected.sender); setSubject(/^Re:/i.test(selected.subject) ? selected.subject : `Re: ${selected.subject}`); setContent(replyText[selected.id] ?? '') }}>Edit reply details</button></div><textarea aria-label="Reply draft" rows={4} placeholder="Write a reply… it stays here even if you switch emails" value={replyText[selected.id] ?? replyDrafts[selected.id]?.content ?? ''} onChange={(event) => setReplyText((values) => ({ ...values, [selected.id]: event.target.value }))}/><div className="actual-reply-actions"><span>Nothing is sent from Aelys.</span><button className="button button--quiet" type="submit" disabled={busy || apiStatus !== 'ready'}><Save size={15} />Save draft</button>{gmailAccount && <button className="button button--primary" type="button" disabled={busy || apiStatus !== 'ready'} onClick={(event) => void saveReply(event, true)}><Upload size={15} />Put in Gmail drafts</button>}</div></form></article> : <p className="actual-reader-none"><MailOpen size={32} />{tab === 'drafts' ? 'Select a draft to edit it.' : selectedId ? 'Message not found in loaded mail.' : 'Select an email to read'}</p>}</section>
    </div>
  </div>
}
