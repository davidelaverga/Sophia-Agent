const MOCK_RESPONSES: Record<string, string[]> = {
  default: [
    "I hear you. Tell me more about what's going on.",
    "That's interesting. What made you think of that?",
    "I'm here with you. What else is on your mind?",
    "Thanks for sharing that. How does it make you feel?",
  ],
  prepare: [
    "Let's get you focused. What's your main goal for this session?",
    'Time to dial in. What do you want to accomplish?',
  ],
  debrief: [
    "How did that go? Let's process what happened together.",
    "Let's reflect on that. What stood out to you most?",
  ],
  reset: [
    "Let's pause for a moment. Take a deep breath with me...",
    'Time to recalibrate. Breathe in... and out.',
  ],
  vent: [
    "I'm here to listen. Let it out - no judgment here.",
    'Sometimes we just need to be heard. Go ahead.',
  ],
  open: [
    "Hey, I'm here. What's on your mind?",
    "I'm listening. Take your time.",
  ],
};

let mockResponseIndex = 0;

export function getMockResponse(preset: string): string {
  const responses = MOCK_RESPONSES[preset] || MOCK_RESPONSES.default;
  const response = responses[mockResponseIndex % responses.length];
  mockResponseIndex++;
  return response;
}
