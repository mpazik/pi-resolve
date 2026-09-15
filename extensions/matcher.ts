/**
 * Pure matching patterns and helpers used by pi-resolve to detect references
 * (`@file`, `` !`cmd` ``) and skill envelopes in text.
 *
 * Dependency-free so they can be unit-tested without loading the pi/tui
 * extension surface.
 */

// ---------- regex patterns ----------

/** Matches `@relative/path` but not inside backticks, preceded by word chars, `/` (npm scopes), or quotes (imports).
 *  Supports backslash-escaped characters (e.g., `\ ` for spaces in paths).
 *  Also matches `@~/...` for home directory references.
 *  Excludes quotes, semicolons, and brackets from path characters to avoid matching
 *  import statements, parenthesized expressions, and markdown link syntax. */
export const FILE_REGEX =
  /(?<![\w`/"'])@(~\/(?:[^\s`,.\\"';()[\]{}]|\\.)*(?:\.(?:[^\s`,.\\"';()[\]{}]|\\.)+)*|\.?(?:[^\s`,.\\"';()[\]{}]|\\.)*(?:\.(?:[^\s`,.\\"';()[\]{}]|\\.)+)*)/g;

/** Matches `` !`command` `` but not when `!` is preceded by a backtick (e.g., inline code `!`) */
export const SHELL_REGEX = /(?<!`)!`([^`]+)`/g;

/** Matches a `<skill>` envelope as emitted by the skill-tool extension.
 *  Captures: 1=name, 2=location, 3=baseDir, 4=body, 5=optional trailing args. */
export const SKILL_BLOCK_REGEX =
  /^<skill name="([^"]+)" location="([^"]+)">\nReferences are relative to ([^\n]+)\.\n\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

// ---------- code ranges ----------

/** Build a set of character ranges that fall inside fenced code blocks or inline code spans.
 *  Used to check whether a regex match at a given offset should be skipped. */
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

  offset = start;
  while (offset < end) {
    // Shell syntax takes precedence only outside an already matched code span.
    // Preserve the existing non-empty, single-backtick command grammar.
    if (text[offset] === "!" && text[offset - 1] !== "`" && text[offset + 1] === "`") {
      const close = text.indexOf("`", offset + 2);
      if (close > offset + 2 && close < end) {
        offset = close + 1;
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

/** Check if a character offset falls inside any code range. */
export function isInsideCode(
  offset: number,
  ranges: Array<[number, number]>,
): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

// ---------- path escaping ----------

/** Collapse backslash escapes in an `@file` path: `\<char>` → `<char>`.
 *  Use to convert a regex capture group into the actual filesystem name. */
export function unescapePath(name: string): string {
  return name.replace(/\\(.)/g, "$1");
}

/** True if a name (after unescaping) is a "bare word" with no `/` and no `.`.
 *  Such matches are skipped (decorators, JSDoc tags, CSS @rules, mentions). */
export function isBareWord(name: string): boolean {
  return !name.includes("/") && !name.includes(".");
}

// ---------- ref extraction ----------

/** A `` !`command` `` reference found in text. Carries the offset and full
 *  matched substring so callers can splice the result back in place. */
export interface CommandRef {
  index: number;
  fullMatch: string;
  command: string;
}

/** An `@file` reference found in text, including its source offset. */
export interface FileRef {
  index: number;
  fullMatch: string;
  path: string;
}

/** Extract `@file` references from `text`, in document order.
 *  Skips refs inside code spans/fences, unescapes path characters, and
 *  drops bare words (no `/` and no `.`). */
export function extractFileReferenceMatches(text: string): FileRef[] {
  const ranges = buildCodeRanges(text);
  const out: FileRef[] = [];
  for (const match of text.matchAll(FILE_REGEX)) {
    if (isInsideCode(match.index, ranges)) continue;
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
 *  Skips refs inside code spans/fences. */
export function extractCommandRefs(text: string): CommandRef[] {
  const ranges = buildCodeRanges(text);
  const out: CommandRef[] = [];
  for (const m of text.matchAll(SHELL_REGEX)) {
    // Reject the whole command if any part crosses a code boundary, not just
    // commands whose opening marker is inside code.
    const end = m.index + m[0].length;
    if (ranges.some(([start, stop]) => m.index < stop && end > start)) continue;
    out.push({ index: m.index, fullMatch: m[0], command: m[1]! });
  }
  return out;
}
