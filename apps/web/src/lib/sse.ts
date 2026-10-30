/** Consume UTF-8 SSE across arbitrary network chunk boundaries, including CRLF. */
export async function consumeSse(response: Response, onEvent: (name: string, data: Record<string, unknown>) => void) {
  if (!response.body) throw new Error('AI stream has no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const dispatch = (block: string) => {
    const lines = block.split(/\r?\n/)
    const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
    if (!data) return
    const parsed: unknown = JSON.parse(data)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onEvent(name, parsed as Record<string, unknown>)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        dispatch(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length)
      }
      if (done) { if (buffer.trim()) dispatch(buffer); break }
    }
  } finally { reader.releaseLock() }
}
