'use client';

import { useEffect, useRef } from 'react';

import { cn } from '../../lib/utils';
import type { BuilderActivityEntryV1 } from '../../types/builder-task';

type BuilderActivityLogProps = {
  entries: BuilderActivityEntryV1[];
  compact?: boolean;
  className?: string;
};

const TOOL_ICONS: Record<string, string> = {
  bash: '⌘',
  shell: '⌘',
  write_file: '✎',
  create_file: '✎',
  edit_file: '✎',
  read_file: '◉',
  list_directory: '▤',
  web_search: '⊛',
  web_browse: '◈',
  crawl_tool: '◈',
  python_repl: '▷',
  write_todos: '☰',
  emit_builder_artifact: '◆',
};

function getToolIcon(entry: BuilderActivityEntryV1): string {
  if (entry.type === 'thinking') return '◎';
  return TOOL_ICONS[entry.tool ?? ''] ?? '•';
}

function getStatusColor(status: BuilderActivityEntryV1['status']): string {
  switch (status) {
    case 'running':
      return 'var(--sophia-purple)';
    case 'done':
      return 'var(--cosmic-teal)';
    case 'error':
      return 'var(--sophia-error, #f87171)';
    default:
      return 'var(--cosmic-text-faint)';
  }
}

function ActivityEntry({
  entry,
  isLast,
  compact,
}: {
  entry: BuilderActivityEntryV1;
  isLast: boolean;
  compact?: boolean;
}) {
  const color = getStatusColor(entry.status);
  const icon = getToolIcon(entry);
  const isRunning = entry.status === 'running';

  return (
    <div className={cn('relative flex gap-2', compact ? 'min-h-[22px]' : 'min-h-[26px]')}>
      {/* Timeline connector */}
      <div className="relative flex flex-col items-center" style={{ width: 16 }}>
        <span
          className={cn(
            'z-10 flex shrink-0 items-center justify-center rounded-full font-mono',
            compact ? 'h-4 w-4 text-[8px]' : 'h-[18px] w-[18px] text-[9px]',
          )}
          style={{
            color,
            background: `color-mix(in srgb, ${color} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
            ...(isRunning ? { boxShadow: `0 0 8px color-mix(in srgb, ${color} 24%, transparent)` } : {}),
          }}
        >
          {icon}
        </span>
        {!isLast && (
          <div
            className="flex-1"
            style={{
              width: 1,
              background: 'color-mix(in srgb, var(--cosmic-text-faint) 18%, transparent)',
              minHeight: compact ? 6 : 8,
            }}
          />
        )}
      </div>

      {/* Content */}
      <div className={cn('min-w-0 flex-1 pb-1', compact ? 'pt-[1px]' : 'pt-[2px]')}>
        <div className="flex items-center gap-1.5">
          <span
            className={cn('truncate', compact ? 'text-[9px]' : 'text-[10px]')}
            style={{ color: isRunning ? color : 'var(--cosmic-text-faint)' }}
          >
            {entry.title}
          </span>
          {isRunning && (
            <span
              className={cn('shrink-0 rounded-full tracking-[0.08em] lowercase', compact ? 'px-1 py-px text-[7px]' : 'px-1.5 py-px text-[8px]')}
              style={{
                color,
                background: `color-mix(in srgb, ${color} 12%, transparent)`,
                animation: 'builder-core-breath 2.4s ease-in-out infinite',
              }}
            >
              active
            </span>
          )}
        </div>
        {entry.detail && (
          <p
            className={cn('truncate font-mono', compact ? 'mt-0.5 text-[8px]' : 'mt-0.5 text-[9px]')}
            style={{ color: 'var(--cosmic-text-whisper)' }}
          >
            {entry.detail}
          </p>
        )}
      </div>
    </div>
  );
}

export function BuilderActivityLog({
  entries,
  compact = false,
  className,
}: BuilderActivityLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(entries.length);

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (entries.length > prevCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevCountRef.current = entries.length;
  }, [entries.length]);

  if (entries.length === 0) {
    return null;
  }

  const latestEntry = entries[entries.length - 1];
  const hasRunning = latestEntry?.status === 'running';

  return (
    <div className={cn(compact ? 'mt-2' : 'mt-2.5', className)}>
      <div
        className={cn(
          'flex items-center gap-1.5',
          compact ? 'text-[8px]' : 'text-[9px]',
        )}
        style={{ color: 'var(--cosmic-text-faint)' }}
      >
        <span className="tracking-[0.1em] lowercase">live builder stream</span>
        <span
          className="rounded-full px-1 py-px tracking-[0.08em]"
          style={{
            color: hasRunning ? 'var(--sophia-purple)' : 'var(--cosmic-text-whisper)',
            background: hasRunning
              ? 'color-mix(in srgb, var(--sophia-purple) 10%, transparent)'
              : 'color-mix(in srgb, var(--cosmic-text-faint) 8%, transparent)',
          }}
        >
          {entries.length}
        </span>
      </div>

      <div
        ref={scrollRef}
        className={cn(
          'mt-1.5 overflow-y-auto rounded-lg border px-2 py-1.5 transition-all duration-300',
          compact ? 'max-h-[140px]' : 'max-h-[200px]',
        )}
        style={{
          borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 60%, transparent)',
          background: 'color-mix(in srgb, var(--cosmic-panel-soft) 40%, transparent)',
        }}
      >
        {entries.map((entry, index) => (
          <ActivityEntry
            key={`${index}-${entry.tool ?? entry.type}`}
            entry={entry}
            isLast={index === entries.length - 1}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}
