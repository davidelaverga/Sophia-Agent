import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { InterruptCard } from '../../app/components/session/InterruptCard';
import type { InterruptPayload } from '../../app/types/session';

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}));

function buildResetInterrupt(): InterruptPayload {
  return {
    kind: 'RESET_OFFER',
    title: 'Quick Reset?',
    message: 'Want to reset?',
    options: [
      { id: 'accept', label: 'Yes, I need to reset', style: 'primary' },
      { id: 'decline', label: "I'm fine", style: 'secondary' },
      { id: 'later', label: 'After one more game', style: 'ghost' },
    ],
    snooze: false,
  };
}

describe('InterruptCard', () => {
  it('renders and selects tertiary ghost option when provided', async () => {
    const onSelect = vi.fn(async () => {});

    render(
      <InterruptCard
        interrupt={buildResetInterrupt()}
        onSelect={onSelect}
      />
    );

    const tertiary = screen.getByRole('button', { name: 'After one more game' });
    expect(tertiary).toBeInTheDocument();

    await userEvent.click(tertiary);

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('later');
    });
  });
});
