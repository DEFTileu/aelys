import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@aelys/shared'
import { getSharedApiClient } from '../../lib/api'
import { formatClock, recordingSupported, startRecording, type Recording } from '../english/speech'

const voiceError = (error: unknown) => {
  const code = error instanceof ApiError ? error.code : (error as { code?: string } | null)?.code
  if (code === 'VOICE_NOT_CONFIGURED') return 'Add an ElevenLabs key in Settings › AI & models'
  if (code === 'BUDGET_EXCEEDED') return 'Voice budget exceeded. Check your AI budget in Settings › AI & models.'
  return 'Voice request failed. Please try again.'
}

export function useVoice(send: (text: string, token: number) => void, setNotice: (notice: string) => void) {
  const generation = useRef(0)
  const playbackGeneration = useRef(0)
  const recording = useRef<Recording | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const audioUrl = useRef<string | null>(null)
  const releaseAudio = () => { audio.current?.pause(); audio.current = null; if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); audioUrl.current = null }
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [reading, setReading] = useState('')
  const clearTimer = () => { if (timer.current) clearInterval(timer.current); timer.current = null }
  const stopReading = () => { playbackGeneration.current++; releaseAudio(); setReading('') }
  const reset = () => { generation.current++; clearTimer(); recording.current?.cancel(); recording.current = null; stopReading(); setPhase('idle'); setElapsed(0) }
  useEffect(() => () => { generation.current++; playbackGeneration.current++; clearTimer(); recording.current?.cancel(); releaseAudio() }, [])
  const speak = async (id: string, text: string, token = generation.current) => {
    if (token !== generation.current) return
    stopReading(); const playback = playbackGeneration.current; setReading(id)
    try {
      const result = await getSharedApiClient().aiVoiceSpeak(text)
      if (token !== generation.current || playback !== playbackGeneration.current) return
      const bytes = Uint8Array.from(atob(result.audio), char => char.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: result.content_type })); audioUrl.current = url
      const player = new Audio(url); audio.current = player
      player.onended = () => { if (playback === playbackGeneration.current) { releaseAudio(); setReading('') } }
      player.onerror = () => { if (playback === playbackGeneration.current) { releaseAudio(); setReading(''); setNotice('Could not play voice audio.') } }
      await player.play()
    } catch (error) { if (token === generation.current && playback === playbackGeneration.current) { releaseAudio(); setReading(''); setNotice(voiceError(error)) } }
  }
  const stop = async () => {
    const current = recording.current; if (!current) return
    recording.current = null; clearTimer(); setPhase('transcribing'); const token = generation.current
    try {
      const blob = await current.stop()
      if (token !== generation.current) return
      const result = await getSharedApiClient().aiVoiceTranscribe(blob)
      if (token !== generation.current) return
      setPhase('idle')
      if (result.text.trim()) send(result.text.trim(), token)
      else setNotice('No speech was recognized. Please try again.')
    } catch (error) { if (token === generation.current) { setPhase('idle'); setNotice(voiceError(error)) } }
  }
  const start = async () => {
    if (phase !== 'idle') return
    stopReading(); setNotice(''); setPhase('starting'); const token = generation.current
    try {
      const current = await startRecording()
      if (token !== generation.current) { current.cancel(); return }
      recording.current = current; setElapsed(0); setPhase('recording')
      const started = Date.now()
      timer.current = setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); setElapsed(Math.min(60, seconds)); if (seconds >= 60) void stop() }, 250)
    } catch { if (token === generation.current) { setPhase('idle'); setNotice('Microphone access denied. Allow microphone access in your browser settings.') } }
  }
  return { supported: recordingSupported(), phase, clock: formatClock(elapsed), start, stop, speak, stopReading, reading, reset }
}
