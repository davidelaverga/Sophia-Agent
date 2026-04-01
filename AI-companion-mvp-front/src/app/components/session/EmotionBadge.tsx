/**
 * EmotionBadge Component
 * Sprint 2 - Visual emotion detection feedback
 * 
 * Shows the detected emotion from Sophia's analysis
 * with color-coded badges and icons.
 */

'use client';

interface EmotionBadgeProps {
  emotion: string | null;
  confidence?: number;
  size?: 'sm' | 'md' | 'lg';
  showConfidence?: boolean;
}

// Emotion configurations with colors and emojis
const EMOTION_CONFIG: Record<string, { emoji: string; bgColor: string; textColor: string; label: string }> = {
  // Negative emotions
  angry: { emoji: '😤', bgColor: 'bg-red-100 dark:bg-red-900/30', textColor: 'text-red-700 dark:text-red-300', label: 'Angry' },
  frustrated: { emoji: '😣', bgColor: 'bg-orange-100 dark:bg-orange-900/30', textColor: 'text-orange-700 dark:text-orange-300', label: 'Frustrated' },
  anxious: { emoji: '😰', bgColor: 'bg-amber-100 dark:bg-amber-900/30', textColor: 'text-amber-700 dark:text-amber-300', label: 'Anxious' },
  sad: { emoji: '😢', bgColor: 'bg-blue-100 dark:bg-blue-900/30', textColor: 'text-blue-700 dark:text-blue-300', label: 'Sad' },
  overwhelmed: { emoji: '😵', bgColor: 'bg-purple-100 dark:bg-purple-900/30', textColor: 'text-purple-700 dark:text-purple-300', label: 'Overwhelmed' },
  
  // Neutral
  neutral: { emoji: '😐', bgColor: 'bg-gray-100 dark:bg-gray-800', textColor: 'text-gray-600 dark:text-gray-300', label: 'Neutral' },
  
  // Positive emotions
  happy: { emoji: '😊', bgColor: 'bg-green-100 dark:bg-green-900/30', textColor: 'text-green-700 dark:text-green-300', label: 'Happy' },
  excited: { emoji: '🎉', bgColor: 'bg-yellow-100 dark:bg-yellow-900/30', textColor: 'text-yellow-700 dark:text-yellow-300', label: 'Excited' },
  calm: { emoji: '😌', bgColor: 'bg-cyan-100 dark:bg-cyan-900/30', textColor: 'text-cyan-700 dark:text-cyan-300', label: 'Calm' },
  hopeful: { emoji: '🌟', bgColor: 'bg-indigo-100 dark:bg-indigo-900/30', textColor: 'text-indigo-700 dark:text-indigo-300', label: 'Hopeful' },
  grateful: { emoji: '🙏', bgColor: 'bg-pink-100 dark:bg-pink-900/30', textColor: 'text-pink-700 dark:text-pink-300', label: 'Grateful' },
  
  // Gaming specific
  tilted: { emoji: '🎮', bgColor: 'bg-red-100 dark:bg-red-900/30', textColor: 'text-red-700 dark:text-red-300', label: 'Tilted' },
  focused: { emoji: '🎯', bgColor: 'bg-blue-100 dark:bg-blue-900/30', textColor: 'text-blue-700 dark:text-blue-300', label: 'Focused' },
};

const DEFAULT_CONFIG = { emoji: '💭', bgColor: 'bg-gray-100 dark:bg-gray-800', textColor: 'text-gray-600 dark:text-gray-300', label: 'Unknown' };

export function EmotionBadge({ 
  emotion, 
  confidence, 
  size = 'md',
  showConfidence = false 
}: EmotionBadgeProps) {
  // Don't render if no emotion
  if (!emotion) return null;
  
  const config = EMOTION_CONFIG[emotion.toLowerCase()] || DEFAULT_CONFIG;
  const displayLabel = config.label;
  
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs gap-1',
    md: 'px-3 py-1 text-sm gap-1.5',
    lg: 'px-4 py-1.5 text-base gap-2',
  };
  
  return (
    <div
      className={`
        inline-flex items-center rounded-full font-medium
        ${config.bgColor} ${config.textColor}
        ${sizeClasses[size]}
        border border-current/10
        shadow-sm
        animate-fadeIn
        transition-all duration-300
      `}
    >
      <span>{config.emoji}</span>
      <span>{displayLabel}</span>
      {showConfidence && confidence !== undefined && (
        <span className="opacity-60 text-xs">
          {Math.round(confidence * 100)}%
        </span>
      )}
    </div>
  );
}

export default EmotionBadge;
