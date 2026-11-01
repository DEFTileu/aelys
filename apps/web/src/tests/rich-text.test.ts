import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, markdownToHtml, safeHref, sanitizeHtml } from '../lib/richText'

const roundTrip = (md: string) => htmlToMarkdown(markdownToHtml(md))

describe('markdown <-> html round trips', () => {
  it.each([
    '# Title',
    '## Subtitle',
    '### Third',
    'Plain paragraph',
    'Line one\nLine two',
    'First\n\nSecond',
    '**bold** and *italic* and ~~gone~~ and `code`',
    'See [Aelys](https://example.com/a?b=1) now',
    '- one\n- two\n- three',
    '1. first\n2. second',
    '- [ ] open\n- [x] done',
    '- parent\n  - child\n    - grandchild\n- next',
    '> quoted line\n>\n> second paragraph',
    '```\nconst a = 1\n\nif (a) { b() }\n```',
    'Above\n\n---\n\nBelow',
    '# Plan\n\nIntro with **bold**.\n\n- [ ] task\n- [x] shipped\n\n> note\n\n```\ncode\n```',
  ])('keeps %j stable', (md) => { expect(roundTrip(md)).toBe(md) })

  it('keeps literal markdown characters in text', () => {
    expect(roundTrip('2 * 3 = 6 and a\\_b and \\# not a heading')).toBe('2 \\* 3 = 6 and a_b and # not a heading')
    expect(roundTrip('snake_case stays')).toBe('snake_case stays')
    expect(markdownToHtml('\\- not a list')).toBe('<p>- not a list</p>')
    expect(htmlToMarkdown('<p>- not a list</p>')).toBe('\\- not a list')
  })

  it('maps task lists to the design markup', () => {
    expect(markdownToHtml('- [ ] a\n- [x] b')).toBe('<ul data-check=""><li>a</li><li data-done="1">b</li></ul>')
  })

  it('serialises contentEditable output (divs, b/i, stray text, trailing br)', () => {
    expect(htmlToMarkdown('Loose<div><b>bold</b> and <i>it</i><br></div><div><br></div><ul><li>a</li></ul>')).toBe('Loose\n\n**bold** and *it*\n\n- a')
    expect(htmlToMarkdown('<p>a​<code>x</code>​</p>')).toBe('a`x`')
  })

  it('never emits unsafe links', () => {
    expect(markdownToHtml('[x](javascript:alert)')).toBe('<p>x</p>')
    expect(htmlToMarkdown('<a href="javascript:alert(1)">x</a>')).toBe('x')
  })
})

describe('sanitizer', () => {
  it('drops scripts, handlers, styles and unknown tags', () => {
    const out = sanitizeHtml('<p onclick="x()" style="color:red">Hi<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="//e"></iframe><span>ok</span></p>')
    expect(out).toBe('<p>Hiok</p>')
    expect(out).not.toMatch(/script|onerror|onclick|style|iframe|img/)
  })
  it('limits links to http, https, mailto and root paths and adds rel/target', () => {
    expect(sanitizeHtml('<a href="https://a.test/x" onclick="y()">a</a>')).toBe('<a href="https://a.test/x" target="_blank" rel="noopener noreferrer">a</a>')
    expect(sanitizeHtml('<a href="mailto:a@b.co">m</a>')).toContain('href="mailto:a@b.co"')
    expect(sanitizeHtml('<a href="/notes">p</a>')).toContain('href="/notes"')
    for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,x', '//evil.test', 'vbscript:x', 'java\nscript:x']) {
      expect(sanitizeHtml(`<a href="${bad}">t</a>`)).toBe('t')
    }
  })
  it('keeps only whitelisted attributes on lists', () => {
    expect(sanitizeHtml('<ul data-check="" class="x" id="y"><li data-done="1" data-x="2">a</li></ul>')).toBe('<ul data-check=""><li data-done="1">a</li></ul>')
  })
  it('exposes the href rule directly', () => {
    expect(safeHref('https://x.test')).not.toBeNull()
    expect(safeHref('javascript:1')).toBeNull()
    expect(safeHref('')).toBeNull()
  })
})
