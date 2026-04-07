'use client';

import {
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Info,
  Pencil,
  X,
} from 'lucide-react';
import { useCallback, useState } from 'react';

import { haptic } from '../../hooks/useHaptics';
import type {
  MemoryCandidateV1,
  MemoryDecision,
} from '../../lib/recap-types';
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
} from '../../lib/recap-types';
import { cn } from '../../lib/utils';

interface RecapMemoryCandidateRowProps {
  candidate: MemoryCandidateV1;
  decision: MemoryDecision;
  editedText?: string;
  onApprove: () => void;
  onEdit: (text: string) => void;
  onDiscard: () => void;
  disabled?: boolean;
}

export function RecapMemoryCandidateRow({
  candidate,
  decision,
  editedText,
  onApprove,
  onEdit,
  onDiscard,
  disabled,
}: RecapMemoryCandidateRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(editedText || candidate.text);
  const [showReason, setShowReason] = useState(false);

  const handleSaveEdit = useCallback(() => {
    onEdit(editValue);
    setIsEditing(false);
    haptic('light');
  }, [editValue, onEdit]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(editedText || candidate.text);
    setIsEditing(false);
  }, [editedText, candidate.text]);

  if (decision === 'discarded') {
    return (
      <div className="py-3 px-4 bg-sophia-surface/30 rounded-xl opacity-50">
        <div className="flex items-center gap-3">
          <X className="w-4 h-4 text-sophia-text2" />
          <span className="text-sm text-sophia-text2 line-through">{candidate.text}</span>
          <span className="text-xs text-sophia-text2/60 ml-auto">Discarded</span>
        </div>
      </div>
    );
  }

  if (decision === 'approved' || decision === 'edited') {
    return (
      <div className="py-4 px-4 bg-sophia-surface border border-sophia-accent/20 rounded-xl transition-all motion-safe:animate-scaleIn">
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-sophia-accent/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Check className="w-4 h-4 text-sophia-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sophia-text">
              {decision === 'edited' ? editedText : candidate.text}
            </p>
            {candidate.category && (
              <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 text-xs bg-sophia-surface-border/50 rounded-full text-sophia-text2">
                {CATEGORY_ICONS[candidate.category]} {CATEGORY_LABELS[candidate.category] || candidate.category}
              </span>
            )}
          </div>
          <span className="text-xs text-sophia-accent/80 font-medium">
            {decision === 'edited' ? 'Edited ✓' : 'Saved ✓'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="py-4 px-4 bg-sophia-surface rounded-xl border border-sophia-surface-border">
      <div className="flex items-start gap-3">
        <div className="w-6 h-6 rounded-full bg-sophia-purple/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Brain className="w-4 h-4 text-sophia-purple" />
        </div>

        <div className="flex-1 min-w-0">
          {isEditing ? (
            <div className="space-y-3">
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                className={cn(
                  'w-full px-3 py-2 text-sm rounded-lg',
                  'bg-sophia-bg border border-sophia-surface-border',
                  'text-sophia-text placeholder:text-sophia-text2/50',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sophia-purple/30',
                  'resize-none'
                )}
                rows={3}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveEdit}
                  className="px-3 py-1.5 text-xs font-medium bg-sophia-purple text-sophia-bg rounded-lg hover:bg-sophia-purple/90"
                >
                  Save & Approve
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="px-3 py-1.5 text-xs font-medium text-sophia-text2 hover:text-sophia-text"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sophia-text mb-2">{candidate.text}</p>

              <div className="flex items-center gap-2 flex-wrap">
                {candidate.category && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-sophia-surface-border/50 rounded-full text-sophia-text2">
                    {CATEGORY_ICONS[candidate.category]} {CATEGORY_LABELS[candidate.category] || candidate.category}
                  </span>
                )}

                {candidate.reason && (
                  <button
                    onClick={() => setShowReason(!showReason)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-sophia-text2 hover:text-sophia-text transition-colors"
                  >
                    <Info className="w-3 h-3" />
                    Why this?
                    {showReason ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                )}
              </div>

              {showReason && candidate.reason && (
                <p className="mt-2 text-xs text-sophia-text2/70 italic bg-sophia-bg/50 rounded-lg px-3 py-2">
                  {candidate.reason}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {!isEditing && (
        <div className="flex items-center gap-2 mt-4 ml-9">
          <button
            onClick={() => {
              haptic('light');
              onApprove();
            }}
            disabled={disabled}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
              'bg-sophia-accent/10 text-sophia-accent hover:bg-sophia-accent/20',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            <Check className="w-3 h-3 inline mr-1" />
            Save
          </button>
          <button
            onClick={() => {
              haptic('light');
              setIsEditing(true);
            }}
            disabled={disabled}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
              'bg-sophia-surface-border/50 text-sophia-text2 hover:text-sophia-text hover:bg-sophia-surface-border',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            <Pencil className="w-3 h-3 inline mr-1" />
            Refine
          </button>
          <button
            onClick={() => {
              haptic('light');
              onDiscard();
            }}
            disabled={disabled}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
              'text-sophia-text2/60 hover:text-sophia-text2 hover:bg-sophia-surface-border/50',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            <X className="w-3 h-3 inline mr-1" />
            Not now
          </button>
        </div>
      )}
    </div>
  );
}
