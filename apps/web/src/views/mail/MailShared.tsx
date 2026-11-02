import { StyledSelect } from '../../components/controls/StyledSelect'
import { PageSkeleton } from '../../components/PageSkeleton'
import { ArrowLeft, Mail, MailOpen, Reply, Save, Upload } from '../../icons'
import type { useMail } from './useMail'

export type MailHook = ReturnType<typeof useMail>

const senderName = (sender: string) => sender.replace(/\s*<[^>]*>\s*$/, '').trim() || sender
const senderEmail = (sender: string) => sender.match(/<([^>]+)>/)?.[1] ?? (sender.includes('@') ? sender : '')
// Design wording: today shows the time, the last week the weekday, older mail "Oct 26".
function mailWhen(iso: string): string {
  const date = new Date(iso), now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 864e5)
  if (days === 0) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return days > 0 && days < 7 ? date.toLocaleDateString('en-US', { weekday: 'short' }) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function MailHeader(m: MailHook) {
  const { phase, loading, notice, compose, recipients, subject, content, setCompose, setReaderOpen, upload, importFile, load, setPhase, setNotice } = m
  return <>
    <input ref={upload} type="file" accept=".eml,message/rfc822" aria-label="Import EML file" hidden onChange={(event) => void importFile(event)} />
    {notice && <p role="status">{notice}</p>}
    {!compose && (recipients || subject || content) && <p role="status">Compose draft kept. <button type="button" onClick={() => { setCompose(true); setReaderOpen(true) }}>Resume draft</button></p>}
    {loading && <PageSkeleton kind="split" label="mail" phase={phase === 'error' ? 'error' : 'loading'} onRetry={() => { setPhase('loading'); setNotice(''); void load() }} />}
  </>
}

export function MailAccounts({ accounts }: MailHook) {
  return accounts.length > 0 ? <>
    <div className="actual-folder-heading">Accounts</div>
    {accounts.map((account) => <div className="actual-mail-account" key={account.id}><span className="actual-account-icon"><Mail size={16} /></span><div><strong>{account.provider === 'gmail' ? 'Gmail' : account.provider}</strong><span>{account.external_id}</span>{account.connection_status === 'connected' ? <small className="actual-account-ok"><i />Read &amp; drafts</small> : <small>{account.connection_status}</small>}</div></div>)}
  </> : null
}

export function MailToolsBody(m: MailHook) {
  const { apiStatus, busy, gmailConfigured, gmailAccount, setGmailAccount, accounts, nextPages, connect, sync, loadGmailDrafts, disconnect } = m
  return <>
    <div className="actual-actions"><button className="button button--quiet" disabled={busy || apiStatus !== 'ready' || !gmailConfigured} onClick={() => void connect()}>Connect Gmail</button><StyledSelect aria-label="Gmail account" value={gmailAccount} onChange={(event) => setGmailAccount(event.target.value)}><option value="">Select connected Gmail</option>{accounts.filter((item) => item.provider === 'gmail' && item.connection_status === 'connected').map((item) => <option key={item.id} value={item.id}>{item.external_id}</option>)}</StyledSelect><button className="button button--quiet" disabled={busy || !gmailAccount || apiStatus !== 'ready'} onClick={() => void sync()}>Load latest Gmail</button>{nextPages[gmailAccount] && <button className="button button--quiet" disabled={busy} onClick={() => void sync(true)}>Load older mail</button>}<button className="button button--quiet" disabled={busy || !gmailAccount || apiStatus !== 'ready'} onClick={() => void loadGmailDrafts()}>Load Gmail drafts</button>{nextPages[`${gmailAccount}:drafts`] && <button className="button button--quiet" disabled={busy} onClick={() => void loadGmailDrafts(true)}>Load older drafts</button>}<button className="button button--quiet" disabled={busy || !gmailAccount} onClick={() => void disconnect()}>Disconnect Gmail</button></div>
    <p className="connected-help">Gmail loads 25 messages per page into your Aelys store. Disconnecting removes access; loaded mail and local drafts stay here. Save replies locally or explicitly save a draft in Gmail. Sending is unavailable.</p>
    {!gmailConfigured && <p className="connected-help">Gmail needs server setup before you can connect your account. You can import EML files while it is being configured.</p>}
  </>
}

export function MailRows(m: MailHook) {
  const { tab, visible, visibleDrafts, drafts, busy, selected, query, setSelectedId, setCompose, setReaderOpen, edit } = m
  return <>
    {tab === 'inbox' ? visible.map((item) => { const unread = item.is_read === false; return <button key={item.id} className={`actual-mail-row${unread ? ' actual-mail-row--unread' : ''}`} aria-pressed={selected?.id === item.id} disabled={busy} onClick={() => { setSelectedId(item.id); setCompose(false); setReaderOpen(true) }}><span className="actual-avatar" aria-hidden="true">{senderName(item.sender).charAt(0).toUpperCase()}</span><span className="actual-mail-row-text"><span className="actual-row-top">{unread && <i className="actual-unread-dot" />}<strong>{senderName(item.sender)}</strong><time>{mailWhen(item.received_at)}</time></span><span className="actual-row-subject">{item.subject || '(No subject)'}</span><span className="actual-row-snippet">{item.thread_id && drafts.some((draft) => draft.thread_id === item.thread_id) && <em>Draft</em>}<small>{item.body.replace(/\s+/g, ' ')}</small></span></span></button> }) : visibleDrafts.map((draft) => <button key={draft.id} className="actual-mail-row" disabled={busy} onClick={() => edit(draft)}><span className="actual-avatar" aria-hidden="true">{(draft.recipients[0] || 'D').charAt(0).toUpperCase()}</span><span className="actual-mail-row-text"><strong>{draft.recipients.join(', ') || 'No recipient yet'}</strong><span>{draft.subject || '(No subject)'}</span><small>{draft.content}</small></span></button>)}
    {(tab === 'inbox' ? visible : visibleDrafts).length === 0 && <p className="actual-empty">{query ? 'No mail matches. Try another folder or search.' : tab === 'inbox' ? 'No imported messages.' : 'No drafts yet.'}</p>}
  </>
}

export function MailReader(m: MailHook) {
  const { apiStatus, busy, selectedId, setReaderOpen, compose, editing, recipients, setRecipients, subject, setSubject, content, setContent, setCompose, save, discard, gmailAccount, tab, selected, accounts, replyText, setReplyText, replyDrafts, saveReply, edit } = m
  return <>
    <button className="button button--quiet actual-back" onClick={() => setReaderOpen(false)}><ArrowLeft size={16} />Back to list</button>{compose ? <form className="settings-form" onSubmit={save}><h2>{editing ? 'Edit draft' : 'New draft'}</h2><label>To (comma separated)<input aria-label="Draft recipients" value={recipients} onChange={(event) => setRecipients(event.target.value)} /></label><label>Subject<input aria-label="Draft subject" value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label>Message<textarea aria-label="Draft message" rows={10} value={content} onChange={(event) => setContent(event.target.value)} /></label><div className="provider-actions"><button className="button button--primary" type="submit" disabled={busy || apiStatus !== 'ready'}>{busy ? 'Saving…' : 'Save draft'}</button><button className="button button--quiet" type="button" disabled={busy || !gmailAccount || apiStatus !== 'ready'} onClick={(event) => void save(event, true)}>Save to Gmail</button><button className="button button--quiet" type="button" disabled={busy} onClick={() => setCompose(false)}>Close</button>{editing && <button className="button button--quiet" type="button" disabled={busy || apiStatus !== 'ready'} onClick={() => void discard(editing)}>Discard local draft</button>}</div></form> : tab === 'inbox' && selected ? <article><div className="actual-reader-head"><h2>{selected.subject || '(No subject)'}</h2><div className="actual-sender"><span className="actual-avatar" aria-hidden="true">{senderName(selected.sender).charAt(0).toUpperCase()}</span><p><strong>{senderName(selected.sender)}</strong><span>{senderEmail(selected.sender) || `To: ${selected.recipients.join(', ')}`}</span></p><span className="actual-acc-chip">{accounts.find((account) => account.id === selected.account_id)?.provider === 'gmail' ? 'Gmail' : 'Imported'}</span><time>{mailWhen(selected.received_at)}</time></div></div><div className="mail-body">{selected.body}</div><form className="actual-reply" onSubmit={saveReply}><div className="actual-reply-heading"><Reply size={16} /><strong>Reply draft</strong><em data-state={replyDrafts[selected.id] ? 'saved' : 'none'}>{replyDrafts[selected.id] ? 'Saved' : 'No draft'}</em><button type="button" className="actual-reply-details" onClick={() => { edit(); setRecipients(selected.sender.match(/<([^>]+)>/)?.[1] ?? selected.sender); setSubject(/^Re:/i.test(selected.subject) ? selected.subject : `Re: ${selected.subject}`); setContent(replyText[selected.id] ?? '') }}>Edit reply details</button></div><textarea aria-label="Reply draft" rows={4} placeholder="Write a reply… it stays here even if you switch emails" value={replyText[selected.id] ?? replyDrafts[selected.id]?.content ?? ''} onChange={(event) => setReplyText((values) => ({ ...values, [selected.id]: event.target.value }))}/><div className="actual-reply-actions"><span>Nothing is sent from Aelys.</span><button className="button button--quiet" type="submit" disabled={busy || apiStatus !== 'ready'}><Save size={15} />Save draft</button>{gmailAccount && <button className="button button--primary" type="button" disabled={busy || apiStatus !== 'ready'} onClick={(event) => void saveReply(event, true)}><Upload size={15} />Put in Gmail drafts</button>}</div></form></article> : <p className="actual-reader-none"><MailOpen size={32} />{tab === 'drafts' ? 'Select a draft to edit it.' : selectedId ? 'Message not found in loaded mail.' : 'Select an email to read'}</p>}
  </>
}
