'use client'

import { useState, useRef, useCallback } from 'react'
import { Mic, Square } from 'lucide-react'
import { useCopy, useTranslation } from '../copy'
import { useAuth } from '../providers'
import { checkMicrophonePermission } from '../lib/microphone-permissions'
import { logger } from '../lib/error-logger'
import { debugLog, debugWarn } from '../lib/debug-logger'

// Legacy browser support type
type LegacyGetUserMedia = (
  constraints: MediaStreamConstraints,
  successCallback: (stream: MediaStream) => void,
  errorCallback: (error: Error) => void
) => void

interface LegacyNavigator extends Navigator {
  getUserMedia?: LegacyGetUserMedia
  webkitGetUserMedia?: LegacyGetUserMedia
  mozGetUserMedia?: LegacyGetUserMedia
}

interface VoiceMessage {
  id: string
  type: 'user' | 'sophia'
  content: string
  sender: 'user' | 'ai'
  timestamp: Date
  audioUrl?: string
  emotion?: { primary: string; confidence: number }
}

interface VoiceRecorderProps {
  onMessage: (message: VoiceMessage) => void
  setIsLoading: (loading: boolean) => void
  accessToken: string | null
}

export default function VoiceRecorder({ onMessage, setIsLoading, accessToken }: VoiceRecorderProps) {
  const copy = useCopy()
  const { t } = useTranslation()

  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  
  // 💜 Get authenticated user for rate limiting
  const { user } = useAuth()

  const startRecording = useCallback(async () => {
    try {
      // Check microphone permission before attempting access (non-blocking)
      // Only block if we're CERTAIN it's denied
      let permissionState: "granted" | "denied" | "prompt" | "unknown" = "unknown"
      try {
        permissionState = await checkMicrophonePermission()
      } catch {
        // Permission API not available - this is OK, we'll try getUserMedia anyway
        permissionState = "unknown"
      }
      
      // Only block if we're CERTAIN permission is denied
      if (permissionState === "denied") {
        alert(t('voiceRecorder.errors.micBlocked'))
        return
      }

      // Support multiple browser APIs for maximum compatibility
      let stream: MediaStream
      const legacyNav = navigator as LegacyNavigator
      
      // Try modern API first
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        })
      }
      // Fallback for older browsers
      else if (legacyNav.getUserMedia) {
        stream = await new Promise<MediaStream>((resolve, reject) => {
          legacyNav.getUserMedia!(
            { audio: true },
            resolve,
            reject
          )
        })
      }
      // Fallback for webkit browsers
      else if (legacyNav.webkitGetUserMedia) {
        stream = await new Promise<MediaStream>((resolve, reject) => {
          legacyNav.webkitGetUserMedia!(
            { audio: true },
            resolve,
            reject
          )
        })
      }
      // Fallback for moz browsers
      else if (legacyNav.mozGetUserMedia) {
        stream = await new Promise<MediaStream>((resolve, reject) => {
          legacyNav.mozGetUserMedia!(
            { audio: true },
            resolve,
            reject
          )
        })
      }
      else {
        throw new Error("getUserMedia is not supported in this browser. Please use a modern browser like Chrome, Firefox, Safari, or Edge.")
      }

      streamRef.current = stream
      audioChunksRef.current = []

      // Try WAV first, fallback to WebM
      let options = { mimeType: 'audio/wav' }
      if (!MediaRecorder.isTypeSupported('audio/wav')) {
        options = { mimeType: 'audio/webm;codecs=opus' }
      }

      const mediaRecorder = new MediaRecorder(stream, options)
      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = async () => {
        await processRecording()
      }

      // Start without a timeslice to ensure we always receive a final
      // dataavailable event with the full recording on stop. Using a very
      // short timeslice can cause empty chunks if the user stops quickly.
      mediaRecorder.start()
      setIsRecording(true)
      setRecordingTime(0)

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1)
      }, 1000)

    } catch (error) {
      // Better error handling - distinguish between different error types
      const err = error as Error
      const errorName = err.name || ""
      const errorMessage = err.message || ""
      
      let userMessage = t('voiceRecorder.errors.micDenied')
      
      // Check for specific permission errors
      if (
        errorName === "NotAllowedError" ||
        errorName === "PermissionDeniedError" ||
        errorMessage.toLowerCase().includes("permission") ||
        errorMessage.toLowerCase().includes("denied") ||
        errorMessage.toLowerCase().includes("not allowed") ||
        errorMessage.toLowerCase().includes("notallowed")
      ) {
        // Double-check permission state after error (non-blocking)
        try {
          const currentPermission = await checkMicrophonePermission()
          if (currentPermission === "denied") {
            userMessage = t('voiceRecorder.errors.micBlocked')
          } else {
            userMessage = t('voiceRecorder.errors.micDeniedPrompt')
          }
        } catch {
          // Permission check failed, use generic message
          userMessage = t('voiceRecorder.errors.micDeniedPrompt')
        }
      } else if (
        errorName === "NotFoundError" ||
        errorName === "DevicesNotFoundError" ||
        errorMessage.toLowerCase().includes("device") ||
        errorMessage.toLowerCase().includes("not found")
      ) {
        userMessage = t('voiceRecorder.errors.noMicrophone')
      } else if (
        errorName === "NotReadableError" ||
        errorMessage.toLowerCase().includes("readable") ||
        errorMessage.toLowerCase().includes("in use")
      ) {
        userMessage = t('voiceRecorder.errors.micInUse')
      } else if (errorMessage.includes("not supported") || errorMessage.includes("getUserMedia")) {
        userMessage = t('voiceRecorder.errors.notSupported')
      } else if (errorMessage.includes("secure context") || errorMessage.includes("HTTPS")) {
        userMessage = t('voiceRecorder.errors.httpsRequired')
      }
      
      debugLog('VoiceRecorder', 'Showing error message', { userMessage })
      alert(userMessage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
        streamRef.current = null
      }
    }
  }, [isRecording])

  const processRecording = async () => {
    if (audioChunksRef.current.length === 0) {
      alert(t('voiceRecorder.errors.noAudio'))
      return
    }

    // Accept short recordings as long as we received data

    setIsLoading(true)

    try {
      if (!accessToken) {
        throw new Error('Missing backend access token. Please refresh the page or sign in again.')
      }

      const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm;codecs=opus'
      const audioBlob = new Blob(audioChunksRef.current, { type: mimeType })

      if (audioBlob.size === 0) {
        alert(t('voiceRecorder.errors.noAudio'))
        return
      }
      
      const formData = new FormData()
      let fileName = 'recording.wav'
      if (mimeType.includes('webm')) {
        fileName = 'recording.webm'
      }
      
      formData.append('file', audioBlob, fileName)
      
      // 💜 Add user_id for rate limiting (optional)
      if (user?.id) {
        formData.append('user_id', user.id)
      }

      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001'}/defi-chat/stream`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        body: formData
      })

      if (!response.ok || !response.body) {
        const detail = !response.ok ? `${response.status} ${response.statusText}` : 'No response body'
        throw new Error(`Streaming request failed: ${detail}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      const sophiaMessageId = Date.now().toString() + '_sophia'
      let transcriptAdded = false
      let accumulated = ''
      let audioUrl: string | null = null

      const pushSophiaMessage = (content: string) => {
        onMessage({
          id: sophiaMessageId,
          type: 'sophia',
          content,
          sender: 'ai',
          timestamp: new Date()
        })
      }

      const updateSophiaMessage = (content: string, extra?: { audioUrl?: string; emotion?: VoiceMessage['emotion'] }) => {
        onMessage({
          id: sophiaMessageId,
          type: 'sophia',
          content,
          sender: 'ai',
          audioUrl: extra?.audioUrl,
          emotion: extra?.emotion,
          timestamp: new Date()
        })
      }

      const _processLine = (line: string) => {
        if (!line.trim()) return
        // Expect SSE lines like: "event: token" or "data: ..."
        // We'll collect per-event until a blank line separates events
      }

      // Simple SSE parser state
      let currentEvent: string | null = null
      let currentData: string[] = []

      const handleEvent = (event: string, data: string) => {
        try {
          if (event === 'transcript') {
            const payload = JSON.parse(data)
            // Add user message first
            if (!transcriptAdded) {
              onMessage({
                id: Date.now().toString() + '_user',
                type: 'user',
                content: payload.transcript,
                sender: 'user',
                emotion: payload.user_emotion,
                timestamp: new Date()
              })
              transcriptAdded = true
              // Initialize Sophia message as empty to start streaming
              pushSophiaMessage('')
            }
          } else if (event === 'token') {
            const chunk = data
            accumulated += chunk
            updateSophiaMessage(accumulated)
          } else if (event === 'reply_done') {
            const payload = JSON.parse(data)
            accumulated = payload.reply || accumulated
            updateSophiaMessage(accumulated)
          } else if (event === 'audio_url') {
            const payload = JSON.parse(data)
            audioUrl = payload.audio_url
            const mock = !!payload.mock_audio
            updateSophiaMessage(accumulated, { audioUrl: payload.audio_url, emotion: payload.sophia_emotion })
            if (audioUrl && !mock && /^https?:\/\//.test(audioUrl)) {
              setTimeout(() => playAudio(audioUrl!), 300)
            }
          } else if (event === 'error') {
            debugWarn('VoiceRecorder', 'SSE error', { data })
          }
        } catch (err) {
          debugWarn('VoiceRecorder', 'Failed to handle SSE event', { event, error: err })
        }
      }

      const flushIfEventComplete = () => {
        if (currentEvent) {
          const data = currentData.join('\n')
          handleEvent(currentEvent, data)
          currentEvent = null
          currentData = []
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          // flush remaining
          flushIfEventComplete()
          break
        }
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.startsWith('event:')) {
            // Starting new event; flush previous
            flushIfEventComplete()
            currentEvent = line.slice('event:'.length).trim()
          } else if (line.startsWith('data:')) {
            currentData.push(line.slice('data:'.length).trim())
          } else if (line.trim() === '') {
            // separator between events
            flushIfEventComplete()
          } else {
            // continuation of data or ignore
            currentData.push(line)
          }
        }
      }

    } catch (error) {
      logger.logError(error, { component: 'VoiceRecorder', action: 'process_recording' })
      alert(t('voiceRecorder.errors.network'))
    } finally {
      setIsLoading(false)
      setRecordingTime(0)
    }
  }

  const playAudio = async (audioUrl: string) => {
    try {
      const audio = new Audio(audioUrl)
      await audio.play()
    } catch (error) {
      logger.logError(error, { component: 'VoiceRecorder', action: 'play_audio' })
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="bg-gradient-to-br from-dark-card via-gray-800/50 to-dark-card border border-dark-border rounded-2xl p-8 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-purple-500/5 to-transparent rounded-full blur-2xl"></div>
      <div className="absolute bottom-0 left-0 w-20 h-20 bg-gradient-to-tr from-cyan-500/5 to-transparent rounded-full blur-2xl"></div>
      
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-r from-purple-500 to-cyan-500 rounded-xl flex items-center justify-center">
              <Mic className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-white">{t('voiceRecorder.title')}</h3>
              <p className="text-sm text-gray-400">{t('voiceRecorder.subtitle')}</p>
            </div>
          </div>
          {isRecording && (
            <div className="flex items-center gap-3 px-4 py-2 bg-red-500/20 border border-red-500/30 rounded-xl">
              <div className="w-3 h-3 bg-red-400 rounded-full animate-pulse shadow-lg shadow-red-400/50"></div>
              <span className="text-sm font-mono text-red-300 font-bold">{formatTime(recordingTime)}</span>
              <span className="text-xs text-red-400 uppercase">{t('voiceRecorder.recordingBadge')}</span>
            </div>
          )}
        </div>

        <div className="flex flex-col items-center justify-center py-8">
          {!isRecording ? (
            <div className="text-center">
              <button
                onClick={startRecording}
                className="group relative w-24 h-24 bg-gradient-to-br from-purple-500 via-blue-500 to-cyan-500 rounded-3xl flex items-center justify-center hover:scale-105 transition-all duration-300 shadow-2xl hover:shadow-purple-500/30 mb-6"
              >
                <Mic className="w-10 h-10 text-white group-hover:scale-105 transition-transform" />
                <div className="absolute inset-0 rounded-3xl bg-white/10 scale-0 group-hover:scale-110 transition-transform duration-500"></div>
                <div className="absolute -inset-2 rounded-3xl bg-gradient-to-r from-purple-500/20 to-cyan-500/20 scale-0 group-hover:scale-100 transition-transform duration-700 blur-lg"></div>
              </button>
              
              <div className="space-y-2">
                <p className="text-lg font-semibold text-white">{t('voiceRecorder.readyTitle')}</p>
                <p className="text-sm text-gray-400 max-w-md mx-auto leading-relaxed">
                  {t('voiceRecorder.readyBody')}
                </p>
              </div>
              
              {/* Feature highlights */}
              <div className="grid grid-cols-3 gap-4 mt-8 max-w-md mx-auto">
                {copy.voiceRecorder.highlights.map((highlight) => (
                  <div
                    key={highlight.id}
                    className="text-center p-3 bg-gradient-to-br from-purple-500/10 to-blue-500/10 border border-purple-500/20 rounded-xl"
                  >
                    <div className="text-lg mb-1">{highlight.emoji}</div>
                    <p className="text-xs text-gray-300 font-medium">{highlight.label}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center">
              <button
                onClick={stopRecording}
                className="relative w-24 h-24 bg-gradient-to-br from-red-500 to-red-600 rounded-3xl flex items-center justify-center hover:scale-105 transition-all duration-200 shadow-2xl shadow-red-500/30 mb-6 animate-pulse"
              >
                <Square className="w-8 h-8 text-white fill-current" />
                <div className="absolute -inset-4 rounded-3xl border-2 border-red-400/50 animate-ping"></div>
              </button>
              
              <div className="space-y-2">
                <p className="text-lg font-semibold text-white">{t('voiceRecorder.recordingTitle')}</p>
                <p className="text-sm text-gray-400">
                  {t('voiceRecorder.recordingBody')}
                </p>
              </div>
              
              {/* Audio visualization */}
              <div className="flex items-center justify-center gap-1 mt-6">
                {[...Array(5)].map((_, i) => (
                  <div
                    key={i}
                    className="w-1 bg-gradient-to-t from-purple-500 to-cyan-500 rounded-full animate-pulse"
                    style={{
                      height: `${Math.random() * 20 + 10}px`,
                      animationDelay: `${i * 0.1}s`,
                      animationDuration: '0.8s'
                    }}
                  ></div>
                ))}
              </div>
            </div>
          )}
        </div>
        
        {/* Tips section */}
        <div className="mt-8 p-4 bg-sophia-surface border border-sophia-surface-border rounded-xl">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 bg-gradient-to-r from-yellow-500 to-orange-500 rounded-lg flex items-center justify-center flex-shrink-0">
              <span className="text-sm">💡</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-sophia-text mb-1">{t('voiceRecorder.tipsTitle')}</p>
              <ul className="text-xs text-sophia-text2 space-y-1">
                {copy.voiceRecorder.tips.map((tip, idx) => (
                  <li key={idx}>• {tip}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
