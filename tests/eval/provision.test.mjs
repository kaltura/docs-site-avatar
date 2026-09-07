import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// provision.mjs gates on these at module load (see the top-level `if
// (!partnerId || !adminSecret) process.exit(2)`) — set dummies before
// importing so the module under test never touches a live credential.
process.env.AGENTIC_PARTNER_ID ||= 'test-partner';
process.env.AGENTIC_ADMIN_SECRET ||= 'test-secret';

const {
  fileForUrl, stripFrontmatter, splitIntoSections, githubSlugify, SUBCHUNK_THRESHOLD,
  buildBaseDirective, PERSONA_NAME, OPENING_PHRASE, hashDocs, CHUNK_FORMAT, goToArgsLine, labelHomeLine,
  checkCustomPromptSchema, REQUIRED_CUSTOM_PROMPT_KEYS,
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

/* splitIntoSections — every chunk after the first carries ONE provenance line: the complete go_to
   argument object (path, plus the manifest's section key when it lists the section — never a raw
   heading slug), so the brain copies a finished call instead of assembling one. */
/** A fake manifest page: ids are the rendered heading slugs, keys are whatever the manifest chose. */
const pageOf = (...pairs) => ({ sections: pairs.map(([key, id]) => ({ key, id: id ?? key })) });
/** The provenance line chunks must carry. The exact wire format is pinned once, in the
 * goToArgsLine test below; the chunk tests only assert that chunks use it. */
const ARGS = goToArgsLine;

test('goToArgsLine: one JSON object, section only when a key is given', () => {
  assert.equal(goToArgsLine('/', 'why-sdk'), 'go_to arguments: {"path":"/","section":"why-sdk"}');
  assert.equal(goToArgsLine('/guides/x/'), 'go_to arguments: {"path":"/guides/x/"}');
  assert.equal(goToArgsLine('/guides/x/', null), 'go_to arguments: {"path":"/guides/x/"}');
});
test('splitIntoSections: a home-page section is path "/" plus the key, never "/<key>/"', () => {
  const md = '# Home\n\nIntro.\n\n## Why this SDK\n\nBody.\n\n## jsDelivr quickstart\n\nBody.';
  const chunks = splitIntoSections(md, { url: '/' }, pageOf(['why-sdk', 'why-this-sdk'], ['jsdelivr-quickstart']));
  assert.equal(chunks[1], `# Home\n${ARGS('/', 'why-sdk')}\n\n## Why this SDK\n\nBody.`);
  assert.equal(chunks[2], `# Home\n${ARGS('/', 'jsdelivr-quickstart')}\n\n## jsDelivr quickstart\n\nBody.`);
  assert.ok(!chunks.some((c) => c.includes('/why-sdk/') || c.includes('/jsdelivr-quickstart/')));
});

test('splitIntoSections: first chunk is title+intro, unprefixed', () => {
  const md = '# My Page\n\nIntro text.\n\n## Section One\n\nBody one.';
  const chunks = splitIntoSections(md, { url: '/my-page/' }, pageOf(['section-one']));
  assert.equal(chunks[0], '# My Page\n\nIntro text.');
});
test('splitIntoSections: later chunks are prefixed with title and the go_to arguments (path + manifest key)', () => {
  const md = '# My Page\n\nIntro text.\n\n## Section One\n\nBody one.';
  const chunks = splitIntoSections(md, { url: '/my-page/' }, pageOf(['section-one']));
  assert.equal(chunks[1], `# My Page\n${ARGS('/my-page/', 'section-one')}\n\n## Section One\n\nBody one.`);
});
test('splitIntoSections: names the manifest KEY, not the heading id, when the two differ', () => {
  const md = '# My Page\n\nIntro.\n\n## Security and Compliance\n\nBody.';
  const chunks = splitIntoSections(md, { url: '/' }, pageOf(['security-compliance', 'security-and-compliance']));
  assert.ok(chunks[1].includes(`\n${ARGS('/', 'security-compliance')}\n`));
  assert.ok(!chunks[1].includes('"security-and-compliance"'));
});
test('splitIntoSections: no manifest page → path-only arguments, no section', () => {
  const md = '# My Page\n\nIntro.\n\n## Section One\n\nBody.';
  const chunks = splitIntoSections(md, { url: '/my-page/' });
  assert.equal(chunks[1], `# My Page\n${ARGS('/my-page/')}\n\n## Section One\n\nBody.`);
});
test('splitIntoSections: a heading the manifest does not list gets path-only arguments', () => {
  const md = '# My Page\n\nIntro.\n\n## Listed\n\nA.\n\n## Unlisted\n\nB.';
  const chunks = splitIntoSections(md, { url: '/my-page/' }, pageOf(['listed']));
  assert.ok(chunks[1].includes(`\n${ARGS('/my-page/', 'listed')}\n`));
  assert.ok(!chunks[2].includes('"section"'));
  assert.ok(chunks[2].startsWith(`# My Page\n${ARGS('/my-page/')}\n\n## Unlisted`));
});
test('splitIntoSections: strips CommonMark\'s optional closing # sequence before the manifest lookup', () => {
  const md = '# My Page\n\nIntro text.\n\n## Section One ##\n\nBody one.';
  const chunks = splitIntoSections(md, { url: '/my-page/' }, pageOf(['section-one']));
  assert.ok(chunks[1].includes(`${ARGS('/my-page/', 'section-one')}\n`));
});
test('splitIntoSections: single-chunk doc (no ## sections) returns just the trimmed source', () => {
  const md = '# My Page\n\nJust one section, no subheadings.';
  const chunks = splitIntoSections(md, { url: '/my-page/' }, pageOf());
  assert.deepEqual(chunks, [md]);
});

/* splitIntoSections — issue #42 sub-chunking of oversized ## sections at ### boundaries.
   The manifest lists h2s only, so a ### sub-chunk names its PARENT section's key. */
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
const API_PAGE = pageOf(['big-phase']);
test('splitIntoSections: an oversized ## section with ### subsections splits at ### boundaries', () => {
  const chunks = splitIntoSections(oversizedSectionDoc(), { url: '/api/' }, API_PAGE);
  assert.equal(chunks.length, 4); // intro + ## preamble + 2 ### sub-chunks
  assert.ok(chunks[1].startsWith(`# API Page\n${ARGS('/api/', 'big-phase')}\n\n## Big Phase`));
  assert.ok(chunks[2].startsWith(`# API Page\n${ARGS('/api/', 'big-phase')}\nPart of section: Big Phase\n\n### Converse`));
  assert.ok(chunks[3].startsWith(`# API Page\n${ARGS('/api/', 'big-phase')}\nPart of section: Big Phase\n\n### Reserved Vars`));
});
test('splitIntoSections: a ### sub-chunk never names its own h3 slug when the manifest is h2-only', () => {
  const chunks = splitIntoSections(oversizedSectionDoc(), { url: '/api/' }, API_PAGE);
  assert.ok(!chunks.some((c) => /"section":"(converse|reserved-vars)"/.test(c)));
});
test('splitIntoSections: a ### sub-chunk prefers its own key when the manifest does list that h3', () => {
  const chunks = splitIntoSections(oversizedSectionDoc(), { url: '/api/' }, pageOf(['big-phase'], ['converse']));
  assert.ok(chunks[2].includes(`${ARGS('/api/', 'converse')}\nPart of section: Big Phase\n`));
  assert.ok(chunks[3].includes(`${ARGS('/api/', 'big-phase')}\nPart of section: Big Phase\n`));
});
test('splitIntoSections: each ### sub-chunk keeps only its own body', () => {
  const chunks = splitIntoSections(oversizedSectionDoc(), { url: '/api/' }, API_PAGE);
  assert.ok(chunks[2].includes('allow_client_variables'));
  assert.ok(!chunks[2].includes('sys__ keys'));
  assert.ok(!chunks[3].includes('allow_client_variables'));
});
test('splitIntoSections: a ## section under the threshold stays whole even with ### subsections', () => {
  const md = '# Page\n\nIntro.\n\n## Small\n\nShort preamble.\n\n### Child\n\nChild body.';
  const chunks = splitIntoSections(md, { url: '/p/' }, pageOf(['small']));
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1].includes('### Child'));
  assert.ok(!chunks[1].includes('Part of section:'));
});
test('splitIntoSections: an oversized ## section with NO ### subsections stays whole', () => {
  const md = `# Page\n\nIntro.\n\n## Long Flat\n\n${filler(SUBCHUNK_THRESHOLD + 100)}`;
  const chunks = splitIntoSections(md, { url: '/p/' }, pageOf(['long-flat']));
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1].includes(`${ARGS('/p/', 'long-flat')}\n`));
});
test('splitIntoSections: sub-chunk ### heading strips CommonMark closing hashes before the manifest lookup', () => {
  const md = `# Page\n\nIntro.\n\n## Big\n\n${filler(SUBCHUNK_THRESHOLD)}\n\n### Sub One ###\n\nBody.`;
  const chunks = splitIntoSections(md, { url: '/p/' }, pageOf(['big'], ['sub-one']));
  assert.ok(chunks[2].includes(`${ARGS('/p/', 'sub-one')}\n`));
});
test('splitIntoSections: heading-only preamble folds into the first ### sub-chunk (no degenerate chunk)', () => {
  // ## heading immediately followed by the first ### — no prose between them.
  const md = `# Page\n\nIntro.\n\n## Big Bare\n\n### First Sub\n\n${filler(SUBCHUNK_THRESHOLD)}\n\n### Second Sub\n\nTail body.`;
  const chunks = splitIntoSections(md, { url: '/p/' }, pageOf(['big-bare']));
  assert.equal(chunks.length, 3); // intro + merged(##+first ###) + second ###
  // Merged chunk carries the parent section's own key and contains both headings.
  assert.ok(chunks[1].includes(`${ARGS('/p/', 'big-bare')}\n`));
  assert.ok(chunks[1].includes('## Big Bare'));
  assert.ok(chunks[1].includes('### First Sub'));
  assert.ok(!chunks[1].includes('Part of section:'));
  assert.ok(chunks[2].includes(`${ARGS('/p/', 'big-bare')}\nPart of section: Big Bare\n`));
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
  const page = pageOf(['real-section'], ['fenced-fake-h2'], ['fenced-fake-h3'], ['tilde-fenced-fake-h3']);
  const chunks = splitIntoSections(md, { url: '/p/' }, page);
  assert.equal(chunks.length, 3); // intro + ## preamble (with fence intact) + one real ### sub
  assert.ok(chunks[1].includes('## fenced fake h2'));
  assert.ok(chunks[1].includes('### fenced fake h3'));
  assert.ok(chunks[2].includes('### tilde-fenced fake h3'));
  assert.ok(!chunks.some((c) => /"section":"(fenced|tilde)/.test(c)));
});
test('splitIntoSections: concatenated chunk bodies reconstruct the full source (nothing lost)', () => {
  const src = oversizedSectionDoc();
  const chunks = splitIntoSections(src, { url: '/api/' }, API_PAGE);
  // Strip each chunk's injected provenance header (everything through the blank line after it).
  const bodies = chunks.map((c, i) => (i === 0 ? c : c.replace(/^# API Page\n(?:go_to arguments|Part of section)[^]*?\n\n/, '')));
  const rebuilt = bodies.join('\n\n');
  const normalize = (t) => t.replace(/\n{2,}/g, '\n\n').trim();
  assert.equal(normalize(rebuilt), normalize(src));
});
test('splitIntoSections: an oversized final ### sub-chunk stays whole (no deeper recursion)', () => {
  const md = `# Page\n\nIntro.\n\n## Big\n\nPreamble. ${filler(SUBCHUNK_THRESHOLD)}\n\n### Huge Sub\n\n${filler(SUBCHUNK_THRESHOLD + 500)}\n\n#### Deeper\n\nDeep body.`;
  const chunks = splitIntoSections(md, { url: '/p/' }, pageOf(['big']));
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
  const chunks = splitIntoSections(md, { url: '/p/' }, pageOf(['bare-parent']));
  assert.equal(chunks.length, 2); // intro + one merged chunk
  assert.ok(chunks[1].includes(`${ARGS('/p/', 'bare-parent')}\n`));
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
  const chunks = splitIntoSections(md, { url: '/p/' }, pageOf(['real-section'], ['swallowed-h2'], ['swallowed-h3']));
  assert.equal(chunks.length, 2); // intro + the one real ## section, fence tail included
  assert.ok(chunks[1].includes('## swallowed h2'));
  assert.ok(chunks[1].includes('### swallowed h3'));
  assert.ok(!chunks.some((c) => /"section":"swallowed/.test(c)));
});
test('splitIntoSections: a section at exactly SUBCHUNK_THRESHOLD stays whole; one char over splits', () => {
  const md = `# Page\n\nIntro.\n\n## Edge\n\nPreamble.\n\n### Child\n\nChild body.`;
  const page = pageOf(['edge']);
  const base = splitIntoSections(md, { url: '/p/' }, page);
  assert.equal(base.length, 2);
  // The raw section text (what the `>` threshold measures) is the chunk minus its injected
  // provenance header — pad the body so it lands on exactly SUBCHUNK_THRESHOLD chars.
  const start = base[1].indexOf('## Edge');
  assert.ok(start > 0);
  const pad = SUBCHUNK_THRESHOLD - (base[1].length - start);
  assert.ok(pad > 0);
  const atThreshold = md.replace('Child body.', `Child body.${'y'.repeat(pad)}`);
  const whole = splitIntoSections(atThreshold, { url: '/p/' }, page);
  assert.equal(whole.length, 2); // strictly-greater trigger: exactly-at stays whole
  assert.ok(whole[1].includes('### Child'));
  assert.ok(!whole[1].includes('Part of section:'));
  const overThreshold = md.replace('Child body.', `Child body.${'y'.repeat(pad + 1)}`);
  const split = splitIntoSections(overThreshold, { url: '/p/' }, page);
  assert.equal(split.length, 3); // one char over: preamble + ### sub-chunk
  assert.ok(split[2].includes(`${ARGS('/p/', 'edge')}\nPart of section: Edge\n`));
});

/* labelHomeLine — the SITE MAP's "/: k1, k2" home line reads like a list of pages; label it. */
test('labelHomeLine: rewrites only the home line, keeps every other line and the block shape', () => {
  const block = { key: 'siteMap', headerTemplate: 'SITE MAP.', type: 'custom', value: '/: meet-nova, why-sdk\n/guides/x/: a, b\n/reference/: c' };
  const out = labelHomeLine(block);
  assert.equal(out.value, '/ (home page; the keys after it are its sections, not pages): meet-nova, why-sdk\n/guides/x/: a, b\n/reference/: c');
  assert.equal(out.key, 'siteMap');
  assert.equal(out.headerTemplate, 'SITE MAP.');
  assert.equal(block.value, '/: meet-nova, why-sdk\n/guides/x/: a, b\n/reference/: c'); // input untouched
});
test('labelHomeLine: home line not first, and a manifest without a home page', () => {
  assert.equal(labelHomeLine({ value: '/guides/x/: a\n/: b' }).value, '/guides/x/: a\n/ (home page; the keys after it are its sections, not pages): b');
  assert.equal(labelHomeLine({ value: '/guides/x/: a\n/reference/: c' }).value, '/guides/x/: a\n/reference/: c');
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
test('hashDocs: the manifest is part of the fingerprint (chunks name its keys)', () => {
  const docs = [{ file: 'index.md', markdown: '# Home\n\n## A\n\nBody.' }];
  const m1 = { pages: [{ path: '/', sections: [{ key: 'a', id: 'a' }] }] };
  const m2 = { pages: [{ path: '/', sections: [{ key: 'a-renamed', id: 'a' }] }] };
  assert.notEqual(hashDocs(docs), hashDocs(docs, m1));
  assert.notEqual(hashDocs(docs, m1), hashDocs(docs, m2));
  assert.equal(hashDocs(docs, m1), hashDocs(docs, structuredClone(m1)));
});
test('hashDocs: folds CHUNK_FORMAT in, so a chunker change alone invalidates the last deploy', () => {
  // The constant is what a chunker change bumps; the hash must move with it.
  assert.equal(typeof CHUNK_FORMAT, 'string');
  assert.ok(CHUNK_FORMAT.length > 0);
  const digest = createHash('sha256').update('index.md\n# Home\n\0').digest('hex');
  assert.notEqual(hashDocs([{ file: 'index.md', markdown: '# Home' }]), digest);
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

/* checkCustomPromptSchema — drift check for Application#getCustomPrompts'
   backend schema (see the Nova adoption plan, § getCustomPrompts). */
test('checkCustomPromptSchema: clean when every required key is present', () => {
  const r = checkCustomPromptSchema(['goal', 'targetAudience', 'restrictedTopics', 'name', 'knowledge']);
  assert.equal(r.clean, true);
  assert.deepEqual(r.missing, []);
});
test('checkCustomPromptSchema: reports a dropped/renamed required key', () => {
  const r = checkCustomPromptSchema(['goal', 'targetAudience', 'name', 'knowledge']);
  assert.equal(r.clean, false);
  assert.deepEqual(r.missing, ['restrictedTopics']);
});
test('checkCustomPromptSchema: a field beyond the required set is reported as extra, not missing', () => {
  const r = checkCustomPromptSchema(['goal', 'targetAudience', 'restrictedTopics', 'name', 'knowledge', 'tone']);
  assert.equal(r.clean, true);
  assert.deepEqual(r.extra, ['knowledge', 'tone']);
});
test('checkCustomPromptSchema: defaults to REQUIRED_CUSTOM_PROMPT_KEYS when no override is passed', () => {
  const r = checkCustomPromptSchema(REQUIRED_CUSTOM_PROMPT_KEYS);
  assert.equal(r.clean, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
});
