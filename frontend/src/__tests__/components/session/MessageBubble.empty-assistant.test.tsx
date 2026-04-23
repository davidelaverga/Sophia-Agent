import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MessageBubble, type UIMessage } from '../../../app/components/session/MessageBubble';

function makeAssistantMessage(content: string): UIMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content,
    createdAt: new Date('2026-04-22T12:00:00.000Z').toISOString(),
  } as UIMessage;
}

describe('MessageBubble empty assistant turns', () => {
  it('does not render the avatar + capsule when an assistant turn has no text yet', () => {
    const { container } = render(
      <MessageBubble message={makeAssistantMessage('')} isLatest={true} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('article', { name: 'Sophia replied' })).not.toBeInTheDocument();
  });

  it('still renders incomplete assistant turns even when empty (response interrupted)', () => {
    render(
      <MessageBubble
        message={{ ...makeAssistantMessage(''), incomplete: true }}
        isLatest={true}
      />,
    );

    expect(screen.getByRole('article', { name: 'Sophia replied' })).toBeInTheDocument();
    expect(screen.getByText('Response interrupted')).toBeInTheDocument();
  });

  it('renders normally once text content streams in', () => {
    render(
      <MessageBubble message={makeAssistantMessage('Hello there.')} isLatest={true} />,
    );

    expect(screen.getByRole('article', { name: 'Sophia replied' })).toBeInTheDocument();
    expect(screen.getByText('Hello there.')).toBeInTheDocument();
  });
});
