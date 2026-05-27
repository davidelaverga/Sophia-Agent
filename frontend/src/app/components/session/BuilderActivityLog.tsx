'use client';

import {
  BookOpen,
  CheckCircle2,
  FileEdit,
  FileSearch,
  FileText,
  ListChecks,
  PackageCheck,
  Pencil,
  Search,
  Sparkles,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, type ComponentType } from 'react';

import { cn } from '../../lib/utils';
import type { BuilderActivityEntryV1 } from '../../types/builder-task';

type BuilderActivityLogProps = {
  entries: BuilderActivityEntryV1[];
  compact?: boolean;
  className?: string;
};

type DisplayEntry = BuilderActivityEntryV1 & {
  count: number;
};

type ActivityVisual = {
  icon: ComponentType<{ className?: string; size?: number }>;
  color: string;
  background: string;
};

const ACTION_VISUALS: Record<string, ActivityVisual> = {
  researching: { icon: Search, color: 'var(--cosmic-teal)', background: 'var(--cosmic-teal)' },
  searching_web: { icon: Search, color: 'var(--cosmic-teal)', background: 'var(--cosmic-teal)' },
  reading_source: { icon: BookOpen, color: 'var(--cosmic-teal)', background: 'var(--cosmic-teal)' },
  creating_plan: { icon: ListChecks, color: 'var(--cosmic-amber)', background: 'var(--cosmic-amber)' },
  updating_plan: { icon: ListChecks, color: 'var(--cosmic-amber)', background: 'var(--cosmic-amber)' },
  creating_artifact: { icon: Sparkles, color: 'var(--sophia-purple)', background: 'var(--sophia-purple)' },
  writing_file: { icon: FileEdit, color: 'var(--sophia-purple)', background: 'var(--sophia-purple)' },
  reading_file: { icon: FileSearch, color: 'var(--cosmic-text-faint)', background: 'var(--cosmic-text-faint)' },
  editing_file: { icon: Pencil, color: 'var(--sophia-purple)', background: 'var(--sophia-purple)' },
  running_check: { icon: TerminalSquare, color: 'var(--cosmic-amber)', background: 'var(--cosmic-amber)' },
  packaging_artifact: { icon: PackageCheck, color: 'var(--cosmic-teal)', background: 'var(--cosmic-teal)' },
  success: { icon: CheckCircle2, color: 'var(--cosmic-teal)', background: 'var(--cosmic-teal)' },
  failed: { icon: XCircle, color: 'var(--sophia-error, #f87171)', background: 'var(--sophia-error, #f87171)' },
  cancelled: { icon: XCircle, color: 'var(--cosmic-text-faint)', background: 'var(--cosmic-text-faint)' },
};

const TOOL_ACTIONS: Record<string, string> = {
  research: 'searching_web',
  plan: 'updating_plan',
  draft: 'writing_file',
  render: 'creating_artifact',
  package: 'packaging_artifact',
  finalize: 'running_check',
  bash: 'running_check',
  shell: 'running_check',
  write_file: 'writing_file',
  create_file: 'writing_file',
  edit_file: 'editing_file',
  str_replace: 'editing_file',
  read_file: 'reading_file',
  web_search: 'searching_web',
  builder_web_search: 'searching_web',
  web_fetch: 'reading_source',
  builder_web_fetch: 'reading_source',
  web_browse: 'reading_source',
  crawl_tool: 'reading_source',
  python_repl: 'running_check',
  write_todos: 'updating_plan',
  emit_builder_artifact: 'packaging_artifact',
};

function activityKey(entry: BuilderActivityEntryV1): string {
  return JSON.stringify([
    entry.action ?? entry.tool ?? entry.type,
    entry.title,
    entry.detail ?? '',
    entry.sourceDomain ?? '',
    entry.sourceTitle ?? '',
    entry.status ?? '',
  ]);
}

function collapseEntries(entries: BuilderActivityEntryV1[]): DisplayEntry[] {
  const collapsed: DisplayEntry[] = [];
  for (const entry of entries) {
    const last = collapsed[collapsed.length - 1];
    if (last && activityKey(last) === activityKey(entry)) {
      last.count += entry.count ?? 1;
      continue;
    }
    collapsed.push({ ...entry, count: entry.count ?? 1 });
  }
  return collapsed;
}

function visualForEntry(entry: BuilderActivityEntryV1): ActivityVisual {
  const action = entry.action ?? (entry.tool ? TOOL_ACTIONS[entry.tool] : undefined);
  if (action && ACTION_VISUALS[action]) {
    return ACTION_VISUALS[action];
  }
  if (entry.status === 'error') return ACTION_VISUALS.failed;
  if (entry.status === 'done') return { icon: FileText, color: 'var(--cosmic-text-faint)', background: 'var(--cosmic-text-faint)' };
  return { icon: Sparkles, color: 'var(--sophia-purple)', background: 'var(--sophia-purple)' };
}

function ActivityEntry({
  entry,
  isLast,
  compact,
}: {
  entry: DisplayEntry;
  isLast: boolean;
  compact?: boolean;
}) {
  const visual = visualForEntry(entry);
  const Icon = visual.icon;
  const isRunning = entry.status === 'running';

  return (
    <div className={cn('relative flex gap-2', compact ? 'min-h-[24px]' : 'min-h-[30px]')}>
      <div className="relative flex flex-col items-center" style={{ width: 18 }}>
        <span
          className={cn(
            'z-10 flex shrink-0 items-center justify-center rounded-full border',
            compact ? 'h-[18px] w-[18px]' : 'h-5 w-5',
          )}
          style={{
            color: visual.color,
            background: `color-mix(in srgb, ${visual.background} 13%, var(--cosmic-panel-soft))`,
            borderColor: `color-mix(in srgb, ${visual.background} 32%, transparent)`,
            boxShadow: `0 0 12px color-mix(in srgb, ${visual.background} ${isRunning ? '24%' : '10%'}, transparent)`,
          }}
        >
          <Icon size={compact ? 10 : 12} />
        </span>
        {!isLast && (
          <div
            className="flex-1"
            style={{
              width: 1,
              background: `linear-gradient(${visual.background}, color-mix(in srgb, var(--cosmic-text-faint) 12%, transparent))`,
              opacity: 0.34,
              minHeight: compact ? 7 : 9,
            }}
          />
        )}
      </div>

      <div className={cn('min-w-0 flex-1 pb-1', compact ? 'pt-[1px]' : 'pt-[2px]')}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn('truncate font-medium', compact ? 'text-[9px]' : 'text-[10px]')}
            style={{ color: entry.status === 'running' ? visual.color : 'var(--cosmic-text-faint)' }}
          >
            {entry.title}
          </span>
          {entry.count > 1 && (
            <span
              className={cn('shrink-0 rounded-full tracking-[0.08em] lowercase', compact ? 'px-1 py-px text-[7px]' : 'px-1.5 py-px text-[8px]')}
              style={{
                color: visual.color,
                background: `color-mix(in srgb, ${visual.background} 12%, transparent)`,
              }}
            >
              x{entry.count}
            </span>
          )}
          {isRunning && (
            <span
              className={cn('shrink-0 rounded-full tracking-[0.08em] lowercase', compact ? 'px-1 py-px text-[7px]' : 'px-1.5 py-px text-[8px]')}
              style={{
                color: visual.color,
                background: `color-mix(in srgb, ${visual.background} 12%, transparent)`,
                animation: 'builder-core-breath 2.4s ease-in-out infinite',
              }}
            >
              active
            </span>
          )}
        </div>
        {entry.detail && (
          <p
            className={cn('truncate', compact ? 'mt-0.5 text-[8px]' : 'mt-0.5 text-[9px]')}
            style={{ color: 'var(--cosmic-text-whisper)' }}
            title={entry.detail}
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
  const collapsedEntries = useMemo(() => collapseEntries(entries), [entries]);
  const prevCountRef = useRef(collapsedEntries.length);

  useEffect(() => {
    if (collapsedEntries.length > prevCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevCountRef.current = collapsedEntries.length;
  }, [collapsedEntries.length]);

  if (collapsedEntries.length === 0) {
    return null;
  }

  const latestEntry = collapsedEntries[collapsedEntries.length - 1];
  const latestVisual = latestEntry ? visualForEntry(latestEntry) : ACTION_VISUALS.creating_artifact;
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
            color: hasRunning ? latestVisual.color : 'var(--cosmic-text-whisper)',
            background: hasRunning
              ? `color-mix(in srgb, ${latestVisual.background} 10%, transparent)`
              : 'color-mix(in srgb, var(--cosmic-text-faint) 8%, transparent)',
          }}
        >
          {collapsedEntries.length}
        </span>
      </div>

      <div
        ref={scrollRef}
        className={cn(
          'mt-1.5 overflow-y-auto rounded-lg border px-2 py-1.5 transition-all duration-300',
          compact ? 'max-h-[148px]' : 'max-h-[212px]',
        )}
        style={{
          borderColor: 'color-mix(in srgb, var(--cosmic-border-soft) 62%, transparent)',
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--cosmic-panel-soft) 46%, transparent), color-mix(in srgb, var(--cosmic-panel) 56%, transparent))',
        }}
      >
        {collapsedEntries.map((entry, index) => (
          <ActivityEntry
            key={`${index}-${activityKey(entry)}`}
            entry={entry}
            isLast={index === collapsedEntries.length - 1}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}
