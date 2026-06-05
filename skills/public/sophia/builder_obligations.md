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

## Web Research

Web research is available for every builder task type, including `frontend`.
You may call `write_todos` first for planning and progress UI. You may use
safe inspection tools such as `ls`, `read_file`, and read-only shell commands
before browsing.

Before the first substantive write/edit/emit step, attempt at least one
`builder_web_search` or `builder_web_fetch`. Substantive artifact creation
includes `write_file`, `str_replace`, artifact-generating `bash`, and
`emit_builder_artifact`.

If `builder_web_search` returns useful factual URLs, fetch at least one
approved result with `builder_web_fetch` before final source writing. Failed,
empty, or weak web-tool attempts still satisfy the gate; continue the build
with the best available context rather than failing only because browsing was
weak.

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
  `fallback_reason`.
- For requested PDFs, normal success requires a real `.pdf`. Markdown or HTML
  fallback is allowed only when rendering failed or was unavailable.
- If a required capability is missing, stop cleanly. Do not loop on the same
  failing command. Emit the best verified fallback if one exists; otherwise
  surface a failed terminal artifact with a clear safe reason.

## Turn Budget

Respect the hard turn and wall-clock caps. When the deliverable exists, emit it
immediately. Do not keep replanning or rerendering after a valid target file is
available unless the harness explicitly asks for one bounded repair.
