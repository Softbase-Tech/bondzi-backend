import {
  validateNarrativeEnvelope,
  type EnvelopeContext,
} from './narrative-envelope.validator';

const CTX: EnvelopeContext = {
  requiredTitles: ['Vectors', 'Binomial Expansion'],
  validTopicIds: ['st-1', 'st-2'],
  validChunkIds: ['chunk-1'],
};

const NARRATIVE =
  'You are making steady progress, but Vectors keeps slowing you down and Binomial Expansion trips you on the expansion step. Slow down on the setup and the marks follow. Start with the Vectors reading below, then retry a short set.';

const good = (recs: unknown[] = []) =>
  JSON.stringify({ narrative: NARRATIVE, recommendations: recs });

describe('validateNarrativeEnvelope', () => {
  it('accepts a grounded envelope and normalises recommendations', () => {
    const res = validateNarrativeEnvelope(
      good([
        {
          syllabusTopicId: 'st-1',
          action: 'read',
          chunkId: 'chunk-1',
          label: 'Vectors — Key Ideas (p. 41)',
        },
        { syllabusTopicId: 'st-2', action: 'practice', count: 99 },
      ]),
      CTX,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.recommendations).toHaveLength(2);
    // practice count is clamped to a sane band
    expect(res.value.recommendations[1].count).toBeLessThanOrEqual(20);
  });

  it('strips markdown fences before parsing', () => {
    const res = validateNarrativeEnvelope('```json\n' + good() + '\n```', CTX);
    expect(res.ok).toBe(true);
  });

  it('rejects non-JSON output', () => {
    const res = validateNarrativeEnvelope('Here is your review!', CTX);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('narrative_schema_invalid');
  });

  it('passes through the model refusal shape as model_refused', () => {
    const res = validateNarrativeEnvelope(
      JSON.stringify({ error: 'out_of_scope', detail: 'no signal' }),
      CTX,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('model_refused');
  });

  it('rejects a narrative that names too few required topics', () => {
    const res = validateNarrativeEnvelope(
      JSON.stringify({
        narrative:
          'You are doing well overall and your consistency is improving every week. Keep practising a little every day and the results will follow you into the exam hall with confidence.',
        recommendations: [],
      }),
      CTX,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('narrative_topics_missing');
  });

  it('rejects markdown inside the narrative', () => {
    const res = validateNarrativeEnvelope(
      JSON.stringify({
        narrative: `## Summary\n${NARRATIVE}`,
        recommendations: [],
      }),
      CTX,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('narrative_markdown');
  });

  it('rejects invented reading (chunkId not supplied)', () => {
    const res = validateNarrativeEnvelope(
      good([
        { syllabusTopicId: 'st-1', action: 'read', chunkId: 'fake-chunk' },
      ]),
      CTX,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('recommendation_invented_reading');
  });

  it('rejects recommendations for topics outside the signal', () => {
    const res = validateNarrativeEnvelope(
      good([{ syllabusTopicId: 'st-999', action: 'practice', count: 5 }]),
      CTX,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('recommendation_unknown_topic');
  });
});
