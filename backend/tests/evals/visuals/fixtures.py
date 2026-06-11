"""Anchor fixtures for the G-VIS provider matrix (Spec VQ-9).

The two failed production artifacts of 2026-06-10/11 become the standing
briefs — exactly as the memory screenshots anchor G-CON/G-RET. The HTML
brief anchors the F1 truncation fix.
"""

DECK_BRIEF = (
    "Create a professional 10-slide technical presentation titled "
    "'Multi-Session Automation Workflows' about designing race-condition-free "
    "workflows with scheduling tools. Cover the problem space, the available "
    "tools, decision architecture, and prevention patterns. Include diagrams "
    "and visuals."
)

PDF_BRIEF = (
    "Create a technical PDF document titled 'Multi-Session Automation "
    "Workflows' (10-12 pages) covering scheduling tools, race-condition "
    "prevention patterns, and decision architecture. Include diagrams, "
    "charts, and visuals."
)

HTML_BRIEF = (
    "Create a polished standalone HTML one-page site summarizing "
    "'Multi-Session Automation Workflows': hero section, three feature "
    "cards, a comparison table, and a closing call-to-action. Styled, "
    "complete, browser-ready."
)

FIXTURES = {
    "deck": {"brief": DECK_BRIEF, "task_type": "presentation", "target": "deck-eval.pptx"},
    "pdf": {"brief": PDF_BRIEF, "task_type": "document", "target": "report-eval.pdf"},
    "html": {"brief": HTML_BRIEF, "task_type": "frontend", "target": "site-eval.html"},
}
