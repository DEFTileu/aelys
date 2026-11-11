import { isNativeHost } from './nativeTransport'

/** A notification as stored on the phone by the Android notification listener. */
export type LogEntry = { id: number; pkg: string; app: string; title: string; body: string; posted: number; kind: 'note' | 'code'; financeTx: string | null }
export type LogSettings = { hideCodes: boolean; keepDays: 7 | 30 | 90; muted: string[] }
export type LogStatus = { access: boolean; settings: LogSettings }

/** The log exists only inside the Android app: notifications never leave the phone. */
export const isAndroidHost = () => isNativeHost() && /Android/i.test(navigator.userAgent)

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(`plugin:aelys-notification-log|${command}`, args)
}

export const notificationLog = {
  status: () => call<LogStatus>('status'),
  openAccessSettings: () => call<void>('open_access_settings'),
  list: async (limit = 500) => (await call<{ entries: LogEntry[] }>('list', { limit })).entries,
  remove: (id: number) => call<void>('remove', { id }),
  clear: () => call<void>('clear'),
  setSettings: (settings: LogSettings) => call<LogSettings>('set_settings', { settings }),
  setFinance: (id: number, transaction: string | null) => call<void>('set_finance', { id, transaction }),
  icons: async (packages: string[]) => (await call<{ icons: Record<string, string> }>('icons', { packages })).icons,
}

export type Payment = { amount: string; currency: string; merchant: string }

const CURRENCIES: readonly [RegExp, string][] = [[/₸|тг\.?|тенге|kzt/i, 'KZT'], [/\$|usd/i, 'USD'], [/€|eur/i, 'EUR'], [/₽|руб\.?|rub/i, 'RUB']]
const SPEND = /(покупк|оплат|списан|платеж|платёж|снятие|расход|транзакц|purchase|paid|payment|spent|debit|сатып|төлем|(?:^|\s)[-−]\s?(?:₸|\$|€|₽)?\d)/i
// Money coming in. Banks add "Бонус +25 ₸" or "Кэшбэк" lines to purchases, so only the earlier keyword counts.
const INCOME = /(пополнен|зачислен|получен|поступлен|возврат|перевод от|кэшбэк|кешбэк|cashback|refund|received|credited|top.?up|бонус)/i
// Not money moving at all, wherever it appears.
const FAILED = /(отклон|declined|недостаточно|insufficient|не прошл|failed)/i
// Amount with its currency on either side: "4 280 ₸", "4 280,50 тг", "$12.99", "KZT 1 950", "₸1,250.00".
const AMOUNT = /(?:(₸|\$|€|₽|kzt|usd|eur|rub)\s?)?(\d{1,3}(?:[   ,.]\d{3})+(?!\d)|\d+)(?:[.,](\d{1,2}))?\s?(₸|тг\.?|тенге|kzt|\$|usd|€|eur|₽|руб\.?|rub)?/gi

/**
 * Reads an expense out of a bank or wallet notification. Returns null unless the text says
 * money was spent and names an amount with a currency. Amounts stay decimal strings.
 */
export function parsePayment(title: string, body: string): Payment | null {
  const text = `${title}\n${body}`
  const spend = text.search(SPEND)
  const income = text.search(INCOME)
  if (spend < 0 || FAILED.test(text) || (income >= 0 && income < spend)) return null
  for (const match of text.matchAll(AMOUNT)) {
    const symbol = match[1] ?? match[4]
    if (!symbol) continue
    const currency = CURRENCIES.find(([re]) => re.test(symbol))?.[1]
    if (!currency) continue
    const whole = match[2]!.replace(/[   ,.]/g, '').replace(/^0+(?=\d)/, '')
    if (!/[1-9]/.test(whole + (match[3] ?? ''))) continue
    const amount = `${whole}.${(match[3] ?? '').padEnd(2, '0')}`
    return { amount, currency, merchant: merchantOf(text, match.index ?? 0, match[0].length) }
  }
  return null
}

function merchantOf(text: string, at: number, length: number): string {
  const after = text.slice(at + length).match(/^\s*(?:[.,·•|]\s*)?(?:в|at|в магазине|магазин|to)?\s*([^\n.,·•|]{2,40})/i)?.[1]?.trim()
  const named = text.match(/(?:в|at|магазин|merchant)\s+([A-ZА-ЯЁ0-9][^\n.,·•|]{1,38})/)?.[1]?.trim()
  const pick = [named, after].find((s) => s && !/^(?:карт|card|баланс|balance|остаток|доступно|\*|\d)/i.test(s))
  return (pick ?? '').replace(/\s*(?:остаток|баланс|balance|доступно|available|карта|card)(?:\s.*)?$/i, '').trim()
}

export type LogItem = LogEntry & { payment: Payment | null; mergedWith: string[] }

const MERGE_WINDOW = 3 * 60_000
/**
 * Samsung Pay and the bank both announce one purchase. Payments with the same amount and
 * currency from different apps within three minutes become one item, kept on the earliest.
 */
export function mergePayments(entries: readonly LogEntry[]): LogItem[] {
  const items: LogItem[] = entries.map((e) => ({ ...e, payment: e.kind === 'code' ? null : parsePayment(e.title, e.body), mergedWith: [] }))
  const byTime = [...items].sort((a, b) => a.posted - b.posted)
  const dropped = new Set<number>()
  for (let i = 0; i < byTime.length; i++) {
    const keep = byTime[i]!
    if (!keep.payment || dropped.has(keep.id)) continue
    for (let j = i + 1; j < byTime.length && byTime[j]!.posted - keep.posted <= MERGE_WINDOW; j++) {
      const other = byTime[j]!
      if (dropped.has(other.id) || !other.payment || other.pkg === keep.pkg) continue
      if (other.payment.amount !== keep.payment.amount || other.payment.currency !== keep.payment.currency) continue
      dropped.add(other.id)
      keep.mergedWith.push(other.app)
      if (!keep.payment.merchant && other.payment.merchant) keep.payment = { ...keep.payment, merchant: other.payment.merchant }
      if (!keep.financeTx && other.financeTx) keep.financeTx = other.financeTx
    }
  }
  return items.filter((item) => !dropped.has(item.id))
}
