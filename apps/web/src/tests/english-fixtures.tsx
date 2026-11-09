import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'
import type { EnglishCourse, EnglishLesson, EnglishStoredSpeakingRound } from '@aelys/shared'
import { EnglishView } from '../views/EnglishView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export const makeClient = () => ({
  englishCourse: vi.fn(), englishLessonToday: vi.fn(), englishBlockDone: vi.fn(), englishSaveProfile: vi.fn(), englishReview: vi.fn(), englishSentences: vi.fn(),
  englishListening: vi.fn(), englishSpeaking: vi.fn(), englishTranscribe: vi.fn(), englishCreateMock: vi.fn(), englishToday: vi.fn(), englishReports: vi.fn(),
  englishSettings: vi.fn(), englishSaveSettings: vi.fn(), englishSubmitReport: vi.fn(), createTask: vi.fn(),
})
export type Client = ReturnType<typeof makeClient>

export const profile = { goal: 'ielts_academic', target_band: '6.5', level: 'b1b2', weak_skills: ['speaking', 'listening'], minutes_per_day: 120, exam_date: '2027-01-22', course_started_on: '2026-10-26' } as const
export const course: EnglishCourse = {
  profile, week: 3, lesson_no: 13, days_to_exam: 74, hours_done: 31, hours_target: 150,
  plan: [
    { week: 1, theme: 'Диагностика и базовые связки', grammar: 'Present tenses', status: 'done' },
    { week: 2, theme: 'Education & learning', grammar: 'Артикли', status: 'done' },
    { week: 3, theme: 'Work & careers', grammar: 'Предлоги', status: 'now' },
    { week: 4, theme: 'Technology & society', grammar: 'Conditionals', status: 'next' },
  ],
  skills: [{ skill: 'listening', band: '5.0', trend: '+0.5' }, { skill: 'reading', band: '6.0', trend: '0' }, { skill: 'writing', band: null, trend: null }, { skill: 'speaking', band: '≈5.0', trend: '-0.5' }],
  adaptations: [{ skill: 'listening', icon: 'headphones', title: 'Listening 5.0:', detail: 'добавлена тренировка слитной речи.' }, { skill: 'writing', icon: 'triangle-alert', title: 'Артикли — 3 урока подряд:', detail: 'мини-упражнение в разминке.' }],
  week_stats: { speaking_rounds: 3, new_words: 38, listening_pct: 71, streak: 9 },
  mock_due: false,
  today: { id: null, blocks: [{ key: 'warmup', title: 'Разминка', minutes: 10, done: false }, { key: 'vocab', title: 'Слова темы', minutes: 15, done: false }, { key: 'listening', title: 'Listening', minutes: 40, done: false }, { key: 'speaking', title: 'Speaking', minutes: 25, done: false }, { key: 'writing', title: 'Writing', minutes: 30, done: false }] },
}
export const lesson: EnglishLesson = {
  id: 'l1', day: '2026-11-09', lesson_no: 13, week: 3, theme: 'Work & careers', progress: {},
  content: {
    theme: 'Work & careers', grammar_focus: 'Предлоги', drill: null,
    blocks: [{ key: 'warmup', title: 'Разминка', minutes: 10 }, { key: 'vocab', title: 'Слова темы', minutes: 15 }, { key: 'listening', title: 'Listening', minutes: 40 }, { key: 'speaking', title: 'Speaking', minutes: 25 }, { key: 'writing', title: 'Writing', minutes: 30 }],
    warmup: [{ word_id: 'w1', before: 'She was ', answer: 'reluctant', after: ' to ask for a raise.', hint_ru: 'неохотный' }, { word_id: 'w2', before: 'It is ', answer: 'essential', after: ' here.', hint_ru: 'необходимый' }],
    vocab: [{ word_id: 'v1', lemma: 'career path', ipa: '/kəˈrɪə pɑːθ/', part_of_speech: 'noun', translation_ru: 'карьерный путь', definition_en: 'a way a career develops', example: 'My career path changed.', collocations: ['choose a career path'] }],
    listening: {
      title: 'The internship', script_visible: false, tts_rate: 1, live: { source: 'BBC 6 Minute English', url: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english', hint_ru: 'Британский акцент, 6 минут.' },
      script: [{ speaker: 'A', text: 'Did the internship help?' }, { speaker: 'B', text: 'Definitely, I got work experience.' }],
      questions: [{ n: 1, before: 'The main benefit was ', after: '.' }, { n: 2, before: 'Deadlines were every ', after: '.' }],
      connected_speech: [{ phrase: 'work experience', sounds_like: 'work‿experience', note_ru: 'слитно' }],
    },
    speaking: { part2: { topic: 'Describe a job you would like to do.', bullets: ['what the job is', 'what skills it requires'] }, part3: ['Why do people change jobs?'], phrases: ['What I mean is'] },
    writing: { kind: 'journal', prompt: null },
  },
}
export const task2Lesson: EnglishLesson = { ...lesson, content: { ...lesson.content, writing: { kind: 'task2', prompt: 'Is work experience more valuable than a degree?' } } }

export function installClient(client: Client) {
  client.englishCourse.mockResolvedValue(course)
  client.englishLessonToday.mockResolvedValue(lesson)
  client.englishToday.mockResolvedValue({ day: '2026-11-09', new_words: [], due_words: [], report: null, stats: { total: 0, mastered: 0, streak: 0 } })
  client.englishReports.mockResolvedValue([])
  client.englishSettings.mockResolvedValue({ reminder_enabled: false, reminder_time: '21:00', timezone: 'UTC' })
  client.englishBlockDone.mockResolvedValue(lesson)
  client.englishReview.mockResolvedValue({})
}

let root: ReturnType<typeof createRoot> | undefined
export let host: HTMLDivElement
export async function mount() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root!.render(<EnglishView apiStatus="ready" />))
}
export function unmount() { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' }
export const byText = <T extends HTMLElement = HTMLButtonElement>(selector: string, text: string) => [...host.querySelectorAll<T>(selector)].find((item) => item.textContent?.trim() === text)
export const button = (text: string) => { const found = byText('button', text); if (!found) throw new Error(`No button "${text}"`); return found }
export const click = (element: HTMLElement) => act(async () => { element.click() })
export const clickText = (text: string) => click(button(text))
export const setValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => act(async () => {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
})
export const field = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!

/** A speaking round as the backend stores it; pass `partial` for rows written before corrected text and tips were kept. */
export const storedRound = (round: 4 | 3 | 2, partial = false): EnglishStoredSpeakingRound => ({
  round, criteria: { fluency: '≈5.5', lexical: '≈6.0', grammar: '≈5.5' }, pauses: 3, linkers_used: 2, duration_sec: 200,
  ...(partial ? {} : { corrected_html_safe: [{ type: 'same', text: 'I ' }, { type: 'ins', text: 'would like' }], tips: [{ kind: 'good', title_ru: 'Хорошо:', detail_ru: 'без длинных пауз.' }] }),
})
