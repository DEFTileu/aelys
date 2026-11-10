import { describe, expect, it } from 'vitest'
import { mergePayments, parsePayment, type LogEntry } from '../lib/notificationLog'

describe('parsePayment', () => {
  it('reads Kazakh bank and wallet purchases as decimal strings', () => {
    expect(parsePayment('Kaspi.kz', 'Покупка 4 280 ₸ MAGNUM CASH&CARRY Остаток 63 140 ₸')).toEqual({ amount: '4280.00', currency: 'KZT', merchant: 'MAGNUM CASH&CARRY' })
    expect(parsePayment('Samsung Pay', 'Paid 4 280 ₸ at Magnum. Card *4821')).toEqual({ amount: '4280.00', currency: 'KZT', merchant: 'Magnum' })
    expect(parsePayment('Freedom', 'Оплата 1 950,50 тг. Yandex Go. Карта *4821')).toEqual({ amount: '1950.50', currency: 'KZT', merchant: 'Yandex Go' })
    expect(parsePayment('Halyk', 'Списание $12.99 Netflix')).toMatchObject({ amount: '12.99', currency: 'USD' })
  })

  it('ignores money coming in, declines and plain messages', () => {
    expect(parsePayment('Kaspi.kz', 'Пополнение 15 000 ₸ от Айгерим')).toBeNull()
    expect(parsePayment('Kaspi.kz', 'Возврат покупки 2 000 ₸')).toBeNull()
    expect(parsePayment('Halyk', 'Оплата отклонена: недостаточно средств 9 000 ₸')).toBeNull()
    expect(parsePayment('Telegram', 'See you at 19:00, I will bring 2 documents')).toBeNull()
    expect(parsePayment('Kaspi.kz', 'Оплата по карте *4821')).toBeNull()
  })
})

const entry = (id: number, pkg: string, app: string, body: string, posted: number, financeTx: string | null = null): LogEntry => ({ id, pkg, app, title: app, body, posted, kind: 'note', financeTx })

describe('mergePayments', () => {
  it('keeps one item when the wallet and the bank report the same purchase', () => {
    const items = mergePayments([
      entry(2, 'kz.kaspi.mobile', 'Kaspi', 'Покупка 4 280 ₸ MAGNUM', 60_000, 'tx-1'),
      entry(1, 'com.samsung.android.spay', 'Samsung Pay', 'Paid 4 280 ₸', 0),
      entry(3, 'org.telegram.messenger', 'Telegram', 'hi', 30_000),
    ])
    expect(items.map((i) => i.id)).toEqual([1, 3])
    expect(items[0]).toMatchObject({ mergedWith: ['Kaspi'], financeTx: 'tx-1', payment: { merchant: 'MAGNUM' } })
  })

  it('keeps separate purchases apart', () => {
    const items = mergePayments([
      entry(1, 'a', 'Samsung Pay', 'Paid 4 280 ₸', 0),
      entry(2, 'b', 'Kaspi', 'Покупка 4 280 ₸', 10 * 60_000),
      entry(3, 'a', 'Samsung Pay', 'Paid 4 280 ₸', 30_000),
    ])
    expect(items).toHaveLength(3)
  })
})
