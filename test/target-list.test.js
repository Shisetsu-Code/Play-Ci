import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTargetList } from '../src/target-list.js';

test('parses comments, blanks and de-duplicates targets', () => {
  const input = `
# comment
https://example.com/a

https://example.com/a
https://example.com/b?x=1
`;
  assert.deepEqual(parseTargetList(input), [
    'https://example.com/a',
    'https://example.com/b?x=1',
  ]);
});

test('rejects malformed or unsupported targets with line number', () => {
  assert.throws(
    () => parseTargetList('# ok\nnot-a-url\n'),
    /line 2/,
  );
  assert.throws(
    () => parseTargetList('file:\/\/\/tmp\/x\n'),
    /Unsupported URL protocol on line 1/,
  );
});

test('enforces target limit', () => {
  assert.throws(
    () => parseTargetList('https://a.example\nhttps://b.example\n', { maxTargets: 1 }),
    /maximum of 1/,
  );
});
