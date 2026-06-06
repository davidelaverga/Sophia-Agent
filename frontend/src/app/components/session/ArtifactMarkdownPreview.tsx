"use client"

import type { ReactNode } from "react"

import { parseInlineMarkdown } from "../../lib/parse-inline-markdown"
import { cn } from "../../lib/utils"

type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "code"; text: string }
  | { type: "rule" }

interface ArtifactMarkdownPreviewProps {
  markdown: string
  className?: string
}

export function ArtifactMarkdownPreview({
  markdown,
  className,
}: ArtifactMarkdownPreviewProps) {
  const blocks = parseMarkdownBlocks(markdown)

  return (
    <article
      className={cn(
        "artifact-markdown-preview text-[color:var(--cosmic-text)]",
        className,
      )}
      aria-label="Markdown artifact preview"
    >
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </article>
  )
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const blocks: MarkdownBlock[] = []
  let paragraphLines: string[] = []
  let codeLines: string[] = []
  let inCodeFence = false

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return
    blocks.push({
      type: "paragraph",
      text: paragraphLines.join(" ").replace(/\s+/g, " ").trim(),
    })
    paragraphLines = []
  }

  const flushList = (
    startIndex: number,
    matcher: RegExp,
    type: "ordered-list" | "unordered-list",
  ): number => {
    const items: string[] = []
    let cursor = startIndex
    while (cursor < lines.length) {
      const match = lines[cursor].match(matcher)
      if (!match) break
      items.push(match[1].trim())
      cursor += 1
    }
    blocks.push({ type, items })
    return cursor - 1
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (trimmed.startsWith("```")) {
      if (inCodeFence) {
        blocks.push({ type: "code", text: codeLines.join("\n") })
        codeLines = []
        inCodeFence = false
      } else {
        flushParagraph()
        inCodeFence = true
      }
      continue
    }

    if (inCodeFence) {
      codeLines.push(line)
      continue
    }

    if (!trimmed) {
      flushParagraph()
      continue
    }

    if (/^([-*_])\1{2,}$/u.test(trimmed)) {
      flushParagraph()
      blocks.push({ type: "rule" })
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/u)
    if (heading) {
      flushParagraph()
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      })
      continue
    }

    if (/^[-*+]\s+/u.test(trimmed)) {
      flushParagraph()
      index = flushList(index, /^[-*+]\s+(.+)$/u, "unordered-list")
      continue
    }

    if (/^\d+[.)]\s+/u.test(trimmed)) {
      flushParagraph()
      index = flushList(index, /^\d+[.)]\s+(.+)$/u, "ordered-list")
      continue
    }

    paragraphLines.push(trimmed)
  }

  if (inCodeFence && codeLines.length > 0) {
    blocks.push({ type: "code", text: codeLines.join("\n") })
  }
  flushParagraph()

  return blocks.length > 0 ? blocks : [{ type: "paragraph", text: "This markdown artifact is ready." }]
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactNode {
  switch (block.type) {
    case "heading":
      return renderHeading(block.level, block.text, index)
    case "paragraph":
      return (
        <p key={index} className="mt-4 text-[15px] leading-[1.75] text-[color:var(--cosmic-text)] first:mt-0">
          {parseInlineMarkdown(block.text)}
        </p>
      )
    case "unordered-list":
      return (
        <ul key={index} className="mt-4 space-y-2 pl-5 text-[15px] leading-[1.65] text-[color:var(--cosmic-text)]">
          {block.items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`} className="list-disc marker:text-[color:var(--cosmic-teal)]">
              {parseInlineMarkdown(item)}
            </li>
          ))}
        </ul>
      )
    case "ordered-list":
      return (
        <ol key={index} className="mt-4 space-y-2 pl-5 text-[15px] leading-[1.65] text-[color:var(--cosmic-text)]">
          {block.items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`} className="list-decimal marker:text-[color:var(--cosmic-teal)]">
              {parseInlineMarkdown(item)}
            </li>
          ))}
        </ol>
      )
    case "code":
      return (
        <pre
          key={index}
          className="mt-5 overflow-x-auto rounded-lg border border-[color:var(--cosmic-border-soft)] bg-[color:var(--cosmic-panel-strong)] p-4 text-xs leading-relaxed text-[color:var(--cosmic-text)]"
        >
          <code>{block.text}</code>
        </pre>
      )
    case "rule":
      return <hr key={index} className="my-6 border-[color:var(--cosmic-border-soft)]" />
  }
}

function renderHeading(level: 1 | 2 | 3, text: string, key: number): ReactNode {
  if (level === 1) {
    return (
      <h1 key={key} className="font-cormorant text-[34px] font-light leading-[1.08] text-[color:var(--cosmic-text-strong)]">
        {parseInlineMarkdown(text)}
      </h1>
    )
  }

  if (level === 2) {
    return (
      <h2 key={key} className="mt-8 border-t border-[color:var(--cosmic-border-soft)] pt-5 text-[18px] font-semibold leading-tight text-[color:var(--cosmic-text-strong)] first:mt-0 first:border-t-0 first:pt-0">
        {parseInlineMarkdown(text)}
      </h2>
    )
  }

  return (
    <h3 key={key} className="mt-6 text-[15px] font-semibold uppercase tracking-[0.08em] text-[color:var(--cosmic-text-muted)]">
      {parseInlineMarkdown(text)}
    </h3>
  )
}
