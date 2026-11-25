import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AnswerActions } from '../views/ai/ChatParts'
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
beforeEach(async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<AnswerActions text="answer" feedback={null} canRegenerate={false} regenDisabled={false} canRate={false} onRegenerate={() => {}} onFeedback={() => {}} />))
})
afterEach(() => { act(() => root.unmount()); host.remove(); if (original) Object.defineProperty(navigator, 'clipboard', original); else delete (navigator as { clipboard?: Clipboard }).clipboard })
it('reports copied only after clipboard succeeds', async () => {
  let finish!: () => void
  const writeText = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy"]')!.click())
  expect(host.textContent).not.toContain('Copied'); expect(writeText).toHaveBeenCalledWith('answer')
  await act(async () => finish()); expect(host.textContent).toContain('Copied')
})
it.each(['failure', 'unavailable'])('shows error for clipboard %s', async mode => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'failure' ? { writeText: vi.fn().mockRejectedValue(new Error('denied')) } : undefined })
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy"]')!.click())
  expect(host.textContent).not.toContain('Copied'); expect(host.querySelector('[role="status"]')?.textContent).toContain('Could not copy')
})
