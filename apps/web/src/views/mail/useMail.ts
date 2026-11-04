import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { ApiError, type MailAccount, type MailDraft, type MailMessage } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import { useDebouncedQuery, usePagedCollection } from '../../lib/usePagedCollection'
import type { ApiStatus } from '../../types'

export const senderName = (sender: string) => sender.replace(/\s*<[^>]*>\s*$/, '').trim() || sender
export const senderEmail = (sender: string) => sender.match(/<([^>]+)>/)?.[1] ?? (sender.includes('@') ? sender : '')
// Design wording: today shows the time, the last week the weekday, older mail "Oct 26".
export function mailWhen(iso: string): string {
  const date = new Date(iso), now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 864e5)
  if (days === 0) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return days > 0 && days < 7 ? date.toLocaleDateString('en-US', { weekday: 'short' }) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function useMail(apiStatus: ApiStatus) {
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
  const [replyOpen, setReplyOpen] = useState(false)
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
  useEffect(() => { setReplyOpen(false) }, [selected?.id])
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
  return { drafts, accounts, gmailAccount, nextPages, tab, setTab, query, setQuery, selectedId, setSelectedId, editing, compose, setCompose, readerOpen, setReaderOpen, replyOpen, setReplyOpen, replyText, setReplyText, replyDrafts, recipients, setRecipients, subject, setSubject, content, setContent, busy, notice, setNotice, setPhase, collection, messages, phase, upload, load, visible, visibleDrafts, selected, edit, save, saveReply, importFile, discard, sync, closeMenu }
}
