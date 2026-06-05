# Research Workflow Card

Use this card whenever web research is enabled.

- Web research is available for every builder task type, including frontend builds.
- Turn 1 may be `write_todos` for planning and UI progress.
- After planning, before any substantive write/edit/emit step, attempt
  `builder_web_search` or `builder_web_fetch` at least once.
- Substantive steps include write_file, str_replace, artifact-generating bash,
  and emit_builder_artifact.
- If search returns useful factual URLs, fetch at least one approved result URL
  with `builder_web_fetch` before final source writing.
- Safe inspection tools such as `ls`, `read_file`, and read-only `bash`
  commands may run before research.
- If web tools fail or return weak results, continue the task using the best
  available context instead of stopping.
- If external sources inform the artifact, include a concise Sources appendix
  and set `emit_builder_artifact.sources_used` to structured `{title, url}`
  entries for the sources actually used.
