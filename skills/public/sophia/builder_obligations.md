# Builder Obligations

This file is for the Sophia builder only.

## Output Contract

- Write every user-facing deliverable and supporting file under
  `/mnt/user-data/outputs/`.
- Use absolute virtual paths such as `/mnt/user-data/outputs/report.html`.
  Never use relative output paths in `emit_builder_artifact`.
- Finish with `emit_builder_artifact` as the final tool call. Everything after
  it is ignored.
- Populate `artifact_path`, `artifact_title`, `artifact_type`, and
  `companion_summary` on every successful or fallback-successful run.
- Add `companion_tone_hint`, `user_next_action`, `confidence`, and
  `sources_used` when relevant.
- The final artifact path must point to the actual user-facing deliverable:
  PDF, PPTX, HTML, Markdown, image, spreadsheet, or verified fallback. It must
  never point to a generator script, test file, tiny placeholder, or missing
  file.

## Terminal Artifact Handoff

When the task carries an explicit artifact target path (a known
`/mnt/user-data/outputs/...` file), the build is a deliverable task, not a
research/answer task.

- You may research first. Research is encouraged when the deliverable needs
  facts.
- Research, planning, todos, and written summaries are not the deliverable.
  They do not complete the task on their own.
- The task is incomplete until the target file is actually written under
  `/mnt/user-data/outputs/` and `emit_builder_artifact` has been called for it.
- Required terminal sequence after any research/planning: (1) write the
  requested artifact file to the target path; (2) verify the file exists; (3)
  call `emit_builder_artifact` exactly once with the real `artifact_path`.
- The final action must be `emit_builder_artifact`, never a plain-text
  response. A plain-text ending with no emit is a failed build with no
  deliverable.
- For an HTML target: write a standalone `.html` document. Do not wrap it in
  Markdown code fences. Do not write a `.md` file and call it HTML. Emit with
  `artifact_type="html"` (or `"webpage"`).
- For a Markdown target: write a real `.md` file. Emit with
  `artifact_type="document"`.
- If you genuinely cannot create the artifact, do not pretend success and do
  not end with plain text. Emit with a specific, safe `fallback_reason` (or
  accept the force-stop fallback) so the failure is reported honestly.

## Web Research

Web research is available for every builder task type, including `frontend`.
You may call `write_todos` first for planning and progress UI. You may use
safe inspection tools such as `ls`, `read_file`, and read-only shell commands
before browsing.

For fresh builds, before the first substantive write/edit/emit step, attempt
at least one `builder_web_search` or `builder_web_fetch`. Substantive artifact
creation includes `write_file`, `str_replace`, artifact-generating `bash`, and
`emit_builder_artifact`.

If `builder_web_search` returns useful factual URLs, fetch at least one
approved result with `builder_web_fetch` before final source writing. Failed,
empty, or weak web-tool attempts still satisfy the gate; continue the build
with the best available context rather than failing only because browsing was
weak.

## Edit Existing Artifact Mode

When `delegation_context.edit_context.mode == "edit_existing_artifact"`, the
runtime has copied the source artifact into
`/mnt/user-data/workspace/source_artifact/`.

- Read the materialized source artifact before writing or emitting.
- Preserve unrelated content. Make the requested local change, not a broad
  rewrite, unless the user explicitly asks for a rewrite.
- Write a versioned revised artifact under `/mnt/user-data/outputs/`; do not
  overwrite the source artifact.
- Pure local edits do not require web research.
- If the edit introduces a new URL, named project, paper, framework, company,
  market, factual topic, or source requirement, search/fetch that new material
  before changing the deliverable.

For mid-build updates, reuse prior research, but if the update introduces a
new URL, named project, paper, framework, company, market, factual topic, or
source requirement, search or fetch that new material before editing the
deliverable.

## Fallback Truth

- A fallback can be a successful user-facing artifact only when a usable file
  exists and fallback metadata is explicit.
- For requested slide decks, normal success requires a structurally valid
  `.pptx`. HTML or Markdown may be emitted only as degraded fallback with
  `requested_artifact_ext="pptx"`, `artifact_is_fallback=true`, and a safe
  `fallback_reason`. If a valid `.pptx` exists, it wins over any fallback.
- For requested PDFs, normal success requires a real `.pdf`. Markdown or HTML
  fallback is allowed only when rendering failed, was unavailable, or produced
  an unusable PDF after the bounded repair. PDF fallback must use
  `requested_artifact_ext="pdf"`, `artifact_is_fallback=true`, and a safe
  `fallback_reason`. If a valid `.pdf` exists, it wins over any fallback.
- If a required capability is missing, stop cleanly. Do not loop on the same
  failing command. Emit the best verified fallback if one exists; otherwise
  surface a failed terminal artifact with a clear safe reason.

## Turn Budget

Respect the hard turn and wall-clock caps. When the deliverable exists, emit it
immediately. Do not keep replanning or rerendering after a valid target file is
available unless the harness explicitly asks for one bounded repair.
