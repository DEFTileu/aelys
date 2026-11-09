import type { EnglishCorrection } from '@aelys/shared'

const TYPE_RU: Record<string, string> = { tense: 'время', article: 'артикль', preposition: 'предлог', collocation: 'сочетаемость', word_choice: 'выбор слова', word_order: 'порядок слов', spelling: 'орфография', grammar: 'грамматика', punctuation: 'пунктуация', other: 'другое' }
const CRITERIA: [keyof NonNullable<EnglishCorrection['criteria']>, string][] = [['task_response', 'Task Response'], ['coherence', 'Coherence & Cohesion'], ['lexical', 'Lexical Resource'], ['grammar', 'Grammar']]

export function ReportResult({ result }: { result: EnglishCorrection }) {
  return <div className="en-result">
    {result.criteria && <ul className="en-crit" aria-label="Критерии Task 2 (примерно)">
      {CRITERIA.map(([key, label]) => <li key={key}><strong>{result.criteria![key]}</strong><span>{label}</span></li>)}</ul>}
    <p className="en-cefr">Уровень: примерно <strong>{result.cefr_estimate.level}</strong> <span>{result.cefr_estimate.rationale}</span></p>
    <h4>Исправленный текст</h4>
    <p className="en-corrected">{result.corrected_text}</p>
    {result.errors.length > 0 ? <><h4>Ошибки ({result.errors.length})</h4>
      <ul className="en-errors">{result.errors.map((error, index) => <li key={index} data-severity={error.severity}>
        <p><del>{error.original}</del> → <ins>{error.correction}</ins> <span className="en-type">{TYPE_RU[error.type] ?? error.type}</span></p>
        <p>{error.explanation_ru}</p></li>)}</ul></> : <p>Ошибок не найдено.</p>}
    {result.target_words.length > 0 && <><h4>Слова урока в тексте</h4>
      <ul className="en-targets">{result.target_words.map((item) => <li key={item.word}><strong>{item.word}</strong>: {item.used_correctly ? 'использовано верно' : 'нужно поправить'}{item.note && ` — ${item.note}`}</li>)}</ul></>}
    {result.strengths.length > 0 && <><h4>Что получилось</h4><ul>{result.strengths.map((item) => <li key={item}>{item}</li>)}</ul></>}
    <p className="en-summary">{result.summary_ru}</p>
  </div>
}
