# Builder Brief Classification

You receive a user's first message in a Builder thread. Classify it into
structured fields so Sophia's Builder agent can plan and execute.

## Inputs

User's brief (verbatim):
{user_brief}

## Classification rules

### task_type

Pick exactly one:

- **research**: explicit ask for information gathering, comparison,
  fact-checking, or summarization of external sources.
- **code**: software task — write, fix, refactor, or analyze code.
- **writing**: prose deliverable — report, blog post, email, doc.
- **data_analysis**: analyze a dataset, produce charts, run stats.
- **visual**: produce a visual artifact (slide deck, diagram, chart).
- **other**: anything that doesn't fit cleanly. Prefer this over
  forcing a wrong category.

### demo_mode

True if the user appears to be testing the system or exploring
capabilities rather than requesting real work. Signals:

- "test", "try", "demo", "show me what you can do"
- Hypothetical or trivial deliverables ("write me a haiku about cats")
- Explicit "I'm just curious" framing

False otherwise. When ambiguous, default False — real work treated
as a demo is worse than the inverse.

### normalized_brief

Rewrite the user's request as a 1-3 sentence specification of what
needs to be produced. Strip pleasantries, ambiguity, and meta-commentary.
Preserve all concrete constraints (length, format, audience, deadline).
If the brief is already clean, return it nearly verbatim.

Examples:

User: "hey could you maybe research electric cars and write a short
blog post about which ones are best in europe for families with kids
thanks"
→ task_type: writing
  demo_mode: false
  normalized_brief: "Write a short blog post recommending the best
  electric cars for families with children in Europe. Include 3-5
  models with brief justifications."

User: "test"
→ task_type: other
  demo_mode: true
  normalized_brief: "User is testing the Builder. Respond with a brief
  acknowledgment and offer to help with a real task."

User: "what's 2+2"
→ task_type: other
  demo_mode: true
  normalized_brief: "Trivial question — answer directly: 4."

## Output

Call the `classify_brief` tool with the three fields. Do not output
prose; only the tool call.
