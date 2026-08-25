/**
 * Escaping block and section markers that appear inside content.
 *
 * A .chat.md document is structured entirely by its `# %%` marker lines, so
 * content that happens to contain one tears the document apart: the block splits
 * in the wrong place, a `<tool_result>` wrapper loses its other half, and turns
 * that never happened appear in the history. That is not hypothetical — it is
 * what happens the moment a chat reads or writes another chat through a tool.
 *
 * So anything written *into* a document gains a percent sign, and anything read
 * back *out* of a block body loses one:
 *
 *     # %% user      written as   # %%% user
 *     # %%% user     written as   # %%%% user
 *
 * Escaping the whole ladder rather than just the two-percent form is what makes
 * it reversible. If only `%%` were escaped, content that already contained
 * `# %%% user` would pass through untouched and then *become* a real marker when
 * it was unescaped.
 *
 * `unescapeMarkers(escapeMarkers(text)) === text` holds for any text. The reverse
 * deliberately does not: a bare `# %% user` in a document is a real marker, and
 * reading a block body must never turn one into content.
 *
 * This must stay byte-for-byte identical to chatmd/markers.py — a document
 * written by one engine has to be readable by the other. The shared vectors in
 * python/tests/marker_vectors.json pin both.
 */

/** Roles that open a top-level block. */
export const BLOCK_ROLES = [
  "user",
  "assistant",
  "system",
  "tool_execute",
  "settings",
] as const;

/** Roles that open a section inside an assistant block. */
export const SECTION_ROLES = ["thinking", "text"] as const;

// Trailing whitespace is limited to spaces, tabs and a carriage return so these
// match exactly the *lines* the parser treats as markers. The parser's own regex
// ends in `\s*$`, which also swallows following newlines, but that affects where
// its match ends, not which lines count.
const TRAILING = "([ \\t\\r]*)$";

function pattern(hashes: string, roles: readonly string[], percents: string): RegExp {
  return new RegExp(`^${hashes} ${percents} (${roles.join("|")})${TRAILING}`, "gim");
}

/** Two or more percent signs: a marker, or something already escaped. */
const blockEscapable = (): RegExp => pattern("#", BLOCK_ROLES, "(%{2,})");
const sectionEscapable = (): RegExp => pattern("##", SECTION_ROLES, "(%{2,})");

/** Three or more: something that was escaped on the way in. */
const blockEscaped = (): RegExp => pattern("#", BLOCK_ROLES, "%(%{2,})");
const sectionEscaped = (): RegExp => pattern("##", SECTION_ROLES, "%(%{2,})");

// Exactly two percent signs: the character after `%%` must be a space, so these
// match precisely the lines the parser turns into blocks — no more.
const blockMarker = (): RegExp => pattern("#", BLOCK_ROLES, "%%");
const sectionMarker = (): RegExp => pattern("##", SECTION_ROLES, "%%");

/**
 * Makes marker-shaped lines safe to write into a document.
 *
 * Applied to everything the extension writes: streamed assistant text, tool
 * results, and anything appended on the user's behalf.
 */
export function escapeMarkers(text: string): string {
  const withBlocks = text.replace(
    blockEscapable(),
    (_match, percents: string, role: string, trailing: string) =>
      `# %${percents} ${role}${trailing}`,
  );
  return withBlocks.replace(
    sectionEscapable(),
    (_match, percents: string, role: string, trailing: string) =>
      `## %${percents} ${role}${trailing}`,
  );
}

/**
 * Restores marker-shaped lines when reading a block body back out.
 *
 * Only ever applied to content *inside* a block, never to a whole document: the
 * document's own markers carry two percent signs and must stay markers.
 */
export function unescapeMarkers(text: string): string {
  const withBlocks = text.replace(
    blockEscaped(),
    (_match, percents: string, role: string, trailing: string) =>
      `# ${percents} ${role}${trailing}`,
  );
  return withBlocks.replace(
    sectionEscaped(),
    (_match, percents: string, role: string, trailing: string) =>
      `## ${percents} ${role}${trailing}`,
  );
}

/**
 * Whether `text` holds a line the parser would read as a marker.
 *
 * Strictly two percent signs: an already-escaped `# %%% user` is content, and
 * reporting it here would mean escaped text still looked dangerous.
 */
export function containsMarkerLine(text: string): boolean {
  return blockMarker().test(text) || sectionMarker().test(text);
}
