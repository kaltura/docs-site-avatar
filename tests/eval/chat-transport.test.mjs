/**
 * Offline unit tests for chat-transport.mjs — the chat-mode eval transport.
 * No live agent, no credentials: fetch is injected (KalturaChatSession supports
 * this natively), so these verify the wire contract this transport drives —
 * converse body shape (threadId / capabilities / page_context request var),
 * mid-stream tool ACKs through the session's own respondToTool(), and the
 * streamTurnWithAck-compatible return shape engine.mjs scores.
 *
 * Run: node --test tests/eval/chat-transport.test.mjs   (part of `npm run test:eval:unit`)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatTurnWithAck } from './chat-transport.mjs';
import { TOOL_SPIRAL_HARD_LIMIT } from './transport.mjs';

// Not a real KS — inspectKs() treats any non-djJ8 string as opaque and moves on.
const FAKE_TOKEN = 'fake-conversation-ks-for-unit-tests';
const management = { sessions: { createConversationToken: async () => FAKE_TOKEN } };
const ROUTES = [
  { url: '/', title: 'Home' },
  { url: '/getting-started/', title: 'Getting Started' },
];

/** One-chunk NDJSON body stream, the shape parseConverseStream() consumes. */
function ndjsonBody(segs) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(segs.map((s) => JSON.stringify(s)).join('\n') + '\n'));
      c.close();
    },
  });
}

/** Fake fetch: serves converse from `segs`, captures every request for assertions. */
function fakeFetch(segs) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (url.endsWith('/assistant/converse')) {
      return { ok: true, status: 200, headers: { get: () => '' }, body: ndjsonBody(segs) };
    }
    if (url.endsWith('/assistant/tool_response')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { impl, calls };
}

test('collects text, ACKs a waitForResponse nav tool via respondToTool, returns the stream shape', async () => {
  const { impl, calls } = fakeFetch([
    { type: 'text', content: 'Sure — heading over. ', threadId: 'th_1', messageId: 'm_1' },
    { type: 'tool', content: 'navigate_to_page {"path":"/getting-started/"}', threadId: 'th_1', tool_metadata: { id: 'tc_1', wait_for_response: true } },
    { type: 'text', content: 'Here we are.', threadId: 'th_1' },
  ]);
  const r = await chatTurnWithAck({ management, configId: 1, message: 'take me to getting started', threadId: null, routes: ROUTES, fetchImpl: impl });

  assert.equal(r.text, 'Sure — heading over. Here we are.');
  assert.equal(r.threadId, 'th_1');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'navigate_to_page');
  assert.deepEqual(r.toolCalls[0].args, { path: '/getting-started/' });
  assert.equal(r.rawToolSegCount, 1);
  assert.equal(r.spiralDetected, false);
  assert.equal(r.spiralRecovered, false);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.acks, [{ name: 'navigate_to_page', response: { ok: true, path: '/getting-started/' } }]);

  const ackCall = calls.find((c) => c.url.endsWith('/assistant/tool_response'));
  assert.ok(ackCall, 'tool_response POST happened');
  assert.equal(ackCall.body.tool_name, 'navigate_to_page');
  assert.equal(ackCall.body.tool_id, 'tc_1');
  assert.equal(ackCall.body.tool_invocation_id, 'tc_1');
  assert.deepEqual(ackCall.body.response, { ok: true, path: '/getting-started/' });
  assert.equal(ackCall.headers.Authorization, `KS ${FAKE_TOKEN}`);
});

test('carries threadId, capabilities, and page_context (via setDynamicPrompt) on the converse body', async () => {
  const { impl, calls } = fakeFetch([{ type: 'text', content: 'The page has three sections.', threadId: 'th_2' }]);
  const pageContext = {
    page: { title: 'Getting Started', url: '/getting-started/' },
    highlightable_elements: [{ id: 'install', label: 'Install' }],
  };
  const r = await chatTurnWithAck({
    management, configId: 1, message: 'what sections are on this page?', threadId: 'th_2', routes: ROUTES,
    capabilities: { use_knowledge_base: 'on' }, pageContext, fetchImpl: impl,
  });

  const converse = calls.find((c) => c.url.endsWith('/assistant/converse'));
  assert.equal(converse.body.userMessage, 'what sections are on this page?');
  assert.equal(converse.body.threadId, 'th_2');
  assert.deepEqual(converse.body.capabilities, { use_knowledge_base: 'on' });
  assert.deepEqual(JSON.parse(converse.body.request_vars.page_context), pageContext);
  assert.equal(r.threadId, 'th_2');
});

test('nav to an unknown path ACKs not_found; highlight uses the forced ack when given', async () => {
  const { impl, calls } = fakeFetch([
    { type: 'tool', content: 'navigate_to_page {"path":"/no-such-page/"}', tool_metadata: { id: 'tc_a', wait_for_response: true } },
    { type: 'tool', content: 'highlight_element {"id":"install"}', tool_metadata: { id: 'tc_b', wait_for_response: true } },
  ]);
  const r = await chatTurnWithAck({
    management, configId: 1, message: 'go somewhere fake and highlight install', threadId: null, routes: ROUTES,
    highlightAck: { ok: true, id: 'install', label: 'Install' }, fetchImpl: impl,
  });

  assert.deepEqual(r.acks, [
    { name: 'navigate_to_page', response: { ok: false, error: 'not_found' } },
    { name: 'highlight_element', response: { ok: true, id: 'install', label: 'Install' } },
  ]);
  const ackBodies = calls.filter((c) => c.url.endsWith('/assistant/tool_response')).map((c) => c.body);
  assert.equal(ackBodies.length, 2);
  assert.deepEqual(ackBodies[0].response, { ok: false, error: 'not_found' });
  assert.deepEqual(ackBodies[1].response, { ok: true, id: 'install', label: 'Install' });
});

test('flags a spiral post-hoc from raw tool segment count, never claims recovery', async () => {
  const segs = Array.from({ length: TOOL_SPIRAL_HARD_LIMIT }, (_, i) => (
    { type: 'tool', content: 'navigate_to_page {"path":"/"}', tool_metadata: { id: `tc_${i}` } }
  ));
  const { impl } = fakeFetch(segs);
  const r = await chatTurnWithAck({ management, configId: 1, message: 'home please', threadId: null, routes: ROUTES, fetchImpl: impl });

  assert.equal(r.rawToolSegCount, TOOL_SPIRAL_HARD_LIMIT);
  assert.equal(r.spiralDetected, true);
  assert.equal(r.spiralRecovered, false);
  // Identical repeated calls dedup to ONE dispatched toolCall — same as a real session.
  assert.equal(r.toolCalls.length, 1);
});

test('surfaces the empty_turn_with_request_vars warning when page_context rides an empty turn', async () => {
  const { impl } = fakeFetch([]);
  const r = await chatTurnWithAck({
    management, configId: 1, message: 'anything on this page?', threadId: null, routes: ROUTES,
    pageContext: { page: { title: 'Home', url: '/' }, highlightable_elements: [] }, fetchImpl: impl,
  });

  assert.equal(r.text, '');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'empty_turn_with_request_vars');
  assert.deepEqual(r.warnings[0].requestVarKeys, ['page_context']);
});
