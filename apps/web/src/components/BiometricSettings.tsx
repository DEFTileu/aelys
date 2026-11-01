import { useEffect, useState } from 'react'
import { getApiConfig } from '../lib/api'
import { isKeychainAccessRequired, KEYCHAIN_ACCESS_NOTICE, loadNativeTransport, nativeBackendOrigin, type BiometricStatus } from '../lib/nativeTransport'
import { Switch } from './Switch'
import { KeychainAccessRecovery } from './KeychainAccessRecovery'

export function BiometricSettings() {
  const [status, setStatus] = useState<BiometricStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const origin = nativeBackendOrigin(getApiConfig().baseUrl)

  useEffect(() => {
    let alive = true
    void loadNativeTransport().then((transport) => transport.biometricStatus(origin)).then(
      (value) => { if (alive) setStatus(value) },
      (reason: unknown) => { if (alive) setError(isKeychainAccessRequired(reason) ? KEYCHAIN_ACCESS_NOTICE : 'Could not check Touch ID. Open settings again.') },
    )
    return () => { alive = false }
  }, [origin])

  const change = async () => {
    if (!status || pending) return
    setPending(true); setError('')
    try {
      const transport = await loadNativeTransport()
      setStatus(await transport.setBiometric(origin, !status.enabled))
    } catch (reason) {
      setError(isKeychainAccessRequired(reason) ? KEYCHAIN_ACCESS_NOTICE : 'Could not change the Touch ID setting. Try again.')
    } finally { setPending(false) }
  }

  const authorizeKeychain = async () => {
    if (pending) return
    setPending(true)
    try {
      const transport = await loadNativeTransport()
      await transport.authorizeKeychain(origin, 'touch_id_policy')
      setStatus(await transport.biometricStatus(origin))
      setError('')
    } catch {
      setError(KEYCHAIN_ACCESS_NOTICE)
    } finally { setPending(false) }
  }

  return <section className="settings-card">
    <h2>Security</h2>
    {!status && !error && <p role="status">Checking Touch ID…</p>}
    {status?.supported && <div className="settings-form">
      <p>Unlock your saved session with Touch ID after the app restarts. Signing in with your Aelys password stays available.</p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <span>Touch ID</span>
        <Switch label="Touch ID" checked={status.enabled} disabled={!status.available && !status.enabled} pending={pending} onCheckedChange={() => void change()} />
      </div>
      {!status.available && <p className="field-help">Touch ID is unavailable. Check your device settings.</p>}
      {pending && <p role="status">Confirm the change on your device…</p>}
    </div>}
    {status && !status.supported && <p>Touch ID is not supported on this device.</p>}
    {error && <p role="alert">{error}</p>}
    {error === KEYCHAIN_ACCESS_NOTICE && <KeychainAccessRecovery pending={pending} onAuthorize={() => void authorizeKeychain()} />}
  </section>
}
