export type BuilderTaskPhaseV1 = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export type BuilderTaskV1 = {
  phase: BuilderTaskPhaseV1;
  taskId?: string;
  label?: string;
  detail?: string;
  messageIndex?: number;
  totalMessages?: number;
};