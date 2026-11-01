import './keychain-recovery.css'

export function KeychainAccessRecovery({ pending, onAuthorize }: { pending: boolean; onAuthorize: () => void }) {
  return <div className="keychain-recovery">
    <p>Allow Aelys to open your saved session.</p>
    <button type="button" className="button button--quiet keychain-recovery__button" disabled={pending} onClick={onAuthorize}>{pending ? 'Waiting for macOS…' : 'Allow macOS access'}</button>
    <details><summary>Which password do I need?</summary><p>In the macOS window, enter the "login" keychain password and choose "Always Allow". This is usually your Mac login password. If you changed it, you may need the old one. You may be asked again after the app is rebuilt.</p></details>
  </div>
}
