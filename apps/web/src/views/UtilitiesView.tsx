import { useEffect, useMemo, useRef, useState } from 'react'
import { Code, Copy, Eye, EyeOff, Languages, Link } from 'lucide-react'
import { ArrowRight, Check, ChevronRight, Lock, RefreshCw, Search, Shield, Terminal, TriangleAlert } from '../icons'
import { Switch } from '../components/Switch'
import { SegmentedTabs } from '../components/ScreenToolbar'
import { generatePassword, MAX_UTILITY_INPUT, PASSWORD_GROUPS, transformText, UtilityError, type Codec, type Direction } from '../lib/utilities'
import './actual-settings.css'
import './utilities.css'

const tools = [
  { id: 'password', name: 'Password generator', description: 'Create a secure password', icon: Lock },
  { id: 'base64', name: 'Base64', description: 'Encode and decode UTF-8 text', icon: Terminal },
  { id: 'url', name: 'URL encoder', description: 'Escape URL components', icon: Link },
  { id: 'html', name: 'HTML entities', description: 'Basic entities and numeric references', icon: Code },
  { id: 'unicode', name: 'Unicode', description: 'Read and escape Unicode', icon: Languages },
] as const

type Tool = 'password' | Codec
const errorMessage = (error: unknown) => error instanceof UtilityError ? error.message : 'The tool is unavailable. Try again.'

/** Content stays in component memory; it never enters API, outbox, storage, or AI context. */
export function UtilitiesView() {
  const [tool, setTool] = useState<Tool>('password')
  const [query, setQuery] = useState('')
  const [length, setLength] = useState(20)
  const [groups, setGroups] = useState<readonly boolean[]>([true, true, true, true])
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [visible, setVisible] = useState(true)
  const [notice, setNotice] = useState('')
  const [direction, setDirection] = useState<Direction>('encode')
  const [source, setSource] = useState('')
  const [tooLarge, setTooLarge] = useState(false)
  const generation = useRef(0)
  const selected = tools.find(item => item.id === tool)!
  const Icon = selected.icon

  const regenerate = () => {
    generation.current++; setNotice('')
    try { setPassword(generatePassword({ length, groups })); setPasswordError('') }
    catch (error) { setPassword(''); setPasswordError(errorMessage(error)) }
  }
  // Changes invalidate the old result immediately, rather than leaving a password with stale settings.
  useEffect(() => { regenerate() }, [length, groups])
  useEffect(() => () => { generation.current++ }, [])

  const result = useMemo(() => {
    if (tooLarge) return { value: '', error: 'Use at most 65,536 input characters.' }
    if (tool === 'password') return { value: '', error: '' }
    try { return { value: transformText(tool, direction, source), error: '' } }
    catch (error) { return { value: '', error: errorMessage(error) } }
  }, [tool, direction, source, tooLarge])

  const changeContent = () => { generation.current++; setNotice('') }
  const copy = async (value: string) => {
    const current = generation.current
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(value)
      if (generation.current === current) setNotice('Copied to clipboard')
    } catch { if (generation.current === current) setNotice('Clipboard unavailable. Select the text and copy it manually.') }
  }

  return <>
    <div className="utilities-caption"><span>Everyday tools, right where you work.</span><span><Shield size={14} />Local only</span></div>
    <div className="actual-settings utilities-layout">
      <aside className="actual-settings-nav" aria-label="Utilities">
        <label className="actual-settings-search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a tool" aria-label="Find a tool" /></label>
        <nav aria-label="Tools">{tools.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())).map(item => <button type="button" key={item.id} aria-current={tool === item.id ? 'page' : undefined} onClick={() => { changeContent(); setTool(item.id); setDirection('encode'); setSource(''); setTooLarge(false) }}><item.icon size={20} /><span><strong>{item.name}</strong><small>{item.description}</small></span><ChevronRight size={16} className="utilities-tool-chevron" /></button>)}
          {!tools.some(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase())) && <p role="status">No matching tools.</p>}
        </nav>
      </aside>
      <div className="utilities-content">
        <section className="utilities-panel" data-glass="" aria-labelledby="utility-title">
          <header className="utilities-panel-heading"><span className="utilities-title-icon"><Icon size={20} /></span><div><h2 id="utility-title">{selected.name}</h2><p>{tool === 'password' ? 'Make it unique. Keep it yours.' : selected.description}</p></div></header>
          {tool === 'password' ? <>
            <div className="utilities-password-result"><label htmlFor="generated-password" className="utilities-field-label">Generated password</label><div className="utilities-password-line"><input id="generated-password" readOnly type={visible ? 'text' : 'password'} value={password} spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" /><button className="icon-button" type="button" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>{visible ? <Eye size={18} /> : <EyeOff size={18} />}</button></div><div className="utilities-result-actions"><button type="button" className="button button--primary" disabled={!password || !!passwordError} onClick={() => void copy(password)}><Copy size={16} />Copy password</button><button type="button" className="button button--quiet" onClick={regenerate}><RefreshCw size={16} />Regenerate</button></div></div>
            {passwordError && <p className="utilities-error" role="alert">{passwordError}</p>}
            <div className="utilities-length"><div><label htmlFor="password-length">Password length</label><output htmlFor="password-length">{length}</output></div><input id="password-length" type="range" min={8} max={64} value={length} onChange={event => setLength(Number(event.target.value))} /><div className="utilities-range-labels"><span>8 characters</span><span>64 characters</span></div></div>
            <div className="utilities-options">{PASSWORD_GROUPS.map((group, index) => <div className="utilities-option" key={group.name}><span><strong>{group.name}</strong><small>{group.sample}</small></span><Switch checked={groups[index]} label={group.name} onCheckedChange={value => setGroups(groups.map((enabled, position) => index === position ? value : enabled))} /></div>)}</div>
          </> : <>
            <div className="utilities-direction"><SegmentedTabs tabs={[{ id: 'encode', label: 'Encode' }, { id: 'decode', label: 'Decode' }]} value={direction} onChange={value => { changeContent(); setDirection(value) }} label="Conversion direction" /></div>
            <div className="utilities-code-grid"><label><span>Input</span><textarea value={source} onChange={event => { changeContent(); const value = event.target.value; setTooLarge(value.length > MAX_UTILITY_INPUT); setSource(value.slice(0, MAX_UTILITY_INPUT)) }} spellCheck={false} autoCorrect="off" autoCapitalize="off" aria-invalid={!!result.error} aria-describedby={result.error ? 'utility-input-error' : undefined} /></label><label><span>Output</span><textarea value={result.value} readOnly spellCheck={false} autoCorrect="off" autoCapitalize="off" /></label></div>
            {result.error && <p className="utilities-error" id="utility-input-error" role="alert">{result.error}</p>}
            <div className="utilities-code-actions"><button type="button" className="button button--primary" disabled={!result.value || !!result.error} onClick={() => void copy(result.value)}><Copy size={16} />Copy result</button><button type="button" className="button button--quiet" disabled={!result.value || !!result.error} onClick={() => { changeContent(); setSource(result.value.slice(0, MAX_UTILITY_INPUT)); setTooLarge(result.value.length > MAX_UTILITY_INPUT); setDirection(direction === 'encode' ? 'decode' : 'encode') }}><ArrowRight size={16} />Reverse</button></div>
          </>}
          {notice && <div className="utilities-message" role="status">{notice.startsWith('Copied') ? <Check size={15} /> : <TriangleAlert size={15} />}{notice}</div>}
        </section>
        <div className="utilities-local-note"><Shield size={15} /><span>Processed on your device. Nothing is sent or saved.</span></div>
      </div>
    </div>
  </>
}
