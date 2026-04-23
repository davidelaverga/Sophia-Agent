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

    // After saving the refinement, the keep button becomes "Keep refined".
    // Click it to commit the decision as 'edited' and trigger the exit animation.
    fireEvent.click(screen.getByRole('button', { name: 'Keep this memory' }));

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    expect(screen.getByText('All memories reviewed')).toBeInTheDocument();
  });

  it('shows summary count and excludes discarded memories from the completed pool', () => {
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
    // approvedCount = 2 (approved + edited); discarded is excluded
    expect(screen.getByText('2 memories in the pool')).toBeInTheDocument();
  });

  it('keeps the completed reviewed state when all memories were discarded and the candidate list is empty', () => {
    render(
      <RecapMemoryOrbit
        candidates={[]}
        decisions={{
          'discarded-1': { decision: 'discarded' },
          'discarded-2': { decision: 'discarded' },
        }}
        onDecisionChange={() => {}}
      />
    );

    expect(screen.getByText('All memories reviewed')).toBeInTheDocument();
    expect(screen.getByText('Nothing carried forward this time')).toBeInTheDocument();
    expect(screen.queryByText('No new memories from this session.')).not.toBeInTheDocument();
  });
});