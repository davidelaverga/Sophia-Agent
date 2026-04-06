/**
 * ArtifactsPanel Component
 * Minimal, content-first design.
 * 
 * - Header: just title + count badge
 * - Rows: no icon boxes, inline status only when not ready
 * - Memories: actions revealed on hover/tap
 * - No Session Details (debug info removed)
 */

'use client';

import { 
  Sparkles,
  Check,
  Loader2
} from 'lucide-react';
import { useState } from 'react';
import React from 'react';

import { haptic } from '../../hooks/useHaptics';
import type { RitualArtifacts, PresetType, ContextMode } from '../../lib/session-types';
import { cn } from '../../lib/utils';
import { OnboardingTipGuard } from '../onboarding';

function formatMemoryCategoryLabel(category: string): string {
  const cleaned = category
    .trim()
    .replace(/[_-]+/g, ' ')
    .toLowerCase();

  return cleaned.replace(/\b\w+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

const MEMORY_CATEGORY_BADGES: Record<string, { emoji: string; label: string }> = {
  identity_profile: { emoji: '🧬', label: 'Identity' },
  relationship_context: { emoji: '🤝', label: 'Relationships' },
  goals_projects: { emoji: '🎯', label: 'Goals' },
  emotional_patterns: { emoji: '💜', label: 'Emotional patterns' },
  regulation_tools: { emoji: '🧘', label: 'Regulation tools' },
  preferences_boundaries: { emoji: '🧩', label: 'Preferences' },
  wins_pride: { emoji: '🏆', label: 'Wins' },
  temporary_context: { emoji: '🗺️', label: 'Temporary context' },
  episodic: { emoji: '📅', label: 'Episodic' },
  emotional: { emoji: '💜', label: 'Emotional' },
  reflective: { emoji: '✨', label: 'Reflective' },
};

function getMemoryCategoryBadge(category: string): { emoji: string; label: string } {
  const normalized = category.trim().toLowerCase();
  return MEMORY_CATEGORY_BADGES[normalized] || { emoji: '💭', label: formatMemoryCategoryLabel(category) };
}

// ============================================================================
// TYPES
// ============================================================================

type ArtifactStatus = 'waiting' | 'capturing' | 'ready';

interface ArtifactsPanelProps {
  artifacts?: RitualArtifacts | null;
  presetType?: PresetType;
  contextMode?: ContextMode;
  sessionId?: string;
  threadId?: string;
  isCollapsed?: boolean;
  onToggle?: () => void;
  className?: string;
  artifactStatus?: {
    takeaway: ArtifactStatus;
    reflection: ArtifactStatus;
    memories: ArtifactStatus;
  };
  onReflectionTap?: (reflection: { prompt: string; why?: string }) => void;
  onMemoryApprove?: (memoryIndex: number) => void;
  onMemoryReject?: (memoryIndex: number) => void;
  memoryInlineFeedback?: {
    index: number;
    message: string;
    variant?: 'error' | 'info' | 'success';
  } | null;
}

// ============================================================================
// SHIMMER – uses sophia-glow for on-brand loading
// ============================================================================

function ShimmerLine({ className }: { className?: string }) {
  return (
    <div className={cn(
      'relative overflow-hidden rounded-full',
      className
    )}
    style={{ background: 'color-mix(in srgb, var(--sophia-purple) 8%, var(--card-bg))' }}
    >
      <div 
        className="absolute inset-0 animate-shimmer"
        style={{
          backgroundImage: 'linear-gradient(90deg, transparent, var(--sophia-glow), transparent)',
          backgroundSize: '200% 100%',
        }}
      />
    </div>
  );
}

// ============================================================================
// ARTIFACT SECTION – Sophia themed, content-first
// ============================================================================

interface ArtifactSectionProps {
  title: string;
  content?: string | null;
  placeholder: string;
  status?: ArtifactStatus;
  dataOnboarding?: string;
  onTap?: () => void;
  memories?: RitualArtifacts['memory_candidates'];
  onApprove?: (index: number) => void;
  onReject?: (index: number) => void;
  memoryInlineFeedback?: {
    index: number;
    message: string;
    variant?: 'error' | 'info' | 'success';
  } | null;
}

function ArtifactSection({ 
  title, 
  content, 
  placeholder,
  status = 'waiting',
  dataOnboarding,
  onTap,
  memories,
  onApprove,
  onReject,
  memoryInlineFeedback,
}: ArtifactSectionProps) {
  const hasContent = content && content.trim().length > 0;
  const effectiveStatus = hasContent ? 'ready' : status;
  const isClickable = !!onTap && hasContent;
  const hasMemories = memories && memories.length > 0;
  
  return (
    <div 
      data-onboarding={dataOnboarding}
      className={cn(
        'group rounded-xl px-3.5 py-3 transition-all duration-500',
        'border',
        effectiveStatus === 'waiting' && 'opacity-30',
        isClickable && 'cursor-pointer active:scale-[0.995]',
      )}
      style={effectiveStatus !== 'waiting'
        ? {
            background: 'var(--cosmic-panel-soft)',
            borderColor: 'var(--cosmic-border-soft)',
          }
        : {
            borderColor: 'var(--cosmic-border-soft)',
          }}
      onClick={isClickable ? () => { haptic('light'); onTap?.(); } : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      {/* Title row — whisper label */}
      <div className="flex items-center gap-2 mb-1.5">
        <h4
          className="text-[9px] tracking-[0.18em] lowercase"
          style={{ color: effectiveStatus === 'ready' ? 'var(--cosmic-text-whisper)' : 'var(--cosmic-text-faint)' }}
        >
          {title.toLowerCase()}
        </h4>
        
        {effectiveStatus === 'capturing' && (
          <span className="flex items-center gap-1 text-[9px]" style={{ color: 'var(--cosmic-text-faint)' }}>
            <Loader2 className="w-2.5 h-2.5 animate-spin opacity-40" />
            detecting
          </span>
        )}
        {effectiveStatus === 'ready' && (
          <span
            className="w-1 h-1 rounded-full"
            style={{ background: 'color-mix(in srgb, var(--sophia-purple) 35%, var(--cosmic-panel-soft))' }}
          />
        )}
      </div>
      
      {/* Content */}
      {effectiveStatus === 'capturing' ? (
        <div className="space-y-2 mt-1">
          <ShimmerLine className="h-2 w-[85%]" />
          <ShimmerLine className="h-2 w-[60%]" />
        </div>
      ) : hasContent && !hasMemories ? (
        <p className="font-cormorant text-[14px] leading-relaxed line-clamp-3" style={{ color: 'var(--cosmic-text)' }}>
          {content}
        </p>
      ) : !hasMemories ? (
        <p className="font-cormorant text-[11px] italic" style={{ color: 'var(--cosmic-text-faint)' }}>
          {placeholder}
        </p>
      ) : null}
      
      {/* Memory candidates */}
      {hasMemories && (
        <div className="mt-2 space-y-2">
          {memories.slice(0, 3).map((candidate, index) => (
            <MemoryCard
              key={`${index}-${candidate?.memory?.slice(0, 18) || 'c'}`}
              memory={candidate?.memory || ''}
              category={candidate?.category}
              inlineFeedback={memoryInlineFeedback?.index === index ? memoryInlineFeedback : null}
              onApprove={() => { haptic('medium'); onApprove?.(index); }}
              onReject={() => { haptic('light'); onReject?.(index); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// REFLECTION CARD – Distinct, premium feel
// ============================================================================

type ReflectionStatus = 'waiting' | 'capturing' | 'ready';

interface ReflectionCardProps {
  prompt?: string | null;
  why?: string | null;
  placeholder: string;
  status: ReflectionStatus;
  dataOnboarding?: string;
  onTap?: () => void;
}

function ReflectionCard({ prompt, why, placeholder, status, dataOnboarding, onTap }: ReflectionCardProps) {
  const hasContent = !!prompt && prompt.trim().length > 0;
  const effectiveStatus = hasContent ? 'ready' : status;
  const isClickable = !!onTap && hasContent;
  const [tapped, setTapped] = useState(false);

  const handleTap = () => {
    if (!isClickable || tapped) return;
    haptic('medium');
    setTapped(true);
    onTap?.();
  };

  // Waiting — nearly invisible
  if (effectiveStatus === 'waiting') {
    return (
      <div className="rounded-xl px-3.5 py-3 border border-transparent opacity-30">
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className="w-1 h-1 rounded-full"
            style={{ background: 'var(--cosmic-text-faint)' }}
          />
          <h4 className="text-[9px] tracking-[0.18em] lowercase" style={{ color: 'var(--cosmic-text-faint)' }}>
            reflection
          </h4>
        </div>
        <p className="font-cormorant text-[12px] italic" style={{ color: 'var(--cosmic-text-faint)' }}>{placeholder}</p>
      </div>
    );
  }

  // Capturing — subtle cosmic shimmer
  if (effectiveStatus === 'capturing') {
    return (
      <div
        data-onboarding={dataOnboarding}
        className="relative overflow-hidden rounded-xl border px-3.5 py-3"
        style={{
          background: 'var(--cosmic-panel-soft)',
          borderColor: 'var(--cosmic-border-soft)',
        }}
      >
        {/* Nebula filament accent */}
        <div
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--sophia-glow) 25%, transparent), transparent)',
          }}
        />
        <div className="flex items-center gap-2 mb-2">
          <span
            className="w-1 h-1 rounded-full"
            style={{ background: 'color-mix(in srgb, var(--sophia-purple) 30%, var(--cosmic-panel-soft))' }}
          />
          <h4 className="text-[9px] tracking-[0.18em] lowercase" style={{ color: 'var(--cosmic-text-whisper)' }}>
            reflection
          </h4>
          <span className="flex items-center gap-1 text-[9px]" style={{ color: 'var(--cosmic-text-faint)' }}>
            <Loader2 className="w-2.5 h-2.5 animate-spin opacity-40" />
            composing
          </span>
        </div>
        <div className="space-y-2">
          <ShimmerLine className="h-2.5 w-[90%]" />
          <ShimmerLine className="h-2 w-[65%]" />
        </div>
      </div>
    );
  }

  // Ready — cosmic, transparent, nebula shows through
  return (
    <div
      data-onboarding={dataOnboarding}
      className={cn(
        'relative rounded-2xl overflow-hidden transition-all duration-700',
        'animate-fadeInUp',
        isClickable && !tapped && 'cursor-pointer hover:scale-[1.01] active:scale-[0.99]',
        tapped && 'opacity-40 pointer-events-none',
      )}
      onClick={handleTap}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      {/* Bloom halo — replaces gradient border */}
      <div
        className="absolute -inset-3 rounded-3xl pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 80% 70% at 50% 40%, color-mix(in srgb, var(--sophia-purple) 8%, transparent) 0%, transparent 70%)',
          filter: 'blur(20px)',
        }}
      />

      {/* Inner content — transparent, cosmic */}
      <div
        className="relative rounded-2xl border px-4 py-3.5"
        style={{
          background: 'var(--cosmic-panel-accent)',
          borderColor: 'var(--cosmic-border-soft)',
          backdropFilter: 'blur(6px)',
        }}
      >
        {/* Header — whisper label */}
        <div className="flex items-center gap-2 mb-2.5 relative">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: 'color-mix(in srgb, var(--sophia-purple) 30%, var(--cosmic-panel-soft))' }}
          />
          <h4 className="text-[9px] tracking-[0.18em] lowercase" style={{ color: 'var(--cosmic-text-whisper)' }}>
            reflection
          </h4>
          {tapped && (
            <span className="ml-auto text-[9px] tracking-[0.12em] lowercase" style={{ color: 'var(--cosmic-text-faint)' }}>
              sent
            </span>
          )}
        </div>

        {/* Prompt — Cormorant, floating */}
        <p className="relative font-cormorant text-[15px] leading-[1.7] font-light" style={{ color: 'var(--cosmic-text)' }}>
          {prompt}
        </p>

        {/* Why context */}
        {why && (
          <p
            className="mt-2 font-cormorant text-[12px] leading-relaxed italic"
            style={{ color: 'var(--cosmic-text-whisper)' }}
          >
            {why}
          </p>
        )}

        {/* CTA — cosmic whisper */}
        {isClickable && !tapped && (
          <div className="mt-3 pt-2.5" style={{ borderTop: '1px solid var(--cosmic-border-soft)' }}>
            <span
              className="text-[9px] tracking-[0.14em] lowercase"
              style={{ color: 'color-mix(in srgb, var(--sophia-purple) 40%, var(--cosmic-text-faint))' }}
            >
              tap to reflect
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MEMORY CARD – Sophia themed, actions on hover/tap
// ============================================================================

interface MemoryCardProps {
  memory: string;
  category?: string;
  inlineFeedback?: {
    message: string;
    variant?: 'error' | 'info' | 'success';
  } | null;
  onApprove: () => void;
  onReject?: () => void;
}

function MemoryCard({ memory, category, inlineFeedback, onApprove, onReject }: MemoryCardProps) {
  const badge = category ? getMemoryCategoryBadge(category) : null;
  const feedbackVariant = inlineFeedback?.variant ?? 'error';
  
  return (
    <div className={cn(
      'group/card relative rounded-xl p-3 transition-all duration-300',
      'border',
    )}
    style={{
      background: 'var(--cosmic-panel-soft)',
      borderColor: 'var(--cosmic-border-soft)',
    }}
    >
      {/* Memory text */}
      <p className="font-cormorant text-[13px] leading-relaxed pr-14 line-clamp-2" style={{ color: 'var(--cosmic-text)' }}>
        {memory}
      </p>
      
      {/* Category badge */}
      {badge && (
        <span 
          className="mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[8px] tracking-[0.14em] lowercase"
          style={{
            color: 'var(--cosmic-text-whisper)',
            borderColor: 'var(--cosmic-border-soft)',
          }}
        >
          <span aria-hidden="true">{badge.emoji}</span>
          {badge.label}
        </span>
      )}

      {inlineFeedback?.message && (
        <div
          className="mt-2 rounded-lg px-2.5 py-1.5 text-[11px] leading-snug"
          style={
            feedbackVariant === 'error'
              ? {
                  color: 'var(--sophia-error)',
                  background: 'color-mix(in srgb, var(--sophia-error) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--sophia-error) 35%, transparent)',
                }
              : {
                  color: 'var(--sophia-purple)',
                  background: 'color-mix(in srgb, var(--sophia-purple) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--sophia-purple) 25%, transparent)',
                }
          }
        >
          {inlineFeedback.message}
        </div>
      )}
      
      {/* Actions — near-invisible until hover */}
      <div className={cn(
        'absolute top-2.5 right-2.5 flex items-center gap-0.5',
        'opacity-100 lg:opacity-0 lg:group-hover/card:opacity-100',
        'transition-opacity duration-300',
      )}>
        <button
          onClick={(e) => { e.stopPropagation(); onApprove(); }}
          className="flex h-6 w-6 items-center justify-center rounded-lg transition-all active:scale-90 hover:text-[var(--cosmic-text)]"
          style={{ color: 'var(--cosmic-text-faint)' }}
          title="Save memory"
          aria-label="Save memory"
        >
          <Check className="w-3 h-3" />
        </button>
        {onReject && (
          <button
            onClick={(e) => { e.stopPropagation(); onReject(); }}
            className="flex h-6 w-6 items-center justify-center rounded-lg transition-all active:scale-90 hover:text-[var(--cosmic-text-muted)]"
            style={{ color: 'var(--cosmic-text-faint)' }}
            title="Skip memory"
            aria-label="Skip memory"
          >
            <span className="text-sm leading-none">&times;</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN ARTIFACTS PANEL
// ============================================================================

export function ArtifactsPanel({
  artifacts,
  presetType,
  sessionId: _sessionId,
  threadId: _threadId,
  isCollapsed = false,
  className,
  artifactStatus = { takeaway: 'waiting', reflection: 'waiting', memories: 'waiting' },
  onReflectionTap,
  onMemoryApprove,
  onMemoryReject,
  memoryInlineFeedback,
}: ArtifactsPanelProps) {
  const hasArtifacts = Boolean(
    artifacts?.takeaway?.trim() ||
    artifacts?.reflection_candidate?.prompt?.trim() ||
    artifacts?.memory_candidates?.length
  );

  const placeholders = {
    takeaway: getPlaceholderCopy('takeaway', presetType),
    reflection: getPlaceholderCopy('reflection', presetType),
    memories: getPlaceholderCopy('memories', presetType),
  };
  
  const handleReflectionTap = () => {
    if (artifacts?.reflection_candidate && onReflectionTap) {
      onReflectionTap({
        prompt: artifacts.reflection_candidate.prompt,
        why: artifacts.reflection_candidate.why,
      });
    }
  };
  
  return (
    <div className={cn('flex flex-col h-full', className)} data-onboarding="artifacts-panel">
      <OnboardingTipGuard tipId="tip-first-artifacts" isTriggered={hasArtifacts} />
      {/* Header — cosmic whisper */}
      <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: '1px solid var(--cosmic-border-soft)' }}>
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: 'color-mix(in srgb, var(--sophia-purple) 30%, var(--cosmic-panel-soft))' }}
        />
        <h3 className="text-[10px] tracking-[0.16em] lowercase" style={{ color: 'var(--cosmic-text-whisper)' }}>artifacts</h3>
        
        {/* Progress dots */}
        <div className="ml-auto flex items-center gap-1">
          {[artifactStatus.takeaway, artifactStatus.reflection, artifactStatus.memories].map((s, i) => (
            <div
              key={i}
              className={cn(
                'w-1 h-1 rounded-full transition-all duration-700',
                s === 'ready' && 'scale-110',
                s === 'capturing' && 'animate-pulse',
              )}
              style={{
                background: s === 'ready'
                  ? 'color-mix(in srgb, var(--sophia-purple) 40%, var(--cosmic-text-faint))'
                  : s === 'capturing'
                    ? 'color-mix(in srgb, var(--sophia-purple) 20%, var(--cosmic-panel-soft))'
                    : 'var(--cosmic-text-faint)',
              }}
            />
          ))}
        </div>
      </div>
      
      {/* Sections */}
      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          <ArtifactSection
            title="Takeaway"
            content={artifacts?.takeaway}
            placeholder={placeholders.takeaway}
            status={artifactStatus.takeaway}
            dataOnboarding="artifact-takeaway"
          />
          
          <ReflectionCard
            prompt={artifacts?.reflection_candidate?.prompt}
            why={artifacts?.reflection_candidate?.why}
            placeholder={placeholders.reflection}
            status={artifactStatus.reflection}
            dataOnboarding="reflection-card"
            onTap={onReflectionTap ? handleReflectionTap : undefined}
          />
          
          <ArtifactSection
            title="Memories"
            content={
              artifacts?.memory_candidates?.length 
                ? `${artifacts.memory_candidates.length} candidates`
                : undefined
            }
            placeholder={placeholders.memories}
            status={artifactStatus.memories}
            dataOnboarding="memory-candidates"
            memories={artifacts?.memory_candidates}
            onApprove={onMemoryApprove}
            onReject={onMemoryReject}
            memoryInlineFeedback={memoryInlineFeedback}
          />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// COLLAPSED RAIL COMPONENT (for desktop sidebar)
// ============================================================================

interface ArtifactsRailProps {
  artifactStatus: {
    takeaway: ArtifactStatus;
    reflection: ArtifactStatus;
    memories: ArtifactStatus;
  };
  onClick: () => void;
  className?: string;
  dataOnboardingId?: string;
}

export function ArtifactsRail({ artifactStatus, onClick, className, dataOnboardingId }: ArtifactsRailProps) {
  const statuses = [artifactStatus.takeaway, artifactStatus.reflection, artifactStatus.memories];
  const pendingCount = statuses.filter(s => s === 'waiting').length;
  const capturingCount = statuses.filter(s => s === 'capturing').length;
  const readyCount = statuses.filter(s => s === 'ready').length;
  const shouldPulse = capturingCount > 0;
  
  return (
    <button
      data-onboarding={dataOnboardingId}
      onClick={() => {
        haptic('light');
        onClick();
      }}
      className={cn(
        'flex items-center justify-center w-full h-full',
        'transition-all duration-500',
        'opacity-25 hover:opacity-60',
        className
      )}
      title="Open Artifacts panel"
      aria-label={`Artifacts: ${readyCount} captured, ${capturingCount} detecting, ${pendingCount} pending`}
    >
      <div className="relative">
        <Sparkles className={cn(
          'h-[16px] w-[16px] transition-colors duration-500 hover:text-[var(--cosmic-text)]',
          shouldPulse && 'animate-pulse'
        )} style={{ color: 'var(--cosmic-text-whisper)' }} />
        
        {/* Subtle bloom dot when ready */}
        {readyCount > 0 && (
          <span
            className="absolute -top-0.5 -right-1 w-1.5 h-1.5 rounded-full transition-all duration-700"
            style={{
              background: 'color-mix(in srgb, var(--sophia-purple) 40%, var(--cosmic-panel-soft))',
              boxShadow: capturingCount > 0 ? '0 0 6px color-mix(in srgb, var(--sophia-purple) 25%, transparent)' : 'none',
            }}
          />
        )}
      </div>
    </button>
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getPlaceholderCopy(
  section: 'takeaway' | 'reflection' | 'memories',
  presetType?: PresetType
): string {
  const baseCopy = {
    takeaway: {
      prepare: "Will capture your key intention",
      debrief: "Will summarize your takeaway",
      reset: "Will note your reset insight",
      vent: "Will capture your realization",
      default: "Will appear after conversation",
    },
    reflection: {
      prepare: "Reflection prompt may appear",
      debrief: "Learning prompt will show",
      reset: "Calming exercise may appear",
      vent: "Processing prompt will show",
      default: "Prompt may be suggested",
    },
    memories: {
      prepare: "May be detected during session",
      debrief: "May be detected during session",
      reset: "May be detected during session",
      vent: "May be detected during session",
      default: "May be detected during session",
    },
  };
  
  const preset = presetType || 'default';
  return baseCopy[section][preset as keyof typeof baseCopy.takeaway] || baseCopy[section].default;
}

export default ArtifactsPanel;
