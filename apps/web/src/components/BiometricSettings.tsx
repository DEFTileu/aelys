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
      (reason: unknown) => { if (alive) setError(isKeychainAccessRequired(reason) ? KEYCHAIN_ACCESS_NOTICE : 'Не удалось проверить Touch ID. Откройте настройки ещё раз.') },
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
      setError(isKeychainAccessRequired(reason) ? KEYCHAIN_ACCESS_NOTICE : 'Не удалось изменить настройку Touch ID. Попробуйте ещё раз.')
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
    <h2>Безопасность</h2>
    {!status && !error && <p role="status">Проверяем Touch ID…</p>}
    {status?.supported && <div className="settings-form">
      <p>Открывайте сохранённую сессию с Touch ID после перезапуска приложения. Вход с паролем Aelys остаётся доступен.</p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <span>Touch ID</span>
        <Switch label="Touch ID" checked={status.enabled} disabled={!status.available && !status.enabled} pending={pending} onCheckedChange={() => void change()} />
      </div>
      {!status.available && <p className="field-help">Touch ID недоступен. Проверьте настройки устройства.</p>}
      {pending && <p role="status">Подтвердите изменение на устройстве…</p>}
    </div>}
    {status && !status.supported && <p>Touch ID не поддерживается на этом устройстве.</p>}
    {error && <p role="alert">{error}</p>}
    {error === KEYCHAIN_ACCESS_NOTICE && <KeychainAccessRecovery pending={pending} onAuthorize={() => void authorizeKeychain()} />}
  </section>
}
