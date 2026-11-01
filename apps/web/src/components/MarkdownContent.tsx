import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './rich-text.css'

/** No raw HTML, embedded frames or remote image requests. */
export function MarkdownContent({ text }: { text: string }) {
  return <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span>[Image: {alt || 'attachment'}]</span>,
  }}>{text}</ReactMarkdown></div>
}
