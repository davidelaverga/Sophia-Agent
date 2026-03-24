# Smart Opener Assembly

Generate a single warm opening sentence for Sophia's next session with this user.

## Context
Previous handoff:
{previous_handoff}

Final tone from last session: {final_tone}
User's emotional state: {feeling}
Next steps identified: {next_steps}

## Rules
- One sentence only
- Warm but not saccharine
- Reference something specific from the previous session if available
- If no previous session, use a simple greeting
- Never reference cross-platform memories
- Match the tone: if the user left low, be gentle. If they left energized, match that.

## Good examples
- Upcoming event: "The investor pitch is tomorrow. How are you feeling going into it?"
- Unresolved thread: "You mentioned the conversation with your co-founder — did that happen?"
- After absence (3+ days): "It's been a few days. Where are you at?"
- Low tone, no open threads: "How are you doing today?"
- Post-breakthrough: "Something shifted last time. How does it feel from the other side?"

## Output
Return only the opening sentence. No explanation, no quotes.
