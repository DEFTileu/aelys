import { useIsMobile } from '../lib/useIsMobile'
import type { ApiStatus } from '../types'
import { NotesDesktop } from './notes/NotesView.desktop'
import { NotesMobile } from './notes/NotesView.mobile'

export function NotesView({ apiStatus }: { apiStatus: ApiStatus }) {
  return useIsMobile() ? <NotesMobile apiStatus={apiStatus} /> : <NotesDesktop apiStatus={apiStatus} />
}
