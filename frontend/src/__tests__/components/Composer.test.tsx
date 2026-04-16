import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

const setComposerValue = vi.fn();
const sendMessage = vi.fn();

vi.mock('../../app/copy', () => ({
  useCopy: () => ({
    chat: {
      placeholder: 'Talk to Sophia',
      characterLimit: {
        max: 2000,
        warningThreshold: 1600,
        exceeded: 'Too long',
        approaching: 'Almost there',
      },
    },
  }),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}));

vi.mock('../../app/lib/time-greetings', () => ({
  getRandomPlaceholder: () => 'Talk to Sophia',
}));

vi.mock('../../app/stores/chat-store', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    composerValue: '',
    setComposerValue,
    sendMessage,
    isLocked: false,
  }),
}));

vi.mock('../../app/stores/presence-store', () => ({
  usePresenceStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    status: 'ready',
    detail: 'Ready when you are',
  }),
  getPresenceCopyKey: () => 'presence.ready',
}));

vi.mock('../../app/stores/usage-limit-store', () => ({
  useUsageLimitStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    isModalOpen: false,
  }),
}));

vi.mock('../../app/stores/selectors', () => ({
  selectComposerState: (state: Record<string, unknown>) => ({
    composerValue: state.composerValue,
    setComposerValue: state.setComposerValue,
    sendMessage: state.sendMessage,
    isLocked: state.isLocked,
  }),
  selectPresenceDisplay: (state: Record<string, unknown>) => ({
    status: state.status,
    detail: state.detail,
  }),
  selectIsModalOpen: (state: Record<string, unknown>) => state.isModalOpen,
}));

vi.mock('../../app/components/InputModeIndicator', () => ({
  InputModeIndicator: () => <div data-testid="input-mode-indicator" />,
}));

vi.mock('../../app/components/UsageHint', () => ({
  UsageHint: () => <div data-testid="usage-hint" />,
}));

import { Composer } from '../../app/components/chat/Composer';

describe('Composer', () => {
  it('renders the textarea and send button', () => {
    render(<Composer textareaRef={createRef<HTMLTextAreaElement>()} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('shows presence status text', () => {
    render(<Composer textareaRef={createRef<HTMLTextAreaElement>()} />);

    expect(screen.getByText('Ready when you are')).toBeInTheDocument();
  });
});