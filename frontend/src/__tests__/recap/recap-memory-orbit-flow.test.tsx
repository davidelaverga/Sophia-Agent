import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    cleanup();
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
    expect(screen.getByText('1 memory selected — complete review to save')).toBeInTheDocument();
    expect(screen.queryByText(/in the pool/)).not.toBeInTheDocument();
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
    expect(screen.getByText('2 memories selected — complete review to save')).toBeInTheDocument();
    expect(screen.queryByText(/in the pool/)).not.toBeInTheDocument();
    expect(screen.queryByText('I prefer short resets between games.')).not.toBeInTheDocument();
    expect(screen.queryByText('I recover faster when I slow down and breathe.')).not.toBeInTheDocument();
    expect(screen.queryByText('Temporary draft memory to remove.')).not.toBeInTheDocument();
    expect(screen.queryByText('Refined')).not.toBeInTheDocument();
  });

  it.each([undefined, '', '   '])('does not label the stock line as a key takeaway when none was supplied (%j)', (takeaway) => {
    render(
      <RecapMemoryOrbit
        takeaway={takeaway}
        candidates={[{ id: 'memory-1', text: 'Synthetic candidate', category: 'fact' }]}
        decisions={{}}
        onDecisionChange={() => {}}
      />
    );
    expect(screen.queryByText('key takeaway')).toBeNull();
    expect(screen.getByText('from this session')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A thread worth carrying forward');
  });

  it('keeps the key takeaway label for a supplied takeaway', () => {
    render(
      <RecapMemoryOrbit
        takeaway="You found the calmer thread."
        candidates={[{ id: 'memory-1', text: 'Synthetic candidate', category: 'fact' }]}
        decisions={{}}
        onDecisionChange={() => {}}
      />
    );
    expect(screen.getByText('key takeaway')).toBeInTheDocument();
    expect(screen.queryByText('from this session')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('You found the calmer thread.');
  });
});
