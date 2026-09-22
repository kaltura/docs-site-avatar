import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPersonas } from './personas.mjs';

const siteData = (pageCount) => ({
  routes: [],
  manifest: {
    pages: Array.from({ length: pageCount }, (_, i) => ({ path: `/page-${i}/`, title: `Page ${i}`, sections: [] })),
  },
});

const tours = (pageCount) => buildPersonas(siteData(pageCount)).filter((p) => p.id.startsWith('site-navigator-'));

test('site-navigator tours cover every manifest page exactly once, in manifest order', () => {
  for (const n of [1, 8, 9, 48, 49, 50, 57]) {
    const paths = tours(n).flatMap((t) => t.turns.map((turn) => turn.expectNavPath));
    assert.deepEqual(paths, siteData(n).manifest.pages.map((p) => p.path), `page count ${n}`);
  }
});

test('site-navigator tours are level: at most 8 turns each, sizes differ by at most one, no straggler', () => {
  for (const n of [1, 8, 9, 48, 49, 50, 57]) {
    const sizes = tours(n).map((t) => t.turns.length);
    assert.ok(Math.max(...sizes) <= 8, `page count ${n}: ${sizes}`);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `page count ${n}: ${sizes}`);
  }
});

test('site-navigator persona labels match the pages each tour actually holds', () => {
  let expectedStart = 1;
  for (const t of tours(50)) {
    assert.equal(t.persona, `Visitor browsing the site, manifest pages ${expectedStart}-${expectedStart + t.turns.length - 1}`);
    expectedStart += t.turns.length;
  }
});
