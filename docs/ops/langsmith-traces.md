# Sophia LangSmith Traces

Sophia builder traces write to the EU LangSmith endpoint and the `Sophia`
project. Runtime tracing requires:

```bash
export LANGSMITH_TRACING=true
export SOPHIA_BUILDER_LANGSMITH_TRACING=true
export LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com
export LANGSMITH_PROJECT=Sophia
export LANGSMITH_API_KEY=<langsmith-api-key>
```

Optional values:

```bash
export LANGSMITH_WORKSPACE_ID=<workspace-id>
export LANGSMITH_PROJECT_UUID=<project-uuid>
```

`LANGSMITH_WORKSPACE_ID` is only needed when the API key can access multiple
workspaces. `LANGSMITH_PROJECT_UUID` is useful for code-agent trace readers
because it avoids a project-name lookup.

For local read-only exports, `langsmith-fetch` can pull recent traces:

```bash
langsmith-fetch traces /tmp/sophia-langsmith-traces \
  --limit 10 \
  --include-metadata \
  --include-feedback
```

The upstream `langsmith-fetch` repository is no longer actively maintained, so
treat it as a convenience export helper rather than a production dependency.
