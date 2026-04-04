'use client';

import { Check, Pencil, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { cn } from '../../lib/utils';
import type { MemoryCandidateV1 } from '../../lib/recap-types';
import { getRecapCategoryPresentation } from '../../lib/recap-types';

interface CosmicMemoryBubbleProps {
  candidate: MemoryCandidateV1;
  position: 'center' | 'left' | 'right';
  isExiting: boolean;
  exitAnimation: 'keep' | 'discard' | null;
  onKeep: () => void;
  onEdit: (editedText: string) => void;
  onDiscard: () => void;
  onClick?: () => void;
  disabled?: boolean;
}

function getDisplayText(candidate: MemoryCandidateV1): string {
  return (candidate.text ?? candidate.memory ?? '').trim();
}

export function CosmicMemoryBubble({
  candidate,
  position,
  isExiting,
  exitAnimation,
  onKeep,
  onEdit,
  onDiscard,
  onClick,
  disabled,
}: CosmicMemoryBubbleProps) {
  const isCenter = position === 'center';
  const displayText = getDisplayText(candidate);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(displayText);
  const categoryPresentation = useMemo(
    () => getRecapCategoryPresentation(candidate.category),
    [candidate.category]
  );

  const trimmedEditValue = editValue.trim();
  const canSaveEdit = trimmedEditValue.length > 0 && !disabled;

  const handleStartEdit = () => {
    if (disabled) return;
    setEditValue(displayText);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setEditValue(displayText);
    setIsEditing(false);
  };

  const handleSaveEdit = () => {
    if (!canSaveEdit) return;
    onEdit(trimmedEditValue);
    setIsEditing(false);
  };

  const getTransformStyles = (): string => {
    if (isExiting) {
      if (exitAnimation === 'keep') {
        return 'translate-y-[-100px] scale-90 opacity-0';
      }
      if (exitAnimation === 'discard') {
        return 'scale-[0.85] opacity-0 blur-md';
      }
    }

    switch (position) {
      case 'left':
        return '-translate-x-[90%] translate-y-[15px] scale-[0.48]';
      case 'right':
        return 'translate-x-[90%] translate-y-[15px] scale-[0.48]';
      default:
        return 'translate-x-0 scale-100';
    }
  };

  return (
    <div
      className={cn(
        'absolute transition-all ease-out',
        isCenter ? 'duration-500' : 'duration-700',
        getTransformStyles(),
        position === 'center' ? 'z-20' : 'z-10',
        !isCenter && 'opacity-[0.14] blur-[5px]',
        !isCenter && !disabled && 'cursor-pointer hover:opacity-[0.22] hover:blur-[3px]'
      )}
      data-onboarding={isCenter ? 'memory-card' : undefined}
      onClick={!isCenter && !disabled ? onClick : undefined}
      role={isCenter ? 'article' : 'button'}
      aria-label={
        isCenter
          ? `Current memory: ${displayText}`
          : `Navigate to: ${displayText.slice(0, 40)}...`
      }
      tabIndex={isCenter ? 0 : -1}
    >
      {isCenter && !isExiting && (
        <div
          className="absolute inset-0 -z-30 rounded-full motion-safe:animate-breatheSlow"
          style={{
            transform: 'scale(2.2)',
            background: 'radial-gradient(circle at 50% 52%, var(--sophia-purple) 0%, transparent 45%)',
            opacity: 0.08,
            filter: 'blur(80px)',
          }}
          aria-hidden="true"
        />
      )}

      {isCenter && !isExiting && (
        <div
          className="absolute inset-0 -z-20 rounded-full motion-safe:animate-glowPulse"
          style={{
            transform: 'scale(1.5)',
            background: 'radial-gradient(circle at 50% 50%, transparent 55%, var(--sophia-purple) 75%, transparent 100%)',
            opacity: 0.1,
            filter: 'blur(30px)',
          }}
          aria-hidden="true"
        />
      )}

      {isCenter && !isExiting && (
        <div
          className="absolute inset-0 -z-10 rounded-full"
          style={{
            transform: 'scale(1.08)',
            boxShadow: '0 0 40px var(--sophia-purple), 0 0 80px var(--sophia-glow)',
            opacity: 0.12,
          }}
          aria-hidden="true"
        />
      )}

      {isExiting && exitAnimation === 'keep' && (
        <>
          <div
            className="absolute inset-0 -z-10 rounded-full animate-pulse"
            style={{
              transform: 'scale(1.6)',
              background: 'radial-gradient(circle at center, var(--sophia-purple) 0%, transparent 55%)',
              opacity: 0.5,
              filter: 'blur(40px)',
            }}
            aria-hidden="true"
          />
          <div className="absolute inset-0 flex items-center justify-center z-30 motion-safe:animate-scaleIn">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center backdrop-blur-sm"
              style={{
                background: 'radial-gradient(circle at center, var(--sophia-purple) 0%, transparent 100%)',
                opacity: 0.4,
              }}
            >
              <Check className="w-8 h-8 text-sophia-purple" />
            </div>
          </div>
        </>
      )}

      <div
        className={cn(
          'relative rounded-full',
          isCenter
            ? 'w-[280px] h-[280px] sm:w-[320px] sm:h-[320px] md:w-[360px] md:h-[360px]'
            : 'w-[280px] h-[280px] sm:w-[320px] sm:h-[320px]',
          isCenter && !isExiting && 'motion-safe:animate-breathe'
        )}
        style={{
          background: isCenter
            ? `
              radial-gradient(ellipse 100% 80% at 50% 75%, var(--sophia-purple) 0%, transparent 50%),
              radial-gradient(circle at 50% 50%, var(--card-bg) 0%, var(--bg) 100%)
            `
            : 'radial-gradient(circle at 50% 55%, var(--card-bg) 0%, var(--bg) 85%)',
          boxShadow: isCenter
            ? `
              inset 0 -40px 80px -40px var(--sophia-purple),
              inset 0 40px 60px -40px var(--sophia-glow),
              inset 0 0 0 1px var(--sophia-purple),
              0 0 80px -20px var(--sophia-purple)
            `
            : `
              inset 0 -20px 40px -20px var(--sophia-purple),
              inset 0 0 0 1px var(--sophia-purple)
            `,
          opacity: isCenter ? 1 : 0.5,
        }}
      >
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            top: '8%',
            left: '12%',
            width: '35%',
            height: '25%',
            background: isCenter
              ? 'radial-gradient(ellipse 100% 100% at 30% 30%, var(--sophia-glow) 0%, transparent 70%)'
              : 'radial-gradient(ellipse 100% 100% at 30% 30%, var(--text-2) 0%, transparent 70%)',
            opacity: isCenter ? 0.14 : 0.05,
            filter: 'blur(12px)',
          }}
          aria-hidden="true"
        />

        {isCenter && (
          <div
            className="absolute inset-[3px] rounded-full pointer-events-none"
            style={{
              background: `
                linear-gradient(to bottom,
                  color-mix(in srgb, var(--sophia-glow) 8%, transparent) 0%,
                  transparent 40%,
                  transparent 60%,
                  color-mix(in srgb, var(--sophia-purple) 12%, transparent) 100%
                )
              `,
            }}
            aria-hidden="true"
          />
        )}

        {isCenter && (
          <div
            className="absolute left-0 right-0 pointer-events-none"
            style={{
              top: '48%',
              height: '8%',
              background: 'linear-gradient(to bottom, transparent, var(--sophia-glow), transparent)',
              opacity: 0.06,
              filter: 'blur(6px)',
            }}
            aria-hidden="true"
          />
        )}

        <div
          className="absolute inset-[2px] rounded-full pointer-events-none"
          style={{
            background: 'transparent',
            boxShadow: isCenter
              ? 'inset 0 0 0 1px color-mix(in srgb, var(--sophia-glow) 6%, transparent)'
              : 'none',
          }}
          aria-hidden="true"
        />

        {isCenter && !isExiting && (
          <div className="absolute left-1/2 top-5 z-20 -translate-x-1/2 px-3">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] backdrop-blur-md',
                categoryPresentation.badgeClassName
              )}
            >
              <span aria-hidden="true">{categoryPresentation.icon}</span>
              <span>{categoryPresentation.label}</span>
            </span>
          </div>
        )}

        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse 90% 70% at 50% 25%, transparent 30%, var(--bg) 100%)',
            opacity: isCenter ? 0.25 : 0.5,
          }}
          aria-hidden="true"
        />

        <div className="absolute inset-0 flex flex-col items-center justify-center p-10 sm:p-12">
          {isCenter && isEditing ? (
            <div className="w-full max-w-[230px] sm:max-w-[250px] space-y-3">
              <textarea
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                rows={4}
                autoFocus
                className={cn(
                  'w-full resize-none rounded-2xl px-4 py-3 text-sm leading-relaxed placeholder:text-white/20',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20'
                )}
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  color: 'rgba(255, 255, 255, 0.65)',
                }}
                placeholder="Refine this memory"
                aria-label="Refine memory text"
              />

              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    handleSaveEdit();
                  }}
                  disabled={!canSaveEdit}
                  className={cn(
                    'rounded-full px-4 py-2 text-[11px] tracking-[0.06em] transition-all duration-300',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20',
                    'disabled:cursor-not-allowed disabled:opacity-40'
                  )}
                  style={{
                    background: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.10)',
                    color: 'rgba(255, 255, 255, 0.60)',
                  }}
                >
                  save refinement
                </button>

                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCancelEdit();
                  }}
                  className={cn(
                    'rounded-full px-4 py-2 text-[11px] tracking-[0.06em] transition-all duration-300',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/10',
                    'hover:text-white/40'
                  )}
                  style={{
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    color: 'rgba(255, 255, 255, 0.30)',
                  }}
                >
                  cancel
                </button>
              </div>
            </div>
          ) : (
            <p
              className={cn(
                'text-center leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
                isCenter
                  ? 'text-white/70 text-base sm:text-lg font-light max-h-[7.5rem] sm:max-h-[9rem] overflow-y-auto pr-1'
                  : 'text-white/15 text-sm line-clamp-3'
              )}
            >
              {displayText}
            </p>
          )}

          {isCenter && !isExiting && !isEditing && (
            <div className="flex items-center gap-2 mt-7 motion-safe:animate-fadeIn">
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onKeep();
                }}
                disabled={disabled}
                data-onboarding={isCenter ? 'recap-memory-keep' : undefined}
                className={cn(
                  'px-5 py-2.5 rounded-full',
                  'text-[11px] tracking-[0.06em]',
                  'transition-all duration-300',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  'hover:scale-105 active:scale-95'
                )}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: 'rgba(255, 255, 255, 0.65)',
                  boxShadow: '0 4px 20px rgba(255, 255, 255, 0.03)',
                }}
                aria-label="Keep this memory"
              >
                keep this
              </button>

              <button
                onClick={(event) => {
                  event.stopPropagation();
                  handleStartEdit();
                }}
                disabled={disabled}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-4 py-2.5 text-[11px] tracking-[0.06em] transition-all duration-300',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/10',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  'hover:scale-105 active:scale-95'
                )}
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  color: 'rgba(255, 255, 255, 0.35)',
                }}
                aria-label="Refine this memory"
              >
                <Pencil className="h-3.5 w-3.5" />
                refine
              </button>

              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscard();
                }}
                disabled={disabled}
                data-onboarding={isCenter ? 'recap-memory-discard' : undefined}
                className={cn(
                  'px-5 py-2.5 rounded-full',
                  'text-[11px] tracking-[0.06em]',
                  'text-white/20',
                  'backdrop-blur-md',
                  'hover:text-white/35',
                  'transition-all duration-300',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-white/10',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  'hover:scale-105 active:scale-95'
                )}
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid rgba(255, 255, 255, 0.04)',
                }}
                aria-label="Let this memory go"
              >
                <X className="mr-1 inline h-3.5 w-3.5" />
                let it go
              </button>
            </div>
          )}
        </div>
      </div>

      {isExiting && exitAnimation === 'discard' && (
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          {[...Array(12)].map((_, i) => (
            <div
              key={i}
              className="absolute w-3 h-3 rounded-full bg-sophia-purple/30 animate-[disperseParticle_600ms_ease-out_forwards]"
              style={{
                left: `${35 + Math.random() * 30}%`,
                top: `${35 + Math.random() * 30}%`,
                animationDelay: `${i * 40}ms`,
                '--disperse-x': `${(Math.random() - 0.5) * 150}px`,
                '--disperse-y': `${(Math.random() - 0.5) * 150}px`,
              } as CSSProperties}
            />
          ))}
        </div>
      )}
    </div>
  );
}
