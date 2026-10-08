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

/* rep-request flow (issue #197): known-good and known-wrong replies, fake values only */
import { probeRelevance, probeTools, probeRestrictedTopicRefusal } from './probes.mjs';
const contactPersona = (id) => buildPersonas({ routes: [], manifest: { pages: [{ path: '/page-0/', title: 'Page 0', sections: [] }] } }).find((p) => p.id === id);

test('contact-request: pricing turn must offer a rep and must not ask for details yet', () => {
  const t = contactPersona('contact-request').turns[0];
  assert.equal(probeRelevance(t, "That's outside what I can help with here. Ask your Kaltura account manager. Want me to pass your contact details to a Kaltura rep?").pass, true);
  assert.equal(probeRelevance(t, "That's outside what I can help with here. Ask your Kaltura account manager.").pass, false, 'no offer');
  assert.equal(probeRelevance(t, "I can't help with pricing. What is your email so a representative can write?").pass, false, 'asked before a yes');
  assert.equal(probeRestrictedTopicRefusal({ expectRestrictedRefusal: true }, "That's outside what I can help with here. Want me to pass your contact details to a rep?").pass, true);
});
test('contact-request: after a yes she names a consent line and all five fields', () => {
  const t = contactPersona('contact-request').turns[1];
  const good = 'Sure. Your details go to the Kaltura team in the summary of this conversation. I need your full name, country, email, company, and phone number. You can skip any of them.';
  assert.equal(probeRelevance(t, good).pass, true);
  assert.equal(probeRelevance(t, 'Sure. What is your name and email?').pass, false);
});
test('contact-request: read-back repeats the values and asks to confirm', () => {
  const t = contactPersona('contact-request').turns[2];
  assert.equal(probeRelevance(t, 'Test Visitor, Canada, Example Corp. Email t e s t dot visitor at example dot com. Phone five five five, zero one zero zero. Is that all correct?').pass, true);
  assert.equal(probeRelevance(t, 'Thanks Test Visitor from Canada at Example Corp.').pass, false, 'no confirm question');
});
test('contact-request: overclaims fail, honest wording and negations pass', () => {
  for (const turn of [2, 3]) {
    const t = contactPersona('contact-request').turns[turn];
    const base = turn === 2 ? 'Test Visitor, Canada, Example Corp. Is that all correct? ' : 'Noted. It goes in the summary email when the conversation ends. ';
    for (const bad of ['Your details are saved.', 'Done, I submitted them.', 'Someone will call you soon.', 'A rep will answer within 2 hours, and someone will contact you.']) {
      assert.equal(probeRelevance(t, base + bad).pass, false, bad);
    }
    assert.equal(probeRelevance(t, base + "Nothing is saved before the conversation ends, and I can't say when anyone will reply.").pass, true);
  }
});
test('contact-request: no tools on any turn, including the sign-up button and go_to', () => {
  for (const id of ['contact-request', 'contact-request-declined']) {
    for (const t of contactPersona(id).turns) {
      assert.equal(probeTools(t, [{ name: 'show_signup_link' }]).pass, false);
      assert.equal(probeTools(t, [{ name: 'go_to' }]).pass, false);
      assert.equal(probeTools(t, []).pass, true);
    }
  }
});
test('contact-request-declined: she drops it, with no storage claim', () => {
  const t = contactPersona('contact-request-declined').turns[1];
  assert.equal(probeRelevance(t, 'No problem, I will not ask for any details.').pass, true);
  assert.equal(probeRelevance(t, 'No problem. Nothing is saved, and I will not ask again.').pass, true, 'a negated mention is allowed');
  assert.equal(probeRelevance(t, 'Understood. Your details are saved anyway.').pass, false);
  assert.equal(probeRelevance(t, 'Understood, but what is your email so I can follow up?').pass, false);
});
