import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RichTextEditor } from '../components/RichTextEditor'
import { MarkdownContent } from '../components/MarkdownContent'

let root: Root | undefined
let host: HTMLDivElement
afterEach(() => { act(() => root?.unmount()); host?.remove() })
function mount(content: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(content))
}

describe('knowledge editor integration', () => {
  it('opens formatted documents without rewriting Markdown or emitting a save', () => {
    const change = vi.fn()
    const markdown = '# A heading\n\n**Important** [reference](https://example.com)\n\n- [ ] Check this\n\n```ts\nconst value = 1\n```\n\n| A | B |\n| --- | --- |\n| one | two |'
    mount(<RichTextEditor label="Document" value={markdown} onChange={change} />)
    expect(host.querySelector('[role="textbox"] strong')?.textContent).toBe('Important')
    expect(host.querySelector('pre')?.textContent).toContain('const value = 1')
    expect(host.querySelector('table')?.textContent).toContain('one')
    expect(host.querySelector('input[type=checkbox]')).not.toBeNull()
    expect(change).not.toHaveBeenCalled()
    const source = [...host.querySelectorAll('button')].find(button => button.textContent === 'Markdown')!
    act(() => source.click())
    expect(host.querySelector('textarea')?.value).toBe(markdown)
    expect(change).not.toHaveBeenCalled()
  })
  it('renders the same safe Markdown for reading and blocks remote image loads', () => {
    mount(<MarkdownContent text={'**bold**\n\n- item\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![private](https://tracker.example/pixel)'} />)
    expect(host.querySelector('strong')?.textContent).toBe('bold')
    expect(host.querySelector('li')?.textContent).toBe('item')
    expect(host.querySelector('script,iframe,img')).toBeNull()
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(host.textContent).toContain('Image: private')
  })
  it('replaces external content without publishing an intermediate or stale draft', () => {
    const change = vi.fn()
    mount(<RichTextEditor label="Document" value="**First**" onChange={change} />)
    act(() => root!.render(<RichTextEditor label="Document" value="**Second**" onChange={change} />))
    expect(host.querySelector('strong')?.textContent).toBe('Second')
    expect(change).not.toHaveBeenCalled()
  })
})
