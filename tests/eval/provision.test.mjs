import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// provision.mjs gates on these at module load (see the top-level `if
// (!partnerId || !adminSecret) process.exit(2)`) — set dummies before
// importing so the module under test never touches a live credential.
process.env.AGENTIC_PARTNER_ID ||= 'test-partner';
process.env.AGENTIC_ADMIN_SECRET ||= 'test-secret';

const {
  fileForUrl, stripFrontmatter, splitIntoSections, githubSlugify, SUBCHUNK_THRESHOLD,
  buildBaseDirective, PERSONA_NAME, OPENING_PHRASE, OPENING_INTRO, NOVA_GREET_VAR, KICKOFF_TRIGGER, hashDocs, CHUNK_FORMAT, goToArgsLine, labelHomeLine, HOME_LINE_NOTE, docsFromManifest,
  targetArgsLine, rewriteTargetMarkup, SIGNUP_LINK_TOOL_NAME, signupLinkTool,
  checkCustomPromptSchema, REQUIRED_CUSTOM_PROMPT_KEYS, knowledgeState, entryIndexState, pollEntryStatus, withRollback,
  chunkFormat, findDocMismatch, loadDocContent, isTransientError, withRetry, uploadWithoutOrphans,
  strayUploadIds, staleKnowledgeCategories, findStrayEntries, planCategoryPrune, buildPrunePlan, linkedCategoryId,
  reportUnconfirmed, reportLeftoverDeletes, failedEntriesProblem, canReuseCorpus, sealNewCorpus,
  multirequestFailures, summarizeDeleteFailures, deleteKnowledge, knowledgeProblem, waitForKnowledgeReady, verifyWaitMs,
} = await import('../../server/provision.mjs');
const { lintPersonaIdentity } = await import('../../vendor/sdk/src/management/prompt-lint.js');
const { SILENT_OPENING, isSilentOpening } = await import('../../vendor/sdk/src/management/index.js');
const { KICKOFF_TRIGGER: EVAL_KICKOFF_TRIGGER, SIGNUP_LINK_TOOL } = await import('./personas.mjs');

/* opening model: a Jinja opening_phrase. The scripted intro plays only when the site sends the
   greet flag on a brand-new thread; every other join renders the SDK's silent-opening marker. */
const OPENING_SHAPE = /^\{%- if (\w+) and (\w+) -%\}([\s\S]*)\{%- else -%\}([\s\S]*)\{%- endif -%\}$/;
/** Renders the one if/else shape OPENING_PHRASE uses, with Jinja truthiness (undefined and '' are falsy). */
function renderOpening(template, vars) {
  const m = template.match(OPENING_SHAPE);
  assert.ok(m, 'OPENING_PHRASE keeps the single whitespace-controlled if/else shape');
  const [, a, b, then, otherwise] = m;
  return vars[a] && vars[b] ? then : otherwise;
}
test('opening: OPENING_PHRASE is one whitespace-controlled if/else, guarded on the greet flag and sys__is_new_thread', () => {
  const [, a, b] = OPENING_PHRASE.match(OPENING_SHAPE);
  assert.equal(a, NOVA_GREET_VAR);
  assert.equal(b, 'sys__is_new_thread');
  assert.equal(OPENING_PHRASE, OPENING_PHRASE.trim(), 'no whitespace outside the tags');
  assert.equal((OPENING_PHRASE.match(/\{%/g) || []).length, 3, 'if, else, endif only');
  assert.equal((OPENING_PHRASE.match(/\{%-/g) || []).length, 3, 'every tag strips whitespace on its left');
  assert.equal((OPENING_PHRASE.match(/-%\}/g) || []).length, 3, 'every tag strips whitespace on its right');
});
test('opening: no bare {{variable}} anywhere, so a missing variable can never reach speech', () => {
  assert.doesNotMatch(OPENING_PHRASE, /\{\{|\}\}/);
});
test('opening: the greet flag on a new thread renders the intro', () => {
  assert.equal(renderOpening(OPENING_PHRASE, { [NOVA_GREET_VAR]: 'yes', sys__is_new_thread: true }), OPENING_INTRO);
});
test('opening: the intro is non-empty spoken text that opens with the persona self-introduction', () => {
  assert.ok(OPENING_INTRO.trim().length > 0);
  assert.match(OPENING_INTRO, new RegExp(`^[^.!?]*\\bI'm ${PERSONA_NAME}\\b`));
  assert.doesNotMatch(OPENING_INTRO, /https?:|\/|`|\{|\}|<|>/, 'TTS text: no URLs, paths, code or markup');
});
test('opening: every other combination renders exactly SILENT_OPENING', () => {
  for (const vars of [
    {},
    { sys__is_new_thread: true },
    { [NOVA_GREET_VAR]: '', sys__is_new_thread: true },
    { [NOVA_GREET_VAR]: 'yes', sys__is_new_thread: false },
    { [NOVA_GREET_VAR]: 'yes' },
  ]) {
    const out = renderOpening(OPENING_PHRASE, vars);
    assert.equal(out, SILENT_OPENING, JSON.stringify(vars));
    assert.ok(isSilentOpening(out));
  }
});
test('opening: the eval sends the exact kickoff the obeyRules prompt is keyed on', () => {
  assert.equal(EVAL_KICKOFF_TRIGGER, KICKOFF_TRIGGER);
});

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
/* GitHub keeps one hyphen per whitespace character: a stripped dash or ampersand leaves two
 * spaces, so the id gets `--`. The manifest holds these ids (51 of the live site's sections), and a
 * collapsed slug would find none of them, leaving those chunks without a section pointer. */
test('githubSlugify: each whitespace char is its own hyphen, matching the site and GitHub', () => {
  assert.equal(githubSlugify("What it is — and isn't"), 'what-it-is--and-isnt');
  assert.equal(githubSlugify('Endpoints & Credentials'), 'endpoints--credentials');
  assert.equal(githubSlugify('Step 1 — Get your credentials (~1 minute)'), 'step-1--get-your-credentials-1-minute');
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

/* data-nova-target wrappers: the raw `<div data-nova-target="jsdelivr-quickstart" ...>` in the
   home page's quick-start chunk was the source of the invented "/jsdelivr-quickstart/" path. */
const TARGET_MD = [
  '# Home', '', 'Intro.', '',
  '## Quick start in the browser', '', 'Pin a tag.', '',
  '<div data-nova-target="jsdelivr-quickstart" data-nova-label="Quick-start browser code example">', '',
  '```html', '<script type="module"></script>', '```', '',
  '</div>', '', 'After the example.',
].join('\n');
const HOME = pageOf(['quick-start-browser', 'quick-start-in-the-browser'], ['jsdelivr-quickstart']);

test('targetArgsLine: label plus the finished object', () => {
  assert.equal(targetArgsLine('Code example', '/', 'jsdelivr-quickstart'),
    'go_to arguments for "Code example": {"path":"/","section":"jsdelivr-quickstart"}');
});
test('rewriteTargetMarkup: wrapper becomes a labelled arguments line, its </div> is dropped, the body stays', () => {
  const out = rewriteTargetMarkup(TARGET_MD, '/', HOME);
  assert.ok(out.includes(`\n${targetArgsLine('Quick-start browser code example', '/', 'jsdelivr-quickstart')}\n`));
  assert.ok(!out.includes('<div'));
  assert.ok(!out.includes('</div>'));
  assert.ok(!out.includes('data-nova-target'));
  assert.ok(out.includes('```html\n<script type="module"></script>\n```'));
  assert.ok(out.endsWith('After the example.'));
});
test('rewriteTargetMarkup: a target the manifest does not list keeps only its label', () => {
  const out = rewriteTargetMarkup(TARGET_MD, '/', pageOf(['quick-start-browser', 'quick-start-in-the-browser']));
  assert.ok(out.includes('\nQuick-start browser code example\n'));
  assert.ok(!out.includes('jsdelivr-quickstart'));
  assert.ok(!out.includes('</div>'));
});
test('rewriteTargetMarkup: a wrapper shown inside a fenced code block is documentation and is left alone', () => {
  const md = '# Guide\n\n```html\n<div data-nova-target="x" data-nova-label="X">\n</div>\n```\n';
  assert.equal(rewriteTargetMarkup(md, '/guides/nav/', pageOf(['x'])), md);
});
/* In-page anchor links: the structured-data-forms page's "On this page" list carried
   `#what-it-is--and-isnt` and `#whats-possible--whats-not`; live, the brain sent the section
   `what-it-is--whats-possible-whats` (two manifest keys fused with an id's `--`). */
test('rewriteTargetMarkup: an in-page anchor link keeps its label and loses the heading id', () => {
  const md = '# Guide\n\n**On this page:** [What it is — and isn\'t](#what-it-is--and-isnt) · [What\'s possible / what\'s not](#whats-possible--whats-not)\n\nSee [the SDK repo](https://github.com/kaltura/intelligent-agents-sdk) and [Getting Started](/getting-started/).';
  const out = rewriteTargetMarkup(md, '/guides/structured-data-forms/', pageOf(['what-it-is', 'what-it-is--and-isnt']));
  assert.ok(out.includes('**On this page:** What it is — and isn\'t · What\'s possible / what\'s not\n'));
  assert.ok(!out.includes('#what-it-is--and-isnt'));
  assert.ok(!out.includes('--whats-not'));
  assert.ok(out.includes('[the SDK repo](https://github.com/kaltura/intelligent-agents-sdk)'));
  assert.ok(out.includes('[Getting Started](/getting-started/)'));
});
test('rewriteTargetMarkup: a link to a section of another page keeps its label and loses path and fragment', () => {
  const md = 'For the full map, see **[System Internals Reference\'s "SDK Module Map & Data Flow"](/reference/architecture-reference/module-map-and-data-flow/#sdk-module-map--data-flow)**, or [Getting Started](/getting-started/).';
  const out = rewriteTargetMarkup(md, '/explanation/architecture/', pageOf(['sdk-module-map']));
  assert.equal(out, 'For the full map, see **System Internals Reference\'s "SDK Module Map & Data Flow"**, or [Getting Started](/getting-started/).');
});
test('rewriteTargetMarkup: an anchor link inside a fenced code block is left alone', () => {
  const md = '# Guide\n\n```md\n[Top](#top)\n```\n';
  assert.equal(rewriteTargetMarkup(md, '/guides/nav/', pageOf(['x'])), md);
});
test('splitIntoSections: no chunk carries a heading id from an anchor link', () => {
  const md = '# Guide\n\nJump to [What it is](#what-it-is--and-isnt).\n\n## What it is — and isn\'t\n\nBody with [back to top](#guide).';
  const chunks = splitIntoSections(md, { url: '/guides/forms/' }, pageOf(['what-it-is', 'what-it-is--and-isnt']));
  assert.equal(chunks[0], '# Guide\n\nJump to What it is.');
  assert.equal(chunks[1], `# Guide\n${ARGS('/guides/forms/', 'what-it-is')}\n\n## What it is — and isn't\n\nBody with back to top.`);
});
test('splitIntoSections: the chunk carries both the section object and the target object, never the raw id', () => {
  const chunks = splitIntoSections(TARGET_MD, { url: '/' }, HOME);
  assert.ok(chunks[1].startsWith(`# Home\n${ARGS('/', 'quick-start-browser')}\n\n## Quick start in the browser`));
  assert.ok(chunks[1].includes(targetArgsLine('Quick-start browser code example', '/', 'jsdelivr-quickstart')));
  assert.ok(!chunks[1].includes('data-nova-target'));
  assert.ok(!chunks[1].includes('/jsdelivr-quickstart/'));
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
test('splitIntoSections: an oversized intro chunk with ### subsections and no ## splits at ### boundaries', () => {
  const md = ['# Flat Page', '', `Intro. ${filler(SUBCHUNK_THRESHOLD)}`, '', '### One', '', 'First body.', '', '### Two', '', 'Second body.'].join('\n');
  const chunks = splitIntoSections(md, { url: '/flat/', file: 'flat.md' });
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].startsWith('# Flat Page') && !chunks[0].includes('### One'));
  assert.ok(chunks[1].startsWith(`# Flat Page\n${ARGS('/flat/', null)}\n\n### One`));
  assert.ok(chunks[2].startsWith(`# Flat Page\n${ARGS('/flat/', null)}\n\n### Two`) && !chunks[2].includes('First body'));
});

test('splitIntoSections: a title-only intro folds into the first ### sub-chunk', () => {
  const md = ['# Flat Page', '', '### One', '', `First body. ${filler(SUBCHUNK_THRESHOLD)}`, '', '### Two', '', 'Second body.'].join('\n');
  const chunks = splitIntoSections(md, { url: '/flat/', file: 'flat.md' });
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].startsWith('# Flat Page\n\n### One'));
  assert.ok(chunks[1].includes('### Two'));
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

/* labelHomeLine — the SITE MAP's "/: k1, k2" home line reads like a list of pages; put a note above it. */
test('labelHomeLine: adds the note above the home line only, keeps every other line and the block shape', () => {
  const block = { key: 'siteMap', headerTemplate: 'SITE MAP.', type: 'custom', value: '/: meet-nova, why-sdk\n/guides/x/: a, b\n/reference/: c' };
  const out = labelHomeLine(block);
  assert.equal(out.value, `${HOME_LINE_NOTE}\n/: meet-nova, why-sdk\n/guides/x/: a, b\n/reference/: c`);
  assert.match(out.value, /^\/: meet-nova/m); // the path token itself is untouched
  assert.equal(out.key, 'siteMap');
  assert.equal(out.headerTemplate, 'SITE MAP.');
  assert.equal(block.value, '/: meet-nova, why-sdk\n/guides/x/: a, b\n/reference/: c'); // input untouched
});
test('labelHomeLine: two-line SITE MAP (title line above the path line) keeps the title and notes the home line', () => {
  const value = '@kaltura/intelligent-agents\n/: meet-nova, why-sdk\n\nGuides\n/guides/x/: a, b';
  assert.equal(labelHomeLine({ value }).value, `@kaltura/intelligent-agents\n${HOME_LINE_NOTE}\n/: meet-nova, why-sdk\n\nGuides\n/guides/x/: a, b`);
});
test('labelHomeLine: home line not first, and a manifest without a home page', () => {
  assert.equal(labelHomeLine({ value: '/guides/x/: a\n/: b' }).value, `/guides/x/: a\n${HOME_LINE_NOTE}\n/: b`);
  assert.equal(labelHomeLine({ value: '/guides/x/: a\n/reference/: c' }).value, '/guides/x/: a\n/reference/: c');
});

/* docsFromManifest — the corpus page list is the go_to manifest's page list, one source file per path */
test('docsFromManifest: one doc per manifest page, in manifest order, with the file fileForUrl resolves', () => {
  const manifest = { pages: [
    { path: '/', title: '@kaltura/intelligent-agents', sections: [] },
    { path: '/reference/wire-protocol/whep/', title: 'WHEP', sections: [{ key: 'a', id: 'a' }] },
    { path: '/guides/x/', sections: [] },
  ] };
  assert.deepEqual(docsFromManifest(manifest), [
    { title: '@kaltura/intelligent-agents', url: '/', file: 'index.md' },
    { title: 'WHEP', url: '/reference/wire-protocol/whep/', file: 'reference/wire-protocol/whep.md' },
    { title: '', url: '/guides/x/', file: 'guides/x.md' },
  ]);
});
test('docsFromManifest: an empty manifest yields no docs', () => {
  assert.deepEqual(docsFromManifest({ pages: [] }), []);
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

/* persona identity lint (issue #32). Nova's real shape: PERSONA_NAME is declared via the
   `name` prompt and the Jinja opening's intro branch says "I'm Nova". The lint reads the whole
   template, so this proves it stays clean against what provision() actually sends. */
test('persona identity lint: Nova\'s real shape (name prompt + Jinja opening) is clean', () => {
  const r = lintPersonaIdentity({
    name: PERSONA_NAME,
    openingPhrase: OPENING_PHRASE,
    baseDirective: buildBaseDirective(),
    prompts: [{ value: PERSONA_NAME }],
  });
  assert.deepEqual(r.findings, []);
  assert.equal(r.detectedName, PERSONA_NAME);
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

/* knowledgeState: what provision()/cleanup() act on after discovering an intellect's corpus live. */
const HASH = 'a'.repeat(64);
test('knowledgeState: one record with one category carries its referenceId as the docs hash', () => {
  const s = knowledgeState([{ id: 3013, categoryIds: [418568503] }], [{ id: 418568503, referenceId: HASH, entryIds: ['1_a', '1_b'] }]);
  assert.deepEqual(s, { recordIds: [3013], categoryIds: [418568503], entryIds: ['1_a', '1_b'], docsHash: HASH });
});
test('knowledgeState: a category without a referenceId (upload never finished) has no docs hash', () => {
  const s = knowledgeState([{ id: 1, categoryIds: [2] }], [{ id: 2, referenceId: null, entryIds: ['1_a'] }]);
  assert.equal(s.docsHash, null);
  assert.deepEqual(s.entryIds, ['1_a']);
});
test('knowledgeState: more than one record or category collects every id but trusts no hash', () => {
  const s = knowledgeState(
    [{ id: 1, categoryIds: [10] }, { id: 2, categoryIds: [20] }],
    [{ id: 10, referenceId: HASH, entryIds: ['1_a'] }, { id: 20, referenceId: HASH, entryIds: ['1_b'] }],
  );
  assert.deepEqual(s.recordIds, [1, 2]);
  assert.deepEqual(s.categoryIds, [10, 20]);
  assert.deepEqual(s.entryIds, ['1_a', '1_b']);
  assert.equal(s.docsHash, null);
});
test('knowledgeState: a record whose category is gone yields the record id only', () => {
  const s = knowledgeState([{ id: 1, categoryIds: [10] }], []);
  assert.deepEqual(s, { recordIds: [1], categoryIds: [], entryIds: [], docsHash: null });
});

/* indexing poll: entryStatus rows are tallied per entry, never per call, and time is a fake clock. */
const row = (id, ...statuses) => ({ entry_id: id, documents: statuses.map((status) => ({ objectType: 'KalturaMarkdownAsset', objectId: `d-${id}`, status })) });
function pollHarness(statusFor, { budgetMs = 10 * 60_000, intervalMs = 30_000 } = {}) {
  let t = 0;
  const calls = [];
  const logs = [];
  const run = (ids) => pollEntryStatus('ks', 1, ids, budgetMs, {
    fetchStatus: async (batch) => { calls.push({ at: t, ids: batch }); return statusFor(batch, calls.length); },
    wait: async (ms) => { t += ms; }, now: () => t, intervalMs, log: (m) => logs.push(m),
  });
  return { run, calls, logs, clock: () => t };
}

test('entryIndexState: only a non-empty documents list with a final status counts as finished', () => {
  assert.equal(entryIndexState(undefined), 'pending');
  assert.equal(entryIndexState({ entry_id: 'a' }), 'pending');
  assert.equal(entryIndexState({ entry_id: 'a', documents: [] }), 'pending', '[].every() is true, so an empty list must not pass as indexed');
  assert.equal(entryIndexState(row('a', null)), 'pending');
  assert.equal(entryIndexState(row('a', 'SUCCEEDED', null)), 'pending');
  assert.equal(entryIndexState(row('a', 'SUCCEEDED')), 'ok');
  assert.equal(entryIndexState(row('a', 'TOO_SHORT')), 'ok');
  assert.equal(entryIndexState(row('a', 'NO_CHAPTERS')), 'failed');
  assert.equal(entryIndexState(row('a', 'SUCCEEDED', 'PARSE_ERROR')), 'failed');
  assert.equal(entryIndexState(row('a', 'SOMETHING_NEW')), 'failed', 'an unknown final status is surfaced, not trusted');
});

test('pollEntryStatus: finishes as soon as every entry is indexed and never re-queries finished ids', async () => {
  const seen = new Set();
  const h = pollHarness((ids, n) => ({ entries: ids.filter((id) => id === 'a' || n >= 2).map((id) => { seen.add(id); return row(id, 'SUCCEEDED'); }) }));
  const r = await h.run(['a', 'b']);
  assert.deepEqual(r, { indexed: 2, failed: [], pending: [] });
  assert.deepEqual(h.calls.map((c) => c.ids), [['a', 'b'], ['b']]);
  assert.equal(h.clock(), 30_000, 'one 30 s wait between the two polls');
  assert.ok(h.logs.includes('✓ all entries confirmed indexed'));
});

test('pollEntryStatus: splits large corpora into batches the SDK accepts (max 500, we use 100)', async () => {
  const ids = Array.from({ length: 390 }, (_, i) => `e${i}`);
  const h = pollHarness((batch) => ({ entries: batch.map((id) => row(id, 'SUCCEEDED')) }));
  const r = await h.run(ids);
  assert.equal(r.indexed, 390);
  assert.deepEqual(h.calls.map((c) => c.ids.length), [100, 100, 100, 90]);
});

test('pollEntryStatus: an empty documents list is not "indexed", so the poll keeps waiting and then gives up at the budget', async () => {
  const h = pollHarness((ids) => ({ entries: ids.map((id) => ({ entry_id: id, documents: [] })) }), { budgetMs: 90_000 });
  const r = await h.run(['a']);
  assert.deepEqual(r, { indexed: 0, failed: [], pending: ['a'] });
  assert.equal(h.clock(), 60_000, 'the next poll would start at the deadline, so it never goes out');
  assert.deepEqual(h.calls.map((c) => c.at), [0, 30_000, 60_000]);
  assert.ok(h.logs.some((m) => m.startsWith('⚠ 1/1 entries not confirmed indexed')));
});

test('pollEntryStatus: a slow batch cannot push later batches past the deadline', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `e${i}`);
  let t = 0;
  const calls = [];
  const r = await pollEntryStatus('ks', 1, ids, 60_000, {
    fetchStatus: async (batch) => { calls.push(batch.length); t += 40_000; return { entries: [] }; },
    wait: async (ms) => { t += ms; }, now: () => t, intervalMs: 30_000, log: () => {},
  });
  assert.deepEqual(calls, [100, 100], 'the third batch would start at 80 s, past the 60 s budget');
  assert.equal(r.pending.length, 250);
});

test('pollEntryStatus: a zero budget is one full status pass over every batch, not only the first', async () => {
  const ids = Array.from({ length: 390 }, (_, i) => `e${i}`);
  const h = pollHarness((batch) => ({ entries: batch.map((id) => row(id, 'SUCCEEDED')) }), { budgetMs: 0 });
  const r = await h.run(ids);
  assert.deepEqual(r, { indexed: 390, failed: [], pending: [] });
  assert.deepEqual(h.calls.map((c) => c.ids.length), [100, 100, 100, 90]);
});

test('pollEntryStatus: entries that finish with an error status are named, counted as finished, and stop the wait', async () => {
  const h = pollHarness((ids) => ({ entries: ids.map((id) => row(id, id === 'bad' ? 'NO_CHAPTERS' : 'SUCCEEDED')) }));
  const r = await h.run(['ok', 'bad']);
  assert.deepEqual(r, { indexed: 1, failed: ['bad'], pending: [] });
  assert.equal(h.calls.length, 1);
  assert.ok(h.logs.some((m) => m.includes('bad NO_CHAPTERS')));
  assert.ok(!h.logs.includes('✓ all entries confirmed indexed'), 'a failed entry must not read as a clean pass');
});

test('pollEntryStatus: a flaky status call is retried, and five in a row stop the wait without throwing', async () => {
  let n = 0;
  const flaky = pollHarness((ids) => { if (++n === 1) throw Object.assign(new Error('boom'), { code: 'http_503' }); return { entries: ids.map((id) => row(id, 'SUCCEEDED')) }; });
  assert.equal((await flaky.run(['a'])).indexed, 1);
  const dead = pollHarness(() => { throw new Error('down'); });
  const r = await dead.run(['a']);
  assert.deepEqual(r.pending, ['a']);
  assert.equal(dead.calls.length, 5);
});

test('pollEntryStatus: the budget is the real-world shape, a tail that lands after many polls is still caught', async () => {
  const h = pollHarness((ids, n) => ({ entries: n >= 40 ? ids.map((id) => row(id, 'SUCCEEDED')) : [] }), { budgetMs: 25 * 60_000 });
  const r = await h.run(['a']);
  assert.equal(r.indexed, 1);
  assert.equal(h.clock(), 39 * 30_000);
});

test('withRollback: returns the task result and never runs the undo', async () => {
  let undone = false;
  assert.equal(await withRollback(async () => 42, () => { undone = true; }), 42);
  assert.equal(undone, false);
});

test('withRollback: a failing task runs the undo once, then rethrows the ORIGINAL error', async () => {
  const order = [];
  const boom = new Error('upload failed');
  await assert.rejects(
    withRollback(async () => { order.push('task'); throw boom; }, async () => { order.push('undo'); }),
    (e) => e === boom,
  );
  assert.deepEqual(order, ['task', 'undo']);
});

test('withRollback: a failing undo is logged and never hides the original error', async () => {
  const logs = [];
  const boom = new Error('repoint failed');
  await assert.rejects(
    withRollback(async () => { throw boom; }, () => { throw Object.assign(new Error('x'), { code: 'server_error' }); }, (...a) => logs.push(a.join(' '))),
    (e) => e === boom,
  );
  assert.deepEqual(logs, ['rollback failed: server_error']);
});

/* K3: the chunk version is derived from the chunker, not bumped by hand. */
test('chunkFormat: CHUNK_FORMAT is a readable version derived from the chunker output', () => {
  assert.match(CHUNK_FORMAT, /^chunks-[0-9a-f]{12}$/);
  assert.equal(chunkFormat(), CHUNK_FORMAT);
});

test('chunkFormat: any change to what the chunker emits changes the version', () => {
  assert.notEqual(chunkFormat((md, doc, page) => splitIntoSections(md, doc, page).map((c) => c.replace('Part of section', 'Section'))), CHUNK_FORMAT);
  assert.notEqual(chunkFormat((md, doc, page) => splitIntoSections(md, doc, page).slice(1)), CHUNK_FORMAT);
});

test('chunkFormat: the fixed sample reaches the chunker branches a hand bump used to cover', () => {
  let chunks;
  chunkFormat((md, doc, page) => (chunks = splitIntoSections(md, doc, page)));
  const text = chunks.join('\n');
  assert.ok(text.includes('Part of section: Beta'), 'oversized ## section split at ###');
  assert.ok(text.includes('go_to arguments for "Table one"'), 'target wrapper rewritten');
  assert.ok(!text.includes('data-nova-target') && !text.includes('(#alpha)') && !text.includes('(/other/'), 'markup and links reduced');
  assert.ok(chunks.some((c) => c.startsWith('# Sample\n') && c.includes('### Intro one')), 'oversized intro keeps its first sub-chunk');
  assert.ok(chunks.some((c) => c.includes('### Intro two') && c.includes('go_to arguments')), 'oversized intro split at ###');
  assert.ok(!chunks.some((c) => c.startsWith('## Not a heading')), 'a fenced ## never starts a chunk');
  assert.ok(chunks.some((c) => c.includes('## Delta')), 'closing-hash heading kept');
});

/* K4: the manifest and the checkout must list the same pages. */
async function siteFixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'nova-site-'));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, 'src', rel, '..'), { recursive: true });
    await writeFile(join(dir, 'src', rel), body);
  }
  return dir;
}
const docsFor = (...urls) => urls.map((url) => ({ url, file: fileForUrl(url), title: '' }));

test('findDocMismatch: names pages only in the manifest and files only in the checkout', () => {
  const r = findDocMismatch(docsFor('/', '/guides/a/', '/guides/gone/'), ['index.md', 'guides/a.md', 'guides/new.md']);
  assert.deepEqual(r, { missingSource: ['/guides/gone/'], unpublished: ['guides/new.md'] });
  assert.deepEqual(findDocMismatch(docsFor('/'), ['index.md']), { missingSource: [], unpublished: [] });
});

test('loadDocContent: a page missing on either side fails up front and names every page', async () => {
  const dir = await siteFixture({ 'index.md': '# Home', 'guides/new.md': '# New', '_includes/partial.md': '# skip', '_data/nav.js': '' });
  await assert.rejects(loadDocContent(dir, docsFor('/', '/guides/gone/')), (e) => {
    assert.match(e.message, /In the manifest only: \/guides\/gone\//);
    assert.match(e.message, /In the checkout only: guides\/new\.md/);
    assert.ok(!e.message.includes('partial.md'), 'include folders are not pages');
    return true;
  });
});

test('loadDocContent: matching pages load with their front matter stripped', async () => {
  const dir = await siteFixture({ 'index.md': '---\ntitle: Home\n---\n# Home', 'guides/a.md': '# A' });
  const docs = docsFor('/', '/guides/a/');
  await loadDocContent(dir, docs);
  assert.deepEqual(docs.map((d) => d.markdown), ['# Home', '# A']);
});

/* K6: transient upload failures are retried with backoff. */
test('isTransientError: 5xx, 429 and a missing HTTP response retry; client and OVP errors do not', () => {
  for (const e of [{ status: 503 }, { status: 500, code: 'server_error' }, { status: 429 }, { code: 'server_error' }, new TypeError('fetch failed')]) assert.equal(isTransientError(e), true, JSON.stringify(e));
  for (const e of [{ status: 400, code: 'bad_request' }, { status: 403 }, { code: 'ovp_error' }]) assert.equal(isTransientError(e), false, JSON.stringify(e));
});

test('withRetry: retries a transient failure with doubling backoff and logs each retry', async () => {
  const waits = [];
  const logs = [];
  let n = 0;
  const r = await withRetry(async () => { if (++n < 3) throw Object.assign(new Error('x'), { status: 502, code: 'server_error' }); return 'ok'; },
    { label: 'upload a.md', wait: async (ms) => waits.push(ms), log: (m) => logs.push(m) });
  assert.equal(r, 'ok');
  assert.deepEqual(waits, [2000, 4000]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /upload a\.md failed \(server_error\), retry 1\/3 in 2s/);
});

test('withRetry: a non-transient error is not retried, and the last error surfaces once attempts run out', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw Object.assign(new Error('bad'), { status: 400 }); }, { wait: async () => {}, log: () => {} }), /bad/);
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(withRetry(async () => { n++; throw Object.assign(new Error(`down ${n}`), { status: 503 }); }, { attempts: 3, wait: async () => {}, log: () => {} }), /down 3/);
  assert.equal(n, 3);
});

/* K2: slow indexing only alerts. The docs hash is stored at the swap, whatever the poll found. */
test('reportUnconfirmed: pending entries produce a warning annotation and a job-summary line', () => {
  const logs = [];
  const summary = [];
  const msg = reportUnconfirmed({ pending: ['a', 'b'] }, 390, 25 * 60_000, {
    env: { GITHUB_STEP_SUMMARY: '/tmp/summary.md' }, log: (m) => logs.push(m), appendSummary: (f, t) => summary.push([f, t]),
  });
  assert.match(msg, /^2 of 390 knowledge entries are not confirmed indexed yet \(waited 25 min\)\. Nothing was rebuilt/);
  assert.deepEqual(logs, [`::warning::${msg}`]);
  assert.deepEqual(summary, [['/tmp/summary.md', `- :warning: ${msg}\n`]]);
});

test('reportUnconfirmed: no summary file outside CI, and nothing at all when nothing is pending', () => {
  const logs = [];
  const append = () => assert.fail('must not write a summary');
  assert.ok(reportUnconfirmed({ pending: ['a'] }, 1, 0, { env: {}, log: (m) => logs.push(m), appendSummary: append }));
  assert.equal(logs.length, 1);
  assert.equal(reportUnconfirmed({ pending: [] }, 1, 0, { env: { GITHUB_STEP_SUMMARY: '/x' }, log: (m) => logs.push(m), appendSummary: append }), null);
  assert.equal(logs.length, 1);
});

test('reportLeftoverDeletes: leftover deletes only warn and add a summary line, nothing else', () => {
  const logs = [];
  const summary = [];
  const msg = reportLeftoverDeletes([{ kind: 'entry', id: 'e1', code: 'ACTION_BLOCKED' }, { kind: 'entry', id: 'e2', code: 'ACTION_BLOCKED' }], {
    env: { GITHUB_STEP_SUMMARY: '/tmp/summary.md' }, log: (m) => logs.push(m), appendSummary: (f, t) => summary.push([f, t]),
  });
  assert.match(msg, /^2 delete call\(s\) for the previous corpus failed or were throttled\. The new corpus is live/);
  assert.deepEqual(logs, [`::warning::${msg}`]);
  assert.deepEqual(summary, [['/tmp/summary.md', `- :warning: ${msg}\n`]]);
  assert.equal(reportLeftoverDeletes([], { env: { GITHUB_STEP_SUMMARY: '/x' }, log: () => assert.fail('silent'), appendSummary: () => assert.fail('silent') }), null);
});

test('failedEntriesProblem: only entries with an error status are a problem, pending ones are not', () => {
  assert.equal(failedEntriesProblem({ failed: [], pending: ['a'] }), null);
  assert.match(failedEntriesProblem({ failed: ['a', 'b'], pending: [] }), /^2 knowledge entries finished indexing with an error status/);
});

test('swap: the hash is stored right after the swap even when the indexing poll timed out, and the run has no problems', async () => {
  const h = pollHarness(() => ({ entries: [] }), { budgetMs: 90_000 });
  const tally = await h.run(['a', 'b']);
  assert.deepEqual(tally.pending, ['a', 'b'], 'the poll timed out');
  const logs = [];
  reportUnconfirmed(tally, 2, h.clock(), { env: {}, log: (m) => logs.push(m) });
  assert.ok(logs[0].startsWith('::warning::2 of 2 knowledge entries are not confirmed indexed yet'));
  assert.equal(failedEntriesProblem(tally), null, 'a timeout is not a problem, so the run exits 0');
  const order = [];
  const problems = await sealNewCorpus({ storeHash: async () => { order.push('hash'); }, removePrevious: async () => { order.push('delete old'); return []; } });
  assert.deepEqual(order, ['hash', 'delete old']);
  assert.deepEqual(problems, []);
});

test('sealNewCorpus: a failed hash write is a problem but still removes the previous corpus', async () => {
  const order = [];
  const problems = await sealNewCorpus({
    storeHash: async () => { throw Object.assign(new Error('boom'), { code: 'server_error' }); },
    removePrevious: async () => { order.push('delete old'); return ['1 delete call(s) failed']; },
  });
  assert.deepEqual(order, ['delete old']);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /docs hash not stored \(server_error\), so the next run rebuilds/);
  assert.deepEqual(await sealNewCorpus({ storeHash: async () => {}, removePrevious: null }), [], 'a first deploy has no previous corpus');
});

const liveCorpus = { recordIds: [1], categoryIds: [2], entryIds: ['a', 'b'], docsHash: 'h1' };
const reuse = (live, hash, force, tally) => {
  const logs = [];
  const alerts = [];
  return canReuseCorpus(live, hash, force, { checkStatus: async () => tally, report: (...a) => alerts.push(a), log: (m) => logs.push(m) })
    .then((reused) => ({ reused, logs, alerts }));
};

test('canReuseCorpus: a matching hash with entries still pending is reused and only alerts', async () => {
  const r = await reuse(liveCorpus, 'h1', false, { indexed: 1, failed: [], pending: ['b'] });
  assert.equal(r.reused, true);
  assert.equal(r.alerts.length, 1);
  assert.deepEqual(r.alerts[0][0].pending, ['b']);
  assert.deepEqual(r.logs, []);
});

test('canReuseCorpus: an entry with an error status rebuilds, a clean matching corpus does not', async () => {
  const bad = await reuse(liveCorpus, 'h1', false, { indexed: 1, failed: ['b'], pending: [] });
  assert.equal(bad.reused, false);
  assert.match(bad.logs[0], /1 entries of the live corpus finished indexing with an error status, rebuilding/);
  assert.equal((await reuse(liveCorpus, 'h1', false, { indexed: 2, failed: [], pending: [] })).reused, true);
});

test('canReuseCorpus: a changed hash, a forced rebuild or no live corpus rebuilds without any status call', async () => {
  const noStatus = async () => assert.fail('must not check status');
  for (const [live, hash, force] of [[liveCorpus, 'h2', false], [liveCorpus, 'h1', true], [null, 'h1', false], [{ ...liveCorpus, docsHash: null }, 'h1', false]]) {
    assert.equal(await canReuseCorpus(live, hash, force, { checkStatus: noStatus }), false);
  }
});

/* K5: delete results are read, failures reported. */
const delCalls = [
  { service: 'baseentry', action: 'delete', entryId: 'e1' },
  { service: 'baseentry', action: 'delete', entryId: 'e2' },
  { service: 'category', action: 'delete', id: 7 },
];
const apiError = (code) => ({ objectType: 'KalturaAPIException', code, message: code });

test('multirequestFailures: reads each result; an exception inside HTTP 200 is a failure, not-found is already deleted', () => {
  assert.deepEqual(multirequestFailures(delCalls, [{}, apiError('ENTRY_ID_NOT_FOUND'), apiError('CATEGORY_LOCKED')]), [{ kind: 'category', id: 7, code: 'CATEGORY_LOCKED' }]);
  assert.deepEqual(multirequestFailures(delCalls, [apiError('ENTRY_LOCKED'), {}, {}]), [{ kind: 'entry', id: 'e1', code: 'ENTRY_LOCKED' }]);
  assert.deepEqual(multirequestFailures(delCalls, [{}, {}]), [{ kind: 'category', id: 7, code: 'NO_RESULT' }], 'a missing result is a failure');
  assert.deepEqual(multirequestFailures(delCalls, [null, null, null]), [], 'a delete that worked returns null');
});

const noWait = { wait: async () => {}, baseMs: 0 };

test('deleteKnowledge: a failed entry delete is returned and logged, and the category is kept', async () => {
  const logs = [];
  const seen = [];
  const failures = await deleteKnowledge('ks', { recordIds: [11], categoryIds: [7], entryIds: ['e1', 'e2'] }, {
    multirequest: async (calls) => { seen.push(...calls); return [apiError('ENTRY_LOCKED'), null]; },
    log: (m) => logs.push(m), ...noWait,
  });
  assert.deepEqual(failures, [{ kind: 'entry', id: 'e1', code: 'ENTRY_LOCKED' }]);
  assert.ok(!seen.some((c) => c.service === 'category'), 'no category delete after an entry delete failed');
  assert.equal(logs.length, 2);
  assert.match(logs[0], /kept category 7/);
  assert.match(logs[1], /1 knowledge delete\(s\) failed: entry e1: ENTRY_LOCKED/);
});

test('deleteKnowledge: entries go in small batches, then the categories in their own call', async () => {
  const batches = [];
  const entryIds = Array.from({ length: 25 }, (_, i) => `e${i}`);
  const failures = await deleteKnowledge('ks', { categoryIds: [7, 8], entryIds }, {
    multirequest: async (calls) => { batches.push(calls); return calls.map(() => null); }, log: () => assert.fail('silent'), ...noWait,
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(batches.map((b) => b.length), [10, 10, 5, 2]);
  assert.ok(batches.slice(0, 3).every((b) => b.every((c) => c.service === 'baseentry')));
  assert.ok(batches[3].every((c) => c.service === 'category'));
});

test('deleteKnowledge: throttled deletes are retried with a doubling pause, then succeed', async () => {
  const waits = [];
  let n = 0;
  const failures = await deleteKnowledge('ks', { categoryIds: [7], entryIds: ['e1', 'e2'] }, {
    multirequest: async (calls) => (calls[0].service === 'category' || n++ > 0 ? calls.map(() => null) : [apiError('ACTION_BLOCKED'), null]),
    wait: async (ms) => { waits.push(ms); }, baseMs: 100, log: () => assert.fail('silent'),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(waits, [100], 'one backoff before the retry round');
});

test('deleteKnowledge: deletes that stay throttled are final after the last round, and the category is kept', async () => {
  const seen = [];
  const failures = await deleteKnowledge('ks', { categoryIds: [7], entryIds: ['e1'] }, {
    multirequest: async (calls) => { seen.push(calls); return [apiError('ACTION_BLOCKED')]; }, rounds: 3, log: () => {}, ...noWait,
  });
  assert.deepEqual(failures, [{ kind: 'entry', id: 'e1', code: 'ACTION_BLOCKED' }]);
  assert.equal(seen.length, 3);
  assert.ok(seen.flat().every((c) => c.service === 'baseentry'));
});

test('deleteKnowledge: a batch that cannot be sent is retried; a clean delete returns nothing and logs nothing', async () => {
  const logs = [];
  const failed = await deleteKnowledge('ks', { categoryIds: [7], entryIds: ['e1'] }, { multirequest: async () => { throw new Error('multirequest HTTP 502'); }, rounds: 2, log: (m) => logs.push(m), ...noWait });
  assert.deepEqual(failed, [{ kind: 'entry', id: 'e1', code: 'multirequest HTTP 502' }]);
  assert.equal(logs.length, 2);
  const clean = await deleteKnowledge('ks', { recordIds: [1], categoryIds: [7], entryIds: ['e1'] }, { multirequest: async (calls) => calls.map(() => ({})), log: (m) => logs.push(m), ...noWait });
  assert.deepEqual(clean, []);
  assert.equal(logs.length, 2, 'the clean run logged nothing');
});

test('deleteKnowledge: a permanent error is not retried', async () => {
  let calls = 0;
  const failures = await deleteKnowledge('ks', { entryIds: ['e1'] }, { multirequest: async () => { calls++; return [apiError('ENTRY_LOCKED')]; }, log: () => {}, ...noWait });
  assert.equal(calls, 1);
  assert.equal(failures[0].code, 'ENTRY_LOCKED');
});

test('deleteKnowledge: never deletes the knowledge record, only the entries and category', async () => {
  const seen = [];
  await deleteKnowledge('ks', { recordIds: [11], categoryIds: [7], entryIds: ['e1'] }, { multirequest: async (calls) => { seen.push(...calls); return calls.map(() => null); }, log: () => {}, ...noWait });
  assert.deepEqual(seen.map((c) => `${c.service}/${c.action}`), ['baseentry/delete', 'category/delete']);
});

test('isTransientError: an SDK timeout (status 0) is transient', () => {
  assert.equal(isTransientError({ status: 0, code: 'error' }), true);
  assert.equal(isTransientError({ status: 404, code: 'not_found' }), false);
});

test('uploadWithoutOrphans: sweeps after every failed try, retries, and returns the upload', async () => {
  const events = [];
  let n = 0;
  const out = await uploadWithoutOrphans(
    async () => { events.push('upload'); if (++n < 3) throw Object.assign(new Error('timeout'), { status: 0, code: 'error' }); return { entryId: 'e9' }; },
    async () => { events.push('sweep'); },
    { wait: async () => {}, log: () => {} },
  );
  assert.deepEqual(out, { entryId: 'e9' });
  assert.deepEqual(events, ['upload', 'sweep', 'upload', 'sweep', 'upload']);
});

test('uploadWithoutOrphans: sweeps after the last failed try; a failing sweep never hides the upload error', async () => {
  const logs = [];
  let sweeps = 0;
  await assert.rejects(
    uploadWithoutOrphans(
      async () => { throw Object.assign(new Error('slow'), { status: 503 }); },
      async () => { sweeps++; throw new Error('sweep broke'); },
      { attempts: 2, wait: async () => {}, log: (m) => logs.push(m) },
    ),
    /slow/,
  );
  assert.equal(sweeps, 2);
  assert.ok(logs.some((m) => /could not clear a stray entry: sweep broke/.test(m)));
});

test('uploadWithoutOrphans: a permanent error is swept once and not retried', async () => {
  let uploads = 0, sweeps = 0;
  await assert.rejects(uploadWithoutOrphans(async () => { uploads++; throw Object.assign(new Error('bad'), { status: 400 }); }, async () => { sweeps++; }, { wait: async () => {}, log: () => {} }), /bad/);
  assert.deepEqual([uploads, sweeps], [1, 1]);
});

test('strayUploadIds: keeps out recorded entries and entries of another build', () => {
  const rows = [{ id: 'a' }, { id: 'b', categoriesIds: '7' }, { id: 'c', categoriesIds: '7,9' }, { id: 'd', categoriesIds: '8' }];
  assert.deepEqual(strayUploadIds(rows, ['b'], 7), ['a', 'c']);
});

test('planCategoryPrune: skips entries shared with a linked category and entries under an hour old', () => {
  const cats = [
    { id: 1, entries: [{ id: 'old', createdAt: 10 }, { id: 'shared', createdAt: 10, categoriesIds: '1,99' }] },
    { id: 2, entries: [{ id: 'old2', createdAt: 10 }, { id: 'fresh', createdAt: 5_000 }] },
  ];
  assert.deepEqual(planCategoryPrune(cats, new Set([99]), 1_000), { entryIds: ['old', 'old2'], categoryIds: [1], keptCategoryIds: [2] });
});

test('staleKnowledgeCategories: only old, unlinked docs-site-avatar-knowledge categories', () => {
  const cats = [
    { id: 1, name: 'docs-site-avatar-knowledge-1', createdAt: 100 },
    { id: 2, name: 'docs-site-avatar-knowledge-2', createdAt: 100 },
    { id: 3, name: 'docs-site-avatar-knowledge-3', createdAt: 5_000 },
    { id: 4, name: 'someone-elses', createdAt: 100 },
  ];
  assert.deepEqual(staleKnowledgeCategories(cats, new Set([2]), 1_000).map((c) => c.id), [1]);
});

test('findStrayEntries: picks categoryless Nova entries and pages past the 10,000 result cap', async () => {
  const rows = Array.from({ length: 10_500 }, (_, i) => ({
    id: `x${i}`, createdAt: 1_000 + i, name: i % 2 ? 'docs-site-avatar-a.md' : 'other-doc', categories: i % 5 === 0 ? 'cat' : '',
  }));
  const list = async (filter, pager) => {
    const inWindow = rows.filter((r) => r.createdAt >= filter.createdAtGreaterThanOrEqual && r.createdAt <= filter.createdAtLessThanOrEqual);
    const start = (pager.pageIndex - 1) * pager.pageSize;
    return { objects: inWindow.slice(start, start + pager.pageSize) };
  };
  const stray = await findStrayEntries(list, { before: 99_999, since: 0 });
  const expected = rows.filter((r) => r.name.startsWith('docs-site-avatar-') && !r.categories).map((r) => r.id);
  assert.deepEqual(stray.sort(), expected.sort());
});

test('findStrayEntries: fails loudly when a whole second holds more than the cap', async () => {
  const list = async (filter, pager) => ({ objects: pager.pageIndex <= 20 ? Array.from({ length: pager.pageSize }, (_, i) => ({ id: `s${pager.pageIndex}-${i}`, createdAt: 5, name: 'x', categories: 'c' })) : [] });
  await assert.rejects(findStrayEntries(list, { before: 10, since: 0 }), /share the createdAt second/);
});

test('summarizeDeleteFailures: names the first few and counts the rest', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'entry', id: `e${i}`, code: 'X' }));
  const line = summarizeDeleteFailures(many);
  assert.match(line, /^12 knowledge delete\(s\) failed: entry e0: X;/);
  assert.match(line, /and 2 more$/);
  assert.ok(!line.includes('e11'));
});

/* K7: the eval entry point waits for the live corpus to finish indexing. */
test('knowledgeProblem: a corpus can be checked only when it is linked and a deploy stored its hash', () => {
  assert.equal(knowledgeProblem(liveCorpus), null);
  assert.match(knowledgeProblem(null), /links no knowledge record/);
  assert.match(knowledgeProblem({ ...liveCorpus, docsHash: null }), /no docs hash/);
});

test('waitForKnowledgeReady: waits through pending polls, then passes once every entry is indexed', async () => {
  const h = pollHarness((ids, n) => ({ entries: n >= 3 ? ids.map((id) => row(id, 'SUCCEEDED')) : [] }), { budgetMs: 45 * 60_000 });
  let seen;
  const total = await waitForKnowledgeReady(liveCorpus, 45 * 60_000, (recordId, entryIds, budget) => { seen = [recordId, budget]; return h.run(entryIds); });
  assert.equal(total, 2);
  assert.deepEqual(seen, [1, 45 * 60_000]);
  assert.equal(h.clock(), 2 * 30_000, 'it waited two intervals before the third poll saw both indexed');
});

test('waitForKnowledgeReady: running out of budget throws the not-finished message and says nothing was rebuilt', async () => {
  const h = pollHarness((ids) => ({ entries: ids.filter((id) => id === 'a').map((id) => row(id, 'SUCCEEDED')) }), { budgetMs: 2 * 60_000 });
  await assert.rejects(
    waitForKnowledgeReady(liveCorpus, 2 * 60_000, (r, ids) => h.run(ids)),
    { message: 'indexing not finished after 2 min (1 of 2 entries); re-run the eval later, nothing was rebuilt' },
  );
});

test('waitForKnowledgeReady: an error-status entry or a missing hash fails at once with the rebuild hint', async () => {
  const h = pollHarness((ids) => ({ entries: ids.map((id) => row(id, id === 'b' ? 'NO_CHAPTERS' : 'SUCCEEDED')) }));
  await assert.rejects(waitForKnowledgeReady(liveCorpus, 60_000, (r, ids) => h.run(ids)), /1 of 2 entries finished indexing with an error status\. Run Redeploy Nova with rebuild ticked/);
  const noPoll = () => assert.fail('must not poll');
  await assert.rejects(waitForKnowledgeReady({ ...liveCorpus, docsHash: null }, 60_000, noPoll), /no docs hash/);
  await assert.rejects(waitForKnowledgeReady(null, 60_000, noPoll), /links no knowledge record/);
});

test('verifyWaitMs: defaults to 45 minutes, takes --index-wait-minutes, rejects a bad value', () => {
  assert.equal(verifyWaitMs(['--verify-knowledge']), 45 * 60_000);
  assert.equal(verifyWaitMs(['--verify-knowledge', '--index-wait-minutes', '10']), 10 * 60_000);
  for (const bad of ['0', '-1', 'abc']) assert.throws(() => verifyWaitMs(['--index-wait-minutes', bad]), /positive number/);
  assert.throws(() => verifyWaitMs(['--index-wait-minutes']), /positive number/);
});

/* sign-up link client tool (#196) */
test('signup link tool: fire-and-forget client tool with no args, so the model cannot pick a URL', () => {
  const t = signupLinkTool();
  assert.equal(t.name, 'show_signup_link');
  assert.equal(t.type, 'client');
  assert.equal(t.wait_for_response, false);
  assert.ok(!t.args || Object.keys(t.args).length === 0);
  assert.ok(!/https?:\/\//.test(JSON.stringify(t)), 'no URL in the tool config');
});
test('signup link tool: the eval persona file uses the same tool name', () => {
  assert.equal(SIGNUP_LINK_TOOL, SIGNUP_LINK_TOOL_NAME);
});

test('--knowledge-only without --reuse fails before any network call', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['server/provision.mjs', '--knowledge-only'], {
    env: { ...process.env, AGENTIC_PARTNER_ID: '1', AGENTIC_ADMIN_SECRET: 'x' }, encoding: 'utf8', timeout: 20000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--knowledge-only needs --reuse/);
  assert.doesNotMatch(r.stdout, /admin token/);
});

test('--help lists --knowledge-only', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['server/provision.mjs', '--help'], {
    env: { ...process.env, AGENTIC_PARTNER_ID: '1', AGENTIC_ADMIN_SECRET: 'x' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--knowledge-only/);
});

test('--prune-orphans runs alone, and --dry-run alone still needs --cleanup or --prune-orphans', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (...args) => spawnSync(process.execPath, ['server/provision.mjs', ...args], {
    env: { ...process.env, AGENTIC_PARTNER_ID: '1', AGENTIC_ADMIN_SECRET: 'x' }, encoding: 'utf8', timeout: 20000,
  });
  const mixed = run('--prune-orphans', '--rebuild');
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /--prune-orphans runs alone/);
  const lone = run('--dry-run');
  assert.notEqual(lone.status, 0);
  assert.match(lone.stderr, /only apply with --cleanup or --prune-orphans/);
  assert.match(run('--help').stdout, /--prune-orphans/);
  const withVerify = run('--verify-knowledge', '--prune-orphans');
  assert.notEqual(withVerify.status, 0);
  assert.match(withVerify.stderr, /--prune-orphans runs alone/);
});

const pruneIo = (over = {}) => ({
  intellects: async function* () { yield { id: 10 }; yield { id: 11 }; },
  getLinkage: async (id) => ({ knowledgeIds: [id * 10] }),
  getRecord: async (id) => ({ config: { sources: [{ categoryIds: [id === 100 ? 1 : 2] }] } }),
  categories: async () => [{ id: 1, name: 'docs-site-avatar-knowledge-a', createdAt: 5 }, { id: 3, name: 'docs-site-avatar-knowledge-b', createdAt: 5 }],
  categoryEntries: async () => [{ id: 'e1', createdAt: 5, categoriesIds: '3' }],
  strays: async () => ['s1'],
  ...over,
});

test('buildPrunePlan: keeps linked categories and plans the unlinked one', async () => {
  const plan = await buildPrunePlan(pruneIo(), { before: 100, liveConfigId: 10 });
  assert.deepEqual([...plan.linkedIds].sort(), [1, 2]);
  assert.deepEqual(plan.categoryIds, [3]);
  assert.deepEqual(plan.entryIds, ['e1']);
  assert.deepEqual(plan.stray, ['s1']);
});

test('buildPrunePlan: fails closed when the live corpus cannot be proven', async () => {
  const run = (io, liveConfigId = 10) => buildPrunePlan(pruneIo(io), { before: 100, liveConfigId });
  await assert.rejects(run({}, null), /no configId/);
  await assert.rejects(run({ intellects: async function* () {} }), /not in the intellect list/);
  await assert.rejects(run({}, 99), /not in the intellect list/);
  await assert.rejects(run({ getLinkage: async () => ({}) }), /links no knowledge category/);
  await assert.rejects(run({ getLinkage: async () => null }), /links no knowledge category/);
  await assert.rejects(run({ getRecord: async () => ({ config: {} }) }), /has no sources/);
  await assert.rejects(run({ getRecord: async () => ({ config: { sources: [{}] } }) }), /links no knowledge category/);
});

test('buildPrunePlan: keeps a category whose entry list hit the cap, but still deletes the entries seen', async () => {
  const full = Array.from({ length: 10_000 }, (_, i) => ({ id: `e${i}`, createdAt: 5, categoriesIds: '3' }));
  const plan = await buildPrunePlan(pruneIo({ categoryEntries: async () => full }), { before: 100, liveConfigId: 10 });
  assert.deepEqual(plan.categoryIds, []);
  assert.deepEqual(plan.cappedCategoryIds, [3]);
  assert.equal(plan.entryIds.length, 10_000);
});

test('findStrayEntries asks for every corpus entry status', async () => {
  const filters = [];
  await findStrayEntries(async (filter) => { filters.push(filter); return { objects: [] }; }, { before: 100 });
  assert.equal(filters[0].statusIn, '-1,-2,0,1,2,7,4');
});

test('linkedCategoryId: reads a plain id and the leaf of a path id', () => {
  assert.equal(linkedCategoryId('413'), 413);
  assert.equal(linkedCategoryId(413), 413);
  assert.equal(linkedCategoryId('408418612>408418622>408418642>408418722'), 408418722);
  assert.ok(Number.isNaN(linkedCategoryId('abc')));
  assert.ok(Number.isNaN(linkedCategoryId('1>')));
});

test('buildPrunePlan: a path-style link protects its leaf category', async () => {
  const plan = await buildPrunePlan(pruneIo({
    getRecord: async (id) => ({ config: { sources: [{ categoryIds: [id === 100 ? '9>1' : 2] }] } }),
  }), { before: 100, liveConfigId: 10 });
  assert.ok(plan.linkedIds.has(1), 'category 1 is linked through the path 9>1');
  assert.ok(!plan.categoryIds.includes(1));
});

test('buildPrunePlan: fails closed on a category link it cannot read', async () => {
  await assert.rejects(buildPrunePlan(pruneIo({
    getRecord: async () => ({ config: { sources: [{ categoryIds: ['not-an-id'] }] } }),
  }), { before: 100, liveConfigId: 10 }), /not a category id/);
});
