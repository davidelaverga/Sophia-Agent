import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}));

import { RitualNode } from '../../app/components/dashboard/RitualNode';
import { RITUALS } from '../../app/components/dashboard/types';

describe('RitualNode', () => {
  it('reveals the one-line ritual description on hover and focus', () => {
    render(
      <RitualNode
        ritual={RITUALS[0]}
        context="work"
        isSelected={false}
        onSelect={() => {}}
      />
    );

    const button = screen.getByRole('button', { name: /pre-work/i });
    const description = screen.getByText('to set your intention before the day starts');

    expect(description).toHaveAttribute('data-visible', 'false');

    fireEvent.mouseEnter(button);
    expect(description).toHaveAttribute('data-visible', 'true');

    fireEvent.mouseLeave(button);
    expect(description).toHaveAttribute('data-visible', 'false');

    fireEvent.focus(button);
    expect(description).toHaveAttribute('data-visible', 'true');
  });
});