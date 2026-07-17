from __future__ import annotations

import os

_BASE_ENV_KEYS = frozenset(
    {
        "CHROME_PATH",
        "COMSPEC",
        "FONTCONFIG_FILE",
        "FONTCONFIG_PATH",
        "HOME",
        "LANG",
        "LC_ADDRESS",
        "LC_ALL",
        "LC_COLLATE",
        "LC_CTYPE",
        "LC_IDENTIFICATION",
        "LC_MEASUREMENT",
        "LC_MESSAGES",
        "LC_MONETARY",
        "LC_NAME",
        "LC_NUMERIC",
        "LC_PAPER",
        "LC_TELEPHONE",
        "LC_TIME",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
        "NO_PROXY",
        "NPM_CONFIG_CACHE",
        "PATH",
        "PATHEXT",
        "PLAYWRIGHT_BROWSERS_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "REQUESTS_CA_BUNDLE",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "SOPHIA_CHROMIUM_PATH",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "TZ",
        "UV_CACHE_DIR",
        "VIRTUAL_ENV",
        "WINDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_RUNTIME_DIR",
    }
)

_OPENAI_ENV_KEYS = frozenset(
    {
        # Existing builder visual authority only. The DQ-only credential has a
        # different name and is intentionally never admitted here.
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_ORGANIZATION",
        "OPENAI_PROJECT",
        "SOPHIA_IMAGE_GEN_CONCURRENCY",
        "SOPHIA_IMAGE_GEN_MAX_RETRIES",
        "SOPHIA_IMAGE_GEN_TIMEOUT",
        "SOPHIA_IMAGE_GENERATION_DEBUG_PROMPT",
        # Preserve operator-configured outbound routing for the fixed trusted
        # image generator without exposing it to user-authored LocalSandbox.
        "ALL_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
    }
)

_LANGSMITH_ENV_KEYS = frozenset(
    {
        "LANGCHAIN_API_KEY",
        "LANGCHAIN_ENDPOINT",
        "LANGCHAIN_PROJECT",
        "LANGCHAIN_TRACING",
        "LANGCHAIN_TRACING_V2",
        "LANGSMITH_API_KEY",
        "LANGSMITH_ENDPOINT",
        "LANGSMITH_PROJECT",
        "LANGSMITH_TRACING",
        "LANGSMITH_WORKSPACE_ID",
        "SOPHIA_BUILDER_LANGSMITH_TRACING",
    }
)


def trusted_subprocess_env(
    *,
    allow_openai: bool = False,
    allow_langsmith: bool = False,
) -> dict[str, str]:
    """Return the least-authority environment for fixed trusted binaries.

    Render injects all service credentials into the LangGraph parent. Native
    renderers, office converters, and fixed image-generation scripts do not
    need DQ admission, Supabase service-role, HMAC, database, or companion
    provider authority. Starting from an allowlist prevents future secrets
    from silently crossing the subprocess boundary.
    """

    allowed = set(_BASE_ENV_KEYS)
    if allow_openai:
        allowed.update(_OPENAI_ENV_KEYS)
    if allow_langsmith:
        allowed.update(_LANGSMITH_ENV_KEYS)

    return {
        key: value
        for key, value in os.environ.items()
        if key in allowed
    }
