/**
 * Splits a stored explanation markdown blob into its two logical parts so
 * the client can render them on separate surfaces:
 *
 *   • `solution`      — the concise worked solution (always present; this is
 *                       what the inline explanation card shows).
 *   • `workedExample` — an OPTIONAL, extended worked example on a different
 *                       set of numbers/framing (this is what the "Worked
 *                       example" sheet shows). `null` when the explanation
 *                       has no example section — the client then hides the
 *                       worked-example affordance entirely.
 *
 * The section markers are ATX headings at line-start, any level (`#`–`######`),
 * case-insensitive. Both the current heading (`## Worked Example`) and the
 * legacy heading (`## Example`, emitted by explanations generated before the
 * worked example became optional) are recognised, so existing rows keep
 * their example section.
 *
 * Pure + no I/O so it can be unit-tested and reused by the serializer.
 */
export interface ExplanationSections {
  solution: string;
  workedExample: string | null;
}

const SOLUTION_HEADING = /^[ \t]*#{1,6}[ \t]+Solution\b.*$/im;
// First "Worked Example" or bare "Example" heading. `Worked Example` is tried
// as part of the same alternation; the \b after keeps "Examples" from a
// paragraph out of the match at line start only.
const EXAMPLE_HEADING =
  /^[ \t]*#{1,6}[ \t]+(?:Worked[ \t]+Example|Example)\b.*$/im;

/** Removes a single leading `## Solution` heading line, if present. */
function stripSolutionHeading(text: string): string {
  return text.replace(SOLUTION_HEADING, '').replace(/^\s*\n/, '');
}

export function splitExplanationSections(
  markdown: string | null | undefined,
): ExplanationSections {
  const text = (markdown ?? '').trim();
  if (!text) return { solution: '', workedExample: null };

  const example = EXAMPLE_HEADING.exec(text);
  if (!example) {
    // No worked-example section — the whole body is the solution.
    return { solution: stripSolutionHeading(text).trim(), workedExample: null };
  }

  const before = text.slice(0, example.index);
  // Everything after the example heading LINE is the worked example body.
  const afterHeading = text.slice(example.index + example[0].length);

  const solution = stripSolutionHeading(before).trim();
  const workedExample = afterHeading.trim();

  return {
    solution,
    // An example heading with no content under it is treated as absent so a
    // stray heading doesn't surface an empty sheet.
    workedExample: workedExample.length > 0 ? workedExample : null,
  };
}
