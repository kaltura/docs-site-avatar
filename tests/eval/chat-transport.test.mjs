/**
 * Offline unit tests for chat-transport.mjs — the chat-mode eval transport.
 * No live agent, no credentials: fetch is injected (KalturaChatSession supports
 * this natively), so these verify the wire contract this transport drives —
 * converse body shape (threadId / capabilities / page_context request var),
 * the fire-and-forget `go_to` tool call the SiteNavigator would receive, and
 * the streamTurn-compatible return shape engine.mjs scores.
 *
 * Run: node --test tests/eval/chat-transport.test.mjs   (part of `npm run test:eval:unit`)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatTurn } from './chat-transport.mjs';
import { TOOL_SPIRAL_HARD_LIMIT } from './transport.mjs';

// Not a real KS — inspectKs() treats any non-djJ8 string as opaque and moves on.
const FAKE_TOKEN = 'fake-conversation-ks-for-unit-tests';
const management = { sessions: { createConversationToken: async () => FAKE_TOKEN } };

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
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { impl, calls };
}

test('collects text, records a fire-and-forget go_to tool call, returns the stream shape', async () => {
  const { impl } = fakeFetch([
    { type: 'text', content: 'Sure — heading over. ', threadId: 'th_1', messageId: 'm_1' },
    { type: 'tool', content: 'go_to {"path":"/getting-started/"}', threadId: 'th_1', tool_metadata: { id: 'tc_1' } },
    { type: 'text', content: 'Here we are.', threadId: 'th_1' },
  ]);
  const r = await chatTurn({ management, configId: 1, message: 'take me to getting started', threadId: null, fetchImpl: impl });

  assert.equal(r.text, 'Sure — heading over. Here we are.');
  assert.equal(r.threadId, 'th_1');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'go_to');
  assert.deepEqual(r.toolCalls[0].args, { path: '/getting-started/' });
  assert.equal(r.rawToolSegCount, 1);
  assert.equal(r.spiralDetected, false);
  assert.equal(r.spiralRecovered, false);
  assert.deepEqual(r.warnings, []);
  assert.equal('acks' in r, false);
});

test('carries threadId, capabilities, and page_context (via setDynamicPrompt) on the converse body', async () => {
  const { impl, calls } = fakeFetch([{ type: 'text', content: 'The page has three sections.', threadId: 'th_2' }]);
  const pageContext = { page: { title: 'Getting Started', url: '/getting-started/' } };
  const r = await chatTurn({
    management, configId: 1, message: 'what sections are on this page?', threadId: 'th_2',
    capabilities: { use_knowledge_base: 'on' }, pageContext, fetchImpl: impl,
  });

  const converse = calls.find((c) => c.url.endsWith('/assistant/converse'));
  assert.equal(converse.body.userMessage, 'what sections are on this page?');
  assert.equal(converse.body.threadId, 'th_2');
  assert.deepEqual(converse.body.capabilities, { use_knowledge_base: 'on' });
  assert.deepEqual(JSON.parse(converse.body.request_vars.page_context), pageContext);
  assert.equal(r.threadId, 'th_2');
});

test('records go_to with both path and section args, no ACK POST is ever made', async () => {
  const { impl, calls } = fakeFetch([
    { type: 'tool', content: 'go_to {"path":"/getting-started/","section":"install"}', tool_metadata: { id: 'tc_a' } },
  ]);
  const r = await chatTurn({ management, configId: 1, message: 'show me how to install it', threadId: null, fetchImpl: impl });

  assert.deepEqual(r.toolCalls[0].args, { path: '/getting-started/', section: 'install' });
  assert.ok(!calls.some((c) => c.url.endsWith('/assistant/tool_response')), 'no tool_response POST for a fire-and-forget tool');
});

test('flags a spiral post-hoc from raw tool segment count, never claims recovery', async () => {
  const segs = Array.from({ length: TOOL_SPIRAL_HARD_LIMIT }, (_, i) => (
    { type: 'tool', content: 'go_to {"path":"/"}', tool_metadata: { id: `tc_${i}` } }
  ));
  const { impl } = fakeFetch(segs);
  const r = await chatTurn({ management, configId: 1, message: 'home please', threadId: null, fetchImpl: impl });

  assert.equal(r.rawToolSegCount, TOOL_SPIRAL_HARD_LIMIT);
  assert.equal(r.spiralDetected, true);
  assert.equal(r.spiralRecovered, false);
  // Identical repeated calls dedup to ONE dispatched toolCall — same as a real session.
  assert.equal(r.toolCalls.length, 1);
});

test('surfaces the empty_turn_with_request_vars warning when page_context rides an empty turn', async () => {
  const { impl } = fakeFetch([]);
  const r = await chatTurn({
    management, configId: 1, message: 'anything on this page?', threadId: null,
    pageContext: { page: { title: 'Home', url: '/' } }, fetchImpl: impl,
  });

  assert.equal(r.text, '');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'empty_turn_with_request_vars');
  assert.deepEqual(r.warnings[0].requestVarKeys, ['page_context']);
});
