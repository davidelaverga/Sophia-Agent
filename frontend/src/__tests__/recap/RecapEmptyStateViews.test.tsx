import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RecapEmptyStateViews } from '../../app/components/recap/RecapEmptyStateViews';

describe('truthful recap empty states', () => {
  afterEach(cleanup);
  it('distinguishes excluded source from successful zero or reviewed candidates', () => {
    render(<RecapEmptyStateViews status="source_excluded" />);
    expect(screen.getByText('Session source is excluded from memory extraction')).toBeTruthy();
    expect(screen.getByText(/not a completed extraction with zero candidates/)).toBeTruthy();
    expect(screen.queryByText('Memories already reviewed')).toBeNull();
    expect(screen.queryByText('Recap is still processing')).toBeNull();
  });
  it('does not claim extraction produced zero when verification failed', () => {
    render(<RecapEmptyStateViews status="unavailable" />);
    expect(screen.getByText(/couldn.t verify this recap/)).toBeTruthy();
    expect(screen.queryByText(/didn.t generate artifacts/)).toBeNull();
  });
  it('does not equate an expired candidate with review or approval', () => {
    render(<RecapEmptyStateViews status="no_pending" />);
    expect(screen.getByText('No candidates currently eligible for review')).toBeTruthy();
    expect(screen.getByText(/Nothing has been approved automatically/)).toBeTruthy();
    expect(screen.queryByText('Memories already reviewed')).toBeNull();
  });
  it('does not equate historical review with current saved memory', () => {
    render(<RecapEmptyStateViews status="reviewed" />);
    expect(screen.getByText(/does not confirm their current saved status/)).toBeTruthy();
    expect(screen.queryByText(/moved into your journal/)).toBeNull();
  });
});
