import { act, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecapMemoryOrbit } from '../../app/components/recap/RecapMemoryOrbit';
import type { MemoryDecision } from '../../app/lib/recap-types';

type DecisionMap = Record<string, { decision: MemoryDecision; editedText?: string }>;

function RecapOrbitHarness({
  candidates,
  initialDecisions = {},
}: {
  candidates: Array<{ id: string; text: string; category?: string }>;
  initialDecisions?: DecisionMap;
}) {
  const [decisions, setDecisions] = useState<DecisionMap>(initialDecisions);

  return (
    <RecapMemoryOrbit
      candidates={candidates}
      decisions={decisions}
      onDecisionChange={(candidateId, decision, editedText) => {
        setDecisions((prev) => ({
          ...prev,
          [candidateId]: editedText
            ? { decision, editedText }
            : { decision },
        }));
      }}
    />
  );
}

describe('RecapMemoryOrbit demo flow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the active orbit category badge and supports refine open/cancel/save', async () => {
    vi.useFakeTimers();

    render(
      <RecapOrbitHarness
        candidates={[
          {
            id: 'memory-1',
            text: 'I want calmer practice sessions.',
            category: 'identity_profile',
          },
        ]}
      />
    );

    expect(screen.getByText('Identity')).toBeInTheDocument();
    expect(screen.getByText('I want calmer practice sessions.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refine this memory' }));

    const textarea = screen.getByRole('textbox', { name: 'Refine memory text' });
    expect(textarea).toHaveValue('I want calmer practice sessions.');

    fireEvent.change(textarea, { target: { value: 'I want calmer tournament sessions.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('textbox', { name: 'Refine memory text' })).not.toBeInTheDocument();
    expect(screen.getByText('I want calmer practice sessions.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refine this memory' }));
    const reopenedTextarea = screen.getByRole('textbox', { name: 'Refine memory text' });
    expect(reopenedTextarea).toHaveValue('I want calmer practice sessions.');

    fireEvent.change(reopenedTextarea, { target: { value: 'I want calmer tournament sessions.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save refinement' }));

    expect(screen.getByText('I want calmer tournament sessions.')).toBeInTheDocument();
    expect(screen.getByText('Keep refined')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep this memory' }));

    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(screen.getByText('All memories reviewed')).toBeInTheDocument();
    expect(screen.getByText('1 memory in the pool')).toBeInTheDocument();
  });

  it('summarizes only approved and edited memories after review', () => {
    render(
      <RecapMemoryOrbit
        candidates={[
          { id: 'approved-1', text: 'I prefer short resets between games.', category: 'preferences_boundaries' },
          { id: 'edited-1', text: 'I recover when I slow down.', category: 'regulation_tools' },
          { id: 'discarded-1', text: 'Temporary draft memory to remove.', category: 'temporary_context' },
        ]}
        decisions={{
          'approved-1': { decision: 'approved' },
          'edited-1': { decision: 'edited', editedText: 'I recover faster when I slow down and breathe.' },
          'discarded-1': { decision: 'discarded' },
        }}
        onDecisionChange={() => {}}
      />
    );

    expect(screen.getByText('All memories reviewed')).toBeInTheDocument();
    expect(screen.getByText('2 memories in the pool')).toBeInTheDocument();
    expect(screen.queryByText('I prefer short resets between games.')).not.toBeInTheDocument();
    expect(screen.queryByText('I recover faster when I slow down and breathe.')).not.toBeInTheDocument();
    expect(screen.queryByText('Temporary draft memory to remove.')).not.toBeInTheDocument();
    expect(screen.queryByText('Refined')).not.toBeInTheDocument();
  });
});
