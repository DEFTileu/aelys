import { createContext } from 'react'

// A UI lifecycle signal, never native authority. AuthGate scopes this callback
// to one mounted authenticated view; no local session data crosses the boundary.
export const SessionReaderAuthContext = createContext<(() => void) | null>(null)
