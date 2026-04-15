export type BuilderTaskPhaseV1 = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export type BuilderTaskProgressSourceV1 = 'todos' | 'messages' | 'none';

export type BuilderTodoV1 = {
  id?: number;
  title: string;
  status: 'not-started' | 'in-progress' | 'completed';
};

export type BuilderShellCommandDebugV1 = {
  tool?: string;
  description?: string;
  status?: string;
  command?: string;
  requestedCommand?: string;
  resolvedCommand?: string;
  shellExecutable?: string | null;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  timeoutSeconds?: number;
  exitCode?: number;
  error?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  outputPreview?: string;
};

export type BuilderTaskDebugV1 = {
  lastToolNames?: string[];
  lastHasEmitBuilderArtifact?: boolean | null;
  lateToolNames?: string[];
  lateHasEmitBuilderArtifact?: boolean | null;
  timeoutObservedDuringStream?: boolean;
  timedOutAt?: string | null;
  finalStatePresent?: boolean;
  builderResultPresent?: boolean;
  suspectedBlocker?: string | null;
  suspectedBlockerDetail?: string | null;
  lastShellCommand?: BuilderShellCommandDebugV1 | null;
  recentShellCommands?: BuilderShellCommandDebugV1[];
};

export type BuilderTaskV1 = {
  phase: BuilderTaskPhaseV1;
  taskId?: string;
  label?: string;
  detail?: string;
  messageIndex?: number;
  totalMessages?: number;
  progressPercent?: number;
  progressSource?: BuilderTaskProgressSourceV1;
  totalSteps?: number;
  completedSteps?: number;
  inProgressSteps?: number;
  pendingSteps?: number;
  activeStepTitle?: string;
  todos?: BuilderTodoV1[];
  startedAt?: string;
  completedAt?: string;
  lastUpdateAt?: string;
  lastProgressAt?: string;
  heartbeatMs?: number;
  idleMs?: number;
  stuck?: boolean;
  stuckReason?: string;
  debug?: BuilderTaskDebugV1;
  heartbeat?: boolean;
  pollCount?: number;
};