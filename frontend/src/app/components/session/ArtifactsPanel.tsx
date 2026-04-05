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

import { useState } from 'react';
import { 
  ChevronDown,
  Sparkles,
  Check,
  Loader2
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../hooks/useHaptics';
import type { RitualArtifacts, PresetType, ContextMode } from '../../lib/session-types';
import React from 'react';
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
        'group rounded-xl px-3.5 py-3 transition-all duration-300',
        'border',
        effectiveStatus === 'ready' && 'bg-sophia-surface border-sophia-surface-border shadow-soft',
        effectiveStatus === 'capturing' && 'border-sophia-surface-border',
        effectiveStatus === 'waiting' && 'border-transparent opacity-40',
        isClickable && 'cursor-pointer hover:shadow-soft hover:border-sophia-purple/25 active:scale-[0.995]',
      )}
      style={effectiveStatus === 'capturing' ? {
        background: 'color-mix(in srgb, var(--sophia-purple) 4%, var(--card-bg))',
      } : undefined}
      onClick={isClickable ? () => { haptic('light'); onTap?.(); } : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      {/* Title row */}
      <div className="flex items-center gap-2 mb-1.5">
        <h4 className={cn(
          'text-[11px] font-semibold uppercase tracking-wider',
          effectiveStatus === 'ready' ? 'text-sophia-purple' : 'text-sophia-text2/60',
        )}>
          {title}
        </h4>
        
        {effectiveStatus === 'capturing' && (
          <span className="flex items-center gap-1 text-[10px] text-sophia-purple/60">
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
            detecting
          </span>
        )}
        {effectiveStatus === 'ready' && (
          <div className="w-4 h-4 rounded-full flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--sophia-purple) 15%, transparent)' }}
          >
            <Check className="w-2.5 h-2.5 text-sophia-purple" />
          </div>
        )}
      </div>
      
      {/* Content */}
      {effectiveStatus === 'capturing' ? (
        <div className="space-y-2 mt-1">
          <ShimmerLine className="h-2 w-[85%]" />
          <ShimmerLine className="h-2 w-[60%]" />
        </div>
      ) : hasContent && !hasMemories ? (
        <p className="text-[13px] leading-relaxed text-sophia-text/85 line-clamp-3">
          {content}
        </p>
      ) : !hasMemories ? (
        <p className="text-[11px] text-sophia-text2/25 italic">
          {placeholder}
        </p>
      ) : null}
      
      {/* Memory candidates */}
      {hasMemories && (
        <div className="mt-2 space-y-2">
          {memories!.slice(0, 3).map((candidate, index) => (
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

  // Waiting — subdued
  if (effectiveStatus === 'waiting') {
    return (
      <div className="rounded-xl px-3.5 py-3 border border-transparent opacity-40">
        <div className="flex items-center gap-2 mb-1.5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-sophia-text2/60">
            Reflection
          </h4>
        </div>
        <p className="text-[11px] text-sophia-text2/25 italic">{placeholder}</p>
      </div>
    );
  }

  // Capturing — shimmer with gradient hint
  if (effectiveStatus === 'capturing') {
    return (
      <div
        data-onboarding={dataOnboarding}
        className="relative rounded-xl px-3.5 py-3 border overflow-hidden"
        style={{
          borderColor: 'color-mix(in srgb, var(--sophia-purple) 25%, var(--card-border))',
          background: 'color-mix(in srgb, var(--sophia-purple) 4%, var(--card-bg))',
        }}
      >
        {/* top accent bar */}
        <div
          className="absolute inset-x-0 top-0 h-[2px]"
          style={{
            background: 'linear-gradient(90deg, transparent, var(--sophia-purple), var(--sophia-glow), transparent)',
            opacity: 0.6,
          }}
        />
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-3.5 h-3.5 text-sophia-purple/50 animate-pulse" />
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-sophia-purple/60">
            Reflection
          </h4>
          <span className="flex items-center gap-1 text-[10px] text-sophia-purple/50">
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
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

  // Ready — the star of the show
  return (
    <div
      data-onboarding={dataOnboarding}
      className={cn(
        'relative rounded-2xl overflow-hidden transition-all duration-500',
        'animate-fadeInUp',
        isClickable && !tapped && 'cursor-pointer hover:scale-[1.01] active:scale-[0.99]',
        tapped && 'opacity-60 pointer-events-none',
      )}
      onClick={handleTap}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      {/* Gradient border via outer wrapper */}
      <div
        className="absolute inset-0 rounded-2xl"
        style={{
          padding: '1px',
          background: 'linear-gradient(135deg, var(--sophia-purple), var(--sophia-glow), var(--sophia-purple))',
          WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude',
        }}
      />

      {/* Inner content */}
      <div
        className="relative rounded-2xl px-4 py-3.5"
        style={{
          background: 'linear-gradient(135deg, color-mix(in srgb, var(--sophia-purple) 6%, var(--card-bg)), color-mix(in srgb, var(--sophia-glow) 4%, var(--card-bg)))',
        }}
      >
        {/* Subtle glow orb */}
        <div
          className="absolute -top-6 -right-6 w-24 h-24 rounded-full blur-2xl pointer-events-none animate-pulse-slow"
          style={{
            background: 'radial-gradient(circle, color-mix(in srgb, var(--sophia-glow) 18%, transparent), transparent 70%)',
          }}
        />

        {/* Header */}
        <div className="flex items-center gap-2 mb-2.5 relative">
          <div
            className="w-5 h-5 rounded-lg flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--sophia-purple) 20%, transparent), color-mix(in srgb, var(--sophia-glow) 15%, transparent))',
            }}
          >
            <Sparkles className="w-3 h-3 text-sophia-purple" />
          </div>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-sophia-purple">
            Reflection
          </h4>
          {tapped && (
            <span className="ml-auto text-[10px] text-sophia-purple/50 flex items-center gap-1">
              <Check className="w-3 h-3" /> sent
            </span>
          )}
        </div>

        {/* Prompt — styled as a thoughtful question */}
        <p className="text-[14px] leading-relaxed text-sophia-text font-medium relative">
          {prompt}
        </p>

        {/* Why context line */}
        {why && (
          <p
            className="mt-2 text-[11px] leading-relaxed italic"
            style={{ color: 'color-mix(in srgb, var(--sophia-purple) 70%, var(--sophia-text2))' }}
          >
            {why}
          </p>
        )}

        {/* CTA */}
        {isClickable && !tapped && (
          <div className="flex items-center gap-1.5 mt-3 pt-2.5 border-t" style={{ borderColor: 'color-mix(in srgb, var(--sophia-purple) 12%, transparent)' }}>
            <span
              className="text-[11px] font-semibold tracking-wide"
              style={{ color: 'var(--sophia-purple)' }}
            >
              Tap to reflect
            </span>
            <ChevronDown className="w-3 h-3 text-sophia-purple -rotate-90" />
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
      'group/card relative rounded-xl p-3 transition-all duration-200',
      'border',
      'hover:shadow-soft',
    )}
    style={{
      background: 'color-mix(in srgb, var(--sophia-purple) 3%, var(--card-bg))',
      borderColor: 'color-mix(in srgb, var(--sophia-purple) 12%, var(--card-border))',
    }}
    >
      {/* Memory text */}
      <p className="text-[12px] leading-relaxed text-sophia-text/80 pr-14 line-clamp-2">
        {memory}
      </p>
      
      {/* Category badge */}
      {badge && (
        <span 
          className="inline-flex items-center gap-1 mt-2 text-[9px] font-semibold tracking-wide px-2 py-0.5 rounded-full"
          style={{
            background: 'color-mix(in srgb, var(--sophia-purple) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--sophia-purple) 14%, transparent)',
            color: 'var(--sophia-purple)',
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
      
      {/* Actions – visible on hover (desktop), always on mobile */}
      <div className={cn(
        'absolute top-2.5 right-2.5 flex items-center gap-0.5',
        'opacity-100 lg:opacity-0 lg:group-hover/card:opacity-100',
        'transition-opacity duration-150',
      )}>
        <button
          onClick={(e) => { e.stopPropagation(); onApprove(); }}
          className={cn(
            'w-7 h-7 rounded-lg flex items-center justify-center',
            'transition-all active:scale-90',
          )}
          style={{
            color: 'var(--sophia-purple)',
            background: 'color-mix(in srgb, var(--sophia-purple) 10%, transparent)',
          }}
          title="Save memory"
          aria-label="Save memory"
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        {onReject && (
          <button
            onClick={(e) => { e.stopPropagation(); onReject(); }}
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center',
              'text-sophia-text2/35 hover:text-sophia-text2',
              'transition-all active:scale-90',
            )}
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
      {/* Header – Sophia branded */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-sophia-surface-border">
        <div
          className="w-6 h-6 rounded-lg flex items-center justify-center"
          style={{ background: 'color-mix(in srgb, var(--sophia-purple) 12%, transparent)' }}
        >
          <Sparkles className="w-3 h-3 text-sophia-purple" />
        </div>
        <h3 className="text-sm font-semibold text-sophia-text">Artifacts</h3>
        
        {/* Progress dots */}
        <div className="ml-auto flex items-center gap-1">
          {[artifactStatus.takeaway, artifactStatus.reflection, artifactStatus.memories].map((s, i) => (
            <div
              key={i}
              className={cn(
                'w-1.5 h-1.5 rounded-full transition-all duration-500',
                s === 'ready' && 'bg-sophia-purple scale-110',
                s === 'capturing' && 'bg-sophia-purple/40 animate-pulse',
                s === 'waiting' && 'bg-sophia-text2/15',
              )}
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
  
  // Determine badge display
  const hasBadge = pendingCount > 0 || capturingCount > 0;
  const badgeClass = capturingCount > 0 
    ? 'bg-amber-500 animate-pulse' 
    : readyCount > 0 
      ? 'bg-emerald-500' 
      : 'bg-sophia-text2/40';
  
  return (
    <button
      data-onboarding={dataOnboardingId}
      onClick={() => {
        haptic('light');
        onClick();
      }}
      className={cn(
        'flex items-center justify-center w-full h-full',
        'transition-all duration-200',
        'opacity-40 hover:opacity-100',
        className
      )}
      title="Open Artifacts panel"
      aria-label={`Artifacts: ${readyCount} captured, ${capturingCount} detecting, ${pendingCount} pending`}
    >
      <div className="relative">
        <Sparkles className={cn(
          'w-[18px] h-[18px] text-sophia-text2 transition-colors',
          'hover:text-sophia-purple',
          shouldPulse && 'animate-pulse'
        )} />
        
        {/* Badge dot */}
        {hasBadge && (
          <span className={cn(
            'absolute -top-1 -right-1.5 w-2 h-2 rounded-full',
            badgeClass
          )} />
        )}
        
        {/* Ready indicator */}
        {readyCount === 3 && !hasBadge && (
          <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-emerald-500" />
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
