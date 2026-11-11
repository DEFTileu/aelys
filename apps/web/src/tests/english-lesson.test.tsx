import { act } from 'react'
import { ApiError } from '@aelys/shared'
import type { EnglishLesson } from '@aelys/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { button, byText, click, clickText, course, field, host, installClient, lesson, makeClient, mount, setValue, storedRound, task2Lesson, unmount } from './english-fixtures'

const client = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>)
vi.mock('../lib/api', () => ({ getSharedApiClient: () => client }))

class FakeUtterance { onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null; lang = ''; rate = 1; pitch = 1; voice: unknown = null; constructor(public text: string) {} }
const spoken: FakeUtterance[] = []
const synth = { speak: vi.fn((utterance: FakeUtterance) => { spoken.push(utterance) }), cancel: vi.fn(), getVoices: () => [{ lang: 'en-US', name: 'US' }, { lang: 'en-GB', name: 'Daniel' }] }

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); spoken.length = 0
  Object.assign(client, makeClient()); installClient(client as never)
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth })
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
})
afterEach(() => { unmount(); vi.unstubAllGlobals(); delete (window as { speechSynthesis?: unknown }).speechSynthesis; delete (navigator as { mediaDevices?: unknown }).mediaDevices })

const openLesson = async () => { await mount(); await clickText('Урок дня') }
const startLesson = async (value = lesson) => { client.englishLessonToday.mockResolvedValue(value); await openLesson(); await clickText('Начать урок 13') }
const nav = (title: string) => [...host.querySelectorAll<HTMLButtonElement>('.en-nav__item')].find((item) => item.textContent?.includes(title))!
const section = (label: string) => host.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!

describe('English lesson', () => {
  it('generates today lesson on demand and walks the warm-up through review calls', async () => {
    await startLesson()
    expect(client.englishLessonToday).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    expect(host.textContent).toContain('Урок 13 · Work & careers')
    expect(section('Разминка').textContent).toContain('1 из 2')
    expect(section('Разминка').textContent).not.toContain('reluctant')
    await clickText('Показать слово')
    expect(section('Разминка').textContent).toContain('reluctant')
    await clickText('Вспомнил')
    expect(client.englishReview).toHaveBeenCalledWith('w1', expect.any(String), true)
    await clickText('Показать слово'); await clickText('Не вспомнил')
    expect(client.englishReview).toHaveBeenLastCalledWith('w2', expect.any(String), false)
    expect(section('Разминка').textContent).toContain('Разминка готова: 1 из 2')
    client.englishBlockDone.mockResolvedValue({ ...lesson, progress: { warmup: { done: true } } })
    await clickText('Дальше: слова темы')
    expect(client.englishBlockDone).toHaveBeenCalledWith('l1', 'warmup')
    expect(nav('Слова темы').getAttribute('aria-current')).toBe('step')
    expect(nav('Разминка').querySelector('[aria-label="Готово"]')).toBeTruthy()
  })

  it('runs a lesson without AI: only warm-up, grammar and reading, graded once on the server', async () => {
    const task = (prompt: string, options: string[] | null = null) => ({ type: options ? 'choice' as const : 'gap' as const, prompt, options })
    const offline = { ...lesson, content: { theme: lesson.content.theme, grammar_focus: 'Present tenses', warmup: lesson.content.warmup,
      blocks: [{ key: 'warmup' as const, title: 'Разминка', minutes: 30 }, { key: 'grammar' as const, title: 'Грамматика', minutes: 45 }, { key: 'reading' as const, title: 'Чтение', minutes: 45 }],
      grammar: { id: 'g-w1-1', title: 'Present Simple', rule_ru: ['Привычки — Present Simple.', 'Сейчас — Continuous.'], examples: [{ en: 'I work.', ru: 'Я работаю.' }], exercises: [task('She ___ (work) here.'), task('He ___ now.', ['works', 'is working'])] },
      reading: { id: 'r-w1-1', title: 'Sleep', paragraphs: [{ label: 'A', text: 'Text.' }], questions: [{ type: 'tfng' as const, prompt: 'Sleep matters.', options: ['TRUE', 'FALSE', 'NOT GIVEN'] }] } } } satisfies EnglishLesson
    await startLesson(offline)
    expect([...host.querySelectorAll('.en-nav__item strong')].map((item) => item.textContent)).toEqual(['Разминка', 'Грамматика', 'Reading'])
    await click(nav('Грамматика'))
    expect(section('Грамматика').textContent).toContain('Привычки — Present Simple.')
    await setValue(field<HTMLInputElement>('input[aria-label="Ответ 1"]'), 'works')
    await click(host.querySelector<HTMLButtonElement>('[role="radio"]')!)
    client.englishTasks.mockResolvedValue({ score: 1, total: 2, results: [{ n: 1, given: 'works', answer: 'works', ok: true, explain_ru: 'Привычка.' }, { n: 2, given: 'works', answer: 'is working', ok: false, explain_ru: 'Now — Continuous.' }] })
    await clickText('Проверить ответы')
    expect(client.englishTasks).toHaveBeenCalledWith('l1', 'grammar', { '1': 'works', '2': 'works' })
    expect(section('Грамматика').textContent).toContain('Правильно: is working.')
    expect(section('Грамматика').textContent).toContain('1 из 2.')
    expect(byText('button', 'Проверить ответы')).toBeUndefined()
  })

  it('resumes an existing lesson without asking to generate it again', async () => {
    client.englishCourse.mockResolvedValue({ ...course, today: { ...course.today, id: 'l1' } })
    await openLesson()
    expect(button('Показать слово')).toBeTruthy()
    expect(host.textContent).not.toContain('Начать урок 13')
  })

  it('surfaces a missing AI provider when generating', async () => {
    client.englishLessonToday.mockRejectedValue(new ApiError(503, 'AI_UNAVAILABLE', 'Подключите AI-провайдера'))
    await openLesson(); await clickText('Начать урок 13')
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Подключите AI-провайдера')
    expect(button('Настройки AI')).toBeTruthy()
  })

  it('checks own vocabulary sentences', async () => {
    await startLesson()
    await click(nav('Слова темы'))
    expect(button('Проверить предложения').disabled).toBe(true)
    await setValue(field<HTMLTextAreaElement>('#en-sent-v1'), 'I chose a clear career path.')
    client.englishSentences.mockResolvedValue({ items: [{ word_id: 'v1', ok: false, title_ru: 'Почти.', detail_ru: 'Добавь артикль.', corrected: 'I chose a clear career path.' }] })
    await clickText('Проверить предложения')
    expect(client.englishSentences).toHaveBeenCalledWith('l1', [{ word_id: 'v1', sentence: 'I chose a clear career path.' }])
    expect(section('Слова темы').textContent).toContain('Почти.')
    expect(button('Дальше: Listening')).toBeTruthy()
  })

  it('limits listening to two plays, then grades and reveals the script and drill', async () => {
    await startLesson()
    await click(nav('Listening'))
    const play = () => host.querySelector<HTMLButtonElement>('button[aria-label="Слушать"]')!
    const speeds = [...host.querySelectorAll<HTMLButtonElement>('.en-speeds button')]
    expect(speeds.map((item) => item.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']) // content.listening.tts_rate = 1 keeps normal speed
    await click(speeds[1]!)
    await click(play())
    expect(spoken).toHaveLength(2)
    expect(spoken[0]!.rate).toBe(0.9); expect(spoken[0]!.voice).toEqual({ lang: 'en-GB', name: 'Daniel' })
    await act(async () => { spoken.at(-1)!.onend?.() })
    await click(play()); await act(async () => { spoken.at(-1)!.onend?.() })
    expect(host.textContent).toContain('Прослушиваний: 2 из 2')
    expect(play().disabled).toBe(true)
    expect(host.textContent).not.toContain('Definitely, I got work experience.')

    const inputs = host.querySelectorAll<HTMLInputElement>('.en-q input')
    await setValue(inputs[0]!, 'work experience'); await setValue(inputs[1]!, 'Monday')
    client.englishListening.mockResolvedValue({ score: 1, total: 2, feedback_ru: 'Ты пропустил «Friday».', results: [{ n: 1, given: 'work experience', answer: 'work experience', ok: true }, { n: 2, given: 'Monday', answer: 'Friday', ok: false }] })
    client.englishLessonToday.mockResolvedValue({ ...lesson, progress: { listening: { done: true, score: 1, total: 2 } } })
    await clickText('Проверить ответы')
    expect(client.englishListening).toHaveBeenCalledWith('l1', { '1': 'work experience', '2': 'Monday' })
    const text = section('Listening').textContent!
    expect(text).toContain('1 из 2.'); expect(text).toContain('Ты пропустил «Friday».'); expect(text).toContain('Friday')
    expect(text).toContain('work‿experience')
    expect(text).not.toContain('Definitely, I got work experience.')
    await clickText('Показать текст аудио')
    expect(section('Listening').textContent).toContain('Definitely, I got work experience.')
    // The connected-speech drill speaks the phrase slowly, then at normal speed.
    spoken.length = 0
    await click(host.querySelector<HTMLButtonElement>('.en-drill button')!)
    expect(spoken.map((item) => [item.text, item.rate])).toEqual([['work experience', 0.7], ['work experience', 1]])
  })

  it('records speech, transcribes it, and releases the microphone', async () => {
    const stop = vi.fn()
    class FakeRecorder { static instances: FakeRecorder[] = []; state = 'inactive'; mimeType = 'audio/webm;codecs=opus'; ondataavailable: ((e: { data: Blob }) => void) | null = null; onstop: (() => void) | null = null
      constructor() { FakeRecorder.instances.push(this) }
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) }); this.onstop?.() } }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } })
    client.englishTranscribe.mockResolvedValue({ text: 'I would like to be a designer.', duration_sec: 5 })
    await startLesson()
    await click(nav('Speaking'))
    await click(host.querySelector('button[aria-label="Начать запись"]')!)
    expect(host.textContent).toContain('Идёт запись')
    await click(host.querySelector('button[aria-label="Остановить запись"]')!)
    expect(stop).toHaveBeenCalled()
    const sent = client.englishTranscribe.mock.calls[0]![0] as Blob
    expect(sent.type).toBe('audio/webm')
    expect(field<HTMLTextAreaElement>('#en-transcript').value).toBe('I would like to be a designer.')
    client.englishSpeaking.mockResolvedValue({ round: 4, criteria: { fluency: '≈5.5', lexical: '≈6.0', grammar: '≈5.5' }, corrected_html_safe: [], tips: [], pauses: 2, linkers_used: 1 })
    await clickText('Отправить на проверку')
    expect(client.englishSpeaking).toHaveBeenCalledWith('l1', expect.objectContaining({ round: 4, transcript: 'I would like to be a designer.', duration_sec: expect.any(Number) }))
  })

  it('falls back to a typed transcript and renders speaking criteria', async () => {
    await startLesson() // jsdom has no MediaRecorder
    await click(nav('Speaking'))
    await click(host.querySelector('button[aria-label="Начать запись"]')!)
    expect(host.textContent).toContain('Запись недоступна в этом браузере.')
    expect(button('Отправить на проверку').disabled).toBe(true)
    await setValue(field<HTMLTextAreaElement>('#en-transcript'), 'This job need good skills of communication because I discuss with developers.')
    client.englishSpeaking.mockResolvedValue({
      round: 4, criteria: { fluency: '≈5.5', lexical: '≈6.0', grammar: '≈5.5' }, pauses: 7, linkers_used: 2,
      corrected_html_safe: [{ type: 'same', text: 'This ' }, { type: 'del', text: 'job need' }, { type: 'ins', text: 'job requires' }],
      tips: [{ kind: 'timing', title_ru: 'Много пауз.', detail_ru: 'Используй связки.' }, { kind: 'good', title_ru: 'Хорошо:', detail_ru: 'ответил на все пункты.' }],
    })
    await clickText('Отправить на проверку')
    expect(client.englishSpeaking).toHaveBeenCalledWith('l1', { round: 4, transcript: expect.stringContaining('This job need'), duration_sec: expect.any(Number) })
    const text = section('Speaking').textContent!
    for (const part of ['≈5.5', '≈6.0', 'Fluency & Coherence', '7 пауз', '2 связки', 'job requires', 'Много пауз.', 'примерно', 'не оцениваем']) expect(text).toContain(part)
    expect(section('Speaking').querySelector('del')!.textContent).toBe('job need')
    expect(section('Speaking').textContent).toContain('4 мин ✓')
  })

  it('falls back to typing when transcription is not configured', async () => {
    class FakeRecorder { state = 'inactive'; mimeType = 'audio/webm'; ondataavailable: unknown = null; onstop: (() => void) | null = null; start() { this.state = 'recording' } stop() { this.state = 'inactive'; this.onstop?.() } }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } })
    client.englishTranscribe.mockRejectedValue(new ApiError(409, 'TRANSCRIPTION_NOT_CONFIGURED', 'not configured'))
    await startLesson(); await click(nav('Speaking'))
    await click(host.querySelector('button[aria-label="Начать запись"]')!)
    await click(host.querySelector('button[aria-label="Остановить запись"]')!)
    expect(host.textContent).toContain('Расшифровка не настроена. Напечатай, что сказал.')
    expect(field('#en-transcript')).toBeTruthy()
  })

  it('submits a journal report with its kind and offers tomorrow tasks', async () => {
    const result = { corrected_text: 'I went to school.', cefr_estimate: { level: 'B1', rationale: 'ok' }, target_words: [], errors: [], strengths: [], summary_ru: 'Хорошая работа', topics: [], tomorrow_tasks: [{ title: 'Позвонить маме', time: '09:00' }] }
    const report = { id: 'r1', day: '2026-11-09', text: 'I goed to school yesterday.', cefr: 'B1', result, created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z' }
    client.englishSubmitReport.mockResolvedValue(report)
    client.englishToday.mockResolvedValueOnce({ day: '2026-11-09', new_words: [], due_words: [], report: null, stats: { total: 0, mastered: 0, streak: 0 } }).mockResolvedValue({ day: '2026-11-09', new_words: [], due_words: [], report, stats: { total: 0, mastered: 0, streak: 0 } })
    client.createTask.mockResolvedValue({})
    await startLesson(); await click(nav('Writing'))
    expect(section('Writing').textContent).toContain('Вечерний отчёт')
    await setValue(field<HTMLTextAreaElement>('textarea[aria-label="Текст отчёта"]'), report.text)
    await clickText('Проверить')
    expect(client.englishSubmitReport).toHaveBeenCalledWith(expect.any(String), report.text, 'journal')
    expect(section('Writing').textContent).toContain('Хорошая работа')
    await clickText('Добавить в задачи')
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Позвонить маме' }))
    expect(host.textContent).toContain('Добавлено: 1')
  })

  it('sends task2 essays with their kind and shows the criteria', async () => {
    const result = { corrected_text: 'text', cefr_estimate: { level: 'B2', rationale: 'ok' }, target_words: [], errors: [], strengths: [], summary_ru: 'Структура ясная', topics: [], tomorrow_tasks: [], kind: 'task2', criteria: { task_response: '≈6.0', coherence: '≈5.5', lexical: '≈6.0', grammar: '≈5.5' } }
    client.englishSubmitReport.mockResolvedValue({ id: 'r2', day: '2026-11-09', text: 'essay', cefr: 'B2', result, created_at: 'x', updated_at: 'y' })
    await startLesson(task2Lesson); await click(nav('Writing'))
    expect(section('Writing').textContent).toContain('Is work experience more valuable than a degree?')
    await setValue(field<HTMLTextAreaElement>('textarea[aria-label="Текст эссе"]'), 'Some people believe that work experience matters more than a degree.')
    await clickText('Проверить')
    expect(client.englishSubmitReport).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Some people believe'), 'task2')
    const text = section('Writing').textContent!
    for (const part of ['Task Response', 'Coherence & Cohesion', '≈6.0', '≈5.5']) expect(text).toContain(part)
  })

  // ---- review fixes ---------------------------------------------------------------------------------------------------------------------------
  const withProgress = (progress: EnglishLesson['progress']): EnglishLesson => ({ ...lesson, progress })
  const installRecorder = (getUserMedia?: () => Promise<unknown>) => {
    const stop = vi.fn()
    class FakeRecorder { state = 'inactive'; mimeType = 'audio/webm'; ondataavailable: ((e: { data: Blob }) => void) | null = null; onstop: (() => void) | null = null
      start() { this.state = 'recording' }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x']) }); this.onstop?.() } }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    const gum = vi.fn(getUserMedia ?? (async () => ({ getTracks: () => [{ stop }] })))
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum } })
    return { stop, gum }
  }
  const recordBtn = () => host.querySelector<HTMLButtonElement>('button[aria-label="Начать запись"]')!

  it('reopens a lesson with stored speaking rounds, including older rows without corrected text or tips', async () => {
    await startLesson(withProgress({ speaking: { rounds: { '4': storedRound(4, true), '3': storedRound(3) } } }))
    await click(nav('Speaking'))
    const speaking = section('Speaking')
    expect(speaking.textContent).toContain('4 мин ✓'); expect(speaking.textContent).toContain('3 пауз')
    expect(speaking.textContent).toContain('Fluency & Coherence'); expect(speaking.textContent).toContain('≈5.5')
    expect(speaking.querySelector('.en-corrected')).toBeNull(); expect(speaking.querySelector('.en-tips')).toBeNull()
    await click([...speaking.querySelectorAll<HTMLButtonElement>('.en-seg button')].find((item) => item.textContent?.startsWith('3 мин'))!)
    expect(section('Speaking').querySelector('ins')!.textContent).toBe('would like')
    expect(section('Speaking').textContent).toContain('без длинных пауз.')
  })

  it('renders the mini drill after the warm-up cards, checks it locally and names the error type', async () => {
    await startLesson({ ...lesson, content: { ...lesson.content, drill: { type: 'article', items: [{ before: 'She is ', after: ' engineer.', answer: 'an' }, { before: 'He has ', after: ' idea.', answer: 'an' }] } } })
    const warmup = section('Разминка')
    expect(warmup.textContent).toContain('Мини-упражнение: артикли')
    expect(warmup.textContent).not.toContain('an engineer')
    const gaps = warmup.querySelectorAll<HTMLInputElement>('.en-q input')
    await setValue(gaps[0]!, 'An'); await setValue(gaps[1]!, 'the')
    await clickText('Проверить')
    expect(warmup.querySelectorAll('.en-q__ans.is-ok')).toHaveLength(1)
    expect(warmup.querySelector('.en-q__ans.is-bad')!.textContent).toBe('an')
    expect(client.englishReview).not.toHaveBeenCalled()
  })

  it('omits the drill when there is none', async () => {
    await startLesson()
    expect(section('Разминка').textContent).not.toContain('Мини-упражнение')
  })

  it('takes the listening speed from the lesson tts_rate, not from weekly stats', async () => {
    await startLesson({ ...lesson, content: { ...lesson.content, listening: { ...lesson.content.listening!, tts_rate: 0.9 } } }) // course week_stats say 71%
    await click(nav('Listening'))
    expect([...host.querySelectorAll<HTMLButtonElement>('.en-speeds button')].map((item) => item.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
    await click(host.querySelector('button[aria-label="Слушать"]')!)
    expect(spoken[0]!.rate).toBe(0.9)
  })

  it('stops speech and releases the microphone when another top-level tab is opened', async () => {
    const { stop } = installRecorder()
    await startLesson(); await click(nav('Listening'))
    await click(host.querySelector('button[aria-label="Слушать"]')!)
    expect(host.querySelector('button[aria-label="Остановить"]')).toBeTruthy()
    await clickText('Курс')
    expect(host.querySelector('button[aria-label="Остановить"]')).toBeNull()
    await clickText('Урок дня'); await click(nav('Speaking'))
    await click(recordBtn())
    expect(host.textContent).toContain('Идёт запись')
    await clickText('Курс')
    expect(stop).toHaveBeenCalled()
    await clickText('Урок дня')
    expect(host.textContent).not.toContain('Идёт запись')
  })

  it('ignores a double tap while the microphone prompt is open and releases a stream that arrives after unmount', async () => {
    const stop = vi.fn(); let grant!: (stream: unknown) => void
    const { gum } = installRecorder(() => new Promise((resolve) => { grant = resolve }))
    await startLesson(); await click(nav('Speaking'))
    await click(recordBtn()); await click(recordBtn())
    expect(gum).toHaveBeenCalledTimes(1)
    expect(recordBtn().disabled).toBe(true)
    unmount()
    await act(async () => grant({ getTracks: () => [{ stop }] }))
    expect(stop).toHaveBeenCalled()
  })

  it('does not advance to the next block when marking the block done fails', async () => {
    client.englishBlockDone.mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom'))
    await startLesson({ ...lesson, content: { ...lesson.content, warmup: [] } })
    await clickText('Дальше: слова темы')
    expect(client.englishBlockDone).toHaveBeenCalledWith('l1', 'warmup')
    expect(nav('Разминка').getAttribute('aria-current')).toBe('step')
    await click(nav('Слова темы')); await clickText('Пропустить')
    expect(client.englishBlockDone).toHaveBeenLastCalledWith('l1', 'vocab')
    expect(nav('Слова темы').getAttribute('aria-current')).toBe('step')
  })

  it('does not reuse the previous recording duration for a typed answer in the next round', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      installRecorder(); client.englishTranscribe.mockResolvedValue({ text: 'I would like to be a designer.', duration_sec: 30 })
      client.englishSpeaking.mockResolvedValue(storedRound(4))
      await startLesson(); await click(nav('Speaking'))
      await click(recordBtn())
      await act(async () => { vi.advanceTimersByTime(30_000) })
      await click(host.querySelector('button[aria-label="Остановить запись"]')!)
      await clickText('Отправить на проверку')
      expect(client.englishSpeaking.mock.calls[0]![1]).toMatchObject({ round: 4, duration_sec: 30 })
      await click([...host.querySelectorAll<HTMLButtonElement>('.en-seg button')].find((item) => item.textContent?.startsWith('3 мин'))!)
      await clickText('Напечатать вместо записи')
      await setValue(field<HTMLTextAreaElement>('#en-transcript'), 'one two three four five six')
      await clickText('Отправить на проверку')
      expect(client.englishSpeaking.mock.calls[1]![1]).toMatchObject({ round: 3, duration_sec: 3 }) // 6 words at 130 wpm, not the stale 30 s
    } finally { vi.useRealTimers() }
  })

  it('shows the answers the learner gave after reloading a graded listening block', async () => {
    const graded = { ...lesson, content: { ...lesson.content, listening: { ...lesson.content.listening!, script_visible: true, questions: [{ n: 1, before: 'The main benefit was ', after: '.', answer: 'work experience' }, { n: 2, before: 'Deadlines were every ', after: '.', answer: 'Friday' }] } },
      progress: { listening: { done: true, score: 1, total: 2, feedback_ru: 'Ты пропустил «Friday».', results: [{ n: 1, given: 'work experience', answer: 'work experience', ok: true }, { n: 2, given: 'Monday', answer: 'Friday', ok: false }] } } } satisfies EnglishLesson
    await startLesson(graded); await click(nav('Listening'))
    const inputs = [...host.querySelectorAll<HTMLInputElement>('.en-q input')]
    expect(inputs.map((item) => item.value)).toEqual(['work experience', 'Monday'])
    expect(inputs.map((item) => item.getAttribute('data-state'))).toEqual(['ok', 'bad'])
    expect(inputs.every((item) => item.maxLength === 80)).toBe(true)
    expect(section('Listening').textContent).toContain('Ты пропустил «Friday».')
  })

  it('caps a long transcription at the backend limit and shows the counter', async () => {
    installRecorder(); client.englishTranscribe.mockResolvedValue({ text: 'word '.repeat(1400), duration_sec: 240 })
    await startLesson(); await click(nav('Speaking'))
    await click(recordBtn()); await click(host.querySelector('button[aria-label="Остановить запись"]')!)
    expect(field<HTMLTextAreaElement>('#en-transcript').value).toHaveLength(6000)
    expect(section('Speaking').textContent).toContain('6000/6000')
  })
})
