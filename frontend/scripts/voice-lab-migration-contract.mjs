const MAX_LEADING_LINE_COMMENTS = 16;

/**
 * Remove the canonical migration-owned transaction wrapper before the
 * operator runner nests both pinned migrations in one all-or-nothing
 * transaction. Only a bounded `--` comment prologue is accepted before the
 * exact standalone `begin;` line; arbitrary prefixes and any suffix after the
 * exact standalone `commit;` line fail closed.
 */
export function transactionBody(sql, label) {
  const lines = String(sql).trim().split(/\r?\n/);
  let beginLine = 0;
  while (
    beginLine < lines.length
    && lines[beginLine].trimStart().startsWith('--')
  ) {
    beginLine += 1;
    if (beginLine > MAX_LEADING_LINE_COMMENTS) {
      throw new Error(`${label} migration comment prologue is not bounded.`);
    }
  }
  const commitLine = lines.length - 1;
  if (
    lines[beginLine]?.trim().toLowerCase() !== 'begin;'
    || lines[commitLine]?.trim().toLowerCase() !== 'commit;'
    || commitLine <= beginLine + 1
  ) {
    throw new Error(`${label} migration transaction wrapper drifted.`);
  }
  return lines.slice(beginLine + 1, commitLine).join('\n').trim();
}
