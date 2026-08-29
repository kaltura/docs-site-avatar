import { test } from 'node:test';
import assert from 'node:assert/strict';

// provision.mjs gates on these at module load (see the top-level `if
// (!partnerId || !adminSecret) process.exit(2)`) — set dummies before
// importing so the module under test never touches a live credential.
process.env.AGENTIC_PARTNER_ID ||= 'test-partner';
process.env.AGENTIC_ADMIN_SECRET ||= 'test-secret';

const {
  fileForUrl, stripFrontmatter, splitIntoSections, githubSlugify, SUBCHUNK_THRESHOLD,
  extractTopLevelHeadings, extractHighlightables, buildSiteMap, buildBaseDirective, PERSONA_NAME, OPENING_PHRASE, hashDocs,
} = await import('../../server/provision.mjs');
const { lintPersonaIdentity } = await import('../../vendor/sdk/src/management/prompt-lint.js');

/* fileForUrl */
test('fileForUrl: strips slashes and appends .md', () => {
  assert.equal(fileForUrl('/guides/voice-input-modes/'), 'guides/voice-input-modes.md');
});
test('fileForUrl: home path resolves to index.md', () => {
  assert.equal(fileForUrl('/'), 'index.md');
});

/* stripFrontmatter */
test('stripFrontmatter: removes a leading --- fenced block', () => {
  const text = '---\nlayout: page\ntitle: X\n---\n# Hello\n\nBody.';
  assert.equal(stripFrontmatter(text), '# Hello\n\nBody.');
});
test('stripFrontmatter: no-op when there is no frontmatter', () => {
  assert.equal(stripFrontmatter('# Hello\n\nBody.'), '# Hello\n\nBody.');
});

/* githubSlugify */
test('githubSlugify: lowercases, spaces to hyphens, strips punctuation', () => {
  assert.equal(githubSlugify('Open-mic vs. push-to-talk'), 'open-mic-vs-push-to-talk');
});
test('githubSlugify: trims surrounding whitespace', () => {
  assert.equal(githubSlugify('  Voice Input Modes  '), 'voice-input-modes');
});

/* extractTopLevelHeadings */
test('extractTopLevelHeadings: collects only ## headings, in order', () => {
  const md = '# Title\n\nIntro.\n\n## First Section\n\nBody.\n\n### Not top-level\n\n## Second Section\n\nMore.';
  assert.deepEqual(extractTopLevelHeadings(md), ['First Section', 'Second Section']);
});
test('extractTopLevelHeadings: empty array when there are no ## headings', () => {
  assert.deepEqual(extractTopLevelHeadings('# Title\n\nJust intro text.'), []);
});
test('extractTopLevelHeadings: strips CommonMark\'s optional closing # sequence', () => {
  assert.deepEqual(extractTopLevelHeadings('## Title ##'), ['Title']);
});

/* extractHighlightables */
test('extractHighlightables: collects ## and ### headings, slugified, in order', () => {
  const md = '# Title\n\n## First Section\n\nBody.\n\n### A Sub Section\n\nMore.';
  assert.deepEqual(extractHighlightables(md), [
    { id: 'first-section', label: 'First Section' },
    { id: 'a-sub-section', label: 'A Sub Section' },
  ]);
});
test('extractHighlightables: data-nova-target divs come before headings, in document order', () => {
  const md = '# Title\n\n## A Heading\n\n<div data-nova-target="widget" data-nova-label="The Widget">Body</div>';
  assert.deepEqual(extractHighlightables(md), [
    { id: 'widget', label: 'The Widget' },
    { id: 'a-heading', label: 'A Heading' },
  ]);
});
test('extractHighlightables: empty array when there are no headings or tagged divs', () => {
  assert.deepEqual(extractHighlightables('# Title\n\nJust intro text.'), []);
});
test('extractHighlightables: dedupes by id — first occurrence wins', () => {
  const md = '<div data-nova-target="widget" data-nova-label="First">A</div>\n\n## Widget\n\nBody.';
  assert.deepEqual(extractHighlightables(md), [{ id: 'widget', label: 'First' }]);
});
test('extractHighlightables: skips heading-like lines inside fenced code blocks', () => {
  const md = '# Title\n\n## Real Section\n\n```md\n## fenced fake heading\n```\n\nBody.';
  assert.deepEqual(extractHighlightables(md), [{ id: 'real-section', label: 'Real Section' }]);
});

/* splitIntoSections */
test('splitIntoSections: first chunk is title+intro, unprefixed', () => {
  const md = '# My Page\n\nIntro text.\n\n## Section One\n\nBody one.';
  const doc = { url: '/my-page/' };
  const chunks = splitIntoSections(md, doc);
  assert.equal(chunks[0], '# My Page\n\nIntro text.');
});
test('splitIntoSections: later chunks are prefixed with title, page path, and anchor slug', () => {
  const md = '# My Page\n\nIntro text.\n\n## Section One\n\nBody one.';
  const doc = { url: '/my-page/' };
  const chunks = splitIntoSections(md, doc);
  assert.equal(
    chunks[1],
    '# My Page\nPage path: /my-page/\nSection anchor id on that page: section-one\n\n## Section One\n\nBody one.',
  );
});
test('splitIntoSections: strips CommonMark\'s optional closing # sequence from the anchor slug', () => {
  const md = '# My Page\n\nIntro text.\n\n## Section One ##\n\nBody one.';
  const chunks = splitIntoSections(md, { url: '/my-page/' });
  assert.match(chunks[1], /Section anchor id on that page: section-one\n/);
});
test('splitIntoSections: single-chunk doc (no ## sections) returns just the trimmed source', () => {
  const md = '# My Page\n\nJust one section, no subheadings.';
  const chunks = splitIntoSections(md, { url: '/my-page/' });
  assert.deepEqual(chunks, [md]);
});

/* splitIntoSections — issue #42 sub-chunking of oversized ## sections at ### boundaries */
const filler = (n) => 'x'.repeat(n);
function oversizedSectionDoc() {
  // One ## section comfortably over SUBCHUNK_THRESHOLD, with a preamble and two ### subsections.
  return [
    '# API Page', '', 'Intro.', '',
    '## Big Phase', '', `Preamble. ${filler(SUBCHUNK_THRESHOLD)}`, '',
    '### Converse', '', 'Needs allow_client_variables.', '',
    '### Reserved Vars', '', 'sys__ keys are server-injected.',
  ].join('\n');
}
test('splitIntoSections: an oversized ## section with ### subsections splits at ### boundaries', () => {
  const chunks = splitIntoSections(oversizedSectionDoc(), { url: '/api/' });
  assert.equal(chunks.length, 4); // intro + ## preamble + 2 ### sub-chunks
  assert.match(chunks[1], /^# API Page\nPage path: \/api\/\nSection anchor id on that page: big-phase\n\n## Big Phase/);
  assert.match(chunks[2], /^# API Page\nPage path: \/api\/\nPart of section: Big Phase\nSection anchor id on that page: converse\n\n### Converse/);
  assert.match(chunks[3], /^# API Page\nPage path: \/api\/\nPart of section: Big Phase\nSection anchor id on that page: reserved-vars\n\n### Reserved Vars/);
});
test('splitIntoSections: each ### sub-chunk keeps only its own body', () => {
  const chunks = splitIntoSections(oversizedSectionDoc(), { url: '/api/' });
  assert.ok(chunks[2].includes('allow_client_variables'));
  assert.ok(!chunks[2].includes('sys__ keys'));
  assert.ok(!chunks[3].includes('allow_client_variables'));
});
test('splitIntoSections: a ## section under the threshold stays whole even with ### subsections', () => {
  const md = '# Page\n\nIntro.\n\n## Small\n\nShort preamble.\n\n### Child\n\nChild body.';
  const chunks = splitIntoSections(md, { url: '/p/' });
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1].includes('### Child'));
  assert.ok(!chunks[1].includes('Part of section:'));
});
test('splitIntoSections: an oversized ## section with NO ### subsections stays whole', () => {
  const md = `# Page\n\nIntro.\n\n## Long Flat\n\n${filler(SUBCHUNK_THRESHOLD + 100)}`;
  const chunks = splitIntoSections(md, { url: '/p/' });
  assert.equal(chunks.length, 2);
  assert.match(chunks[1], /Section anchor id on that page: long-flat\n/);
});
test('splitIntoSections: sub-chunk ### heading strips CommonMark closing hashes from its slug', () => {
  const md = `# Page\n\nIntro.\n\n## Big\n\n${filler(SUBCHUNK_THRESHOLD)}\n\n### Sub One ###\n\nBody.`;
  const chunks = splitIntoSections(md, { url: '/p/' });
  assert.match(chunks[2], /Section anchor id on that page: sub-one\n/);
});
test('splitIntoSections: heading-only preamble folds into the first ### sub-chunk (no degenerate chunk)', () => {
  // ## heading immediately followed by the first ### — no prose between them.
  const md = `# Page\n\nIntro.\n\n## Big Bare\n\n### First Sub\n\n${filler(SUBCHUNK_THRESHOLD)}\n\n### Second Sub\n\nTail body.`;
  const chunks = splitIntoSections(md, { url: '/p/' });
  assert.equal(chunks.length, 3); // intro + merged(##+first ###) + second ###
  // Merged chunk carries the parent section's own anchor and contains both headings.
  assert.match(chunks[1], /Section anchor id on that page: big-bare\n/);
  assert.ok(chunks[1].includes('## Big Bare'));
  assert.ok(chunks[1].includes('### First Sub'));
  assert.ok(!chunks[1].includes('Part of section:'));
  assert.match(chunks[2], /Part of section: Big Bare\nSection anchor id on that page: second-sub\n/);
});
test('splitIntoSections: heading-like lines inside code fences never split (## and ### levels)', () => {
  const md = [
    '# Page', '', 'Intro.', '',
    '## Real Section', '',
    '```md', '## fenced fake h2', '### fenced fake h3', '```', '',
    `Body. ${filler(SUBCHUNK_THRESHOLD)}`, '',
    '### Real Sub', '',
    '~~~', '### tilde-fenced fake h3', '~~~', '',
    'Sub body.',
  ].join('\n');
  const chunks = splitIntoSections(md, { url: '/p/' });
  assert.equal(chunks.length, 3); // intro + ## preamble (with fence intact) + one real ### sub
  assert.ok(chunks[1].includes('## fenced fake h2'));
  assert.ok(chunks[1].includes('### fenced fake h3'));
  assert.ok(chunks[2].includes('### tilde-fenced fake h3'));
  assert.ok(!chunks.some((c) => /Section anchor id on that page: fenced-fake/.test(c)));
});
test('splitIntoSections: concatenated chunk bodies reconstruct the full source (nothing lost)', () => {
  const src = oversizedSectionDoc();
  const chunks = splitIntoSections(src, { url: '/api/' });
  // Strip each chunk's injected provenance header (everything through the blank line after it).
  const bodies = chunks.map((c, i) => (i === 0 ? c : c.replace(/^# API Page\n(?:Page path|Part of section|Section anchor id on that page)[^]*?\n\n/, '')));
  const rebuilt = bodies.join('\n\n');
  const normalize = (t) => t.replace(/\n{2,}/g, '\n\n').trim();
  assert.equal(normalize(rebuilt), normalize(src));
});
test('splitIntoSections: an oversized final ### sub-chunk stays whole (no deeper recursion)', () => {
  const md = `# Page\n\nIntro.\n\n## Big\n\nPreamble. ${filler(SUBCHUNK_THRESHOLD)}\n\n### Huge Sub\n\n${filler(SUBCHUNK_THRESHOLD + 500)}\n\n#### Deeper\n\nDeep body.`;
  const chunks = splitIntoSections(md, { url: '/p/' });
  assert.equal(chunks.length, 3); // intro + ## preamble + one ### sub, however large
  assert.ok(chunks[2].length > SUBCHUNK_THRESHOLD);
  assert.ok(chunks[2].includes('#### Deeper'));
});
test('splitIntoSections: oversized section with heading-only preamble and ONE ### child folds to a single whole chunk', () => {
  // By design: the fold merges the bare ## heading into its only ### child, leaving one
  // sub-chunk — and a lone oversized sub-chunk stays whole (same rule as the test above),
  // so no split happens. Splitting couldn't reduce embedded mass here anyway: the only
  // alternative is a degenerate heading-only chunk plus a still-oversized remainder.
  const md = `# Page\n\nIntro.\n\n## Bare Parent\n\n### Only Child\n\n${filler(SUBCHUNK_THRESHOLD + 200)}`;
  const chunks = splitIntoSections(md, { url: '/p/' });
  assert.equal(chunks.length, 2); // intro + one merged chunk
  assert.match(chunks[1], /Section anchor id on that page: bare-parent\n/);
  assert.ok(chunks[1].includes('## Bare Parent'));
  assert.ok(chunks[1].includes('### Only Child'));
  assert.ok(!chunks[1].includes('Part of section:'));
});
test('splitIntoSections: an unclosed fence runs to end of document, so later headings never split (CommonMark)', () => {
  // CommonMark: a fence with no closer extends to the end of the document; markdown-it
  // renders everything after it as code, so those "headings" get no anchor ids on the live
  // site. Chunking must match the renderer and treat them as fence content too.
  const md = [
    '# Page', '', 'Intro.', '',
    '## Real Section', '', `Body. ${filler(SUBCHUNK_THRESHOLD)}`, '',
    '```', '## swallowed h2', '### swallowed h3',
  ].join('\n');
  const chunks = splitIntoSections(md, { url: '/p/' });
  assert.equal(chunks.length, 2); // intro + the one real ## section, fence tail included
  assert.ok(chunks[1].includes('## swallowed h2'));
  assert.ok(chunks[1].includes('### swallowed h3'));
  assert.ok(!chunks.some((c) => /Section anchor id on that page: swallowed/.test(c)));
});
test('splitIntoSections: a section at exactly SUBCHUNK_THRESHOLD stays whole; one char over splits', () => {
  const md = `# Page\n\nIntro.\n\n## Edge\n\nPreamble.\n\n### Child\n\nChild body.`;
  const base = splitIntoSections(md, { url: '/p/' });
  assert.equal(base.length, 2);
  // The raw section text (what the `>` threshold measures) is the chunk minus its injected
  // provenance header — pad the body so it lands on exactly SUBCHUNK_THRESHOLD chars.
  const start = base[1].indexOf('## Edge');
  assert.ok(start > 0);
  const pad = SUBCHUNK_THRESHOLD - (base[1].length - start);
  assert.ok(pad > 0);
  const atThreshold = md.replace('Child body.', `Child body.${'y'.repeat(pad)}`);
  const whole = splitIntoSections(atThreshold, { url: '/p/' });
  assert.equal(whole.length, 2); // strictly-greater trigger: exactly-at stays whole
  assert.ok(whole[1].includes('### Child'));
  assert.ok(!whole[1].includes('Part of section:'));
  const overThreshold = md.replace('Child body.', `Child body.${'y'.repeat(pad + 1)}`);
  const split = splitIntoSections(overThreshold, { url: '/p/' });
  assert.equal(split.length, 3); // one char over: preamble + ### sub-chunk
  assert.match(split[2], /Part of section: Edge\nSection anchor id on that page: child\n/);
});

/* buildSiteMap */
test('buildSiteMap: groups pages by nav group and lists path + cite URL', () => {
  const docs = [
    { group: 'Home', title: 'Home', url: '/', topics: [] },
    { group: 'Guides', title: 'Voice Input Modes', url: '/guides/voice-input-modes/', topics: ['Open-mic vs. push-to-talk'] },
  ];
  const map = buildSiteMap(docs);
  assert.match(map, /^Home:\n- Home — path: \//m);
  assert.match(map, /Guides:\n- Voice Input Modes — path: \/guides\/voice-input-modes\/ \(cite as: .+\) — topics: Open-mic vs\. push-to-talk/);
});
test('buildSiteMap: a page with no topics has no trailing " — topics:" suffix', () => {
  const docs = [{ group: 'Home', title: 'Home', url: '/', topics: [] }];
  const map = buildSiteMap(docs);
  assert.ok(!map.includes('topics:'));
});
test('buildSiteMap: a page\'s highlightables render as indented informational bullets, one per line', () => {
  const docs = [{
    group: 'Guides', title: 'Integrations', url: '/guides/integrations/', topics: [],
    highlightables: [{ id: 'hubspot', label: 'HubSpot' }, { id: 'salesforce', label: 'Salesforce' }],
  }];
  const map = buildSiteMap(docs);
  assert.match(map, /- Integrations — path: \/guides\/integrations\/ \(cite as: .+\)\n  - highlightable \(informational only\): "HubSpot" → hubspot\n  - highlightable \(informational only\): "Salesforce" → salesforce/);
});
test('buildSiteMap: a page with no highlightables has no highlightable bullets', () => {
  const docs = [{ group: 'Home', title: 'Home', url: '/', topics: [], highlightables: [] }];
  const map = buildSiteMap(docs);
  assert.ok(!map.includes('highlightable'));
});

/* hashDocs — the fingerprint provision() uses to skip re-uploading an unchanged knowledge base */
test('hashDocs: identical file+markdown pairs hash identically', () => {
  const docs = [{ file: 'index.md', markdown: '# Home\n\nBody.' }];
  assert.equal(hashDocs(docs), hashDocs([{ file: 'index.md', markdown: '# Home\n\nBody.' }]));
});
test('hashDocs: a one-character content change changes the hash', () => {
  const a = [{ file: 'index.md', markdown: '# Home\n\nBody.' }];
  const b = [{ file: 'index.md', markdown: '# Home\n\nBody!' }];
  assert.notEqual(hashDocs(a), hashDocs(b));
});
test('hashDocs: order matters — same docs in a different order hash differently', () => {
  const a = [{ file: 'a.md', markdown: 'A' }, { file: 'b.md', markdown: 'B' }];
  const b = [{ file: 'b.md', markdown: 'B' }, { file: 'a.md', markdown: 'A' }];
  assert.notEqual(hashDocs(a), hashDocs(b));
});
test('hashDocs: content shifted across a file boundary does not collide', () => {
  // Without a separator between docs, ['a','bc'] and ['ab','c'] would hash identically.
  const a = [{ file: 'x.md', markdown: 'a' }, { file: 'y.md', markdown: 'bc' }];
  const b = [{ file: 'x.md', markdown: 'ab' }, { file: 'y.md', markdown: 'c' }];
  assert.notEqual(hashDocs(a), hashDocs(b));
});

/* persona identity lint (issue #32) — Nova's real shape: PERSONA_NAME is declared
   via the `name` prompt, not via a name-bearing openingPhrase (hers is the SSML
   silence tag OPENING_PHRASE). This proves lintPersonaIdentity's declared-name-alone
   drift check stays clean against what provision() actually sends today. */
test('persona identity lint: Nova\'s real shape (name-only, no name-bearing openingPhrase) is clean', () => {
  const r = lintPersonaIdentity({
    name: PERSONA_NAME,
    openingPhrase: OPENING_PHRASE,
    baseDirective: buildBaseDirective(),
    prompts: [{ value: PERSONA_NAME }],
  });
  assert.deepEqual(r.findings, []);
});
