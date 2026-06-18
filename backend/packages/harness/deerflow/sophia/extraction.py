"""Mem0 memory extraction from completed session transcripts.

Uses Claude Haiku + the mem0_extraction.md prompt template to extract
structured observations from a session, then writes each memory to Mem0
via add_memories() with full metadata and status="pending_review".
"""

import json
import logging
import re
from datetime import UTC, datetime
from difflib import SequenceMatcher
from pathlib import Path

import anthropic

from deerflow.sophia.mem0_client import add_memories

logger = logging.getLogger(__name__)

# Path to the extraction prompt template
_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
_EXTRACTION_TEMPLATE_PATH = _PROMPTS_DIR / "mem0_extraction.md"

# Model for all pipeline LLM calls (per spec)
_PIPELINE_MODEL = "claude-haiku-4-5-20251001"

_EXPLICIT_REMEMBER_PATTERNS = [
    re.compile(r"(?is)\bplease\s+remember(?:\s+that)?\s+(?P<statement>.+)"),
    re.compile(r"(?is)\bi\s+want\s+you\s+to\s+remember(?:\s+that)?\s+(?P<statement>.+)"),
    re.compile(r"(?is)\bcould\s+you\s+remember(?:\s+that)?\s+(?P<statement>.+)"),
    re.compile(r"(?is)\bcan\s+you\s+remember(?:\s+that)?\s+(?P<statement>.+)"),
    re.compile(r"(?is)\bremember(?:\s+that|\s+this)?\s+(?P<statement>.+)"),
]
_PREFERENCE_LABEL_MARKERS = (
    "preference",
    "preferred",
    "favorite",
    "favourite",
)
_TEST_OR_META_MARKERS = ("test", "segment", "sample", "dummy")
_CREDENTIAL_MARKERS = (
    "password",
    "passcode",
    "credential",
    "credentials",
    "security token",
    "api key",
    "access key",
    "private key",
    "secret",
    "token",
    "otp",
    "2fa",
    "recovery code",
)
_NON_DURABLE_MARKERS = ("temporary", "one-time", "one time", "codename")
# Task-history backstop: a build *request* made to Sophia ("user asked for a
# report about X", "user wants a deck about Y") is transient task history, not a
# durable fact, and pollutes the builder. The prompt (mem0_extraction.md) is the
# primary lever; this catches what the model still emits. It fires on a request
# verb + deliverable noun, but only when the noun is a *strong* "make me a ___"
# deliverable (report, presentation, deck, slide, webpage) OR a weak/ambiguous
# noun (document, pdf, material, …) paired with an explicit create/build cue —
# and never when the requester is a third party ("boss asked for a status report")
# or it is a delivery preference. This keeps durable memories ("user asked for HR
# documents", "anxious about a board presentation") while dropping "user asked for
# a report about Hermes". See fix/builder-memory-contamination.
#
# Request verbs span ask / request / want / need. "ask" requires "for" (with an
# optional recipient: "asked for", "asked me/you/us/sophia for"), a recipient +
# "to" ("asked me to"), or "to <create>" ("asked to build") — so it never matches
# "asked about the report" or "asked to see the report"; want/need are bare (they
# govern the deliverable directly: "wants a report"). The noun + third-party +
# preference guards bound the recall.
#
# An optional TIME phrase may sit between "asked"/recipient and "for"/"to"
# ("asked on Tuesday for a report", "asked on June 12 for a deck", "asked me
# yesterday to build") — a legacy memory often records when the ask happened, and
# the extraction prompt resolves temporals to ABSOLUTE dates. The phrase is a
# tightly scoped temporal adverbial (the "on" form only matches a weekday or a
# date), so it cannot swallow a topic phrase: "asked about the report for the
# team" and "asked on pricing for clarity" still do NOT match the for-arm.
# Absolute-date forms after "on": "June 12(, 2026)", ISO "2026-06-12", "06/12",
# "the 12th".
_ABSOLUTE_DATE = (
    r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\s+\d{1,2}(?:,?\s+\d{4})?"
    r"|\d{4}-\d{1,2}-\d{1,2}"
    r"|\d{1,2}/\d{1,2}(?:/\d{2,4})?"
    r"|the\s+\d{1,2}(?:st|nd|rd|th)?"
)
_REQUEST_TIME_PHRASE = (
    r"(?:on\s+\w+day"
    r"|on\s+(?:" + _ABSOLUTE_DATE + r")"
    r"|yesterday|today|earlier|again|recently|just\s+now|just"
    r"|this\s+(?:morning|afternoon|evening|week|month)"
    r"|last\s+(?:week|month|night|time)"
    r"|the\s+other\s+(?:day|week)"
    r"|(?:a\s+)?(?:while|moment|day|week|month)s?\s+ago"
    r"|\d+\s+(?:days?|weeks?|months?|hours?)\s+ago)"
)
_DELIVERABLE_REQUEST_RE = re.compile(
    r"\b(?:requested|requests)\b"
    # "asked for" / "asked {sophia,me,you,us} for" (recipient optional) with an
    # optional intervening time phrase: "asked on Tuesday for", "asked me yesterday for"
    r"|\bask(?:ed|s)\s+(?:(?:sophia|me|you|us)\s+)?(?:" + _REQUEST_TIME_PHRASE + r"\s+)?for\b"
    # "asked {sophia,me,you,us} to <anything>" (recipient-directed), optional time phrase
    r"|\bask(?:ed|s)\s+(?:sophia|me|you|us)\s+(?:" + _REQUEST_TIME_PHRASE + r"\s+)?to\b"
    # bare "asked sophia" (Sophia-directed)
    r"|\bask(?:ed|s)\s+sophia\b"
    # bare "asked to <create>" — gated on a creation stem so "asked to see/review"
    # an existing artifact is NOT a build request. Optional time phrase: "asked on Monday to build"
    r"|\bask(?:ed|s)\s+(?:" + _REQUEST_TIME_PHRASE + r"\s+)?to\s+(?:creat|buil[dt]|mak|made|draft|generat|design|produc|prepar|wr(?:ite|ote|itten)|put\s+together|summari[sz]|compil|collat|assembl|convert|export|render)"
    r"|\bwant(?:ed|s)?\b"
    r"|\bneed(?:ed|s)?\b"
    # polite request forms: "would like a report", "user'd like a deck", "would love"
    r"|\bwould\s+(?:like|love)\b"
    r"|\b'?d\s+(?:like|love)\b"
)
_DELIVERABLE_NOUNS = (
    "presentation", "report", "deck", "slide", "document", "pdf",
    "html", "material", "deliverable", "artifact", "webpage",
    "infographic", "spreadsheet", "write-up",
    # WEAK deliverable types the builder dispatches (HTML/PDF output regexes):
    # summary/brief/article/explainer. Ambiguous (verb "brief me", adjective
    # "brief chat", "read an article"), so they are NOT in the STRONG set — they
    # drop only when topic-scoped ("a brief about X") or with a create cue, and a
    # bare/verbal/adjectival use is kept. "to brief" is exempted as a verb below.
    "summary", "brief", "article", "explainer",
    # Common document deliverables (weak — could name an existing doc): proposal,
    # memo, whitepaper, newsletter, essay.
    "proposal", "memo", "whitepaper", "newsletter", "essay",
    # Visual deliverables the builder produces (generate_visual_asset /
    # generate_excalidraw_diagram; companion_provider_fallback treats them as build
    # intent). Weak — "an image of my cat" could be an existing photo.
    "chart", "image", "diagram", "graph", "illustration", "mockup", "wireframe", "flowchart",
    # Format/extension deliverables the dispatch recognizes
    # (start_builder_task._REQUESTED_OUTPUT_EXTENSION_PATTERNS): csv/json/markdown/
    # docx/xlsx/excel. Weak. (Bare "md" is omitted — too ambiguous: doctor/state.)
    "csv", "json", "markdown", "docx", "xlsx", "excel",
)
# Frontend / web deliverables. The frontend dispatch path
# (``start_builder_task._HTML_OUTPUT_RE``) treats these bare nouns as build
# targets, so a legacy "user asked Sophia to build a website about X" memory must
# also drop as task_history — otherwise the prior frontend subject contaminates a
# new build. These are STRONG deliverables (an unambiguous "make me a ___").
# Kept as a regex fragment (not re.escape'd tuple entries) so the spaced forms
# allow flexible whitespace; the single-word "webpage" already lives in
# ``_DELIVERABLE_NOUNS``. The outer ``s?`` in each consuming pattern pluralizes
# (website → websites, landing page → landing pages, web app → web apps).
_WEB_DELIVERABLE_FRAGMENT = (
    r"website|web\s+site|web\s+page|landing\s+page|web\s+app(?:lication)?"
    r"|single[-\s]page\s+(?:app|site)"
)
# PowerPoint presentation aliases. The dispatch path
# (``start_builder_task._PPTX_OUTPUT_RE``) routes "PowerPoint"/"pptx"/"power
# point" as a presentation build, so a legacy "user asked for a PowerPoint about
# X" memory must drop as task_history too. STRONG deliverables. ("slide deck" /
# "slides" are already covered by the "slide"/"deck" nouns.)
_PPTX_DELIVERABLE_FRAGMENT = r"powerpoints?|pptx|power\s*points?"
# A deliverable word that MODIFIES a skill/activity ("presentation coaching",
# "presentation practice", "report-writing skills") is not the requested
# deliverable — it names a goal/context. This negative lookahead keeps the noun
# from matching when it is immediately followed by such an activity word or a
# hyphen-compound, so those durable memories are not dropped as task_history.
# Singular support-role words (a presentation *coach*/*mentor*/*tutor*) are
# exempted too — "user wants a presentation coach" is a support goal, not a build
# request — alongside the gerund "coaching". Emotional/support states modifying
# the noun ("presentation confidence/anxiety/nerves/fear/stress") name a feeling
# goal, not a requested artifact, so they are exempted as well. Person/role
# compounds ("website developer", "presentation designer") are a request for a
# PERSON, not the artifact, so they are exempted regardless of direction.
# NOTE: project/product words ("report generator/tool/app") are NOT here — a
# compound like "report generator" is the user's own project ONLY when there is
# no Sophia-directed build subject, so it is exempted by
# ``_PROJECT_PRODUCT_COMPOUND_RE`` in the no-subject branch only (a Sophia-directed
# "build a report generator ABOUT X" must still drop).
_NOT_SKILL_MODIFIER = (
    r"(?!\s+(?:coach(?:ing|es)?|mentor(?:s|ing|ship)?|tutor(?:s|ing)?|trainers?|"
    r"instructors?|teachers?|practice|prep|preparation|skills?|training|tips?|feedback|"
    r"advice|help|anxiet(?:y|ies)|nerves|nervousness|jitters|confiden\w+|fear\w*|"
    r"stress\w*|dread\w*|panic\w*|worr\w+|developers?|designers?|"
    r"class(?:es)?|courses?|lessons?)|-)"
)
# Match the deliverable nouns on WORD BOUNDARIES (optional trailing plural).
# A bare ``noun in content`` substring test silently fires inside unrelated
# words — "report" in "reported", "material" in "immaterial", "document" in
# "documented" — which, combined with a common request verb, would wrongly
# drop durable feeling/relationship/lesson memories as task_history (an
# abuse-disclosure case was reproduced in review). Anchoring keeps every
# intended case (the real "...educational materials..." build-request snippet
# still matches) while removing that false-positive class.
_DELIVERABLE_NOUN_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(noun) for noun in _DELIVERABLE_NOUNS)
    + "|" + _WEB_DELIVERABLE_FRAGMENT + "|" + _PPTX_DELIVERABLE_FRAGMENT + r")s?\b" + _NOT_SKILL_MODIFIER
)
# A genuine delivery *preference* ("prefers concise reports") is not a build
# request. Match the preference VERB on a word boundary so a topic noun like
# "report on consumer preferences" does NOT exempt itself (the bare substring
# "prefer" did — letting a real build request escape the filter).
_DELIVERY_PREFERENCE_RE = re.compile(r"\bprefer(?:s|red|ring)?\b")
# A standing preference can also be phrased with want/need ("user wants reports
# to be concise and include citations") — the prompt says these belong in
# `preference`, so the classifier must not drop them. Recognize the STYLE/format
# phrasing: a "<deliverable> to be/should be …" construction or a quality/format
# descriptor. Gated (in _is_delivery_preference) to fire only when there is NO
# build signal (no create/build cue, no "about <topic>"), so "make a concise
# report about Hermes" is still a build request, not a preference.
_DELIVERY_STYLE_RE = re.compile(
    r"\bto\s+(?:be|include|have|contain|use|avoid|cover)\b|\bshould\s+(?:be|include|have)\b"
    r"|\b(?:concise|succinct|brief|shorter|longer|detailed|thorough|formal|informal|casual|"
    r"polished|minimal|skimmable|scannable|punchy|high-level)\b"
    r"|\b(?:bullet|bullets|citations?|footnotes?|headlines?)\b|\bno\s+(?:jargon|bullets?|paragraphs?|fluff)\b"
    r"|\bplain\s+language\b|\bexecutive\s+summary\b|\bone[\s-]pager?\b"
)
# A topic marker introduces the deliverable's *subject* ("report ABOUT X",
# "presentation ON Y"). It does double duty: (1) it tells a styled deliverable
# noun apart from a standing style preference ("concise report about Hermes" is a
# build, "reports to be concise" is a preference), and (2) it splits the request
# *intent* (before the marker) from the *subject* (after) so the preference /
# third-party guards only scan who-is-asking, never incidental words in the topic
# ("report about what the CLIENT REQUESTED"). "for" is excluded (a recipient, not
# a subject: "report for the board").
#
# Subject-introducing PARTICIPLES count too: "a PDF summarizing X", "a document
# outlining Y", "a report detailing Z" scope the deliverable to a subject exactly
# like "about X" (covering/comparing were already here). Without them a weak noun
# in this shape ("requested a PDF summarizing Hermes") had no subject marker AND
# no create cue, so the no-subject branch kept it and the prior subject leaked.
#
# "on" is special: it introduces a subject ("report ON Hermes") OR a TIME ("asked
# ON Tuesday for a report"). A temporal "on <weekday/date>" is NOT a subject — if
# treated as one it leaves the topic split with no deliverable before it and the
# request is wrongly kept (the deliverable is after the date). So "on" only counts
# as a topic marker when it is NOT followed by a temporal expression.
_TEMPORAL_AFTER_ON = (
    r"(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b"
    r"|\d{1,2}(?:st|nd|rd|th)?\b"
    r"|" + _ABSOLUTE_DATE + r")"
)
_TOPIC_MARKER_RE = re.compile(
    r"\b(?:about|regarding|concerning|covering|comparing|"
    r"summari[sz]ing|outlining|detailing|describing|explaining|analy[sz]ing|highlighting)\b"
    r"|\bon\b(?!\s+" + _TEMPORAL_AFTER_ON + r")"
)
# One-off build signals — distinguish a SINGULAR styled request ("a detailed deck
# by Monday", "a concise report for the board") from a standing/generic style
# preference ("reports to be concise"). A singular article directly governing a
# deliverable, or a deadline, marks a one-off build that must NOT be exempted as a
# preference (see _is_delivery_preference). Generic/plural deliverables and the
# "to be …" construction carry neither and stay preferences.
_SINGULAR_DELIVERABLE_RE = re.compile(
    r"\ban?\s+(?:[\w-]+\s+){0,3}?(?:" + "|".join(re.escape(noun) for noun in _DELIVERABLE_NOUNS)
    + "|" + _WEB_DELIVERABLE_FRAGMENT + "|" + _PPTX_DELIVERABLE_FRAGMENT + r")s?\b"
)
# A SINGULAR INDEFINITE deliverable immediately governing a "for <X>" phrase
# ("a PDF for Hermes", "a summary for OpenClaw"). "for" is not a topic marker (it
# is often an audience: "a report for the board"), so a weak deliverable scoped by
# "for" is only treated as a build when it carries the indefinite article — a NEW
# one — which separates it from retrieving an existing artifact ("the onboarding
# PDF for new hires", "HR documents for the audit").
_SINGULAR_DELIVERABLE_FOR_RE = re.compile(
    r"\ban?\s+(?:[\w-]+\s+){0,3}?(?:" + "|".join(re.escape(noun) for noun in _DELIVERABLE_NOUNS)
    + "|" + _WEB_DELIVERABLE_FRAGMENT + "|" + _PPTX_DELIVERABLE_FRAGMENT + r")s?\s+for\s+\w"
)
# A build-VISUAL deliverable scoped by "of <subject>" ("chart OF Q2 revenue",
# "diagram OF the architecture") — "of" introduces the data the visual depicts, so
# it is a build. Limited to the unambiguous build-visuals; "image" is excluded
# because "image of my cat" is usually an existing photo, not a generated visual.
_VISUAL_OF_RE = re.compile(
    r"\b(?:charts?|diagrams?|graphs?|infographics?|flowcharts?|illustrations?|"
    r"mockups?|wireframes?)\s+of\s+\w"
)
_DEADLINE_RE = re.compile(
    r"\bdue\b|\btomorrow\b|\bby\s+(?:\w+day|tomorrow|tonight|noon|eod|cob|next\b|end\b|the\b|\d)"
)
# An explicit create/build cue. Combined with a request verb + deliverable noun
# it marks a build request made *of Sophia*, and distinguishes it from a request
# to a third party for an existing artifact ("asked for HR documents") or the
# user's own work ("user is building a report tool" — has no request verb).
# ``buil[dt]s?`` matches build / builds / built (incl. the passive "a PDF built
# about X") while word boundaries keep it out of "building". ``wr(ite|…)``
# matches bare write / writes / writing / wrote / written (and "write up") so
# "asked Sophia to write a PDF about X" is recognized as a build cue — the
# request-verb gate keeps it off the user's own writing ("user wrote a report").
# Content-production verbs (summarize/compile/collate/assemble) and the
# transformation phrase "turn/convert <X> into/to" are build cues too, so a weak
# deliverable phrased as "summarize Hermes in a PDF" / "turn the notes into a
# document" is recognized without an explicit "about <topic>".
_DELIVERABLE_CREATION_RE = re.compile(
    r"\bcreat(?:e|es|ed|ing)\b|\bcreation\s+of\b|\bbuil[dt]s?\b|"
    r"\bmake\b|\bmakes\b|\bmaking\b|\bmade\b|\bdraft(?:s|ed|ing)?\b|"
    r"\bgenerat(?:e|es|ed|ing)\b|\bdesign(?:s|ed|ing)?\b|\bproduc(?:e|es|ed|ing)\b|"
    r"\bprepar(?:e|es|ed|ing)\b|\bput\s+together\b|\bwr(?:ite|ites|iting|ote|itten)\b|"
    r"\bsummari[sz](?:e|es|ed|ing)\b|\bcompil(?:e|es|ed|ing)\b|"
    r"\bcollat(?:e|es|ed|ing)\b|\bassembl(?:e|es|ed|ing)\b|"
    r"\bexport(?:s|ed|ing)?\b|\brender(?:s|ed|ing)?\b|"
    r"\b(?:turn|convert)(?:s|ed|ing)?\s+[^.?!]{0,40}?\b(?:in)?to\b"
)
# STRONG deliverable nouns: things one asks Sophia to *produce*. A request verb
# alone is enough to mark these as task history ("user asked for a report about
# X"), no separate creation cue needed — that distinguishes them from weak nouns
# (document/pdf/material/…) that could name an existing artifact.
_STRONG_DELIVERABLE_NOUN_RE = re.compile(
    r"\b(?:presentation|report|deck|slide|webpage|infographic|spreadsheet|write-up|"
    + _WEB_DELIVERABLE_FRAGMENT + "|" + _PPTX_DELIVERABLE_FRAGMENT + r")s?\b" + _NOT_SKILL_MODIFIER
)
# A request involving a third party is a relationship fact, NOT a build request
# made of Sophia — never drop it. Two shapes: the third party is the asker
# ("boss asked for a status report", "user's manager requested a deck"), or the
# third party is the one asked to act — the *redirected requestee*
# ("user wants their boss to deliver the report", "user asked the team to build a
# deck"). The redirect shape requires the party to directly follow a request /
# causative verb (+ optional determiner) so it does NOT match an audience phrase
# where the party merely *receives* the deliverable ("asked Sophia to build a
# report FOR the team to review" — Sophia is still the requester → must drop).
# Sophia / me / you are NOT third parties, so genuine user→Sophia requests match.
_THIRD_PARTY = (
    r"boss|manager|supervisor|colleague|co-?worker|client|customer|teammate|"
    r"recruiter|director|investor|stakeholder|ceo|cto|cfo|hr|team|lead"
)
# Content/source-material nouns. In "from <party>", a party (esp. client/customer)
# immediately followed by one of these is a SOURCE the deliverable is built FROM
# ("a report from customer FEEDBACK", "from the client NOTES"), NOT a person who
# produces it — so the producer arm below must not exempt that Sophia build.
_SOURCE_MATERIAL_NOUNS = (
    r"feedback|notes?|data|materials?|info(?:rmation)?|input|research|insights?|"
    r"comments?|reviews?|surveys?|tickets?|complaints?|interviews?|transcripts?|"
    r"records?|logs?|metrics?|analytics|emails?|messages?|docs?|files?|"
    r"requirements?|specs?|specifications?|guidelines?|criteria|instructions?|briefs?|requests?"
)
_THIRD_PARTY_REQUEST_RE = re.compile(
    # (1) third party is the asker: "boss asked", "manager requested"
    rf"\b(?:{_THIRD_PARTY})\b\s+"
    r"(?:asked|asks|requested|requests|wanted|wants|told|tells|needs|needed|demanded|demands|require[sd]?)\b"
    # (2) third party is the redirected requestee: "wants their boss to", "asked the team to",
    # "requested their manager to" — include requested/requests so a user→third-party
    # redirect ("user requested their manager to create a report") is preserved.
    rf"|\b(?:asked|asks|requested|requests|wanted|wants|needed|needs|told|tells|got|had)\s+"
    rf"(?:(?:the|their|a|an|our|my|your|his|her|its)\s+)?(?:{_THIRD_PARTY})\b\s+to\b"
    # (3) third party is the PRODUCER: "a report FROM their manager" — the user
    # asked for a deliverable the third party makes, not a build of Sophia. The
    # negative lookahead excludes source-material phrases ("from customer
    # feedback", "from the client notes", and the possessive "from the client's
    # notes" / "from their manager's feedback"), where the party modifies a content
    # noun and Sophia is still the one building — those must still drop.
    rf"|\bfrom\s+(?:(?:the|their|a|an|our|my|your|his|her|its)\s+)?(?:{_THIRD_PARTY})\b"
    rf"(?!(?:'s|’s)?\s+(?:{_SOURCE_MATERIAL_NOUNS}))"
    # (4) PASSIVE: the third party is the asker in passive voice ("was requested
    # BY their boss", "asked by HR", "tasked by the client") — a work obligation,
    # not a request made of Sophia.
    rf"|\b(?:asked|requested|told|tasked|assigned|instructed|directed)\s+by\s+"
    rf"(?:(?:the|their|a|an|our|my|your|his|her|its)\s+)?(?:{_THIRD_PARTY})\b"
)
# The deliverable WORD is not a requested artifact when it is used as a VERB
# ("wants to report on harassment", "to document the abuse", "to brief them") —
# report/document/brief double as verbs — so a request verb + "report on X" /
# "brief them" is not a build request.
_DELIVERABLE_AS_VERB_RE = re.compile(r"\bto\s+report\b|\bto\s+documents?\b|\bto\s+brief\b")
# …or when the deliverable is the OBJECT of a help / practice / prep request
# ("asked for help with a presentation", "needs help preparing for a report",
# "practicing for the deck") — the user wants support with an existing/upcoming
# deliverable, not for Sophia to build one. (Mirrors the skill-modifier exemption
# for the pre-noun framing.)
_HELP_OR_PRACTICE_RE = re.compile(
    r"\bhelp(?:\s+(?:me|them|us|him|her))?\s+(?:with|on|prepare|prep|practic\w+|rehears\w+)\b"
    r"|\b(?:practic\w+|rehears\w+|prepar\w+|prep)\s+for\b"
)
# A STRONG noun inside a common NON-DELIVERABLE compound is not a build target:
# a school "report card", a playing-card "deck of cards" / "card deck", a "deck
# chair"/"deck shoes"/"deck hand" (furniture/nautical), a "slide rule"
# (calculator). These satisfy the request-verb + strong-noun test ("needs a deck
# of cards", "wants a deck chair") but are durable facts, not deliverables. A real
# "slide deck about X" does not match these compounds and still drops.
_NON_DELIVERABLE_COMPOUND_RE = re.compile(
    r"\breport\s+cards?\b"
    r"|\bdecks?\s+of\s+cards?\b"
    r"|\bcard\s+decks?\b"
    r"|\bdecks?\s+(?:chairs?|hands?|shoes?)\b"
    r"|\bslide\s+rules?\b"
)
# An emotional/support GOAL where a deliverable is the activity context, not the
# requested artifact: "wants confidence FOR presentations", "scared OF giving
# presentations", "calm BEFORE the presentation". The emotional word comes BEFORE
# the deliverable (via a connector), which distinguishes it from a real build
# whose subject happens to be an emotion ("a report ABOUT anxiety" — there the
# deliverable precedes the feeling, so this does NOT match and it still drops).
_EMOTIONAL_STATE = (
    r"confiden\w+|anxiet(?:y|ies)|anxious|nervous\w*|nerves|scared|afraid|fearful|fear|"
    r"stress\w*|worr\w+|calm\w*|comfortable|jitters|dread\w*|panic\w*|courage|imposter|impostor"
)
_EMOTIONAL_SUPPORT_RE = re.compile(
    r"\b(?:" + _EMOTIONAL_STATE + r")\b"
    r"[^.?!]{0,25}?\b(?:for|with|about|around|during|giving|delivering|before|ahead\s+of|of)\b"
    r"[^.?!]{0,25}?\b(?:"
    + "|".join(re.escape(noun) for noun in _DELIVERABLE_NOUNS)
    + "|" + _WEB_DELIVERABLE_FRAGMENT + r")s?\b"
)
# A deliverable word naming the user's OWN software project/product: "report
# generator", "presentation app", "slide builder", "PDF tool". This is exempted
# ONLY in the no-subject branch AND only when the request is NOT Sophia-directed —
# a Sophia-directed build of one ("asked Sophia to build a report generator for
# OpenClaw", "build a report generator ABOUT OpenClaw") is still a build request
# and must drop. The user's OWN work ("wants to create a report generator for
# their startup") has no Sophia direction, so it stays.
_PROJECT_PRODUCT_COMPOUND_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(noun) for noun in _DELIVERABLE_NOUNS)
    + "|" + _WEB_DELIVERABLE_FRAGMENT + "|" + _PPTX_DELIVERABLE_FRAGMENT + r")s?\s+"
    r"(?:generators?|tools?|apps?|applications?|platforms?|builders?|engines?|software|"
    r"bots?|pipelines?|frameworks?|librar(?:y|ies)|plugins?|extensions?|saas)\b"
)
# A request explicitly directed at Sophia: any directing verb (ask/request/want/
# need/tell/have/get/expect/'d like) aimed at Sophia/me/you/us — including
# causative delegation ("wants to HAVE Sophia build", "GET Sophia to build") and
# want/need-phrased ("wants Sophia to build", "needs you to create") — or the bare
# "asked/requested to <create>". Used to deny the project/product and own-work
# exemptions (a build Sophia is directed to do is task history, even if the
# deliverable is a "generator" or framed as the user's intent).
_SOPHIA_DIRECTED_RE = re.compile(
    r"\b(?:ask(?:ed|s)?|request(?:ed|s)?|want(?:ed|s)?|need(?:ed|s)?|tell(?:s|ing)?|told|"
    r"have|having|had|get(?:s|ting)?|got|expect(?:ed|s|ing)?|'?d\s+like|would\s+like)\s+(?:sophia|me|you|us)\b"
    r"|\b(?:ask(?:ed|s)|request(?:ed|s))\s+(?:" + _REQUEST_TIME_PHRASE + r"\s+)?to\s+(?:creat|buil[dt]|mak|made|draft|generat|design|produc|prepar|wr(?:ite|ote|itten)|put\s+together|summari[sz]|compil|collat|assembl|convert|export|render)"
)
# An OWN-WORK goal/commitment: the user states THEIR OWN intent to act on a
# deliverable ("needs to prepare a presentation by Monday", "wants to finish the
# report by Friday") — the user does it, not Sophia. The infinitive "to <verb>"
# right after want/need/plan/… is the tell ("wants TO finish" vs "wants A
# report"). Combined (in _is_non_artifact_deliverable_use) with a NOT-Sophia-
# directed check so "wants Sophia to build a deck" / "asked Sophia to …" still
# drop. "to ask" is excluded (delegating the ask is not own work).
_OWN_WORK_RE = re.compile(
    r"\b(?:want(?:ed|s)?|need(?:ed|s)?|plan(?:ned|s|ning)?|hop(?:e|ed|es|ing)|"
    r"aim(?:ed|s|ing)?|tr(?:y|ies|ied|ying)|going|wish(?:ed|es)?|intend(?:ed|s)?|"
    r"would\s+like)\s+to\s+(?!ask\b)\w"
)
_DUPLICATE_STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "because",
    "for",
    "in",
    "is",
    "it",
    "my",
    "of",
    "prefers",
    "preferred",
    "preference",
    "the",
    "them",
    "their",
    "to",
    "user",
    "users",
    "with",
}


class MemoryWriteError(RuntimeError):
    """Raised when candidate extraction succeeded but the memory write did not."""


def _load_template() -> str:
    """Load the mem0_extraction.md prompt template."""
    return _EXTRACTION_TEMPLATE_PATH.read_text(encoding="utf-8")


def _format_transcript(messages: list[dict]) -> str:
    """Format messages as 'User: ...' / 'Sophia: ...' pairs."""
    lines = []
    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if not content:
            continue
        if role == "user":
            lines.append(f"User: {content}")
        elif role in ("assistant", "ai"):
            lines.append(f"Sophia: {content}")
    return "\n\n".join(lines)


def _strip_markdown_fences(text: str) -> str:
    """Strip markdown code block fences (```json ... ```) if present."""
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.split("\n")
        # Remove first line (```json or ```)
        lines = lines[1:]
        # Remove last line if it's ```
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines)
    return stripped.strip()


def analyze_explicit_remember_messages(messages: list[dict]) -> dict:
    """Return deterministic explicit-remember candidates and safe diagnostics.

    Diagnostics deliberately omit transcript text and candidate content. They
    only carry source identifiers and rejection reasons so production can tell
    whether an explicit user request was intentionally filtered.
    """
    entries: list[dict] = []
    rejections: list[dict] = []
    seen: set[str] = set()

    for index, msg in enumerate(messages):
        if msg.get("role") != "user":
            continue

        statement = _extract_explicit_remember_statement(str(msg.get("content") or ""))
        if not statement:
            continue

        source_metadata = _source_metadata_for_message(messages, index)
        rejection_reason = _explicit_remember_rejection_reason(statement)
        if rejection_reason:
            rejections.append({"reason": rejection_reason, **source_metadata})
            continue

        entry = _explicit_preference_entry_from_statement(statement, source_metadata)
        if entry is None:
            rejections.append({"reason": "low_confidence", **source_metadata})
            continue

        key = _normalize_entry_content(entry["content"])
        if key in seen:
            continue
        seen.add(key)
        entries.append(entry)

    return {
        "entries": entries,
        "rejections": rejections,
        "explicit_count": len(entries) + len(rejections),
    }


def _extract_explicit_remember_statement(text: str) -> str | None:
    if not text:
        return None
    normalized = " ".join(text.strip().split())
    for pattern in _EXPLICIT_REMEMBER_PATTERNS:
        match = pattern.search(normalized)
        if not match:
            continue
        statement = _clean_clause(match.group("statement"))
        return statement or None
    return None


def _source_metadata_for_message(messages: list[dict], index: int) -> dict:
    source_messages = [messages[index]]
    if index + 1 < len(messages) and messages[index + 1].get("role") in {"assistant", "ai"}:
        source_messages.append(messages[index + 1])

    sequences = [
        sequence
        for message in source_messages
        if isinstance((sequence := _message_sequence(message)), int)
    ]
    message_ids = [
        message_id
        for message in source_messages
        if isinstance((message_id := _message_id(message)), str) and message_id
    ]

    metadata: dict[str, object] = {}
    if sequences:
        metadata["sequence_start"] = min(sequences)
        metadata["sequence_end"] = max(sequences)
    if message_ids:
        metadata["source_message_ids"] = message_ids
    return metadata


def _message_sequence(message: dict) -> int | None:
    sequence = message.get("sequence")
    if isinstance(sequence, int):
        return sequence
    metadata = message.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("sequence"), int):
        return metadata["sequence"]
    return None


def _message_id(message: dict) -> str | None:
    message_id = message.get("message_id")
    if isinstance(message_id, str) and message_id:
        return message_id
    metadata = message.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("message_id"), str):
        return metadata["message_id"]
    return None


def _explicit_remember_rejection_reason(statement: str) -> str | None:
    lowered = statement.casefold()
    if any(marker in lowered for marker in _CREDENTIAL_MARKERS):
        return "credential_like"
    if any(marker in lowered for marker in _NON_DURABLE_MARKERS):
        return "temporary_or_test_marker"
    return None


def _explicit_preference_entry_from_statement(
    statement: str,
    source_metadata: dict,
) -> dict | None:
    statement = _clean_clause(statement)
    if not statement:
        return None

    content = _explicit_my_preference_content(statement)
    if content is None:
        content = _explicit_i_prefer_content(statement)
    if content is None:
        return None

    lowered = statement.casefold()
    is_test_or_meta = any(marker in lowered for marker in _TEST_OR_META_MARKERS)
    tags = ["explicit_user_statement", "explicit_remember", "preference"]
    if is_test_or_meta:
        tags.append("test_marker")

    return {
        "content": content,
        "category": "preference",
        "importance": 0.45 if is_test_or_meta else 0.82,
        "confidence": 0.72 if is_test_or_meta else 0.9,
        "target_date": None,
        "metadata": {
            "tags": tags,
            "explicit_remember_source": "deterministic_preference",
            **source_metadata,
        },
    }


def _explicit_my_preference_content(statement: str) -> str | None:
    match = re.search(
        r"(?is)\bmy\s+(?P<label>[a-z0-9][^.!?]{1,90}?)\s+(?:is|are)\s+(?P<value>[^.!?]{1,200})",
        statement,
    )
    if not match:
        return None

    label = _clean_label(match.group("label"))
    if not label or not _is_preference_label(label):
        return None

    value, reason = _split_reason(match.group("value"))
    if not value:
        return None

    content = f"User's {label} is {value}"
    if reason:
        content += f" because {reason}"
    return _sentence(content)


def _explicit_i_prefer_content(statement: str) -> str | None:
    match = re.search(r"(?is)\bi\s+prefer\s+(?P<value>[^.!?]{1,200})", statement)
    if not match:
        return None

    value, reason = _split_reason(match.group("value"))
    if not value:
        return None

    content = f"User prefers {value}"
    if reason:
        content += f" because {reason}"
    return _sentence(content)


def _is_preference_label(label: str) -> bool:
    lowered = label.casefold()
    return any(marker in lowered for marker in _PREFERENCE_LABEL_MARKERS)


def _split_reason(value: str) -> tuple[str | None, str | None]:
    parts = re.split(r"\s+because\s+", _clean_clause(value), maxsplit=1, flags=re.IGNORECASE)
    main = _clean_clause(parts[0]) if parts else None
    reason = _clean_reason(parts[1]) if len(parts) > 1 else None
    return main or None, reason or None


def _clean_clause(value: str) -> str:
    cleaned = " ".join(str(value or "").split())
    cleaned = cleaned.strip().strip("-:;,.!?()[]{}\"'")
    return cleaned


def _clean_label(value: str) -> str:
    label = _clean_clause(value).casefold()
    label = re.sub(r"^(?:the|a|an)\s+", "", label)
    return label


def _clean_reason(value: str) -> str:
    reason = _clean_clause(value)
    replacements = [
        (r"\bhelps me\b", "helps them"),
        (r"\bhelp me\b", "help them"),
        (r"\bmy\b", "their"),
        (r"\bme\b", "them"),
    ]
    for pattern, replacement in replacements:
        reason = re.sub(pattern, replacement, reason, flags=re.IGNORECASE)
    return reason


def _sentence(value: str) -> str:
    cleaned = _clean_clause(value)
    if not cleaned:
        return ""
    return cleaned if cleaned.endswith(".") else f"{cleaned}."


def _normalize_entry_content(content: str | None) -> str:
    return " ".join(str(content or "").casefold().split())


def _extract_explicit_preferred_name_entries(messages: list[dict]) -> list[dict]:
    """Create deterministic preferred-name candidates from explicit user statements."""
    entries: list[dict] = []
    seen: set[str] = set()
    for msg in messages:
        if msg.get("role") != "user":
            continue
        name = _extract_explicit_preferred_name_from_text(str(msg.get("content") or ""))
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        entries.append(
            {
                "content": f"Preferred name: {name}. Explicit user statement.",
                "category": "fact",
                "importance": 0.95,
                "confidence": 0.98,
                "target_date": None,
                "metadata": {
                    "tags": ["preferred_name", "explicit_user_statement"],
                    "preferred_name_source": "explicit_user_statement",
                },
            }
        )
    return entries


def _extract_explicit_preferred_name_from_text(text: str) -> str | None:
    if not text:
        return None
    patterns = [
        r"(?i)\bmy\s+name\s+is\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
        r"(?i)\bcall\s+me\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
        r"(?i)\brefer\s+to\s+me\s+as\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
        r"(?i)\bi\s+go\s+by\s+([A-Z][A-Za-z'_-]{1,40}(?:\s+[A-Z][A-Za-z'_-]{1,40}){0,2})\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        cleaned = _clean_explicit_preferred_name(match.group(1))
        if cleaned:
            return cleaned
    return None


def _clean_explicit_preferred_name(value: str) -> str | None:
    name = value.strip().strip("-:.,;()[]{}\"'")
    name = re.split(r"[.,;:!?]\s+", name, maxsplit=1)[0]
    name = re.split(
        r"\s+(?:no|not|please|from|instead|because|when|if|but|could|can|remember|going|for)\b",
        name,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0].strip()
    if not name or len(name) > 60:
        return None
    if any(ch in name for ch in ("/", "\\", "\x00", "<", ">", "{", "}")):
        return None
    if not re.fullmatch(r"[A-Za-z][A-Za-z'_-]*(?:\s+[A-Za-z][A-Za-z'_-]*){0,2}", name):
        return None
    lowered = name.lower()
    stop_words = {
        "user",
        "unknown",
        "anonymous",
        "none",
        "null",
        "n/a",
        "na",
        "me",
        "you",
        "on",
        "the",
        "a",
        "an",
        "this",
        "that",
        "it",
        "important",
        "tomorrow",
        "today",
        "later",
        "thing",
        "one",
        "someone",
        "list",
        "about",
        "launch",
    }
    if lowered in stop_words or any(part in stop_words for part in lowered.split()):
        return None
    if name.islower():
        return " ".join(part[:1].upper() + part[1:] for part in name.split())
    return name


def _merge_deterministic_entries(extracted: list, deterministic_entries: list[dict]) -> list[dict]:
    normalized = [entry for entry in extracted if isinstance(entry, dict)]
    existing_content = {
        _normalize_entry_content(str(entry.get("content") or ""))
        for entry in normalized
        if isinstance(entry, dict) and entry.get("content")
    }

    if deterministic_entries:
        normalized = [
            entry
            for entry in normalized
            if not _is_duplicate_of_deterministic_entry(entry, deterministic_entries)
        ]
        existing_content = {
            _normalize_entry_content(str(entry.get("content") or ""))
            for entry in normalized
            if isinstance(entry, dict) and entry.get("content")
        }

    for entry in deterministic_entries:
        if not isinstance(entry, dict):
            continue
        content_key = _normalize_entry_content(str(entry.get("content") or ""))
        if not content_key or content_key in existing_content:
            continue
        existing_content.add(content_key)
        normalized.append(entry)

    return normalized


def _is_duplicate_of_deterministic_entry(entry: dict, deterministic_entries: list[dict]) -> bool:
    content = str(entry.get("content") or "")
    if not content:
        return False
    return any(
        _content_near_duplicate(content, str(deterministic.get("content") or ""))
        for deterministic in deterministic_entries
        if isinstance(deterministic, dict)
    )


def _content_near_duplicate(left: str, right: str) -> bool:
    left_normalized = _normalize_entry_content(left)
    right_normalized = _normalize_entry_content(right)
    if not left_normalized or not right_normalized:
        return False
    if left_normalized == right_normalized:
        return True

    sequence_score = SequenceMatcher(None, left_normalized, right_normalized).ratio()
    if sequence_score >= 0.78:
        return True

    left_tokens = _content_tokens(left_normalized)
    right_tokens = _content_tokens(right_normalized)
    if not left_tokens or not right_tokens:
        return False
    return len(left_tokens & right_tokens) / min(len(left_tokens), len(right_tokens)) >= 0.65


def _content_tokens(content: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", content.casefold())
        if len(token) > 2 and token not in _DUPLICATE_STOPWORDS
    }


def _filter_policy_rejected_entries(extracted: list[dict], *, llm_classifier=None) -> list[dict]:
    """Drop policy-rejected extraction candidates.

    ``credential_like`` and ``non_durable`` are unambiguous, deterministic hard
    drops (never sent to the LLM). ``task_history`` (build/deliverable requests)
    is decided by ``llm_classifier`` — authoritative — over ALL of the remaining
    *reviewable* candidates, so a lexical false positive (e.g. "wants presentation
    coaching") can't pre-empt the LLM by being dropped before it is reviewed. The
    lexical ``_is_deliverable_request`` signal is the fallback used only when the
    LLM is unavailable or errors. ``llm_classifier`` takes the reviewable contents
    and returns the set of indices to drop (best-effort — see
    ``_classify_task_history_with_llm``).
    """
    rejection_counts: dict[str, int] = {}
    reviewable: list[dict] = []
    reviewable_contents: list[str] = []
    lexical_task_history: set[int] = set()

    for entry in extracted:
        if not isinstance(entry, dict):
            continue
        content = str(entry.get("content") or "")
        reason = _candidate_policy_rejection_reason(content)
        if reason in ("credential_like", "non_durable"):
            rejection_counts[reason] = rejection_counts.get(reason, 0) + 1
            continue
        if reason == "task_history":
            lexical_task_history.add(len(reviewable))
        reviewable.append(entry)
        reviewable_contents.append(content)

    # task_history is LLM-authoritative when the classifier returns a set (incl.
    # empty). It returns None — or raises — when classification is UNAVAILABLE, in
    # which case we fall back to the lexical signal. Critically, a None/failure is
    # NOT treated as "drop nothing": that would let a lexical build-request hit be
    # written to Mem0 and reopen the contamination bug.
    llm_drop: set[int] | None = None
    if llm_classifier is not None and reviewable_contents:
        try:
            llm_drop = llm_classifier(reviewable_contents)
        except Exception:
            logger.warning("extraction task-history LLM classifier failed; lexical result stands", exc_info=True)
            llm_drop = None
    task_history_drop = llm_drop if llm_drop is not None else set(lexical_task_history)

    filtered: list[dict] = []
    for idx, entry in enumerate(reviewable):
        if idx in task_history_drop:
            rejection_counts["task_history"] = rejection_counts.get("task_history", 0) + 1
            continue
        filtered.append(entry)

    if rejection_counts:
        logger.info(
            "session.finalization extraction_policy_filtered reasons=%s",
            sorted(rejection_counts.items()),
        )

    return filtered


def _candidate_policy_rejection_reason(content: str) -> str | None:
    lowered = content.casefold()
    if any(marker in lowered for marker in _CREDENTIAL_MARKERS):
        return "credential_like"
    if "codename" in lowered or "temporary" in lowered:
        return "non_durable"
    if _is_deliverable_request(lowered):
        return "task_history"
    return None


def _is_deliverable_request(lowered: str) -> bool:
    """True for 'user asked for a <deliverable>' task-history snippets.

    Tuned across several review rounds to drop genuine build requests while never
    dropping a durable memory that merely shares a verb and a noun.

    A build request must carry a request verb (``_DELIVERABLE_REQUEST_RE``) —
    this separates a request from the user's own work ("user is building a report
    tool"). It must also be a request for the deliverable as an ARTIFACT: a
    deliverable word used as a verb ("wants to report on harassment"), as the
    object of a help/practice/prep request ("asked for help with a presentation"),
    a strong noun inside a non-deliverable compound ("a deck of cards", "a report
    card"), or the activity context of an emotional/support goal ("wants
    confidence for presentations") is exempted (``_is_non_artifact_deliverable_use``).
    That exemption is scoped to the request INTENT, never the subject — a real
    "deck about practicing for interviews" must still drop, since "practicing for"
    is the topic, not the request. The rest splits the request *intent* from the
    deliverable's *subject* at the first topic marker ("report ABOUT X"), because
    the guards below describe the request itself and must NOT be tripped by
    incidental words in the subject ("report about what customers PREFER", "report
    about what the CLIENT REQUESTED"):

    - With a subject ("<deliverable> about <topic>"): the requested deliverable
      noun must appear in the intent; the third-party and delivery-preference
      *verb* guards scan only the intent; then ANY deliverable noun in the intent —
      STRONG (report/presentation/deck) or weak (pdf/html/document/material) —
      marks it task history. The subject-scoping IS the build signal ("a PDF about
      X" = "make me a PDF on X"), so no separate create/build cue is required here
      (unlike the no-subject branch). Style words ("concise") do NOT exempt a
      deliverable about a topic.
    - Without a subject: a standing delivery preference ("prefers concise reports",
      "wants reports to be concise") is kept (``_is_delivery_preference``); a
      third-party request ("boss asked for a status report") is kept; otherwise a
      STRONG noun, or a weak noun + create/build cue, marks it task history.
    """
    if not _DELIVERABLE_REQUEST_RE.search(lowered):
        return False

    topic_markers = list(_TOPIC_MARKER_RE.finditer(lowered))
    if topic_markers:
        return _topic_scoped_request_is_build(lowered, topic_markers)
    return _subjectless_request_is_build(lowered)


def _is_non_artifact_deliverable_use(lowered: str) -> bool:
    """The deliverable word is present but is NOT a requested artifact — keep it.

    Five shapes: a deliverable word used as a verb ("wants to report on
    harassment"); the object of a help/practice/prep request ("asked for help with
    a presentation"); a strong noun inside a non-deliverable compound ("a deck of
    cards", "a report card"); the activity context of an emotional/support goal
    ("wants confidence for presentations"); or an OWN-WORK goal where the user
    states their own intent to act ("needs to prepare a presentation by Monday",
    "wants to finish the report") — unless the request is Sophia-directed.
    """
    if (
        _DELIVERABLE_AS_VERB_RE.search(lowered)
        or _HELP_OR_PRACTICE_RE.search(lowered)
        or _NON_DELIVERABLE_COMPOUND_RE.search(lowered)
        or _EMOTIONAL_SUPPORT_RE.search(lowered)
    ):
        return True
    return bool(_OWN_WORK_RE.search(lowered) and not _SOPHIA_DIRECTED_RE.search(lowered))


def _topic_scoped_request_is_build(lowered: str, topic_markers: list) -> bool:
    """Resolve a request that carries a subject marker ("<deliverable> about X").

    Splits at the first topic marker with the requested deliverable named BEFORE
    it — earlier markers can be temporal ("asked Sophia ON MONDAY to build a report
    about X"), so the split must land on "about", not "on Monday", or the intent
    has no noun. A subject marker present is itself the build signal ("a PDF about
    OpenClaw" = "make me a PDF on OpenClaw"), so ANY deliverable noun in the intent
    — strong or weak — marks task history, unless the intent is a third-party or
    delivery-preference request.
    """
    intent = None
    for marker in topic_markers:
        candidate = lowered[: marker.start()]
        if _DELIVERABLE_NOUN_RE.search(candidate):
            intent = candidate
            break
    if intent is None:
        # A subject is present but the deliverable noun is only AFTER it
        # ("wants to focus on the presentation") — not a build request.
        return False
    # The request VERB must be in the intent, not only in the subject. The global
    # gate in _is_deliverable_request accepts a request verb anywhere, so a durable
    # existing-artifact fact whose SUBJECT happens to mention one ("keeps a report
    # about what the client REQUESTED in Q3") would otherwise drop — require it in
    # the intent so only an actual request of the deliverable counts.
    if not _DELIVERABLE_REQUEST_RE.search(intent):
        return False
    # Scope the non-artifact exemptions to the request INTENT, never the subject:
    # "asked for a deck about practicing for interviews" is a real deck build — the
    # "practicing for" lives in the topic and must not exempt the request.
    if _is_non_artifact_deliverable_use(intent):
        return False
    if _THIRD_PARTY_REQUEST_RE.search(intent):
        return False
    # A preference VERB in the intent exempts a GENERIC standing preference
    # ("prefers reports about X") — but NOT a concrete singular/deadlined build
    # whose intent merely carries an adjectival "preferred" ("requested a report
    # in their preferred format about OpenClaw"). Mirror _is_delivery_preference's
    # one-off precedence so the latter still drops.
    if _DELIVERY_PREFERENCE_RE.search(intent) and not (
        _SINGULAR_DELIVERABLE_RE.search(intent) or _DEADLINE_RE.search(intent)
    ):
        return False
    return True


def _subjectless_request_is_build(lowered: str) -> bool:
    """Resolve a request with no subject marker.

    A standing delivery preference ("prefers concise reports") or a third-party
    request ("boss asked for a status report") is kept; otherwise a STRONG noun, or
    a weak noun + create/build cue, marks it task history. (Weak nouns alone could
    name an existing artifact — "asked for HR documents" — so they stay.)
    """
    if not _DELIVERABLE_NOUN_RE.search(lowered):
        return False
    # No subject marker, so the whole snippet IS the request — apply the
    # non-artifact exemptions here ("wants confidence for presentations",
    # "a deck of cards", "help with a presentation").
    if _is_non_artifact_deliverable_use(lowered):
        return False
    # A project/product compound with NO subject is the user's own work
    # ("a report generator for their startup") — keep — UNLESS the request is
    # Sophia-directed ("asked Sophia to build a report generator for OpenClaw"),
    # which is a build request and must drop even though "for OpenClaw" is not a
    # topic marker. (A subject-marked "… about OpenClaw" already drops via the
    # topic branch, which never consults this exemption.)
    if _PROJECT_PRODUCT_COMPOUND_RE.search(lowered) and not _SOPHIA_DIRECTED_RE.search(lowered):
        return False
    if _THIRD_PARTY_REQUEST_RE.search(lowered):
        return False
    if _is_delivery_preference(lowered):
        return False
    if _STRONG_DELIVERABLE_NOUN_RE.search(lowered):
        return True
    if _DELIVERABLE_CREATION_RE.search(lowered):
        return True
    # A singular-indefinite weak deliverable scoped by a trailing "for <X>"
    # ("a PDF for Hermes") is a one-off build — drop it. (Plural/definite forms,
    # which read as existing-artifact retrieval, do not match.)
    if _SINGULAR_DELIVERABLE_FOR_RE.search(lowered):
        return True
    # A build-visual scoped by "of <subject>" ("chart of Q2 revenue") is a build.
    return bool(_VISUAL_OF_RE.search(lowered))


def _is_delivery_preference(lowered: str) -> bool:
    """True when the snippet is a standing *delivery preference*, not a build request.

    Two forms: the explicit preference verb ("prefers concise reports"), or a
    style/format phrasing ("wants reports to be concise and include citations").
    The style form is recognized only when there is NO build signal:
    - no explicit create/build cue and no "about <topic>" subject (so a styled
      build request "make a concise report about Hermes" is still task history); and
    - not a SINGULAR one-off request — a singular article governing a deliverable
      ("a detailed deck") or a deadline ("by Monday") marks a one-off styled build
      ("needs a detailed deck by Monday", "wants a concise report for the board"),
      which is task history, not a standing preference about how deliverables look.

    The SINGULAR/deadline one-off check runs FIRST — before the preference verb —
    so an adjectival "preferred" inside a concrete build ("requested a report in
    their preferred format for OpenClaw", "a deck using their preferred template")
    does not let `prefer*` short-circuit it into a kept preference. A standing
    preference is generic ("prefers concise reports", "wants their reports
    concise"), carrying no singular article or deadline, so it is unaffected.
    """
    if _SINGULAR_DELIVERABLE_RE.search(lowered) or _DEADLINE_RE.search(lowered):
        return False
    if _DELIVERY_PREFERENCE_RE.search(lowered):
        return True
    if _DELIVERABLE_CREATION_RE.search(lowered) or _TOPIC_MARKER_RE.search(lowered):
        return False
    if not _DELIVERY_STYLE_RE.search(lowered):
        return False
    return True


# Focused Haiku classifier — the authoritative task-history backstop. The lexical
# `_is_deliverable_request` is a fast deterministic approximation; natural-language
# phrasing of "is this a build request about a subject" is genuinely hard for
# regexes (seven review rounds of edge cases), so a small dedicated LLM call is
# more reliable. Runs only in the offline extraction pipeline (no voice latency),
# batched over all lexical-survivor candidates in one call.
_TASK_HISTORY_CLASSIFIER_INSTRUCTION = (
    "You are a strict classifier for a personal AI companion's long-term memory.\n"
    "\n"
    "Each numbered statement is a candidate memory written in the third person about a user. "
    "Identify the ones that are TRANSIENT BUILD/DELIVERABLE REQUESTS: a request that a deliverable be "
    "produced — a report, presentation, deck, slides, document, PDF, write-up, infographic, webpage, "
    "spreadsheet, and the like — about some subject. This includes \"asked Sophia to build/create/draft "
    "<deliverable> about X\", \"asked to build a report about Y\", \"wants a deck on Z\", \"needs a "
    "presentation about W\". These are one-off task history; the subject of the deliverable must NOT "
    "become a durable memory because it contaminates future builds.\n"
    "\n"
    "Do NOT flag these (they are durable and must be kept):\n"
    "- Facts, decisions, feelings, relationships, behavioral patterns, lessons, commitments.\n"
    "- Delivery PREFERENCES — how the user likes deliverables made (\"prefers concise reports\", "
    "\"wants reports to be short and include citations\").\n"
    "- The user's OWN work or projects (\"user is building a report tool for their startup\").\n"
    "- A deliverable requested BY or FROM a third party (\"boss asked for a status report\"; "
    "\"user's manager requested a deck\").\n"
    "\n"
    "Return ONLY a JSON array of the 0-based indices of the statements that ARE transient "
    "build/deliverable requests. If none qualify, return [].\n"
    "\n"
    "Statements:\n"
    "{statements}"
)


def _classify_task_history_with_llm(contents: list[str], *, client=None) -> set[int] | None:
    """Haiku pass flagging build/deliverable-request task history.

    Returns a *set* of flagged indices (into ``contents``) on a SUCCESSFUL
    classification — possibly empty (the model ran and flagged nothing). Returns
    ``None`` when classification is UNAVAILABLE: missing client, API error,
    non-JSON / non-list response, or a non-empty response carrying no integer
    indices. ``None`` is the critical signal — it tells ``_filter_policy_rejected_entries``
    to fall back to the lexical heuristic rather than treating a failure as
    "drop nothing" (which would let a lexical build-request hit slip into Mem0).
    An empty ``contents`` list is a no-op success (empty set).
    """
    if not contents:
        return set()
    try:
        client = client or anthropic.Anthropic()
        numbered = "\n".join(f"{i}. {content}" for i, content in enumerate(contents))
        prompt = _TASK_HISTORY_CLASSIFIER_INSTRUCTION.replace("{statements}", numbered)
        response = client.messages.create(
            model=_PIPELINE_MODEL,
            max_tokens=256,
            messages=[{"role": "user", "content": prompt}],
        )
        parsed = json.loads(_strip_markdown_fences(response.content[0].text))
    except Exception:
        return None  # classifier unavailable → caller falls back to lexical

    if not isinstance(parsed, list):
        return None
    flagged: set[int] = set()
    saw_valid_index = False
    for item in parsed:
        # bool is an int subclass — exclude True/False from being read as indices.
        if isinstance(item, bool):
            continue
        if isinstance(item, int) and 0 <= item < len(contents):
            saw_valid_index = True
            flagged.add(item)
    if parsed and not saw_valid_index:
        # Non-empty list with no VALID in-range indices (objects, prose, or only
        # out-of-range numbers like [5] for one candidate) — treat as a malformed
        # response and fall back to lexical, NOT "flag nothing".
        return None
    return flagged


def _write_extracted_memories(
    *,
    user_id: str,
    session_id: str,
    extracted: list,
    metadata: dict,
    require_memory_write: bool = False,
) -> list[dict]:
    """Write vetted extraction candidates to Mem0 with standard review metadata."""
    written_memories: list[dict] = []
    platform = metadata.get("platform", "text")
    context_mode = metadata.get("context_mode", "life")

    for entry in extracted:
        if not isinstance(entry, dict) or not entry.get("content"):
            continue

        importance_score = entry.get("importance", 0.5)
        if importance_score >= 0.8:
            importance_label = "structural"
        elif importance_score >= 0.4:
            importance_label = "potential"
        else:
            importance_label = "contextual"

        entry_meta = entry.get("metadata", {})
        if not isinstance(entry_meta, dict):
            entry_meta = {}

        mem0_metadata = {
            "category": entry.get("category", "fact"),
            "importance": importance_label,
            "importance_score": importance_score,
            "confidence": entry.get("confidence", 0.5),
            "status": "pending_review",
            "platform": platform,
            "context_mode": context_mode,
        }
        for metadata_key in (
            "thread_id",
            "sequence_start",
            "sequence_end",
            "source_message_ids",
            "extraction_run_id",
        ):
            source_value = entry_meta.get(metadata_key)
            if source_value is None:
                source_value = metadata.get(metadata_key)
            if source_value is not None:
                mem0_metadata[metadata_key] = source_value

        # Include tone_estimate if present in the entry metadata
        if entry_meta.get("tone_estimate") is not None:
            mem0_metadata["tone_estimate"] = entry_meta["tone_estimate"]

        # Include ritual_phase if present
        if entry_meta.get("ritual_phase"):
            mem0_metadata["ritual_phase"] = entry_meta["ritual_phase"]

        # Include target_date if present
        if entry.get("target_date"):
            mem0_metadata["target_date"] = entry["target_date"]

        # Include tags if present
        if entry_meta.get("tags"):
            mem0_metadata["tags"] = entry_meta["tags"]

        # Include safe source marker for deterministic preferred-name candidates.
        if entry_meta.get("preferred_name_source"):
            mem0_metadata["preferred_name_source"] = entry_meta["preferred_name_source"]

        if entry_meta.get("explicit_remember_source"):
            mem0_metadata["explicit_remember_source"] = entry_meta["explicit_remember_source"]

        result = add_memories(
            user_id=user_id,
            messages=[{"role": "user", "content": entry["content"]}],
            session_id=session_id,
            metadata=mem0_metadata,
        )
        if require_memory_write and not result:
            raise MemoryWriteError("mem0_write_failed")

        written_memories.append({
            "content": entry["content"],
            "category": entry.get("category", "fact"),
            "importance": importance_label,
            "importance_score": importance_score,
            "metadata": mem0_metadata,
            "mem0_result": result,
        })

        logger.info(
            "session.finalization extraction_memory_written user_id=%s session_id=%s category=%s importance=%s",
            user_id,
            session_id,
            entry.get("category", "fact"),
            importance_label,
        )

    return written_memories


def extract_session_memories(
    user_id: str,
    session_id: str,
    messages: list[dict],
    session_metadata: dict | None = None,
    *,
    require_memory_write: bool = False,
) -> list[dict]:
    """Extract memories from a completed session transcript.

    Loads the mem0_extraction.md template, fills it with the session
    transcript and metadata, calls Claude Haiku to extract structured
    observations, then writes each memory to Mem0 via add_memories().

    Args:
        user_id: The user ID.
        session_id: The session/run ID.
        messages: List of message dicts with 'role' and 'content' keys.
        session_metadata: Optional dict with keys like 'context_mode',
            'ritual_type', 'platform', 'tone_start', 'tone_end'.

    Returns:
        List of memory dicts that were written to Mem0. Empty list on
        error or if no memories were extracted.
    """
    logger.info(
        "session.finalization extraction_start user_id=%s session_id=%s message_count=%s",
        user_id,
        session_id,
        len(messages),
    )

    if not messages:
        logger.info("Empty transcript for session %s — skipping extraction", session_id)
        return []

    metadata = session_metadata or {}
    session_date = metadata.get("session_date", datetime.now(UTC).strftime("%Y-%m-%d"))

    # Format the transcript
    transcript = _format_transcript(messages)
    if not transcript.strip():
        logger.info("No user/assistant content in session %s — skipping extraction", session_id)
        return []
    explicit_remember_analysis = analyze_explicit_remember_messages(messages)
    explicit_remember_entries = explicit_remember_analysis["entries"]
    if explicit_remember_analysis["explicit_count"]:
        rejection_reasons: dict[str, int] = {}
        for rejection in explicit_remember_analysis["rejections"]:
            reason = str(rejection.get("reason") or "unknown")
            rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1
        logger.info(
            "session.finalization explicit_remember_analyzed user_id=%s session_id=%s explicit_count=%s deterministic_candidates=%s rejection_reasons=%s",
            user_id,
            session_id,
            explicit_remember_analysis["explicit_count"],
            len(explicit_remember_entries),
            sorted(rejection_reasons.items()),
        )
    deterministic_entries = [
        *_extract_explicit_preferred_name_entries(messages),
        *explicit_remember_entries,
    ]

    # Load and fill the template
    try:
        template = _load_template()
    except FileNotFoundError:
        logger.error("Extraction template not found at %s", _EXTRACTION_TEMPLATE_PATH)
        if not deterministic_entries:
            if require_memory_write:
                raise MemoryWriteError("extraction_template_missing")
            return []
        return _write_extracted_memories(
            user_id=user_id,
            session_id=session_id,
            extracted=deterministic_entries,
            metadata=metadata,
            require_memory_write=require_memory_write,
        )

    # Use manual replacement instead of str.format() because the template
    # contains literal JSON curly braces that would conflict with format().
    replacements = {
        "{transcript}": transcript,
        "{artifacts}": str(metadata.get("artifacts", "None")),
        "{session_date}": session_date,
        "{context_mode}": metadata.get("context_mode", "life"),
        "{ritual_type}": str(metadata.get("ritual_type", "None")),
        "{tone_start}": str(metadata.get("tone_start", "unknown")),
        "{tone_end}": str(metadata.get("tone_end", "unknown")),
        "{session_id}": session_id,
        "{existing_memories}": str(metadata.get("existing_memories", "None")),
    }
    prompt = template
    for placeholder, value in replacements.items():
        prompt = prompt.replace(placeholder, value)

    # Call Claude Haiku via Anthropic SDK
    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model=_PIPELINE_MODEL,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        response_text = response.content[0].text
    except Exception:
        logger.error("Anthropic API call failed for session %s", session_id, exc_info=True)
        if not deterministic_entries:
            if require_memory_write:
                raise MemoryWriteError("extractor_failed")
            return []
        return _write_extracted_memories(
            user_id=user_id,
            session_id=session_id,
            extracted=deterministic_entries,
            metadata=metadata,
            require_memory_write=require_memory_write,
        )

    # Parse JSON response
    try:
        cleaned = _strip_markdown_fences(response_text)
        extracted = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        logger.error(
            "Failed to parse extraction response for session %s: %s",
            session_id,
            response_text[:200] if response_text else "(empty)",
        )
        if not deterministic_entries:
            if require_memory_write:
                raise MemoryWriteError("extractor_invalid_response")
            return []
        extracted = deterministic_entries

    if not isinstance(extracted, list):
        logger.error("Extraction response is not a list for session %s", session_id)
        if not deterministic_entries:
            if require_memory_write:
                raise MemoryWriteError("extractor_invalid_response")
            return []
        extracted = deterministic_entries

    # Lexical policy filter + an authoritative Haiku task-history pass (reusing the
    # extraction client). Runs only over LLM candidates; deterministic entries are
    # merged in afterwards and bypass the filter.
    extracted = _filter_policy_rejected_entries(
        extracted,
        llm_classifier=lambda survivor_contents: _classify_task_history_with_llm(survivor_contents, client=client),
    )
    extracted = _merge_deterministic_entries(extracted, deterministic_entries)

    logger.info(
        "session.finalization extraction_candidates user_id=%s session_id=%s candidate_count=%s",
        user_id,
        session_id,
        len(extracted),
    )

    # Write each extracted memory to Mem0
    written_memories = _write_extracted_memories(
        user_id=user_id,
        session_id=session_id,
        extracted=extracted,
        metadata=metadata,
        require_memory_write=require_memory_write,
    )

    logger.info(
        "session.finalization extraction_complete user_id=%s session_id=%s written_count=%s candidate_count=%s",
        user_id,
        session_id,
        len(written_memories),
        len(extracted),
    )

    return written_memories
