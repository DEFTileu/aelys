import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeView } from '../views/KnowledgeView'

const client = vi.hoisted(() => ({ notes: vi.fn(), projects: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
const records = [
  { id: 'first', title: 'Alpha', markdown_body: '# Heading', parent_id: null, project_id: null, version: 1 },
  { id: 'second', title: 'Beta', markdown_body: 'Body text', parent_id: null, project_id: null, version: 2 },
]
let host: HTMLDivElement
let root: ReturnType<typeof createRoot> | undefined

async function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(<KnowledgeView apiStatus="ready" />)) }
function button(label: string) { return [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(label))! }

beforeEach(() => {
  vi.resetAllMocks()
  client.notes.mockResolvedValue(records)
  client.projects.mockResolvedValue([])
  window.history.replaceState({}, '', '/knowledge')
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 700px)', addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

describe('mobile knowledge', () => {
  it('shows the document list first and one document at a time', async () => {
    await mount()
    expect(host.querySelector('.knowledge-m')).not.toBeNull()
    expect(host.querySelector('.knowledge-grid')).toBeNull()
    expect(host.querySelectorAll('.knowledge-item')).toHaveLength(2)
    expect(host.querySelector('.knowledge-reader')).toBeNull()
    await act(async () => button('Beta').click())
    expect(host.querySelector('.knowledge-list')).toBeNull()
    expect(host.querySelector('.knowledge-content h1')?.textContent).toBe('Beta')
    await act(async () => button('Back').click())
    expect(host.querySelector('.knowledge-reader')).toBeNull()
    expect(host.querySelectorAll('.knowledge-item')).toHaveLength(2)
  })
})
