import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject } from './parse';
import { parseEnriched } from '../enrich';
import { parseDigest } from '../review-digest';

test('extractJsonObject: clean JSON', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

test('extractJsonObject: strips ```json fences', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJsonObject: pulls object out of surrounding prose', () => {
  assert.deepEqual(extractJsonObject('Sure! Here it is: {"a":1} — hope that helps.'), { a: 1 });
});

test('extractJsonObject: throws when no object present', () => {
  assert.throws(() => extractJsonObject('no json here'));
});

test('extractJsonObject: rejects a bare array', () => {
  assert.throws(() => extractJsonObject('[1,2,3]'));
});

test('parseEnriched: valid payload', () => {
  const raw = JSON.stringify({
    description: 'A great product.',
    category: 'Audio',
    features: ['ANC', 'IPX5'],
    keywords: ['earbuds', 'wireless'],
  });
  assert.deepEqual(parseEnriched(raw), {
    description: 'A great product.',
    category: 'Audio',
    features: ['ANC', 'IPX5'],
    keywords: ['earbuds', 'wireless'],
  });
});

test('parseEnriched: coerces non-string array items to strings', () => {
  const raw = '{"description":"d","category":"c","features":[1,2],"keywords":["k"]}';
  assert.deepEqual(parseEnriched(raw).features, ['1', '2']);
});

test('parseEnriched: throws on missing fields', () => {
  assert.throws(() => parseEnriched('{"description":"d"}'));
});

test('parseDigest: valid payload', () => {
  const raw = JSON.stringify({
    overallSentiment: 'mixed',
    summary: 'Some liked it, some did not.',
    themes: [{ theme: 'battery', sentiment: 'negative', detail: 'shorter than advertised' }],
  });
  assert.equal(parseDigest(raw).overallSentiment, 'mixed');
  assert.equal(parseDigest(raw).themes.length, 1);
});

test('parseDigest: throws on missing themes', () => {
  assert.throws(() => parseDigest('{"overallSentiment":"ok","summary":"s"}'));
});
