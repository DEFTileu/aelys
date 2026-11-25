import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AiDesktop } from '../views/ai/AiView.desktop'
import { AiMobile } from '../views/ai/AiView.mobile'

const client = vi.hoisted(() => ({ aiProviders: vi.fn(), aiConversations: vi.fn(), aiMessages: vi.fn(), aiConversationActions: vi.fn(), createAIRun: vi.fn(), aiRunEvents: vi.fn(), aiVoiceTranscribe: vi.fn(), aiVoiceSpeak: vi.fn() }))
const identity = vi.hoisted(() => ({ value: '' }))
const media = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), play: vi.fn(), pause: vi.fn(), supported: true }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client, getDraftPartition: async (kind: string) => JSON.stringify(['web', 'backend', identity.value, kind]) }))
vi.mock('../views/english/speech', () => ({ recordingSupported: () => media.supported, startRecording: media.start, formatClock: (s: number) => `0:${String(s).padStart(2, '0')}` }))
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const click = async (label: string) => act(async () => { const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(button).not.toBeNull(); button!.click() })
async function render(mobile = false) {
  await act(async () => root.render(mobile ? <AiMobile apiStatus="ready" /> : <AiDesktop apiStatus="ready" />))
  await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')?.disabled).toBe(false))
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.includes('First chat'))!.click() })
  await vi.waitFor(() => expect(host.textContent).toContain('Existing answer'))
}
beforeEach(() => {
  vi.resetAllMocks(); media.supported = true; localStorage.clear(); identity.value = crypto.randomUUID()
  client.aiProviders.mockResolvedValue([{ id: 'p', kind: 'claude', enabled: true, has_secret: true, model_policy: {} }])
  client.aiConversations.mockResolvedValue([{ id: 'one', title: 'First chat' }, { id: 'two', title: 'Second chat' }])
  client.aiMessages.mockResolvedValue([{ id: 'a', role: 'assistant', content: 'Existing answer' }])
  client.aiConversationActions.mockResolvedValue([])
  client.createAIRun.mockImplementation(async () => { client.aiMessages.mockResolvedValue([{ id: 'a', role: 'assistant', content: 'Existing answer' }, { id: 'b', role: 'assistant', content: 'New answer' }]); return { id: 'run' } })
  client.aiRunEvents.mockResolvedValue(new Response('event: ai.run.completed\ndata: {}\n\n'))
  client.aiVoiceTranscribe.mockResolvedValue({ text: 'Spoken question' })
  client.aiVoiceSpeak.mockResolvedValue({ audio: 'YQ==', content_type: 'audio/mpeg' })
  media.start.mockResolvedValue({ stop: media.stop, cancel: media.cancel }); media.stop.mockResolvedValue(new Blob(['audio']))
  media.play.mockResolvedValue(undefined)
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:voice'); static revokeObjectURL = vi.fn() })
  vi.stubGlobal('Audio', class { play = media.play; pause = media.pause; onended: (() => void) | null = null; onerror: (() => void) | null = null })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers() })

it.each([false, true])('records and sends a spoken question, then reads its answer (mobile: %s)', async (mobile) => {
  await render(mobile)
  await click('Record voice'); await click('Stop recording')
  await vi.waitFor(() => expect(client.createAIRun).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: 'one', message: 'Spoken question' }), expect.anything()))
  await vi.waitFor(() => expect(client.aiVoiceSpeak).toHaveBeenCalledWith('New answer'))
})

it('reads and stops an existing answer', async () => {
  await render(); await click('Read aloud')
  await vi.waitFor(() => expect(media.play).toHaveBeenCalled())
  await click('Stop reading'); expect(media.pause).toHaveBeenCalled(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice')
})

it('discards a transcription when the conversation changes', async () => {
  let resolve!: (value: { text: string }) => void
  client.aiVoiceTranscribe.mockReturnValue(new Promise(r => { resolve = r }))
  await render(); await click('Record voice'); await click('Stop recording')
  await vi.waitFor(() => expect(client.aiVoiceTranscribe).toHaveBeenCalled())
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.includes('Second chat'))!.click(); resolve({ text: 'stale' }) })
  expect(client.createAIRun).not.toHaveBeenCalled()
})

it('cancels a microphone that becomes available after switching chats', async () => {
  let resolve!: (value: { stop: typeof media.stop; cancel: typeof media.cancel }) => void
  media.start.mockReturnValue(new Promise(r => { resolve = r }))
  await render(); await click('Record voice')
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.includes('Second chat'))!.click(); resolve({ stop: media.stop, cancel: media.cancel }) })
  expect(media.cancel).toHaveBeenCalled()
  expect(client.aiVoiceTranscribe).not.toHaveBeenCalled()
})

it('does not play pending speech after switching chats', async () => {
  let resolve!: (value: { audio: string; content_type: string }) => void
  client.aiVoiceSpeak.mockReturnValue(new Promise(r => { resolve = r }))
  await render(); await click('Read aloud')
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.includes('Second chat'))!.click(); resolve({ audio: 'YQ==', content_type: 'audio/mpeg' }) })
  expect(media.play).not.toHaveBeenCalled()
})

it('automatically stops recording after 60 seconds', async () => {
  await render(); vi.useFakeTimers(); await click('Record voice')
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(media.stop).toHaveBeenCalledTimes(1)
  expect(client.aiVoiceTranscribe).toHaveBeenCalledTimes(1)
})

it('shows a microphone permission notice', async () => {
  media.start.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
  await render(); await click('Record voice')
  expect(host.textContent).toContain('Microphone access denied')
})

it('ignores pending speech on unmount', async () => {
  let resolve!: (value: { audio: string; content_type: string }) => void
  client.aiVoiceSpeak.mockReturnValue(new Promise(r => { resolve = r }))
  await render(); await click('Read aloud')
  await act(async () => { root.unmount(); resolve({ audio: 'YQ==', content_type: 'audio/mpeg' }) })
  expect(media.play).not.toHaveBeenCalled()
  root = createRoot(host)
})


it('hides the microphone when recording is unsupported', async () => {
  media.supported = false; await render()
  expect(host.querySelector('[aria-label="Record voice"]')).toBeNull()
})

it.each([['VOICE_NOT_CONFIGURED', 'Add an ElevenLabs key in Settings › AI & models'], ['BUDGET_EXCEEDED', 'Voice budget exceeded']])('shows a clear notice for %s', async (code, message) => {
  client.aiVoiceSpeak.mockRejectedValue({ code })
  await render(); await click('Read aloud')
  expect(host.textContent).toContain(message)
})

it('invalidates pending speech when the session changes', async () => {
  let resolve!: (value: { audio: string; content_type: string }) => void
  client.aiVoiceSpeak.mockReturnValue(new Promise(r => { resolve = r }))
  await render(); await click('Read aloud')
  await act(async () => { window.dispatchEvent(new Event('aelys:session-changed')); resolve({ audio: 'YQ==', content_type: 'audio/mpeg' }) })
  expect(media.play).not.toHaveBeenCalled()
})

it('blocks typed sends while a voice question is being transcribed', async () => {
  let resolve!: (value: { text: string }) => void
  client.aiVoiceTranscribe.mockReturnValue(new Promise(r => { resolve = r }))
  await render(); await click('Record voice'); await click('Stop recording')
  await act(async () => {
    const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Message Aelys"]')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Competing message')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true)
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(client.createAIRun).not.toHaveBeenCalled()
  await act(async () => resolve({ text: 'Spoken question' }))
  await vi.waitFor(() => expect(client.createAIRun).toHaveBeenCalledWith(expect.objectContaining({ message: 'Spoken question' }), expect.anything()))
})
