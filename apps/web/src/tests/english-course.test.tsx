import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { button, clickText, course, field, host, installClient, makeClient, mount, setValue, unmount } from './english-fixtures'

const client = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>)
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); Object.assign(client, makeClient()); installClient(client as never) })
afterEach(unmount)

describe('English course tab', () => {
  it('renders skills, plan, adaptations and week stats from the API', async () => {
    await mount()
    const text = host.textContent!
    for (const part of ['неделя 3 из 10', 'Сейчас ≈ 5.5', 'Цель — 6.5 к 22 января', '31 ч из ~150', 'Начать урок 13', 'экзамен через', '74 дн.']) expect(text).toContain(part)
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('Listening 5.0')
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain('Writing нет оценки')
    expect(text).toContain('↑0.5'); expect(text).toContain('↓0.5')
    const plan = [...host.querySelectorAll('.en-plan li')]
    expect(plan.map((item) => item.getAttribute('data-status'))).toEqual(['done', 'done', 'now', 'next'])
    expect(plan[2]!.getAttribute('aria-current')).toBe('step')
    expect(text).toContain('Work & careers'); expect(text).toContain('Артикли — 3 урока подряд:')
    expect(text).toContain('71%'); expect(text).toContain('38')
    expect(host.querySelector('[aria-label="Пробный тест"]')).toBeNull()
    expect(client.englishCourse).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), expect.anything())
  })

  it('shows the mock card only when due and records the entered bands', async () => {
    client.englishCourse.mockResolvedValue({ ...course, mock_due: true })
    client.englishCreateMock.mockResolvedValue({})
    await mount()
    expect(host.querySelector<HTMLAnchorElement>('a[href="https://takeielts.britishcouncil.org/prepare/ielts-ready"]')).toBeTruthy()
    await clickText('Внести результат')
    expect(button('Сохранить результат').disabled).toBe(true)
    const selects = host.querySelectorAll<HTMLSelectElement>('.en-mock select')
    await setValue(selects[0]!, '5.5'); await setValue(selects[1]!, '6.5')
    await clickText('Сохранить результат')
    expect(client.englishCreateMock).toHaveBeenCalledWith({ day: expect.any(String), listening: '5.5', reading: '6.5' })
    expect(host.textContent).toContain('Результат сохранён')
  })
})

describe('English profile tab', () => {
  it('saves the chosen profile with PUT semantics and shows the result', async () => {
    client.englishSaveProfile.mockImplementation(async (body: object) => ({ ...body, course_started_on: '2026-10-26' }))
    await mount()
    await clickText('Мой курс')
    await clickText('3 ч · максимум'); await clickText('7.0'); await clickText('Писать'); await clickText('Говорить')
    await setValue(field<HTMLInputElement>('input[type="date"]'), '2027-02-01')
    await clickText('Сохранить и пересобрать план')
    expect(client.englishSaveProfile).toHaveBeenCalledWith({ goal: 'ielts_academic', target_band: '7.0', level: 'b1b2', weak_skills: ['listening', 'writing'], minutes_per_day: 180, exam_date: '2027-02-01' })
    expect(host.textContent).toContain('Сохранено')
  })

  it('saves the evening reminder with the browser timezone', async () => {
    client.englishSaveSettings.mockImplementation(async (body: unknown) => body)
    await mount()
    await clickText('Мой курс')
    const { act } = await import('react')
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
    expect(client.englishSaveSettings).toHaveBeenCalledWith({ reminder_enabled: true, reminder_time: '21:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  })
})
