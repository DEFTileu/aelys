import { useEffect, useState } from 'react'
import { getApiConfig } from '../lib/api'
import { isKeychainAccessRequired, KEYCHAIN_ACCESS_NOTICE, loadNativeTransport, nativeBackendOrigin, type BiometricStatus } from '../lib/nativeTransport'
import { Lock } from '../icons'
import { Card, SwitchRow } from '../views/settings/ui'
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

  return <>
    {!status && !error && <Card><div className="st-msg" role="status">Checking Touch ID…</div></Card>}
    {status?.supported && <Card>
      <SwitchRow title="Unlock with Touch ID" hint="Instead of the password" checked={status.enabled} disabled={!status.available && !status.enabled} pending={pending} onChange={() => void change()} />
      {!status.available && <div className="st-msg">Touch ID is unavailable. Check your device settings.</div>}
      {pending && <div className="st-msg" role="status">Confirm the change on your device…</div>}
    </Card>}
    {status && !status.supported && <Card><div className="st-msg">Touch ID is not supported on this device.</div></Card>}
    {error && <Card>
      <div className="st-error" role="alert">{error}</div>
      {error === KEYCHAIN_ACCESS_NOTICE && <div className="st-pad"><KeychainAccessRecovery pending={pending} onAuthorize={() => void authorizeKeychain()} /></div>}
    </Card>}
    {status?.supported && <div className="st-note"><Lock size={14} aria-hidden="true" />Biometric data never leaves this Mac. Signing in with your Aelys password stays available.</div>}
  </>
}
