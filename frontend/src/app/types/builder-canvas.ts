import type { BuilderCompletionEventV1 } from './builder-completion';

export type BuilderCanvasStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export type BuilderCanvasActivity =
  | {
    kind: 'phase';
    phase: 'starting' | 'researching' | 'drafting' | 'finalizing' | 'refining' | 'done';
    category?: BuilderCanvasActivityCategory;
    action?: BuilderCanvasActivityAction;
    label: string;
    detail?: string;
    source_domain?: string;
    source_title?: string;
  }
  | {
    kind: 'tool_activity';
    category: BuilderCanvasActivityCategory;
    action?: BuilderCanvasActivityAction;
    label: string;
    detail?: string;
    source_domain?: string;
    source_title?: string;
  };

export type BuilderCanvasActivityCategory =
  | 'research'
  | 'plan'
  | 'draft'
  | 'render'
  | 'package'
  | 'finalize';

export type BuilderCanvasActivityAction =
  | 'researching'
  | 'searching_web'
  | 'reading_source'
  | 'creating_plan'
  | 'updating_plan'
  | 'creating_artifact'
  | 'writing_file'
  | 'reading_file'
  | 'editing_file'
  | 'running_check'
  | 'packaging_artifact'
  | 'success'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type BuilderCanvasEventV1 = {
  version: 1;
  event_id: string;
  sequence: number;
  parent_thread_id: string;
  task_id: string;
  run_id: string;
  occurred_at: string;
  kind: 'progress' | 'terminal';
  status: BuilderCanvasStatus;
  activity?: BuilderCanvasActivity;
  completion?: BuilderCompletionEventV1;
};

export type BuilderCanvasTaskSnapshotV1 = {
  parent_thread_id: string;
  task_id: string;
  run_id: string;
  status: BuilderCanvasStatus;
  latest_activity?: BuilderCanvasActivity;
  completion?: BuilderCompletionEventV1;
};

export type BuilderCanvasSnapshotV1 = {
  version: 1;
  active_task: BuilderCanvasTaskSnapshotV1 | null;
  recent_events: BuilderCanvasEventV1[];
};
