/** Browser speech helpers: synthesis for listening drills, MediaRecorder for speaking. */

export type SpeechPart = { text: string; rate: number; pitch?: number }

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'

/** Prefer a British voice (IELTS accent), then any English voice, else the browser default. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  return voices.find((voice) => voice.lang.replace('_', '-').toLowerCase() === 'en-gb')
    ?? voices.find((voice) => voice.lang.toLowerCase().startsWith('en'))
}

export function stopSpeaking() { if (speechSupported()) window.speechSynthesis.cancel() }

/** Speaks the parts in order. Returns a cancel function; cancelling never fires the callbacks. */
export function speakParts(parts: readonly SpeechPart[], on: { onPart?: (index: number) => void; onDone?: () => void } = {}): () => void {
  if (!speechSupported() || !parts.length) { on.onDone?.(); return () => undefined }
  let live = true
  window.speechSynthesis.cancel()
  const voice = pickVoice(window.speechSynthesis.getVoices())
  parts.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part.text)
    utterance.lang = 'en-GB'
    if (voice) utterance.voice = voice
    utterance.rate = part.rate
    if (part.pitch) utterance.pitch = part.pitch
    utterance.onstart = () => { if (live) on.onPart?.(index) }
    utterance.onend = () => { if (live && index === parts.length - 1) on.onDone?.() }
    utterance.onerror = () => { if (live && index === parts.length - 1) on.onDone?.() }
    window.speechSynthesis.speak(utterance)
  })
  return () => { live = false; window.speechSynthesis.cancel() }
}

export const recordingSupported = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

export type Recording = { stop: () => Promise<Blob>; cancel: () => void }

/** Starts the microphone. Rejects when permission is denied. The mic tracks are always released on stop/cancel. */
export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const release = () => stream.getTracks().forEach((track) => track.stop())
  try {
    const recorder = new MediaRecorder(stream)
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    recorder.start()
    return {
      stop: () => new Promise<Blob>((resolve) => {
        recorder.onstop = () => { release(); resolve(new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] })) }
        if (recorder.state === 'inactive') recorder.onstop(new Event('stop')); else recorder.stop()
      }),
      cancel: () => { recorder.onstop = null; if (recorder.state !== 'inactive') recorder.stop(); release() },
    }
  } catch (error) { release(); throw error }
}

export const formatClock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.max(0, Math.floor(seconds) % 60)).padStart(2, '0')}`
