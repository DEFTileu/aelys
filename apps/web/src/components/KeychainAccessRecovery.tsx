import './keychain-recovery.css'

export function KeychainAccessRecovery({ pending, onAuthorize }: { pending: boolean; onAuthorize: () => void }) {
  return <div className="keychain-recovery">
    <p>Разрешите Aelys открыть сохранённую сессию.</p>
    <button type="button" className="button button--quiet keychain-recovery__button" disabled={pending} onClick={onAuthorize}>{pending ? 'Ожидаем macOS…' : 'Разрешить доступ macOS'}</button>
    <details><summary>Какой пароль нужен?</summary><p>В окне macOS введите пароль связки «login» и выберите «Всегда разрешать». Обычно это пароль входа в Mac. Если он менялся, может понадобиться прежний. После пересборки приложения разрешение может потребоваться снова.</p></details>
  </div>
}
