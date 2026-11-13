import { useState } from 'react'
import { Plus } from '../../../icons'
import { companion } from '../../../lib/companion/api'
import type { CompanionState, IceContact } from '../../../lib/companion/types'
import { Card, Group, SwitchRow } from '../ui'

// The limits the board's ICE card has room for (companion protocol: ice_update).
const MAX_CONTACTS = 2, MAX_NAME = 32, MAX_RELATION = 16, MAX_PHONE = 23, MAX_NOTE = 96
const FAILED = 'Something went wrong. Check the connection and try again.'
const INCOMPLETE = 'Each contact needs a name and a phone number.'
type Draft = Required<IceContact>

interface Props { state: CompanionState; ownerName: string | null | undefined; refresh: () => Promise<void> }

export function EmergencyPage({ state, ownerName, refresh }: Props) {
  // The form starts from what the server holds and is not overwritten by later polls while the owner edits.
  const [contacts, setContacts] = useState<Draft[]>(() => (state.ice?.contacts ?? []).map((c) => ({ name: c.name, relation: c.relation ?? '', phone: c.phone })))
  const [note, setNote] = useState(state.ice?.med_note ?? '')
  const [show, setShow] = useState({ name: state.ice?.show_name ?? true, contacts: state.ice?.show_contacts ?? true, med: state.ice?.show_med ?? true })
  const [open, setOpen] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const name = ownerName ?? state.ice?.owner_name

  const edit = (next: Draft[]) => { setContacts(next); setSaved(false); setError('') }
  const change = (i: number, field: keyof Draft, value: string) => edit(contacts.map((c, j) => (j === i ? { ...c, [field]: value } : c)))
  const toggle = (key: keyof typeof show, value: boolean) => { setShow({ ...show, [key]: value }); setSaved(false) }

  const save = async () => {
    const kept = contacts.map((c) => ({ name: c.name.trim(), relation: c.relation.trim(), phone: c.phone.trim() })).filter((c) => c.name || c.phone || c.relation)
    if (kept.some((c) => !c.name || !c.phone)) { setError(INCOMPLETE); return }
    setBusy(true); setError('')
    try {
      await companion.setIce(state.device_id, { owner_name: name ?? undefined, contacts: kept, med_note: note, show_name: show.name, show_contacts: show.contacts, show_med: show.med })
      setContacts(kept); setOpen(null); setSaved(true)
      await refresh()
    } catch { setError(FAILED) }
    setBusy(false)
  }

  return <>
    <div className="st-sub">Opens on Aelys when both buttons are held for 2 s</div>
    <Group title="Emergency contacts">
      <Card>
        {contacts.map((c, i) => <div key={i}>
          <button type="button" className="st-row dv-nav" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
            <span className={`dv-av${i % 2 ? ' dv-av--blue' : ''}`} aria-hidden="true">{(c.name.trim()[0] ?? '+').toUpperCase()}</span>
            <span className="st-grow"><span className="st-label">{c.name || 'New contact'}</span><span className="st-hint">{[c.relation, c.phone].filter(Boolean).join(' · ') || 'Tap to edit'}</span></span>
          </button>
          {open === i && <div className="dv-edit">
            <input className="st-input" aria-label={`Contact ${i + 1} name`} placeholder="Name" maxLength={MAX_NAME} value={c.name} disabled={busy} onChange={(e) => change(i, 'name', e.target.value)} />
            <input className="st-input" aria-label={`Contact ${i + 1} relation`} placeholder="Relation" maxLength={MAX_RELATION} value={c.relation} disabled={busy} onChange={(e) => change(i, 'relation', e.target.value)} />
            <input className="st-input" aria-label={`Contact ${i + 1} phone`} placeholder="Phone" inputMode="tel" maxLength={MAX_PHONE} value={c.phone} disabled={busy} onChange={(e) => change(i, 'phone', e.target.value)} />
            <button type="button" className="st-btn st-btn--danger" disabled={busy} onClick={() => { edit(contacts.filter((_, j) => j !== i)); setOpen(null) }}>Remove contact</button>
          </div>}
        </div>)}
        {contacts.length < MAX_CONTACTS && <button type="button" className="st-row st-row--56 dv-nav dv-add" disabled={busy} onClick={() => { edit([...contacts, { name: '', relation: '', phone: '' }]); setOpen(contacts.length) }}><Plus size={18} aria-hidden="true" />Add contact</button>}
      </Card>
    </Group>
    <Group title="Medical notes">
      <Card><div className="st-block">
        <label className="st-hint" htmlFor="dv-med">Optional. Only what you'd want a stranger to see</label>
        <textarea id="dv-med" className="st-textarea dv-med" maxLength={MAX_NOTE} value={note} disabled={busy} onChange={(e) => { setNote(e.target.value.slice(0, MAX_NOTE)); setSaved(false) }} />
      </div></Card>
    </Group>
    <Group title="Show on Aelys card">
      <Card>
        <SwitchRow title="Your name" hint={name || 'Not set'} checked={show.name} disabled={busy} onChange={(v) => toggle('name', v)} />
        <SwitchRow title="Contacts" hint="Name, relation and phone" checked={show.contacts} disabled={busy} onChange={(v) => toggle('contacts', v)} />
        <SwitchRow title="Medical notes" hint="Shown under the contacts" checked={show.med} disabled={busy} onChange={(v) => toggle('med', v)} />
      </Card>
    </Group>
    {error && <div className="st-error" role="alert">{error}</div>}
    {saved && <div className="st-note dv-center" role="status">Saved</div>}
    <button type="button" className="st-btn st-btn--primary dv-wide" disabled={busy} onClick={() => void save()}>Save</button>
  </>
}
