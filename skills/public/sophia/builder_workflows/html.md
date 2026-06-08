# HTML Workflow Card

Use this card for requested `.html` files and for HTML fallback artifacts.

- Write a standalone browser-renderable document under `/mnt/user-data/outputs/`.
- Include `<!doctype html>`, `<html>`, `<head>`, and `<body>`.
- Keep CSS embedded unless the user explicitly requested multiple files.
- Do not wrap HTML in Markdown fences.
- Do not HTML-escape the document as text (`&lt;html` is invalid for delivery).
- For chart/diagram/visual requests, read
  `/mnt/skills/public/visual-design/SKILL.md`, then create inline SVG/CSS/HTML
  diagrams or embed local visual assets from `/mnt/user-data/outputs/visuals/`.
- Emit the `.html` file only after it exists and can be rendered by a browser.

When HTML is a fallback for a requested `.pptx` or `.pdf`, mark it explicitly
with fallback metadata and explain the degraded format in `companion_summary`.
