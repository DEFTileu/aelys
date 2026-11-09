import { useState } from 'react'
import type { EnglishLesson, EnglishSentenceResult } from '@aelys/shared'
import { Volume2 } from '../../../icons'
import { getSharedApiClient } from '../../../lib/api'
import { speakParts, speechSupported } from '../speech'
import type { CourseHook } from '../useEnglishCourse'

export function VocabBlock({ lesson, en, onNext }: { lesson: EnglishLesson; en: CourseHook; onNext: () => void }) {
  const words = lesson.content.vocab
  const [mine, setMine] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState<Record<string, EnglishSentenceResult>>({})
  const [checked, setChecked] = useState(false)
  const filled = words.filter((word) => (mine[word.word_id] ?? '').trim().length >= 3)
  const check = () => void en.run(async () => {
    const { items } = await getSharedApiClient().englishSentences(lesson.id, filled.slice(0, 12).map((word) => ({ word_id: word.word_id, sentence: mine[word.word_id]!.trim() })))
    setFeedback(Object.fromEntries(items.map((item) => [item.word_id, item]))); setChecked(true)
  })
  const next = () => void en.markDone('vocab').then((ok) => ok && onNext())
  return <section className="en-stack" aria-label="Слова темы">
    <div><h2 className="en-h">Слова темы: {lesson.content.theme}</h2>
      <p className="en-muted">Лексика Band 6–7 для Speaking Part 3 и Writing Task 2. Составь своё предложение с каждым словом.</p></div>
    {words.map((word) => {
      const fb = feedback[word.word_id]
      const id = `en-sent-${word.word_id}`
      return <article key={word.word_id} className="en-card en-vocab">
        <div className="en-stack en-stack--tight">
          <div className="en-word-head"><strong className="en-word-title">{word.lemma}</strong>
            {word.ipa && <span className="en-muted">{word.ipa}</span>}
            {word.part_of_speech && <span className="en-muted">{word.part_of_speech}</span>}
            {speechSupported() && <button type="button" className="en-icon-btn" aria-label={`Послушать ${word.lemma}`} onClick={() => speakParts([{ text: word.lemma, rate: 0.9 }])}><Volume2 size={16} /></button>}</div>
          <p className="en-ru">{word.translation_ru}</p>
          <p className="en-muted">{word.definition_en}</p>
          <p><em>{word.example}</em></p>
          {word.collocations.length > 0 && <ul className="en-tags" aria-label="Сочетания">{word.collocations.map((item) => <li key={item}>{item}</li>)}</ul>}
        </div>
        <div className="en-stack en-stack--tight">
          <label htmlFor={id} className="en-label">Твоё предложение с «{word.lemma}»</label>
          <textarea id={id} rows={2} maxLength={300} value={mine[word.word_id] ?? ''} onChange={(event) => { setMine({ ...mine, [word.word_id]: event.target.value }); setChecked(false) }} />
          {fb && <div className={`en-fb ${fb.ok ? 'en-fb--ok' : 'en-fb--fix'}`} role="status"><strong>{fb.title_ru}</strong> {fb.detail_ru}{fb.corrected && <> <ins>{fb.corrected}</ins></>}</div>}
        </div>
      </article>
    })}
    <div className="en-actions">
      <button type="button" className="en-btn en-btn--primary" disabled={en.busy || en.writeBlocked || (!checked && !filled.length)} onClick={checked ? next : check}>
        {en.busy ? 'Проверяем…' : checked ? 'Дальше: Listening' : 'Проверить предложения'}</button>
      {!checked && <button type="button" className="en-btn" disabled={en.busy || en.writeBlocked} onClick={next}>Пропустить</button>}
    </div>
  </section>
}
