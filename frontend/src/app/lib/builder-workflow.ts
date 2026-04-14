export const BUILDER_DISCOVERY_PROMPT =
  'I want to use Builder for this. Help me clarify the deliverable, gather the right specs, and switch to Builder when you have enough detail.';

type CancelBuilderTaskResponse = {
  task_id?: string;
  status?: string;
  detail?: string | null;
};

export async function cancelBuilderTask(taskId: string): Promise<CancelBuilderTaskResponse> {
  const response = await fetch(`/api/sophia/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
  });

  const payload = await response.json().catch(() => ({})) as CancelBuilderTaskResponse & {
    error?: string;
    details?: { detail?: string };
  };

  if (!response.ok) {
    throw new Error(
      payload.error || payload.details?.detail || payload.detail || 'Failed to cancel builder task.',
    );
  }

  return payload;
}