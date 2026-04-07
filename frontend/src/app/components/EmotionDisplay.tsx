'use client'

interface EmotionDisplayProps {
  emotion: {
    label: string
    confidence: number
  }
  size?: 'sm' | 'md' | 'lg'
}

export default function EmotionDisplay({ emotion, size = 'md' }: EmotionDisplayProps) {
  const getEmotionEmoji = (label: string) => {
    switch (label.toLowerCase()) {
      case 'positive':
        return '🟢'
      case 'negative':
        return '🔴'
      case 'neutral':
      default:
        return '⚪'
    }
  }

  const getEmotionColor = (label: string) => {
    switch (label.toLowerCase()) {
      case 'positive':
        return 'emotion-positive'
      case 'negative':
        return 'emotion-negative'
      case 'neutral':
      default:
        return 'emotion-neutral'
    }
  }

  const getSizeClasses = () => {
    switch (size) {
      case 'sm':
        return 'px-2 py-0.5 text-xs'
      case 'lg':
        return 'px-4 py-2 text-base'
      case 'md':
      default:
        return 'px-3 py-1 text-sm'
    }
  }

  const confidencePercentage = Math.round(emotion.confidence * 100)

  return (
    <div className={`inline-flex items-center gap-1 rounded-full border ${getEmotionColor(emotion.label)} ${getSizeClasses()}`}>
      <span className="text-xs">{getEmotionEmoji(emotion.label)}</span>
      <span className="font-medium capitalize">{emotion.label}</span>
      <span className="opacity-75">{confidencePercentage}%</span>
    </div>
  )
}
