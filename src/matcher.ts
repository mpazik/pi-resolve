/** Matches `@relative/path` unless preceded by word chars, backticks, `/` (npm scopes), or quotes (imports).
 *  Supports backslash-escaped characters (e.g., `\ ` for spaces in paths).
 *  Also matches `@~/...` for home directory references.
 *  Excludes quotes, semicolons, and brackets from path characters to avoid matching
 *  import statements, parenthesized expressions, and markdown link syntax. */
export const FILE_REGEX =
  /(?<![\w`/"'])@(~\/(?:[^\s`,.\\"';()[\]{}]|\\.)*(?:\.(?:[^\s`,.\\"';()[\]{}]|\\.)+)*|\.?(?:[^\s`,.\\"';()[\]{}]|\\.)*(?:\.(?:[^\s`,.\\"';()[\]{}]|\\.)+)*)/g;

/** Matches non-empty shell candidates, preserving escapes verbatim.
 *  Backslashes pair with the next character, so only an even-backslash backtick
 *  closes the command. Marker escape parity is checked before resolution. */
export const SHELL_REGEX = /(?<!`)!`((?:[^`\\]|\\[\s\S])+)`/g;

/** An odd run of backslashes immediately before a reference marker escapes it. */
function isBackslashEscaped(text: string, offset: number): boolean {
  let start = offset;
  while (start > 0 && text[start - 1] === "\\") start--;
  return (offset - start) % 2 === 1;
}

/** Matches a `<skill>` envelope as emitted by the skill-tool extension.
 *  Captures: 1=name, 2=location, 3=baseDir, 4=body, 5=optional trailing args. */
export const SKILL_BLOCK_REGEX =
  /^<skill name="([^"]+)" location="([^"]+)">\nReferences are relative to ([^\n]+)\.\n\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** Fenced blocks and inline spans, excluding shell reference delimiters. */
export function buildCodeRanges(
  text: string,
): Array<[start: number, end: number]> {
  const ranges: Array<[number, number]> = [];
  let fence: { start: number; marker: string; length: number } | undefined;
  let proseStart = 0;
  let lineStart = 0;

  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    const line = text.slice(lineStart, newline === -1 ? lineEnd : newline)
      .replace(/\r$/, "");
    // Only the line prefix needs a pattern. Fence pairing is stateful.
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      const rest = delimiter[2]!;
      if (fence) {
        if (run[0] === fence.marker && run.length >= fence.length && /^[ \t]*$/.test(rest)) {
          ranges.push([fence.start, lineEnd]);
          fence = undefined;
          proseStart = lineEnd;
        }
      } else if (run[0] === "~" || !rest.includes("`")) {
        appendInlineCodeRanges(text, proseStart, lineStart, ranges);
        fence = { start: lineStart, marker: run[0]!, length: run.length };
      }
    }
    lineStart = lineEnd;
  }

  if (fence) ranges.push([fence.start, text.length]);
  else appendInlineCodeRanges(text, proseStart, text.length, ranges);
  return ranges;
}

/** Scan one prose region. Backtick runs pair only with runs of equal length.
 *  Index runs first so unmatched delimiters do not cause repeated suffix scans. */
function appendInlineCodeRanges(
  text: string,
  start: number,
  end: number,
  ranges: Array<[number, number]>,
): void {
  const runs = new Map<number, { positions: number[]; cursor: number }>();
  let offset = start;
  while (offset < end) {
    if (text[offset] !== "`") {
      offset++;
      continue;
    }
    const runStart = offset;
    while (offset < end && text[offset] === "`") offset++;
    const length = offset - runStart;
    const entry = runs.get(length);
    if (entry) entry.positions.push(runStart);
    else runs.set(length, { positions: [runStart], cursor: 0 });
  }

  // Use the extraction grammar at the current offset, never a separate closer rule.
  const shell = new RegExp(SHELL_REGEX.source, "y");
  offset = start;
  while (offset < end) {
    // Shell syntax takes precedence only outside an already matched code span.
    if (text[offset] === "!" && !isBackslashEscaped(text, offset)) {
      shell.lastIndex = offset;
      if (shell.exec(text) && shell.lastIndex <= end) {
        offset = shell.lastIndex;
        continue;
      }
    }
    if (text[offset] !== "`") {
      offset++;
      continue;
    }
    const runStart = offset;
    while (offset < end && text[offset] === "`") offset++;
    const length = offset - runStart;
    const entry = runs.get(length);
    if (!entry) continue;
    while (entry.cursor < entry.positions.length && entry.positions[entry.cursor]! < offset) {
      entry.cursor++;
    }
    const close = entry.positions[entry.cursor];
    if (close !== undefined) {
      ranges.push([runStart, close + length]);
      offset = close + length;
    }
  }
}

export function isInsideCode(
  offset: number,
  ranges: Array<[number, number]>,
): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

/** Collapse backslash escapes in an `@file` path: `\<char>` → `<char>`. */
export function unescapePath(name: string): string {
  return name.replace(/\\(.)/g, "$1");
}

/** True if a name (after unescaping) is a "bare word" with no `/` and no `.`.
 *  Such matches are skipped (decorators, JSDoc tags, CSS @rules, mentions). */
export function isBareWord(name: string): boolean {
  return !name.includes("/") && !name.includes(".");
}

export interface CommandRef {
  index: number;
  fullMatch: string;
  command: string;
}

export interface FileRef {
  index: number;
  fullMatch: string;
  path: string;
}

/** Extract `@file` references from `text`, in document order.
 *  Skips escaped markers and refs inside code spans/fences, unescapes path characters, and
 *  drops bare words (no `/` and no `.`). */
export function extractFileReferenceMatches(text: string): FileRef[] {
  const ranges = buildCodeRanges(text);
  const out: FileRef[] = [];
  for (const match of text.matchAll(FILE_REGEX)) {
    if (isBackslashEscaped(text, match.index) || isInsideCode(match.index, ranges)) continue;
    const path = unescapePath(match[1]!);
    if (isBareWord(path)) continue;
    out.push({ index: match.index, fullMatch: match[0], path });
  }
  return out;
}

export function extractFileRefs(text: string): string[] {
  return extractFileReferenceMatches(text).map((reference) => reference.path);
}

/** Extract `` !`command` `` references from `text`, in document order.
 *  Skips escaped markers and refs inside code spans/fences. */
export function extractCommandRefs(text: string): CommandRef[] {
  const ranges = buildCodeRanges(text);
  const out: CommandRef[] = [];
  const shell = new RegExp(SHELL_REGEX.source, "y");
  for (let index = text.indexOf("!"); index !== -1; index = text.indexOf("!", index + 1)) {
    // Skip suppressed openers before matching so their apparent commands cannot
    // consume later references. Code spans do not use shell escape rules.
    if (isBackslashEscaped(text, index) || isInsideCode(index, ranges)) continue;
    shell.lastIndex = index;
    const match = shell.exec(text);
    if (!match) continue;
    // Reject the whole command if any part crosses a code boundary, not just
    // commands whose opening marker is inside code.
    const end = shell.lastIndex;
    if (ranges.some(([start, stop]) => index < stop && end > start)) continue;
    out.push({ index, fullMatch: match[0], command: match[1]! });
    index = end - 1;
  }
  return out;
}

type ReferenceCandidate =
  | (FileRef & { kind: "file" })
  | (CommandRef & { kind: "command" });

export function referenceCandidates(text: string, fileText = text): ReferenceCandidate[] {
  return [
    ...extractFileReferenceMatches(fileText).map((reference) => ({ kind: "file" as const, ...reference })),
    ...extractCommandRefs(text).map((reference) => ({ kind: "command" as const, ...reference })),
  ].sort((left, right) => left.index - right.index);
}

/** Expansion may duplicate arguments. Without a source map, identical expanded
 * references conservatively retain direct-input policy, including disabled refs. */
export function maskDirectReferences(text: string, input: string, kind?: "file" | "command"): string {
  const key = (candidate: ReferenceCandidate) =>
    candidate.kind === "file" ? `file:${candidate.path}` : `command:${candidate.command}`;
  const captured = new Set(referenceCandidates(input)
    .filter((candidate) => !kind || candidate.kind === kind).map(key));
  const consumed = referenceCandidates(text).filter((candidate) => captured.has(key(candidate)));
  for (const match of consumed.reverse()) {
    // Preserve argument positions for subsequent skill $N substitution.
    const mask = match.fullMatch.replace(/\S/g, "_");
    text = text.slice(0, match.index) + mask + text.slice(match.index + match.fullMatch.length);
  }
  return text;
}
