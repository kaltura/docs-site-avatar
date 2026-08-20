import { test } from 'node:test';
import assert from 'node:assert/strict';

// provision.mjs gates on these at module load (see the top-level `if
// (!partnerId || !adminSecret) process.exit(2)`) — set dummies before
// importing so the module under test never touches a live credential.
process.env.AGENTIC_PARTNER_ID ||= 'test-partner';
process.env.AGENTIC_ADMIN_SECRET ||= 'test-secret';

const {
  fileForUrl, stripFrontmatter, splitIntoSections, githubSlugify,
  extractTopLevelHeadings, buildSiteMap, buildBaseDirective, PERSONA_NAME, OPENING_PHRASE,
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
