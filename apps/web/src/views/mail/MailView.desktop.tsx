import { StyledSelect } from '../../components/controls/StyledSelect'
import { ApiStatusPill } from '../../components/ApiStatusPill'
import { FileUp, Inbox, Search, Save, ShieldCheck, SquarePen } from '../../icons'
import type { ApiStatus } from '../../types'
import '../connected.css'
import '../actual-mail-finance.css'
import '../desktop/page-tokens.css'
import '../desktop/mail.css'
import { MailAccounts, MailHeader, MailReader, MailRows, MailToolsBody } from './MailShared'
import { useMail } from './useMail'

export function MailDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const m = useMail(apiStatus)
  const { busy, loading, readerOpen, upload, tab, setTab, query, setQuery, setCompose, setReaderOpen, edit, messages, drafts, load } = m
  return <div className="connected-workspace actual-workspace actual-mail">
    <MailHeader {...m} />
    <div hidden={loading} className={`actual-mail-grid ${readerOpen ? 'actual-reader-open' : ''}`}>
      <aside className="actual-panel actual-folders"><button className="button actual-import" disabled={busy || apiStatus !== 'ready'} onClick={() => upload.current?.click()}><FileUp size={16} />Import .eml</button><div className="actual-folder-heading">Mailboxes</div><nav aria-label="Mail folders">{(['inbox', 'drafts'] as const).map((folder) => { const count = folder === 'inbox' ? messages.filter((item) => item.is_read === false).length : drafts.length; return <button key={folder} type="button" aria-pressed={tab === folder} onClick={() => { setTab(folder); setCompose(false); setReaderOpen(false) }}>{folder === 'inbox' ? <Inbox size={16} /> : <Save size={16} />}<span className="actual-folder-name">{folder === 'inbox' ? 'Inbox' : 'Drafts'}</span><span>{count || ''}</span></button> })}</nav><MailAccounts {...m} /><div className="actual-topline actual-topline--panel"><ApiStatusPill status={apiStatus} /><button className="button button--quiet" disabled={busy} onClick={() => void load()}>Refresh</button><details className="actual-mail-tools"><summary>Mail tools</summary><MailToolsBody {...m} /></details></div><p className="actual-mail-policy"><ShieldCheck size={14} />Aelys reads mail and prepares drafts. It never sends email.</p></aside>
      <section className="actual-panel actual-mail-list" aria-label={tab === 'inbox' ? 'Messages' : 'Drafts'}><div className="actual-mobile-mail-actions"><button className="button button--primary" disabled={busy} onClick={() => edit()}>Compose</button><button className="button button--quiet" disabled={busy || apiStatus !== 'ready'} onClick={() => upload.current?.click()}>Import .eml</button></div><div className="actual-mobile-folders" aria-label="Mail folders">{(['inbox', 'drafts'] as const).map((folder) => <button type="button" key={folder} aria-pressed={tab === folder} onClick={() => { setTab(folder); setCompose(false); setReaderOpen(false) }}>{folder === 'inbox' ? 'Inbox' : 'Drafts'}</button>)}</div><label className="actual-search"><Search size={16} /><input aria-label="Search mail" placeholder="Search mail" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" className="actual-compose-icon" aria-label="Compose" title="Compose a new draft" disabled={busy} onClick={() => edit()}><SquarePen size={16} /></button></label><div className="actual-folder-select">Folder<StyledSelect aria-label="Mail folder" value={tab} onChange={(event) => { setTab(event.target.value as 'inbox' | 'drafts'); setCompose(false); setReaderOpen(false) }}><option value="inbox">Inbox</option><option value="drafts">Drafts</option></StyledSelect></div><MailRows {...m} /></section>
      <section className="actual-panel actual-mail-reader"><MailReader {...m} /></section>
    </div>
  </div>
}
