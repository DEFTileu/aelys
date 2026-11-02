import { Plus, Search } from '../../icons'
import type { ApiStatus } from '../../types'
import '../connected.css'
import '../actual-mail-finance.css'
import './mail-mobile.css'
import { MailAccounts, MailHeader, MailReader, MailRows, MailToolsBody } from './MailShared'
import { useMail } from './useMail'

// Mobile shows the list or the reader, never both; Compose is a FAB on the list screen.
export function MailMobile({ apiStatus }: { apiStatus: ApiStatus }) {
  const m = useMail(apiStatus)
  const { loading, readerOpen, busy, edit, tab, setTab, setCompose, setReaderOpen, query, setQuery, upload, load } = m
  return <div className="connected-workspace actual-workspace actual-mail mail-m">
    <MailHeader {...m} />
    <div className="mail-m-body" hidden={loading}>
      {readerOpen ? <section className="actual-panel actual-mail-reader"><MailReader {...m} /></section> : <>
        <div className="mail-m-folders" role="group" aria-label="Mail folders">{(['inbox', 'drafts'] as const).map((folder) => <button type="button" key={folder} aria-pressed={tab === folder} onClick={() => { setTab(folder); setCompose(false); setReaderOpen(false) }}>{folder === 'inbox' ? 'Inbox' : 'Drafts'}</button>)}</div>
        <label className="actual-search"><Search size={16} /><input aria-label="Search mail" placeholder="Search mail" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <section className="actual-panel actual-mail-list" aria-label={tab === 'inbox' ? 'Messages' : 'Drafts'}><MailRows {...m} /></section>
        <details className="mail-m-tools"><summary>Accounts and Gmail</summary>
          <div className="actual-actions"><button className="button button--quiet" disabled={busy} onClick={() => upload.current?.click()}>Import .eml</button><button className="button button--quiet" disabled={busy} onClick={() => void load()}>Refresh</button></div>
          <MailAccounts {...m} /><MailToolsBody {...m} />
        </details>
        <button type="button" className="mail-m-fab" aria-label="Compose" disabled={busy} onClick={() => edit()}><Plus size={24} /></button>
      </>}
    </div>
  </div>
}
