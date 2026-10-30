/** Fingerprint geometry and pending stroke sequence from the ACTUAL launch design. */
const PATHS = ['M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4', 'M14 13.12c0 2.38 0 6.38-1 8.88', 'M17.29 21.02c.12-.6.43-2.3.5-3.02', 'M2 12a10 10 0 0 1 18-6', 'M2 16h.01', 'M21.8 16c.2-2 .131-5.354 0-6', 'M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2', 'M8.65 22c.21-.66.45-1.32.57-2', 'M9 6.8a6 6 0 0 1 9 5.2v2'] as const

export function TouchIdIcon({ pending }: { pending: boolean }) {
  return <span className="auth-touch-id" aria-hidden="true">
    {pending && <span className="auth-touch-id__pulse" />}
    <svg className="auth-fingerprint" viewBox="0 0 24 24" width="52" height="52" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6">
      {PATHS.map(path => <path key={path} d={path} stroke="rgba(255,255,255,.55)" />)}
      {pending && PATHS.map((path, index) => <path className="auth-touch-id__stroke" key={path} d={path} pathLength="1" strokeDasharray="1" stroke="#fff" style={{ animationDelay: `${index * 60}ms` }} />)}
    </svg>
  </span>
}
