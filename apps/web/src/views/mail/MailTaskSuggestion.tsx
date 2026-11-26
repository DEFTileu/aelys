import { useState } from 'react'
import type { AIAction } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'

export function MailTaskSuggestion({ id, offline }: { id: string; offline: boolean }) {
  const [action, setAction] = useState<Pick<AIAction, 'id' | 'title' | 'summary' | 'status'> | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(decision?: 'approve' | 'reject') {
    setBusy(true)
    setNotice('')
    try {
      const api = getSharedApiClient()
      const result = decision && action
        ? await (decision === 'approve' ? api.approveAIAction(action.id) : api.rejectAIAction(action.id))
        : await api.suggestMailTask(id, Intl.DateTimeFormat().resolvedOptions().timeZone)
      setAction(result)
      if (!result) setNotice('No explicit task request found.')
    } catch {
      setNotice('Could not process this suggestion. Check the connection and source access.')
    } finally { setBusy(false) }
  }
  return <section aria-label="Task suggestion">
    {action ? <>
      <strong>{action.title}</strong>{action.summary && <p>Due {new Date(action.summary).toLocaleString()}</p>}
      <p><a href={`/mail?mail=${encodeURIComponent(id)}`}>Source message</a></p>
      {action.status === 'pending' ? <>
        <button disabled={busy || offline} onClick={() => void submit('approve')}>Create task</button>
        <button disabled={busy || offline} onClick={() => void submit('reject')}>Dismiss</button>
      </> : <p role="status">{{approved: 'Task created.', rejected: 'Suggestion dismissed.', failed: 'Task creation failed.'}[action.status]}</p>}
    </> : <button disabled={busy || offline} onClick={() => void submit()}>Suggest a task</button>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
