export type Codec = 'base64' | 'url' | 'html' | 'unicode'
export type Direction = 'encode' | 'decode'
export type UtilityErrorCode = 'INVALID_INPUT' | 'INPUT_TOO_LARGE' | 'INVALID_PASSWORD_OPTIONS' | 'SECURE_RANDOM_UNAVAILABLE'

export class UtilityError extends Error {
  constructor(readonly code: UtilityErrorCode, message: string) { super(message); this.name = 'UtilityError' }
}

export const MAX_UTILITY_INPUT = 65_536
export const PASSWORD_GROUPS = [
  { name: 'Uppercase letters', sample: 'A–Z', characters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { name: 'Lowercase letters', sample: 'a–z', characters: 'abcdefghijklmnopqrstuvwxyz' },
  { name: 'Numbers', sample: '0–9', characters: '0123456789' },
  { name: 'Symbols', sample: '! @ # $ % & *', characters: '!@#$%&*?+-_' },
] as const
export type PasswordOptions = { length: number; groups: readonly boolean[] }

function randomIndex(size: number): number {
  if (!globalThis.crypto?.getRandomValues) throw new UtilityError('SECURE_RANDOM_UNAVAILABLE', 'Secure random generation is unavailable on this device.')
  const limit = Math.floor(0x100000000 / size) * size
  const value = new Uint32Array(1)
  for (let attempt = 0; attempt < 128; attempt++) {
    globalThis.crypto.getRandomValues(value)
    if (value[0] < limit) return value[0] % size
  }
  throw new UtilityError('SECURE_RANDOM_UNAVAILABLE', 'Secure random generation failed. Try again.')
}

/** Rejection sampling keeps every allowed password equally likely, including group coverage. */
export function generatePassword(options: PasswordOptions): string {
  if (!Number.isInteger(options.length) || options.length < 8 || options.length > 64 || options.groups.length !== PASSWORD_GROUPS.length) {
    throw new UtilityError('INVALID_PASSWORD_OPTIONS', 'Choose a password length between 8 and 64.')
  }
  const groups = PASSWORD_GROUPS.filter((_, index) => options.groups[index]).map(group => group.characters)
  if (!groups.length) throw new UtilityError('INVALID_PASSWORD_OPTIONS', 'Choose at least one character set.')
  const alphabet = groups.join('')
  for (let attempt = 0; attempt < 128; attempt++) {
    const characters = Array.from({ length: options.length }, () => alphabet[randomIndex(alphabet.length)])
    if (groups.every(group => characters.some(character => group.includes(character)))) return characters.join('')
  }
  throw new UtilityError('SECURE_RANDOM_UNAVAILABLE', 'Secure random generation failed. Try again.')
}

function invalid(message: string): never { throw new UtilityError('INVALID_INPUT', message) }
function assertUnicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('The text contains an unpaired Unicode surrogate.')
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid('The text contains an unpaired Unicode surrogate.')
  }
}
function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const htmlEntities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const htmlCharacters: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function transformText(codec: Codec, direction: Direction, input: string): string {
  if (input.length > MAX_UTILITY_INPUT) throw new UtilityError('INPUT_TOO_LARGE', 'Use at most 65,536 input characters.')
  assertUnicode(input)
  const encode = direction === 'encode'
  try {
    if (codec === 'base64') {
      if (encode) return base64Encode(input)
      // Standard padded Base64 only, including canonical unused bits; output must be valid UTF-8.
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) invalid('Enter standard Base64 with the required = padding.')
      const bytes = Uint8Array.from(atob(input), character => character.charCodeAt(0))
      const output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (base64Encode(output) !== input) invalid('Enter canonical Base64 containing UTF-8 text.')
      return output
    }
    if (codec === 'url') {
      const output = encode ? encodeURIComponent(input) : decodeURIComponent(input)
      assertUnicode(output)
      return output
    }
    if (codec === 'html') {
      if (encode) return input.replace(/[&<>"']/g, character => htmlEntities[character])
      const output = input.replace(/&([^;\s&]+);/g, (_match, entity: string) => {
        if (Object.hasOwn(htmlCharacters, entity)) return htmlCharacters[entity]
        if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) invalid('Supported entities: amp, lt, gt, quot, apos, and numeric references.')
        const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid('Enter a valid Unicode numeric reference.')
        return String.fromCodePoint(code)
      })
      assertUnicode(output)
      return output
    }
    if (encode) return Array.from(input, character => {
      const code = character.codePointAt(0)!
      return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`
    }).join('')
    // Scan once so decoding a literal backslash followed by "u" never decodes twice.
    const output = input.replace(/\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|[\s\S]?)/gi, (_match, braced: string | undefined, unit: string | undefined) => {
      if (!braced && !unit) invalid('Use Unicode escapes such as \\u0041 or \\u{1f600}.')
      const code = parseInt(braced ?? unit!, 16)
      if (code > 0x10ffff) invalid('Enter a Unicode code point up to 10FFFF.')
      return String.fromCodePoint(code)
    })
    assertUnicode(output)
    return output
  } catch (error) {
    if (error instanceof UtilityError) throw error
    invalid(codec === 'url' ? 'Check the URL escapes (%HH) and UTF-8 text.' : 'Check the encoded input and UTF-8 text.')
  }
}
