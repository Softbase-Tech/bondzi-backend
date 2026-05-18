/**
 * Shape of a single worked example attached to a question's explanation.
 *
 * Stored on `questions.explanation_examples` as a JSONB array. Markdown
 * fields are kept as-is on the server (no pre-rendered HTML cached
 * alongside) — mobile + admin clients render the markdown the same
 * way they already render the question body, so a single rendering
 * pipeline handles both. If we ever cache HTML for `explanation` and
 * want parity here, add `promptHtml` / `solutionHtml` as siblings.
 */
export interface WorkedExample {
  /** Optional human label, e.g. "Example 1" or "Alternative method". */
  caption?: string | null;

  /** The example question / scenario. Markdown source. */
  prompt: string;

  /** The worked-out answer. Markdown source. */
  solution: string;

  /**
   * Optional ordered bullets when the solution decomposes into discrete
   * steps. Each entry is a markdown-formatted line.
   */
  steps?: string[] | null;

  /**
   * Optional diagram / figure illustrating the example. Same URL shape
   * as the question's `imageUrl` (CDN public URL).
   */
  imageUrl?: string | null;
}
