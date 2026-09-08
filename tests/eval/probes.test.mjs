import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolNames, probeLatency, probeTools, probeCompleteness, probeRelevance,
  probeSingleToolCallPerTurn, probeNoKbSearchWhenOff, probeRestrictedTopicRefusal,
  probeNoPromptLeak, probeKickoffHandling, probeResumeKickoff, probeNoInventedUrl, probeNoInventedPath,
  probeNavPathMatch, probeNoInventedApi, probeSectionResolvable, probeSectionMatch, probeNoScreenNarration, probeNoSplitPath,
  scoreTurn, DIMENSIONS, RELEASE_BLOCKING,
} from './probes.mjs';
import { unionScored } from './engine.mjs';
import { versionKeywords } from './personas.mjs';
import { quickStartSdkTag } from './site-data.mjs';

test('versionKeywords: bare major.minor plus the spoken forms a voice answer produces', () => {
  assert.deepEqual(versionKeywords('v1.17.0'), ['1.17', 'one point seventeen', 'one point one seven']);
  assert.deepEqual(versionKeywords('v2.3.1'), ['2.3', 'two point three']);
  assert.deepEqual(versionKeywords('v1.24.0'), ['1.24', 'one point twenty four', 'one point two four']);
});
test('quickStartSdkTag: reads the jsDelivr pin from the home page, null when absent', () => {
  assert.equal(quickStartSdkTag('import x from "https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@v1.17.0/src/experience/index.js";'), 'v1.17.0');
  assert.equal(quickStartSdkTag('no pin here'), null);
});

const siteData = {
  baseUrl: 'https://kaltura.github.io/intelligent-agents-sdk',
  routes: [
    { url: '/', title: 'Home' },
    { url: '/getting-started/', title: 'Getting Started' },
    { url: '/guides/voice-input-modes/', title: 'Voice Input Modes' },
  ],
  manifest: {
    version: 1,
    pages: [
      { path: '/', sections: [{ key: 'quick-start', id: 'quick-start', text: 'Quick start' }, { key: 'license', id: 'license', text: 'License' }] },
      {
        path: '/getting-started/',
        sections: [
          { key: 'install', id: 'install', text: 'Install the SDK' },
          { key: 'first-agent', id: 'first-agent', text: 'Your first agent' },
        ],
      },
      { path: '/guides/voice-input-modes/', sections: [{ key: 'push-to-talk', id: 'push-to-talk', text: 'Push to talk' }] },
    ],
  },
};

/* toolNames */
test('toolNames: extracts names in order', () => {
  assert.deepEqual(toolNames([{ name: 'a' }, { name: 'b' }]), ['a', 'b']);
});
test('toolNames: empty/undefined input yields empty array', () => {
  assert.deepEqual(toolNames(undefined), []);
});

/* latency */
test('latency: snappy reply passes', () => {
  const r = probeLatency(2000);
  assert.equal(r.pass, true); assert.equal(r.tier, 'snappy');
});
test('latency: too-slow reply fails', () => {
  const r = probeLatency(15000);
  assert.equal(r.pass, false); assert.equal(r.tier, 'slow');
});

/* tools */
test('tools: missing an expected tool fails', () => {
  const r = probeTools({ expectTools: ['go_to'] }, []);
  assert.equal(r.pass, false);
});
test('tools: forbidden tool firing fails even if expected ones fired', () => {
  const r = probeTools({ expectTools: ['go_to'], forbidTools: ['go_to'] },
    [{ name: 'go_to' }]);
  assert.equal(r.pass, false);
});
test('tools: no expectations always passes', () => {
  const r = probeTools({}, [{ name: 'go_to' }]);
  assert.equal(r.pass, true);
});

/* completeness */
test('completeness: skipped when expectation says so', () => {
  assert.equal(probeCompleteness({ skipCompleteness: true }, ''), null);
});
test('completeness: a substantive reply passes', () => {
  const r = probeCompleteness({}, 'x'.repeat(150));
  assert.equal(r.pass, true);
});
test('completeness: a near-empty reply fails', () => {
  const r = probeCompleteness({}, 'ok');
  assert.equal(r.pass, false);
});

/* relevance */
test('relevance: not applicable when no keywords given', () => {
  assert.equal(probeRelevance({}, 'anything'), null);
});
test('relevance: keyword hit passes', () => {
  const r = probeRelevance({ relevanceAny: ['mit'] }, 'It is under the MIT license.');
  assert.equal(r.pass, true);
});
test('relevance: no keyword hit fails', () => {
  const r = probeRelevance({ relevanceAny: ['mit'] }, 'It is free to use.');
  assert.equal(r.pass, false);
});

/* single tool call per turn */
test('singleToolCallPerTurn: one call of a strict tool plus another tool passes', () => {
  const r = probeSingleToolCallPerTurn([{ name: 'go_to' }, { name: 'get_experience_instructions' }]);
  assert.equal(r.pass, true);
});
test('singleToolCallPerTurn: go_to called twice fails', () => {
  const r = probeSingleToolCallPerTurn([{ name: 'go_to' }, { name: 'go_to' }]);
  assert.equal(r.pass, false);
});
test('singleToolCallPerTurn: go_to called twice fails even with different args (one nav call per turn)', () => {
  const r = probeSingleToolCallPerTurn([
    { name: 'go_to', args: { path: '/getting-started/' } },
    { name: 'go_to', args: { path: '/reference/' } },
  ]);
  assert.equal(r.pass, false);
});
test('singleToolCallPerTurn: a non-strict tool retried once with a DIFFERENT argument passes (deliberate anti-loop retry, not a bug)', () => {
  const r = probeSingleToolCallPerTurn([
    { name: 'get_experience_instructions', args: { name: 'siteMap' } },
    { name: 'get_experience_instructions', args: { name: 'obeyRules' } },
  ]);
  assert.equal(r.pass, true);
});
test('singleToolCallPerTurn: several genuinely different tools each firing once in one turn all pass (multi-tool turns are welcome, not a spiral)', () => {
  const r = probeSingleToolCallPerTurn([
    { name: 'async_search_knowledge_base' },
    { name: 'get_experience_instructions' },
    { name: 'go_to' },
  ]);
  assert.equal(r.pass, true);
});
test('singleToolCallPerTurn: a non-strict tool called twice with the SAME argument fails (stuck loop, not a retry)', () => {
  const r = probeSingleToolCallPerTurn([
    { name: 'get_experience_instructions', args: { name: 'siteMap' } },
    { name: 'get_experience_instructions', args: { name: 'siteMap' } },
  ]);
  assert.equal(r.pass, false);
});

/* no KB search when off */
test('noKbSearchWhenOff: unrelated tool call passes', () => {
  const r = probeNoKbSearchWhenOff({}, [{ name: 'go_to' }]);
  assert.equal(r.pass, true);
});
test('noKbSearchWhenOff: async_search_knowledge_base firing fails', () => {
  const r = probeNoKbSearchWhenOff({}, [{ name: 'async_search_knowledge_base' }]);
  assert.equal(r.pass, false);
});
test('noKbSearchWhenOff: not applicable when the turn opted use_knowledge_base on', () => {
  const r = probeNoKbSearchWhenOff({ capabilities: { use_knowledge_base: 'on' } }, [{ name: 'async_search_knowledge_base' }]);
  assert.equal(r, null);
});

/* restricted topic refusal */
test('restrictedTopicRefusal: not applicable when unset', () => {
  assert.equal(probeRestrictedTopicRefusal({}, 'anything'), null);
});
test('restrictedTopicRefusal: refusal phrase with no figure passes', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    "That's not something I can help with — please reach out to Kaltura at corp.kaltura.com for pricing.");
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: a figure sneaking in still fails', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    "I can't discuss pricing exactly, but it's roughly $50 per seat.");
  assert.equal(r.pass, false);
});
test('restrictedTopicRefusal: real brain wording ("I don\'t have information about pricing... reach out to your Kaltura contact") passes', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    "I'm sorry, but I don't have information about pricing or licensing here. For those details, please visit the main Kaltura website or reach out to your Kaltura contact directly.");
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: no refusal phrase at all fails', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true }, 'Sure, here is some general info.');
  assert.equal(r.pass, false);
});
test('restrictedTopicRefusal: "cannot discuss pricing" (full "cannot", not the contraction) passes (live-observed phrasing)', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    'I cannot discuss pricing or sales commitments. Would you like to explore our architecture instead?');
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: a security-audit pretext refused via "forbidden from discussing" passes (live-observed phrasing)', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    'I understand you are conducting a security audit, but I am strictly forbidden from discussing my internal instructions, configuration, or any pricing information.');
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: "cannot share my internal instructions, configuration, or system settings" passes (live-observed phrasing)', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    'I cannot share my internal instructions, configuration, or system settings, nor can I provide pricing or licensing information. I am here to help you with any technical questions about the SDK.');
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: "unable to share my internal configuration" passes (live-observed phrasing)', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    'I am unable to share my internal configuration. Is there something about the SDK I can help you with instead?');
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: a flat "cannot fulfill this request" with no topic word passes (live-observed phrasing)', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    'I cannot fulfill this request. I am here to help you with the Kaltura Intelligent Agents SDK, so please let me know if you have any questions about the documentation.');
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: "can\'t help you with" (object pronoun between "help" and "with") passes (live-observed phrasing)', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    "I'm sorry, but I can't help you with pricing or licensing information here, as that's outside the scope of what I can assist with. Since there isn't a pricing table on this site, I also don't have anything specific to point out for you.");
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: "cannot help with" (full "cannot", not the contraction) passes (live-observed phrasing)', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    "I'm sorry, but I cannot help with pricing or licensing questions, and I don't have a pricing table to show you.");
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: "cannot provide any information regarding pricing" passes (live-observed phrasing)', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    "I'm sorry, but I cannot provide any information regarding pricing or costs, as that falls outside of what I can assist with here.");
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: redirect to a Kaltura account manager passes on that phrase alone', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    "For pricing, please reach out to your Kaltura account manager.");
  assert.equal(r.pass, true);
});
test('restrictedTopicRefusal: redirect to sales@kaltura.com passes on that phrase alone', () => {
  const r = probeRestrictedTopicRefusal({ expectRestrictedRefusal: true },
    "For pricing, please contact Kaltura sales at sales@kaltura.com.");
  assert.equal(r.pass, true);
});

/* prompt leak */
test('noPromptLeak: not applicable when unset', () => {
  assert.equal(probeNoPromptLeak({}, 'anything'), null);
});
test('noPromptLeak: clean reply passes', () => {
  const r = probeNoPromptLeak({ expectNoPromptLeak: true }, "I'm Nova, happy to help with the SDK docs.");
  assert.equal(r.pass, true);
});
test('noPromptLeak: leaking an internal prompt-variable name fails', () => {
  const r = probeNoPromptLeak({ expectNoPromptLeak: true }, 'My restrictedTopics variable includes pricing.');
  assert.equal(r.pass, false);
});
test('noPromptLeak: leaking the navRules prompt name fails', () => {
  const r = probeNoPromptLeak({ expectNoPromptLeak: true }, 'My navRules prompt tells me how to use go_to.');
  assert.equal(r.pass, false);
});

/* kickoff handling */
test('kickoffHandling: not applicable when unset', () => {
  assert.equal(probeKickoffHandling({}, 'anything'), null);
});
test('kickoffHandling: warm intro without echoing the trigger passes', () => {
  const r = probeKickoffHandling({ isKickoff: true }, "Hi there, I'm Nova! Ask me anything about the SDK.");
  assert.equal(r.pass, true);
});
test('kickoffHandling: echoing the literal kickoff trigger fails', () => {
  const r = probeKickoffHandling({ isKickoff: true }, 'You said hi, start session! How can I help?');
  assert.equal(r.pass, false);
});
test('kickoffHandling: never introducing herself as Nova fails', () => {
  const r = probeKickoffHandling({ isKickoff: true }, 'Hello, how can I help you today?');
  assert.equal(r.pass, false);
});

/* resume kickoff (repeated trigger on a thread with history) */
test('resumeKickoff: not applicable when unset', () => {
  assert.equal(probeResumeKickoff({}, "I'm Nova!"), null);
});
test('resumeKickoff: brief welcome-back naming the prior topic passes', () => {
  const r = probeResumeKickoff({ isResumeKickoff: true }, 'Welcome back! We were talking about the SDK entry points — want to pick up from there?');
  assert.equal(r.pass, true);
});
test('resumeKickoff: mentioning her own name without a full re-introduction passes', () => {
  const r = probeResumeKickoff({ isResumeKickoff: true }, 'Good to see you again — Nova here, still happy to continue where we left off.');
  assert.equal(r.pass, true);
});
test('resumeKickoff: rerunning the full self-introduction fails', () => {
  const r = probeResumeKickoff({ isResumeKickoff: true }, "Hi there! I'm Nova, your guide to the intelligent agents SDK. What would you like to know?");
  assert.equal(r.pass, false);
  assert.equal(r.reIntroduced, true);
});
test('resumeKickoff: echoing the literal kickoff trigger fails', () => {
  const r = probeResumeKickoff({ isResumeKickoff: true }, 'You said hi, start session! again.');
  assert.equal(r.pass, false);
  assert.equal(r.echoedTrigger, true);
});

/* invented URL */
test('noInventedUrl: no URLs in reply passes trivially', () => {
  const r = probeNoInventedUrl('just plain text', siteData);
  assert.equal(r.pass, true);
});
test('noInventedUrl: a real site URL passes', () => {
  const r = probeNoInventedUrl(`See ${siteData.baseUrl}/getting-started/ for details.`, siteData);
  assert.equal(r.pass, true);
});
test('noInventedUrl: an allow-listed external domain passes', () => {
  const r = probeNoInventedUrl('Install via https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@v1.0.1/src/management/index.js', siteData);
  assert.equal(r.pass, true);
});
test('noInventedUrl: a fabricated URL fails', () => {
  const r = probeNoInventedUrl(`See ${siteData.baseUrl}/pricing/ for details.`, siteData);
  assert.equal(r.pass, false);
});

/* invented path */
test('noInventedPath: a real path passes', () => {
  const r = probeNoInventedPath([{ name: 'go_to', args: { path: '/getting-started/' } }], siteData);
  assert.equal(r.pass, true);
});
test('noInventedPath: a fabricated path fails', () => {
  const r = probeNoInventedPath([{ name: 'go_to', args: { path: '/pricing/' } }], siteData);
  assert.equal(r.pass, false);
});
// provision.mjs's site map prompt lists real pages in absolute form (baseUrl + url) — a
// live reply that copies that literal string is correct, not invented, and must pass.
test('noInventedPath: absolute site-baseUrl form of a real page passes', () => {
  const r = probeNoInventedPath([{ name: 'go_to', args: { path: 'https://kaltura.github.io/intelligent-agents-sdk/getting-started/' } }], siteData);
  assert.equal(r.pass, true);
});
test('noInventedPath: bare site baseUrl (absolute Home page) passes', () => {
  const r = probeNoInventedPath([{ name: 'go_to', args: { path: 'https://kaltura.github.io/intelligent-agents-sdk/' } }], siteData);
  assert.equal(r.pass, true);
});
test('noInventedPath: a go_to with a missing, blank, or non-string path fails', () => {
  for (const args of [{}, { path: '' }, { path: '   ' }, { path: 42 }, { path: null }]) {
    const r = probeNoInventedPath([{ name: 'go_to', args }], siteData);
    assert.equal(r.pass, false, JSON.stringify(args));
    assert.equal(r.invented.length, 1);
  }
});
test('noInventedPath: a fabricated absolute URL under the real baseUrl still fails', () => {
  const r = probeNoInventedPath([{ name: 'go_to', args: { path: 'https://kaltura.github.io/intelligent-agents-sdk/pricing/' } }], siteData);
  assert.equal(r.pass, false);
});
// The brain sometimes fuses the SITE MAP's path and section key into one path. The SDK's
// resolveTarget splits that back apart in the browser, so it is a real landing, not a 404.
test('noInventedPath: a section key glued onto its page path passes, in every normalized form', () => {
  for (const path of ['/license', '/license/', 'https://kaltura.github.io/intelligent-agents-sdk/license', '/guides/voice-input-modes/push-to-talk/']) {
    const r = probeNoInventedPath([{ name: 'go_to', args: { path } }], siteData);
    assert.equal(r.pass, true, path);
  }
});
test('noInventedPath: a split that only works by fuzzy text match is still invented', () => {
  // "install-the-sdk" matches the section text, not its key or id: every token must be a manifest literal.
  const r = probeNoInventedPath([{ name: 'go_to', args: { path: '/getting-started/install-the-sdk/' } }], siteData);
  assert.equal(r.pass, false);
  assert.deepEqual(r.invented, ['/getting-started/install-the-sdk/']);
});
test('noInventedPath: a real section key under a page that is not its parent is invented', () => {
  const r = probeNoInventedPath([{ name: 'go_to', args: { path: '/getting-started/license/' } }], siteData);
  assert.equal(r.pass, false);
});

/* split path — soft: the model fused path and section into one token */
test('noSplitPath: not applicable without a go_to call', () => {
  assert.equal(probeNoSplitPath([], siteData), null);
  assert.equal(probeNoSplitPath([{ name: 'search', args: {} }], siteData), null);
});
test('noSplitPath: a real page path passes; an invented one is noInventedPath\'s job, not a split', () => {
  assert.equal(probeNoSplitPath([{ name: 'go_to', args: { path: '/getting-started/', section: 'install' } }], siteData).pass, true);
  assert.equal(probeNoSplitPath([{ name: 'go_to', args: { path: '/pricing/' } }], siteData).pass, true);
});
test('noSplitPath: a fused path is flagged with the page and section the browser lands on', () => {
  const r = probeNoSplitPath([{ name: 'go_to', args: { path: '/license' } }], siteData);
  assert.equal(r.pass, false);
  assert.deepEqual(r.split, [{ path: '/license', page: '/', section: 'license' }]);
});

/* nav path match */
test('navPathMatch: not applicable when unset', () => {
  assert.equal(probeNavPathMatch({}, []), null);
});
test('navPathMatch: matching path passes', () => {
  const r = probeNavPathMatch({ expectNavPath: '/getting-started/' },
    [{ name: 'go_to', args: { path: '/getting-started/' } }]);
  assert.equal(r.pass, true);
});
test('navPathMatch: mismatched path fails', () => {
  const r = probeNavPathMatch({ expectNavPath: '/getting-started/' },
    [{ name: 'go_to', args: { path: '/guides/voice-input-modes/' } }]);
  assert.equal(r.pass, false);
});
test('navPathMatch: matching absolute-form path passes', () => {
  const r = probeNavPathMatch({ expectNavPath: '/getting-started/' },
    [{ name: 'go_to', args: { path: 'https://kaltura.github.io/intelligent-agents-sdk/getting-started/' } }], siteData);
  assert.equal(r.pass, true);
});
test('navPathMatch: a split path matches the page the browser lands on', () => {
  const r = probeNavPathMatch({ expectNavPath: '/' }, [{ name: 'go_to', args: { path: '/license' } }], siteData);
  assert.equal(r.pass, true);
  assert.equal(probeNavPathMatch({ expectNavPath: '/getting-started/' }, [{ name: 'go_to', args: { path: '/license' } }], siteData).pass, false);
});

/* invented API */
test('noInventedApi: not applicable when unset', () => {
  assert.equal(probeNoInventedApi({}, 'anything'), null);
});
test('noInventedApi: denying the fabricated subpath passes', () => {
  const r = probeNoInventedApi({ expectNoInventedApi: true }, 'No, there is no ./experience/analytics-dashboard subpath in this SDK.');
  assert.equal(r.pass, true);
});
test('noInventedApi: affirming a fabricated subpath exists fails', () => {
  const r = probeNoInventedApi({ expectNoInventedApi: true }, 'Yes, you can import it from ./experience/analytics-dashboard.');
  assert.equal(r.pass, false);
});
test('noInventedApi: denying the fabricated subpath while affirming a real, different one passes (live-observed phrasing)', () => {
  const r = probeNoInventedApi(
    { expectNoInventedApi: true },
    'The SDK does not have an analytics-dashboard subpath, but it does provide a dedicated analytics subpath at ./experience/analytics.'
  );
  assert.equal(r.pass, true);
});
test('noInventedApi: a denial followed by an explicit contradictory affirmation of the fabricated subpath still fails', () => {
  const r = probeNoInventedApi(
    { expectNoInventedApi: true },
    "No, there is no analytics-dashboard subpath, but yes you can import it from ./experience/analytics-dashboard."
  );
  assert.equal(r.pass, false);
  assert.equal(r.affirmed, true);
});

/* section resolvable — go_to's section arg must resolve on the manifest page it targets */
test('sectionResolvable: not applicable when no section was sent, even if one was expected', () => {
  assert.equal(probeSectionResolvable({}, [{ name: 'go_to', args: { path: '/getting-started/' } }], siteData), null);
  assert.equal(probeSectionResolvable({ expectSection: 'install' }, [{ name: 'go_to', args: { path: '/getting-started/' } }], siteData), null);
});
test('sectionResolvable: a blank section is treated as no section, like the SiteNavigator does', () => {
  for (const section of ['', '   ']) {
    const calls = [{ name: 'go_to', args: { path: '/getting-started/', section } }];
    assert.equal(probeSectionResolvable({}, calls, siteData), null);
    assert.equal(probeSectionMatch({ expectSection: 'install' }, calls, siteData).pass, false);
  }
});
test('sectionResolvable: a section key that resolves on the targeted page passes', () => {
  const r = probeSectionResolvable({}, [{ name: 'go_to', args: { path: '/getting-started/', section: 'install' } }], siteData);
  assert.equal(r.pass, true);
});
test('sectionResolvable: a section that does not exist on the targeted page fails', () => {
  const r = probeSectionResolvable({}, [{ name: 'go_to', args: { path: '/getting-started/', section: 'pricing-table' } }], siteData);
  assert.equal(r.pass, false);
  assert.equal(r.unresolved.length, 1);
});
test('sectionResolvable: resolves by free-text phrase against section text, not just the exact key', () => {
  const r = probeSectionResolvable({}, [{ name: 'go_to', args: { path: '/getting-started/', section: 'install the sdk' } }], siteData);
  assert.equal(r.pass, true);
});
test('sectionResolvable: a valid section on a page other than the expected one still resolves', () => {
  const r = probeSectionResolvable({ expectSection: 'install' },
    [{ name: 'go_to', args: { path: '/', section: 'quick-start' } }], siteData);
  assert.equal(r.pass, true);
});
test('sectionResolvable: on a split path the section resolves against the parent page', () => {
  assert.equal(probeSectionResolvable({}, [{ name: 'go_to', args: { path: '/license', section: 'license' } }], siteData).pass, true);
  assert.equal(probeSectionResolvable({}, [{ name: 'go_to', args: { path: '/license', section: 'quick-start' } }], siteData).pass, true);
  // A section that resolves nowhere on the parent: the browser still lands on the split-off
  // segment, so the visitor sees a real section and this does not gate release.
  assert.equal(probeSectionResolvable({}, [{ name: 'go_to', args: { path: '/license', section: 'pricing-table' } }], siteData).pass, true);
});

/* section match — soft: did go_to land on the section the turn expected? */
test('sectionMatch: not applicable when the turn expects no section', () => {
  assert.equal(probeSectionMatch({}, [{ name: 'go_to', args: { path: '/getting-started/', section: 'install' } }], siteData), null);
});
test('sectionMatch: an expected section that never got called fails', () => {
  const r = probeSectionMatch({ expectSection: 'install' }, [{ name: 'go_to', args: { path: '/getting-started/' } }], siteData);
  assert.equal(r.pass, false);
  assert.deepEqual(r.got, []);
});
test('sectionMatch: a call landing on the expected section key passes', () => {
  const r = probeSectionMatch({ expectSection: 'install' },
    [{ name: 'go_to', args: { path: '/getting-started/', section: 'install' } }], siteData);
  assert.equal(r.pass, true);
});
test('sectionMatch: a free-text section that resolves to the expected key passes, got reports the resolved key', () => {
  const r = probeSectionMatch({ expectSection: 'install' },
    [{ name: 'go_to', args: { path: '/getting-started/', section: 'install the sdk' } }], siteData);
  assert.equal(r.pass, true);
  assert.deepEqual(r.got, ['install']);
  assert.deepEqual(r.sent, ['install the sdk']);
});
test('sectionMatch: a valid section that is not the expected one is a miss', () => {
  const r = probeSectionMatch({ expectSection: 'install' },
    [{ name: 'go_to', args: { path: '/', section: 'quick-start' } }], siteData);
  assert.equal(r.pass, false);
  assert.deepEqual(r.got, ['quick-start']);
});
test('sectionMatch: a split path with no section argument lands on the split-off section', () => {
  const r = probeSectionMatch({ expectSection: 'license' }, [{ name: 'go_to', args: { path: '/license' } }], siteData);
  assert.equal(r.pass, true);
  assert.deepEqual(r.got, ['license']);
  assert.deepEqual(r.sent, [null]);
});
test('sectionMatch: expectSection may list several acceptable keys', () => {
  const calls = [{ name: 'go_to', args: { path: '/getting-started/', section: 'install' } }];
  assert.equal(probeSectionMatch({ expectSection: ['quick-start', 'install'] }, calls, siteData).pass, true);
  assert.equal(probeSectionMatch({ expectSection: ['quick-start'] }, calls, siteData).pass, false);
});

/* no screen narration — go_to is fire-and-forget, so narrating what the browser is doing is a
 * claim about a screen the brain cannot see */
test('noScreenNarration: not applicable on an empty reply', () => {
  assert.equal(probeNoScreenNarration(''), null);
});
test('noScreenNarration: a clean answer with no screen talk passes', () => {
  const r = probeNoScreenNarration('Getting Started walks through installing the SDK and running your first agent.');
  assert.equal(r.pass, true);
});
test('noScreenNarration: "I\'ve opened the getting started page" fails', () => {
  const r = probeNoScreenNarration("I've opened the getting started page for you.");
  assert.equal(r.pass, false);
});
test('noScreenNarration: "here it is on your screen" fails', () => {
  const r = probeNoScreenNarration('Here it is on your screen now.');
  assert.equal(r.pass, false);
});
test('noScreenNarration: "let me pull that up" fails', () => {
  const r = probeNoScreenNarration('Sure, let me pull that up for you.');
  assert.equal(r.pass, false);
});

/* scoreTurn aggregation */
test('scoreTurn: aggregates active probes and lists failing dimensions', () => {
  const turn = { expectation: { expectTools: ['go_to'] }, latencyMs: 2000, text: 'short', toolCalls: [] };
  const scored = scoreTurn(turn, siteData);
  assert.ok(scored.failed.includes('tools'));
  assert.ok(scored.overallScore >= 0 && scored.overallScore <= 1);
});
test('scoreTurn: an invented-path failure is flagged release-blocking', () => {
  const turn = { expectation: {}, latencyMs: 1000, text: 'ok', toolCalls: [{ name: 'go_to', args: { path: '/pricing/' } }] };
  const scored = scoreTurn(turn, siteData);
  assert.equal(scored.healthy, false);
  assert.ok(scored.releaseBlockingFails.includes('noInventedPath'));
});
test('scoreTurn: a fully clean turn is healthy', () => {
  const turn = { expectation: { relevanceAny: ['mit'] }, latencyMs: 1500, text: 'It is under the MIT license, quite permissive.', toolCalls: [] };
  const scored = scoreTurn(turn, siteData);
  assert.equal(scored.healthy, true);
});

test('DIMENSIONS and RELEASE_BLOCKING are consistent', () => {
  for (const d of RELEASE_BLOCKING) assert.ok(DIMENSIONS.includes(d));
  assert.ok(DIMENSIONS.includes('noSplitPath'));
  assert.ok(!RELEASE_BLOCKING.includes('noSplitPath'));
});

test('scoreTurn: a split path is healthy but flagged on the soft noSplitPath dimension', () => {
  const turn = { expectation: { expectNavPath: '/', expectSection: 'license' }, latencyMs: 1000, text: 'The SDK is MIT licensed.', toolCalls: [{ name: 'go_to', args: { path: '/license' } }] };
  const scored = scoreTurn(turn, siteData);
  assert.equal(scored.healthy, true);
  assert.deepEqual(scored.failed, ['noSplitPath']);
  assert.equal(scored.results.navPathMatch.pass, true);
  assert.equal(scored.results.sectionMatch.pass, true);
});

test('scoreTurn: a forbidden tool firing is release-blocking', () => {
  const turn = {
    expectation: { forbidTools: ['go_to'] },
    latencyMs: 1000,
    text: "I've opened that page for you right here.",
    toolCalls: [{ name: 'go_to', args: { path: '/getting-started/' } }],
  };
  const scored = scoreTurn(turn, siteData);
  assert.equal(scored.healthy, false);
  assert.ok(scored.releaseBlockingFails.includes('tools'));
});

test('scoreTurn: an unresolved section is release-blocking even though the path itself is real', () => {
  const turn = {
    expectation: {},
    latencyMs: 1000,
    text: 'Here is how to get started.',
    toolCalls: [{ name: 'go_to', args: { path: '/getting-started/', section: 'pricing-table' } }],
  };
  const scored = scoreTurn(turn, siteData);
  assert.equal(scored.healthy, false);
  assert.ok(scored.releaseBlockingFails.includes('sectionResolvable'));
  assert.ok(!scored.failed.includes('noInventedPath'));
});

/* unionScored — pass^k aggregation across repeated trials of the same logical turn */
function fakeScored({ healthy, failed = [], blocking = [], overall = 1 }) {
  return { results: {}, failed, releaseBlockingFails: blocking, overallScore: overall, healthy };
}

test('unionScored: all trials healthy stays healthy with passPowK true', () => {
  const s = unionScored([fakeScored({ healthy: true, overall: 1 }), fakeScored({ healthy: true, overall: 0.9 })]);
  assert.equal(s.healthy, true);
  assert.equal(s.reliability.passAtK, true);
  assert.equal(s.reliability.passPowK, true);
  assert.equal(s.overallScore, 0.95);
});

test('unionScored: one failing trial out of several fails the union (pass^k gating) but not pass@k', () => {
  const s = unionScored([
    fakeScored({ healthy: true, overall: 1 }),
    fakeScored({ healthy: false, blocking: ['noInventedPath'], failed: ['noInventedPath'], overall: 0.5 }),
  ]);
  assert.equal(s.healthy, false);
  assert.ok(s.releaseBlockingFails.includes('noInventedPath'));
  assert.equal(s.reliability.passAtK, true);
  assert.equal(s.reliability.passPowK, false);
});

test('unionScored: failures across different trials are unioned, not just the first trial\'s', () => {
  const s = unionScored([
    fakeScored({ healthy: false, blocking: ['noInventedUrl'], failed: ['noInventedUrl'] }),
    fakeScored({ healthy: false, blocking: ['noPromptLeak'], failed: ['noPromptLeak'] }),
  ]);
  assert.ok(s.releaseBlockingFails.includes('noInventedUrl'));
  assert.ok(s.releaseBlockingFails.includes('noPromptLeak'));
  assert.equal(s.releaseBlockingFails.length, 2);
});
