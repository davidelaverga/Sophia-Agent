# LangSmith Trace Access

Sophia builder traces land in the EU LangSmith project named `Sophia`.

Required runtime configuration:

```bash
LANGSMITH_TRACING=false
SOPHIA_BUILDER_LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com
LANGSMITH_WORKSPACE_ID=<workspace-id>
LANGSMITH_PROJECT=Sophia
LANGSMITH_API_KEY=<runtime-key>
```

Optional, useful when exporting by project UUID:

```bash
LANGSMITH_PROJECT_UUID=<project-uuid>
```

For read-only code-agent access, register a LangSmith MCP server such as
`langchain-ai/langsmith-mcp-server` with a read-only API key and the same endpoint/project
configuration. The expected tool flow is:

1. `ls_list_runs` filtered to project `Sophia`, recent builder tags, or a `thread_id`.
2. `ls_read_run` for the root run and important child runs.
3. Cross-reference run metadata with Render/Vercel logs using `thread_id`, `task_id`, and `run_id`.

Local helper fallback:

```bash
LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com \
LANGSMITH_WORKSPACE_ID=<workspace-id> \
LANGSMITH_PROJECT=Sophia \
LANGSMITH_API_KEY=<read-only-key> \
langsmith-fetch traces --include-metadata --include-feedback
```

`langsmith-fetch` is deprecated upstream, but it is still useful as a read-only export helper
when MCP tooling is not available. Never commit API keys or signed artifact URLs.
