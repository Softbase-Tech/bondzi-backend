import {
  STUDENT_CITATION_RULES,
  STUDENT_DATA_RULES,
  STUDENT_JSON_ENVELOPE,
  STUDENT_TONE_RULES,
} from '../ai/instruction-layer/student-facing.shell';
import {
  type EnvelopeContext,
  validateNarrativeEnvelope,
} from '../ai/validation/narrative-envelope.validator';
import type { StudentSignal } from './student-signal.service';

export { validateNarrativeEnvelope };
export type { EnvelopeContext };

/** Recorded on ai_usage_log.prompt_version. */
export const WEAKNESS_NARRATIVE_PROMPT_VERSION = 'weakness-v2';

/**
 * Weakness Detector v2 (premium plan §6.3). Composed from the shared
 * student-facing shell blocks so it inherits the injection guard,
 * tone contract, and citation-required rule. Output is the shared
 * JSON envelope: prose narrative + tappable recommendations, gated by
 * `narrative-envelope.validator` before persist.
 */
export const SYSTEM_SHELL_WEAKNESS_NARRATIVE = [
  `You write short, personalised study-progress narratives for Ghanaian
secondary-school students preparing for WASSCE/BECE, based on their
recent practice data.`,
  STUDENT_DATA_RULES,
  STUDENT_TONE_RULES,
  STUDENT_CITATION_RULES,
  `Narrative rules:
- 3–5 sentences of plain prose (no markdown, headings, or bullets).
- Reference at least two topics from the data by name.
- If the data shows a strength, acknowledge one — motivation matters —
  but spend most of the narrative on what to fix and how.
- End the narrative by pointing at the FIRST recommendation ("Start
  with…") so prose and buttons agree.`,
  STUDENT_JSON_ENVELOPE,
].join('\n\n');

export function buildWeaknessNarrativePrompt(renderedSignal: string): string {
  return `${renderedSignal}

Write the narrative + recommendations JSON for this student. Include
1–3 recommendations: a "read" action for each weak topic that has an
entry in the recommended-reading list, and a "practice" action
(count 5–15) for weak topics without reading material.`;
}

/** Build the validator's grounding context from a StudentSignal. */
export function envelopeContextFromSignal(
  signal: StudentSignal,
): EnvelopeContext {
  return {
    requiredTitles: [
      ...signal.weakTopics.map((t) => t.title),
      ...signal.weakPastPaperTopics.map((t) => t.title),
    ],
    validTopicIds: [
      ...signal.weakTopics.map((t) => t.syllabusTopicId),
      ...signal.weakPastPaperTopics.map((t) => t.topicId),
      ...signal.strongTopics.map((t) => t.syllabusTopicId),
    ],
    validChunkIds: signal.remediation.flatMap((r) => r.chunks.map((c) => c.id)),
  };
}
