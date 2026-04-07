/**
 * SophiaEyes Component
 * Sprint 1+ - Delightful UX
 * 
 * Subtle "eyes" animation that makes Sophia feel present.
 * Used in the session page when Sophia is thinking/responding.
 */

'use client';

import { cn } from '../../lib/utils';

interface SophiaEyesProps {
  state: 'idle' | 'listening' | 'thinking' | 'speaking';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function SophiaEyes({ state, size = 'md', className }: SophiaEyesProps) {
  const sizeClasses = {
    sm: 'w-12 h-6 gap-2',
    md: 'w-16 h-8 gap-3',
    lg: 'w-20 h-10 gap-4',
  };
  
  const dotSizes = {
    sm: 'w-2 h-2',
    md: 'w-3 h-3',
    lg: 'w-4 h-4',
  };

  return (
    <div 
      className={cn(
        'flex items-center justify-center',
        sizeClasses[size],
        className
      )}
      role="img"
      aria-label={`Sophia is ${state}`}
    >
      {/* Left eye */}
      <div className={cn(
        'rounded-full transition-all duration-500',
        dotSizes[size],
        state === 'idle' && 'bg-sophia-purple/60',
        state === 'listening' && 'bg-sophia-purple animate-[blink_3s_ease-in-out_infinite]',
        state === 'thinking' && 'bg-amber-400 animate-[lookAround_2s_ease-in-out_infinite]',
        state === 'speaking' && 'bg-sophia-purple animate-pulse',
      )} />
      
      {/* Right eye */}
      <div className={cn(
        'rounded-full transition-all duration-500',
        dotSizes[size],
        state === 'idle' && 'bg-sophia-purple/60',
        state === 'listening' && 'bg-sophia-purple animate-[blink_3s_ease-in-out_infinite_0.1s]',
        state === 'thinking' && 'bg-amber-400 animate-[lookAround_2s_ease-in-out_infinite_0.1s]',
        state === 'speaking' && 'bg-sophia-purple animate-pulse',
      )} />
    </div>
  );
}

export default SophiaEyes;
