import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, csvAttachmentDisposition } from '../csv';

test('toCsv: empty rows + no columns → empty string', () => {
  assert.equal(toCsv([]), '');
});

test('toCsv: empty rows + columns → header only', () => {
  const out = toCsv<{ a: string; b: number }>([], ['a', 'b']);
  assert.equal(out, 'a,b\r\n');
});

test('toCsv: simple rows produce header + body', () => {
  const out = toCsv([
    { a: 1, b: 'hi' },
    { a: 2, b: 'there' },
  ]);
  assert.equal(out, 'a,b\r\n1,hi\r\n2,there\r\n');
});

test('toCsv: quotes fields containing comma / quote / newline', () => {
  const out = toCsv([
    { name: 'Hello, World', note: 'She said "hi"', code: 'a\nb' },
  ]);
  assert.match(out, /"Hello, World"/);
  assert.match(out, /"She said ""hi"""/);
  assert.match(out, /"a\nb"/);
});

test('toCsv: nulls / undefined → empty cell', () => {
  const out = toCsv([{ a: null, b: undefined, c: 'x' }]);
  assert.equal(out, 'a,b,c\r\n,,x\r\n');
});

test('toCsv: Date → ISO 8601', () => {
  const d = new Date('2026-01-02T03:04:05.000Z');
  const out = toCsv([{ at: d }]);
  assert.match(out, /2026-01-02T03:04:05\.000Z/);
});

test('toCsv: nested objects/arrays JSON-stringified and quoted', () => {
  const out = toCsv([{ tags: ['a', 'b'], meta: { x: 1 } }]);
  assert.match(out, /"\[""a"",""b""\]"/);
  assert.match(out, /"\{""x"":1\}"/);
});

test('toCsv: respects custom column order + missing keys', () => {
  const out = toCsv(
    [
      { a: 1, b: 2, c: 3 },
      { a: 4, b: 5 },
    ],
    ['c', 'a']
  );
  assert.equal(out, 'c,a\r\n3,1\r\n,4\r\n');
});

test('csvAttachmentDisposition: sanitises filename', () => {
  const v = csvAttachmentDisposition('alerts 2026/04/19.csv');
  assert.match(v, /attachment; filename="alerts_2026_04_19.csv"/);
});
