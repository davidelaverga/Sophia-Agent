/**
 * EmotionalWeather Component
 * Sprint 1+ - Visual indicators for emotional trends
 * 
 * Shows the user's emotional "weather" based on backend analysis.
 * Displayed in bootstrap cards and session header.
 */

'use client';

import { cn } from '../../lib/utils';
import type { EmotionalTrend, EmotionalWeather as EmotionalWeatherType } from '../../types/sophia-ui-message';

// =============================================================================
// TREND ICONS
// =============================================================================

interface TrendIconProps {
  trend: EmotionalTrend;
  size?: 'sm' | 'md' | 'lg';
  animated?: boolean;
  className?: string;
}

export function TrendIcon({ trend, size = 'md', animated = false, className }: TrendIconProps) {
  const sizeClasses = {
    sm: 'text-base',
    md: 'text-xl',
    lg: 'text-2xl',
  };
  
  const icons: Record<EmotionalTrend, { emoji: string; color: string }> = {
    improving: { emoji: '↗️', color: 'text-green-500' },
    stable: { emoji: '→', color: 'text-blue-400' },
    declining: { emoji: '↘️', color: 'text-orange-500' },
    unknown: { emoji: '🌤️', color: 'text-sophia-text2' },
  };
  
  const { emoji, color } = icons[trend] || icons.unknown;
  
  return (
    <span 
      className={cn(
        sizeClasses[size],
        color,
        animated && 'animate-pulse',
        className
      )}
      role="img" 
      aria-label={`Emotional trend: ${trend}`}
    >
      {emoji}
    </span>
  );
}

// =============================================================================
// WEATHER BADGE (compact display)
// =============================================================================

interface WeatherBadgeProps {
  weather: EmotionalWeatherType;
  showLabel?: boolean;
  className?: string;
}

export function WeatherBadge({ weather, showLabel = true, className }: WeatherBadgeProps) {
  const bgColors: Record<EmotionalTrend, string> = {
    improving: 'bg-green-500/10 border-green-500/20',
    stable: 'bg-blue-500/10 border-blue-500/20',
    declining: 'bg-orange-500/10 border-orange-500/20',
    unknown: 'bg-sophia-surface border-sophia-surface-border',
  };
  
  return (
    <div className={cn(
      'inline-flex items-center gap-1.5 px-2 py-1 rounded-full border',
      bgColors[weather.trend] || bgColors.unknown,
      className
    )}>
      <TrendIcon trend={weather.trend} size="sm" />
      {showLabel && (
        <span className="text-xs text-sophia-text2">{weather.label}</span>
      )}
    </div>
  );
}

// =============================================================================
// WEATHER CARD (for bootstrap display)
// =============================================================================

interface WeatherCardProps {
  weather: EmotionalWeatherType;
  className?: string;
}

export function WeatherCard({ weather, className }: WeatherCardProps) {
  const descriptions: Record<EmotionalTrend, string> = {
    improving: "Things seem to be looking up",
    stable: "Holding steady",
    declining: "Might be a tough stretch",
    unknown: "Let's check in",
  };
  
  const suggestions: Record<EmotionalTrend, string> = {
    improving: "Let's keep the momentum going.",
    stable: "Consistency is good. What's next?",
    declining: "I'm here if you need support.",
    unknown: "Tell me how you're feeling.",
  };
  
  return (
    <div className={cn(
      'p-4 rounded-xl bg-sophia-surface border border-sophia-surface-border',
      className
    )}>
      <div className="flex items-center gap-3 mb-2">
        <TrendIcon trend={weather.trend} size="lg" />
        <div>
          <p className="font-medium text-sophia-text">{weather.label}</p>
          <p className="text-sm text-sophia-text2">
            {descriptions[weather.trend]}
          </p>
        </div>
      </div>
      <p className="text-sm text-sophia-purple/80 italic">
        {suggestions[weather.trend]}
      </p>
      {weather.last_updated && (
        <p className="mt-2 text-[10px] text-sophia-text2/50">
          Updated {formatRelativeTime(weather.last_updated)}
        </p>
      )}
    </div>
  );
}

// =============================================================================
// MINI WEATHER (for session header)
// =============================================================================

interface MiniWeatherProps {
  weather: EmotionalWeatherType;
  onClick?: () => void;
  className?: string;
}

export function MiniWeather({ weather, onClick, className }: MiniWeatherProps) {
  const Component = onClick ? 'button' : 'div';
  
  return (
    <Component
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 text-sm',
        onClick && 'hover:opacity-80 transition-opacity cursor-pointer',
        className
      )}
      {...(onClick ? { 'aria-label': `Emotional weather: ${weather.label}` } : {})}
    >
      <TrendIcon trend={weather.trend} size="sm" />
      <span className="text-sophia-text2 text-xs hidden sm:inline">
        {weather.label}
      </span>
    </Component>
  );
}

// =============================================================================
// HELPER: Format relative time
// =============================================================================

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  return `${diffDays}d ago`;
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export const EmotionalWeather = {
  TrendIcon,
  Badge: WeatherBadge,
  Card: WeatherCard,
  Mini: MiniWeather,
};

export default EmotionalWeather;
