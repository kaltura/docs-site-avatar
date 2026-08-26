/**
 * Headless chat transport for the Nova eval — the chat-mode sibling of transport.mjs.
 * Where transport.mjs iterates `Conversations#stream()` and hand-POSTs tool ACKs,
 * this drives the SDK's real `KalturaChatSession` (the exact class the site's chat
 * mode runs in the browser), so the eval exercises the shipped client stack:
 * `sendText()` turn serialization, `onToolCall()` dedup + pending-ack registry,
 * `respondToTool()`'s wire contract, and `setDynamicPrompt()`'s `page_context`
 * request-var sugar (the same call the site's `highlighter.js` makes per page).
 *
 * Return shape matches `streamTurnWithAck` so engine.mjs/probes.mjs score both
 * transports identically, plus a `warnings` array (KalturaChatSession's
 * `empty_turn_with_request_vars` diagnostic — the one signal that distinguishes
 * "the allow_client_variables gate ate the turn" from a genuinely empty reply).
 *
 * Spiral handling differs from transport.mjs by design: `sendText()` drains the
 * whole stream before returning, so there's no mid-stream abandon point and no
 * recovery resend here — `spiralDetected` is computed post-hoc from the returned
 * segments, `spiralRecovered` is always false, and engine.mjs's 90s turn abort
 * (the `signal` below) is what bounds a live spiral on this path.
 */
import { KalturaChatSession } from '../../vendor/sdk/src/experience/chat-session.js';
import { ksString } from '../../vendor/sdk/src/management/client.js';
import { resolveRoute, TOOL_SPIRAL_HARD_LIMIT } from './transport.mjs';

/**
 * Run one headless chat-mode conversation turn through the real KalturaChatSession,
 * ACKing `navigate_to_page` and `highlight_element` via `respondToTool()`.
 * @param {object} opts — same contract as `streamTurnWithAck`, plus:
 * @param {object} [opts.pageContext] delivered via `session.setDynamicPrompt()` before the
 *   turn — the same payload shape the site's highlighter.js pushes
 *   (`{page:{title,url}, highlightable_elements:[{id,label}]}`).
 * @returns {Promise<{text:string, threadId:string|null, toolCalls:object[], acks:object[], rawToolSegCount:number, spiralDetected:boolean, spiralRecovered:boolean, warnings:object[]}>}
 */
export async function chatTurnWithAck({ management, configId, message, threadId, routes, highlightAck, capabilities, pageContext, fetchImpl = fetch, signal }) {
  const token = await management.sessions.createConversationToken({ configId });
  const session = new KalturaChatSession({
    token: ksString(token),
    ...(threadId ? { threadId } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(process.env.AGENTIC_GENIE_URL ? { genieUrl: process.env.AGENTIC_GENIE_URL } : {}),
    fetch: fetchImpl,
    logger: () => {},
  });

  const toolCalls = [];
  const acks = [];
  const warnings = [];
  const ackPromises = [];
  session.on('toolCall', (call) => toolCalls.push(call));
  session.on('warning', (w) => warnings.push(w));

  // Same ACK semantics as transport.mjs (resolveRoute / forced-or-not_found highlight),
  // but through the session's own respondToTool() instead of a hand-built POST.
  const ackVia = (call, response) => {
    acks.push({ name: call.name, response });
    if (call.toolMetadata?.waitForResponse && call.toolMetadata.id) {
      ackPromises.push(session.respondToTool(call.toolMetadata.id, response));
    }
  };
  session.onToolCall('navigate_to_page', (args, call) => {
    const route = resolveRoute(args?.path, routes);
    ackVia(call, route ? { ok: true, path: route.url } : { ok: false, error: 'not_found' });
  });
  session.onToolCall('highlight_element', (args, call) => {
    ackVia(call, highlightAck || { ok: false, error: 'not_found' });
  });

  try {
    session.connect();
    if (pageContext) session.setDynamicPrompt(pageContext);
    const r = await session.sendText(message, { signal });
    await Promise.all(ackPromises);
    const rawToolSegCount = r.segments.filter((s) => s.type === 'tool').length;
    return {
      text: r.text.trim(),
      threadId: r.threadId ?? threadId ?? null,
      toolCalls,
      acks,
      rawToolSegCount,
      spiralDetected: rawToolSegCount >= TOOL_SPIRAL_HARD_LIMIT,
      spiralRecovered: false,
      warnings,
    };
  } finally {
    session.disconnect();
  }
}
