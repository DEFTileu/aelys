import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError } from '@aelys/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnglishView } from '../views/EnglishView'

const client = vi.hoisted(() => ({ englishToday: vi.fn(), englishReports: vi.fn(), englishGenerate: vi.fn(), englishReview: vi.fn(), englishSubmitReport: vi.fn(), englishSettings: vi.fn(), englishSaveSettings: vi.fn(), createTask: vi.fn() }))
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement

const word = (id: string, lemma: string) => ({ id, lemma, part_of_speech: 'verb', ipa: '/x/', definition_en: `def of ${lemma}`, translation_ru: `перевод ${lemma}`, example: `I ${lemma} daily.`, collocations: ['a b'], false_friend_ru: '', box: 1, due_on: '2026-11-09', introduced_on: '2026-11-08', lapses: 0 })
const result = { corrected_text: 'I went to school.', cefr_estimate: { level: 'B1', rationale: 'simple but clear' }, target_words: [{ word: 'ponder', used_correctly: false, note: 'не использовано' }], errors: [{ original: 'I goed', correction: 'I went', type: 'grammar', explanation_ru: 'Неправильный глагол', severity: 'major' }], strengths: ['ясно'], summary_ru: 'Хорошая работа', topics: ['school'], tomorrow_tasks: [{ title: 'Позвонить маме', time: '09:00' }, { title: 'Купить хлеб', time: null }, { title: 'Сходить в зал', time: null }] }
const report = { id: 'r1', day: '2026-11-09', text: 'I goed to school yesterday and it was fine.', cefr: 'B1', result, created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z' }
const empty = { day: '2026-11-09', new_words: [], due_words: [word('d1', 'recall')], report: null, stats: { total: 1, mastered: 0, streak: 0 } }
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!
async function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(<EnglishView apiStatus="ready" />)) }
const typeText = (value: string) => act(async () => { const area = host.querySelector('textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value); area.dispatchEvent(new Event('input', { bubbles: true })) })

beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); client.englishToday.mockResolvedValue(empty); client.englishReports.mockResolvedValue([]); client.englishSettings.mockResolvedValue({ reminder_enabled: false, reminder_time: '21:00', timezone: 'UTC' }); client.createTask.mockResolvedValue({}) })
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })

describe('English view', () => {
  it('generates words with the chosen count', async () => {
    client.englishGenerate.mockResolvedValue({ ...empty, new_words: [word('n1', 'ponder')] })
    await mount()
    await act(async () => button('10').click())
    await act(async () => button('Получить слова').click())
    expect(client.englishGenerate).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 10)
    expect(host.textContent).toContain('ponder'); expect(host.textContent).toContain('перевод ponder')
  })
  it('reveals and reviews a due word', async () => {
    client.englishReview.mockResolvedValue(word('d1', 'recall'))
    await mount()
    expect(host.textContent).toContain('recall'); expect(host.textContent).not.toContain('def of recall')
    await act(async () => button('Показать').click())
    expect(host.textContent).toContain('def of recall')
    await act(async () => button('Помню').click())
    expect(client.englishReview).toHaveBeenCalledWith('d1', expect.any(String), true)
    expect(host.textContent).toContain('Сегодня повторять нечего')
  })
  it('submits a report and renders the corrections', async () => {
    client.englishSubmitReport.mockResolvedValue(report)
    client.englishToday.mockResolvedValueOnce(empty).mockResolvedValue({ ...empty, report }) // the refresh after submit returns the stored report
    await mount()
    expect(button('Отправить на проверку').disabled).toBe(true)
    await typeText(report.text)
    await act(async () => button('Отправить на проверку').click())
    expect(client.englishSubmitReport).toHaveBeenCalledWith(expect.any(String), report.text)
    const text = host.textContent!
    for (const part of ['I went to school.', 'I goed', 'Неправильный глагол', 'грамматика', 'примерно', 'B1', 'ponder', 'Хорошая работа']) expect(text).toContain(part)
    expect(button('Переписать')).toBeTruthy()
  })
  it('points to AI settings when no provider is connected', async () => {
    client.englishGenerate.mockRejectedValue(new ApiError(503, 'AI_UNAVAILABLE', 'Подключите AI-провайдера в настройках'))
    await mount()
    await act(async () => button('Получить слова').click())
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Подключите AI-провайдера')
    expect(button('Настройки AI')).toBeTruthy()
  })
  it('adds the checked, edited tomorrow tasks and hides the block', async () => {
    client.englishToday.mockResolvedValue({ ...empty, report })
    await mount()
    const boxes = () => [...host.querySelectorAll<HTMLInputElement>('.en-tomorrow input[type="checkbox"]')]
    expect(boxes().map((box) => box.checked)).toEqual([true, true, true])
    await act(async () => boxes()[1]!.click()) // drop "Купить хлеб"
    await act(async () => { const input = host.querySelectorAll<HTMLInputElement>('.en-tomorrow input[type="text"]')[2]!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Сходить на тренировку'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button('Добавить в задачи').click())
    expect(client.createTask).toHaveBeenCalledTimes(2)
    expect(client.createTask).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'Позвонить маме', due_at: new Date(2026, 10, 10, 9, 0).toISOString(), due_timezone: expect.any(String) }))
    expect(client.createTask).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'Сходить на тренировку', due_at: new Date(2026, 10, 10, 23, 59).toISOString() }))
    expect(host.textContent).toContain('Добавлено: 2')
    expect(host.querySelector('.en-tomorrow')).toBeNull()
    expect(localStorage.getItem('aelys.english.tasks-added.v1')).toContain('r1:')
  })
  it('does not offer tomorrow tasks again once added', async () => {
    client.englishToday.mockResolvedValue({ ...empty, report })
    localStorage.setItem('aelys.english.tasks-added.v1', JSON.stringify([`r1:${report.updated_at}`]))
    await mount()
    expect(host.querySelector('.en-tomorrow')).toBeNull()
  })
  it('saves the reminder with the browser timezone', async () => {
    client.englishSaveSettings.mockImplementation(async (body: unknown) => body)
    await mount()
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    expect(client.englishSaveSettings).toHaveBeenCalledWith({ reminder_enabled: true, reminder_time: '21:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    expect(host.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  })
})
