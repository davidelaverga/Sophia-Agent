import { describe, expect, it, vi } from 'vitest';

import { navigateToSessionDocument } from '../../app/lib/session-navigation';

describe('navigateToSessionDocument', () => {
  it('uses one full-document navigation to the ordinary session route', () => {
    const assign = vi.fn();

    navigateToSessionDocument({ assign });

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/session');
  });
});
