import { describe, expect, it, vi } from 'vitest'
import { generatePassword, MAX_UTILITY_INPUT, PASSWORD_GROUPS, transformText, UtilityError } from '../lib/utilities'

const text = 'Привет, Aelys! 👩🏽‍💻\n<&>"\'\\u0041\u0000\ufeff'

describe('local text utilities', () => {
  it.each(['base64', 'url', 'html', 'unicode'] as const)('round-trips Unicode, control characters, and literal escapes through %s', codec => {
    expect(transformText(codec, 'decode', transformText(codec, 'encode', text))).toBe(text)
    expect(transformText(codec, 'encode', '')).toBe('')
    expect(transformText(codec, 'decode', '')).toBe('')
  })
  it('uses standard Base64 and percent-encoded URL components', () => {
    expect(transformText('base64', 'encode', 'Hello, Aelys!')).toBe('SGVsbG8sIEFlbHlzIQ==')
    expect(transformText('base64', 'decode', '77u/Qg==')).toBe('\ufeffB')
    expect(transformText('url', 'encode', 'a+b c/?')).toBe('a%2Bb%20c%2F%3F')
    expect(transformText('url', 'decode', 'a+b')).toBe('a+b')
  })
  it.each(['a', 'AA=', 'Zh==', '====', 'Zg', 'Zg==\n', '/w==', '8J+Y'])('rejects noncanonical Base64 or invalid UTF-8: %s', input => {
    expect(() => transformText('base64', 'decode', input)).toThrow(UtilityError)
  })
  it('treats HTML as literal text with a documented set of entities', () => {
    expect(transformText('html', 'encode', '<script>&"\'</script>')).toBe('&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;')
    expect(transformText('html', 'decode', '&lt;img src=x onerror=alert(1)&gt;')).toBe('<img src=x onerror=alert(1)>')
    expect(transformText('html', 'decode', '&#128512; &#x1F600; &apos;')).toBe("😀 😀 '")
    expect(transformText('html', 'decode', '&amp;lt;')).toBe('&lt;')
  })
  it.each(['&#x110000;', '&#55296;', '&#-1;', '&unknown;'])('rejects unsupported or invalid HTML references: %s', input => {
    expect(() => transformText('html', 'decode', input)).toThrow(UtilityError)
  })
  it('supports braced code points and UTF-16 pairs without decoding twice', () => {
    expect(transformText('unicode', 'decode', '\\uD83D\\uDE00')).toBe('😀')
    expect(transformText('unicode', 'decode', '\\u{1f600}')).toBe('😀')
    expect(transformText('unicode', 'decode', '\\u005c\\u0075\\u0030\\u0030\\u0034\\u0031')).toBe('\\u0041')
  })
  it.each(['\\u12', '\\u{110000}', '\\u{xyz}', '\\ud800', '\\udc00', '\\'])('rejects malformed Unicode escapes: %s', input => {
    expect(() => transformText('unicode', 'decode', input)).toThrow(UtilityError)
  })
  it.each(['base64', 'url', 'html', 'unicode'] as const)('rejects input beyond the limit and unpaired surrogates for %s', codec => {
    expect(() => transformText(codec, 'encode', 'x'.repeat(MAX_UTILITY_INPUT + 1))).toThrow(UtilityError)
    expect(() => transformText(codec, 'encode', '\ud800')).toThrow(UtilityError)
    expect(transformText(codec, 'encode', 'x'.repeat(MAX_UTILITY_INPUT)).length).toBeGreaterThanOrEqual(MAX_UTILITY_INPUT)
    expect(transformText(codec, 'decode', transformText(codec, 'encode', 'x'.repeat(8_000)))).toBe('x'.repeat(8_000))
  })
  it('does not echo sensitive input in errors', () => {
    for (const codec of ['base64', 'url', 'html', 'unicode'] as const) {
      const input = codec === 'url' ? 'private-data%wrong' : codec === 'html' ? '&private-data;' : codec === 'unicode' ? '\\u{private-data}' : 'private-data'
      try { transformText(codec, 'decode', input); throw new Error('expected failure') }
      catch (error) { expect(error).toBeInstanceOf(UtilityError); expect(String(error)).not.toContain('private-data') }
    }
  })
})

describe('secure password generation', () => {
  it('satisfies each possible group selection at both length boundaries', () => {
    for (let mask = 1; mask < 16; mask++) for (const length of [8, 64]) {
      const selected = PASSWORD_GROUPS.map((_, index) => !!(mask & (1 << index)))
      const groups = PASSWORD_GROUPS.filter((_, index) => selected[index])
      const password = generatePassword({ length, groups: selected })
      expect(password).toHaveLength(length)
      expect([...password].every(character => groups.some(group => group.characters.includes(character)))).toBe(true)
      for (const group of groups) expect([...password].some(character => group.characters.includes(character))).toBe(true)
    }
  })
  it.each([7, 65, 8.5, NaN])('rejects invalid length %s', length => {
    expect(() => generatePassword({ length, groups: [true, true, true, true] })).toThrow(UtilityError)
  })
  it('rejects empty or malformed character selections', () => {
    expect(() => generatePassword({ length: 20, groups: [false, false, false, false] })).toThrow(UtilityError)
    expect(() => generatePassword({ length: 20, groups: [] })).toThrow(UtilityError)
  })
  it('rejects biased tail samples instead of applying modulo to them', () => {
    let calls = 0
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
      const values = array as Uint32Array; values[0] = calls++ === 0 ? 0xffffffff : 7; return array
    })
    try {
      expect(generatePassword({ length: 8, groups: [false, false, true, false] })).toBe('77777777')
      expect(calls).toBe(9)
    } finally { spy.mockRestore() }
  })
  it('fails closed without secure randomness', () => {
    vi.stubGlobal('crypto', undefined)
    try { expect(() => generatePassword({ length: 20, groups: [true, true, true, true] })).toThrow(UtilityError) }
    finally { vi.unstubAllGlobals() }
  })
})
