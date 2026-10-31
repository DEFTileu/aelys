import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { UtilitiesView } from '../views/UtilitiesView'

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement
async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<UtilitiesView />)) }
const button = (name: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(name) || item.getAttribute('aria-label') === name)!
const input = () => host.querySelector<HTMLTextAreaElement>('textarea')!
const output = () => host.querySelectorAll<HTMLTextAreaElement>('textarea')[1]
async function click(name: string) { await act(async () => button(name).click()) }
async function type(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })) }) }
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('works offline without API, storage, or AI calls and clears content on unmount', async () => {
  const network = vi.fn(() => { throw new Error('Unexpected network call') }); vi.stubGlobal('fetch', network)
  const local = vi.spyOn(Storage.prototype, 'setItem')
  await mount()
  expect(host.querySelector<HTMLInputElement>('#generated-password')!.value.length).toBe(20)
  await click('Base64'); await type('Привет 🌙'); await click('Reverse')
  expect(output().value).toBe('Привет 🌙')
  expect(network).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled()
  act(() => root!.unmount()); root = undefined
  await mount(); await click('Base64'); expect(input().value).toBe(''); expect(output().value).toBe('')
})
it('regenerates for changed settings and blocks empty selections', async () => {
  await mount()
  for (const name of ['Uppercase letters', 'Lowercase letters', 'Symbols']) await click(name)
  expect(host.querySelector<HTMLInputElement>('#generated-password')!.value).toMatch(/^\d{20}$/)
  await click('Numbers')
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('Choose at least one')
  expect(button('Copy password').disabled).toBe(true)
  expect(host.querySelector<HTMLInputElement>('#generated-password')!.value).toBe('')
  await click('Numbers'); expect(button('Copy password').disabled).toBe(false)
})
it('never renders decoded HTML and disables copying invalid results', async () => {
  await mount(); await click('HTML entities'); await click('Decode'); await type('&lt;img src=x onerror=alert(1)&gt;')
  expect(output().value).toBe('<img src=x onerror=alert(1)>'); expect(host.querySelector('img')).toBeNull()
  await type('&#x110000;'); expect(host.querySelector('[role="alert"]')).not.toBeNull()
  expect(output().value).toBe(''); expect(button('Copy result').disabled).toBe(true)
})
it('reports clipboard success and failure honestly', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  await mount(); await click('Base64'); await type('Hello'); await click('Copy result')
  expect(writeText).toHaveBeenCalledWith('SGVsbG8='); expect(host.querySelector('[role="status"]')!.textContent).toContain('Copied')
  writeText.mockRejectedValue(new Error('Permission denied')); await click('Copy result')
  expect(host.querySelector('[role="status"]')!.textContent).toContain('Clipboard unavailable')
})
it('discards stale clipboard feedback when content changes', async () => {
  let resolve!: () => void
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>(done => { resolve = done }) } })
  await mount(); await click('Base64'); await type('Hello'); await click('Copy result'); await type('Changed')
  await act(async () => resolve())
  expect(host.querySelector('[role="status"]')).toBeNull()
})
