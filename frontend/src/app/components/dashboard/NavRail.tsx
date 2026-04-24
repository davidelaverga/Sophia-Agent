/**
 * NavRail — Left navigation rail (desktop) + bottom nav bar (mobile)
 *
 * Borderless, transparent overlay — lets the cosmic background breathe through.
 * Follows the same text-first / sweep-light design language as DashboardSidebar.
 *
 * Ownership contract:
 * - NavRail owns the compact navigation entry points.
 * - The desktop Sessions icon is the only collapsed trigger for opening session history.
 * - DashboardSidebar owns the expanded sessions content once that trigger is opened.
 *
 * Desktop: 56px fixed rail on the left edge with icon tooltips
 * Mobile: bottom bar with icon + label (like native iOS tab bar)
 */

'use client';

import { BookOpen, Clock, FileText, Settings } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { haptic } from '../../hooks/useHaptics';
import { cn } from '../../lib/utils';

import { useSweepGlow } from './sweepLight';

// ── Desktop Rail Item ───────────────────────────────────────

interface NavRailItemProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
  /** Render a micro-label below the icon for non-obvious icons. */
  showLabel?: boolean;
  railExpanded?: boolean;
}

function NavRailItem({ icon: Icon, label, active, badge, onClick, showLabel, railExpanded }: NavRailItemProps) {
  const showInlineLabel = Boolean(showLabel && railExpanded);

  return (
    <div className="group relative flex w-full justify-center">
      <button
        type="button"
        onClick={() => {
          haptic('light');
          onClick();
        }}
        aria-label={label}
        className={cn(
          'relative rounded-xl transition-all duration-200',
          railExpanded
            ? 'flex h-10 w-[116px] items-center justify-start gap-2.5 px-3'
            : 'flex h-10 w-10 items-center justify-center',
          !active && 'hover:bg-[var(--cosmic-hover-bg)]',
        )}
        style={{ color: active ? 'var(--sophia-purple)' : 'var(--cosmic-text-muted)' }}
      >
        {/* Active indicator — thin left accent bar with glow */}
        {active && (
          <span
            className="absolute -left-1.5 top-2 bottom-2 w-[2px] rounded-full"
            style={{
              background: 'var(--sophia-purple)',
              boxShadow: '0 0 8px var(--sophia-purple)',
            }}
          />
        )}
        <Icon className="h-[18px] w-[18px]" />
        {showInlineLabel && (
          <span
            className={cn(
              'text-[11px] tracking-[0.01em] leading-none font-medium transition-[color,text-shadow] duration-200',
              active
                ? 'text-[var(--sophia-purple)] [text-shadow:var(--cosmic-navrail-label-active-glow)]'
                : 'text-[var(--cosmic-text-muted)] group-hover:text-[var(--cosmic-navrail-label-hover)] group-hover:[text-shadow:var(--cosmic-navrail-label-hover-glow)]',
            )}
          >
            {label}
          </span>
        )}
        {badge != null && badge > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex min-w-[14px] items-center justify-center rounded-full px-1 text-[8px] font-bold text-white"
            style={{ background: 'var(--sophia-purple)' }}
          >
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </button>

      {/* Tooltip — appears to the right on hover (only when no label is shown) */}
      {!active && !railExpanded && !showLabel && (
        <div
          className={cn(
            'pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-3',
            'whitespace-nowrap rounded-lg px-2.5 py-1.5',
            'text-[11px] font-medium tracking-wide',
            'opacity-0 transition-opacity duration-200 group-hover:opacity-100',
          )}
          style={{
            background: 'var(--cosmic-panel-strong)',
            color: 'var(--cosmic-text-strong)',
            border: '1px solid var(--cosmic-border-soft)',
            boxShadow: 'var(--cosmic-shadow-md)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

// ── Desktop Nav Rail ────────────────────────────────────────

interface NavRailProps {
  onToggleSessions: () => void;
  sessionsExpanded: boolean;
  sessionCount: number;
  onOpenSettings: () => void;
}

export function NavRail({
  onToggleSessions,
  sessionsExpanded,
  sessionCount,
  onOpenSettings,
}: NavRailProps) {
  const router = useRouter();
  const sweepRef = useSweepGlow();
  const [isHoverExpanded, setIsHoverExpanded] = useState(false);
  const railExpanded = isHoverExpanded && !sessionsExpanded;

  return (
    <nav
      ref={sweepRef}
      onMouseEnter={() => setIsHoverExpanded(true)}
      onMouseLeave={() => setIsHoverExpanded(false)}
      onFocusCapture={() => setIsHoverExpanded(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
          setIsHoverExpanded(false);
        }
      }}
      className={cn(
        'fixed left-0 top-0 bottom-0 z-30 hidden flex-col py-5 lg:flex',
        'transition-[width] duration-250 ease-out',
        railExpanded ? 'w-[132px] items-start pl-2 pr-2' : 'w-[56px] items-center',
      )}
      style={{
        filter: 'brightness(calc(1 + var(--sweep-glow, 0) * 0.10))',
      }}
    >
      {/* Primary navigation */}
      <div className={cn('mt-1 flex w-full flex-col gap-1.5', railExpanded ? 'items-stretch' : 'items-center')}>
        <NavRailItem
          icon={Clock}
          label="Sessions"
          active={sessionsExpanded}
          badge={sessionCount}
          onClick={onToggleSessions}
          showLabel
          railExpanded={railExpanded}
        />
        <NavRailItem
          icon={BookOpen}
          label="Journal"
          onClick={() => router.push('/journal')}
          showLabel
          railExpanded={railExpanded}
        />
        <NavRailItem
          icon={FileText}
          label="Files"
          onClick={() => router.push('/files')}
          showLabel
          railExpanded={railExpanded}
        />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Settings — bottom */}
      <NavRailItem icon={Settings} label="Settings" onClick={onOpenSettings} railExpanded={railExpanded} />
    </nav>
  );
}

// ── Mobile Bottom Nav Bar ───────────────────────────────────

function MobileNavItem({
  icon: Icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic('light');
        onClick();
      }}
      aria-label={label}
      className="relative flex flex-1 flex-col items-center gap-0.5 py-2"
    >
      <span className="relative" style={{ color: active ? 'var(--sophia-purple)' : 'var(--cosmic-text-muted)' }}>
        <Icon
          className="h-5 w-5 transition-colors duration-200"
        />
        {badge != null && badge > 0 && (
          <span
            className="absolute -right-1.5 -top-1 flex min-w-[14px] items-center justify-center rounded-full px-1 text-[8px] font-bold text-white"
            style={{ background: 'var(--sophia-purple)' }}
          >
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </span>
      <span
        className="text-[10px] font-medium tracking-wide transition-colors duration-200"
        style={{ color: active ? 'var(--sophia-purple)' : 'var(--cosmic-text-whisper)' }}
      >
        {label}
      </span>
    </button>
  );
}

interface MobileNavBarProps {
  onOpenSessions: () => void;
  sessionCount: number;
  onOpenSettings: () => void;
}

export function MobileNavBar({ onOpenSessions, sessionCount, onOpenSettings }: MobileNavBarProps) {
  const router = useRouter();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 flex items-center lg:hidden"
      style={{
        background: 'var(--cosmic-panel)',
        borderTop: '1px solid var(--cosmic-border-soft)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
      }}
    >
      <MobileNavItem
        icon={Clock}
        label="Sessions"
        badge={sessionCount}
        onClick={onOpenSessions}
      />
      <MobileNavItem
        icon={BookOpen}
        label="Journal"
        onClick={() => router.push('/journal')}
      />
      <MobileNavItem
        icon={FileText}
        label="Files"
        onClick={() => router.push('/files')}
      />
      <MobileNavItem icon={Settings} label="Settings" onClick={onOpenSettings} />
    </nav>
  );
}
