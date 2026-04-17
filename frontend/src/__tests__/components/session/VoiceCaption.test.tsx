import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceCaption } from '../../../app/components/session/VoiceCaption';

describe('VoiceCaption', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports visibility so overlapping voice chrome can hide while captions are on screen', () => {
    const onVisibilityChange = vi.fn();
    const now = new Date().toISOString();

    const { rerender } = render(
      <VoiceCaption
        messages={[]}
        isVoiceMode={true}
        onVisibilityChange={onVisibilityChange}
      />
    );

    rerender(
      <VoiceCaption
        messages={[
          {
            id: 'user-1',
            role: 'user',
            content: 'Can you help me think this through?',
            createdAt: now,
          },
        ]}
        isVoiceMode={true}
        onVisibilityChange={onVisibilityChange}
      />
    );

    expect(screen.getByText('Can you help me think this through?')).toBeInTheDocument();
    expect(onVisibilityChange).toHaveBeenLastCalledWith(true);

    act(() => {
      vi.advanceTimersByTime(4501);
    });

    expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  });
});