/**
 * Shared validator for the student-facing JSON envelope
 * (`STUDENT_JSON_ENVELOPE` in instruction-layer/student-facing.shell):
 * prose narrative + machine-readable recommendations. Two consumers —
 * the weakness narrative (§6.3) and the post-exam review (§6.5) —
 * validate against a grounding context built from their own signal.
 *
 * Enforced:
 *   • parseable envelope with a non-trivial narrative (120–900 chars)
 *   • no markdown headings/bullets in the narrative
 *   • ≥ min(2, available) required topic titles named verbatim
 *   • every "read" chunkId exists in the supplied reading list —
 *     no invented reading
 *   • every topic id cited exists in the context
 */

export interface NarrativeWithRecommendations {
  narrative: string;
  recommendations: Array<{
    syllabusTopicId: string;
    action: 'read' | 'practice';
    chunkId?: string;
    label?: string;
    count?: number;
  }>;
}

/**
 * Grounding context the envelope is validated against. Built from a
 * StudentSignal (weakness narrative) or from an exam's per-topic
 * tallies (post-exam review) — one validator, two consumers (§6.6).
 */
export interface EnvelopeContext {
  /** Topic titles the narrative must name (≥ min(2, length) of them). */
  requiredTitles: string[];
  /** Every topic id a recommendation may cite. */
  validTopicIds: string[];
  /** Every chunk id a "read" recommendation may cite. */
  validChunkIds: string[];
}

export function validateNarrativeEnvelope(
  rawText: string,
  ctx: EnvelopeContext,
):
  | { ok: true; value: NarrativeWithRecommendations }
  | { ok: false; reason: string; detail: string } {
  const trimmed = rawText
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      reason: 'narrative_schema_invalid',
      detail: `not valid JSON: ${trimmed.slice(0, 120)}`,
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj?.error === 'string' && obj.error) {
    return {
      ok: false,
      reason: 'model_refused',
      detail: typeof obj.detail === 'string' ? obj.detail : obj.error,
    };
  }
  const narrative =
    typeof obj?.narrative === 'string' ? obj.narrative.trim() : '';
  if (narrative.length < 120 || narrative.length > 900) {
    return {
      ok: false,
      reason: 'narrative_length',
      detail: `narrative is ${narrative.length} chars (want 120–900)`,
    };
  }
  if (/^#{1,6}\s|\n#{1,6}\s|^\s*[-*]\s/m.test(narrative)) {
    return {
      ok: false,
      reason: 'narrative_markdown',
      detail: 'narrative contains markdown headings/bullets',
    };
  }

  const named = ctx.requiredTitles.filter((t) =>
    narrative.toLowerCase().includes(t.toLowerCase()),
  );
  const minNamed = Math.min(2, ctx.requiredTitles.length);
  if (named.length < minNamed) {
    return {
      ok: false,
      reason: 'narrative_topics_missing',
      detail: `narrative names ${named.length}/${minNamed} required topics (${ctx.requiredTitles.slice(0, 5).join(' | ')})`,
    };
  }

  const validTopicIds = new Set(ctx.validTopicIds);
  const validChunkIds = new Set(ctx.validChunkIds);
  const rawRecs = Array.isArray(obj?.recommendations)
    ? (obj.recommendations as Array<Record<string, unknown>>)
    : [];
  const recommendations: NarrativeWithRecommendations['recommendations'] = [];
  for (const r of rawRecs.slice(0, 4)) {
    const action = r?.action;
    const topicId =
      typeof r?.syllabusTopicId === 'string' ? r.syllabusTopicId : '';
    if (action !== 'read' && action !== 'practice') continue;
    if (!validTopicIds.has(topicId)) {
      return {
        ok: false,
        reason: 'recommendation_unknown_topic',
        detail: `recommendation cites topic "${topicId}" not present in the signal`,
      };
    }
    if (action === 'read') {
      const chunkId = typeof r.chunkId === 'string' ? r.chunkId : '';
      if (!validChunkIds.has(chunkId)) {
        return {
          ok: false,
          reason: 'recommendation_invented_reading',
          detail: `read recommendation cites chunkId "${chunkId}" not in the supplied reading list`,
        };
      }
      recommendations.push({
        syllabusTopicId: topicId,
        action,
        chunkId,
        label: typeof r.label === 'string' ? r.label.slice(0, 160) : undefined,
      });
    } else {
      const count = Number(r.count);
      recommendations.push({
        syllabusTopicId: topicId,
        action,
        count: Number.isFinite(count)
          ? Math.max(3, Math.min(20, Math.round(count)))
          : 5,
      });
    }
  }

  return { ok: true, value: { narrative, recommendations } };
}
