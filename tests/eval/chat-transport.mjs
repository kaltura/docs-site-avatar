/**
 * Headless chat transport for the Nova eval — the chat-mode sibling of transport.mjs.
 * Where transport.mjs iterates `Conversations#stream()`, this drives the SDK's real
 * `KalturaChatSession` (the exact class the site's chat mode runs in the browser), so the
 * eval exercises the shipped client stack: `sendText()` turn serialization, the `toolCall`
 * event the site's SiteNavigator subscribes to, and `setDynamicPrompt()`'s `page_context`
 * request-var sugar (the same call the site makes per page).
 *
 * Record-only, like transport.mjs: `go_to` is fire-and-forget, so nothing is ever ACKed.
 * Return shape matches `streamTurn` so engine.mjs/probes.mjs score both transports
 * identically, plus a `warnings` array (KalturaChatSession's `empty_turn_with_request_vars`
 * diagnostic — the one signal that distinguishes "the allow_client_variables gate ate the
 * turn" from a genuinely empty reply).
 *
 * Spiral handling differs from transport.mjs by design: `sendText()` drains the whole stream
 * before returning, so there's no mid-stream abandon point and no recovery resend here.
 * `spiralDetected` comes from the session's own `toolSpiralDetected` event (its
 * `toolSpiralLimit` is set to the same `TOOL_SPIRAL_HARD_LIMIT` transport.mjs uses),
 * `spiralRecovered` is always false, and engine.mjs's 90s turn abort (the `signal` below)
 * is what bounds a live spiral on this path.
 *
 * One session object is built per turn, so `sessionCompleteOnEnd` is off: the SDK's default
 * would post a session-completed signal on every `disconnect()`, which would fire lifecycle
 * completion on every eval turn instead of once per conversation.
 */
import { KalturaChatSession } from '../../vendor/sdk/src/experience/index.js';
import { ksString } from '../../vendor/sdk/src/management/client.js';
import { TOOL_SPIRAL_HARD_LIMIT } from './transport.mjs';

/**
 * Run one headless chat-mode conversation turn through the real KalturaChatSession.
 * @param {object} opts — same contract as `streamTurn`, plus:
 * @param {object} [opts.pageContext] delivered via `session.setDynamicPrompt()` before the
 *   turn — the same payload shape the site pushes (`{page:{title,url}}`).
 * @returns {Promise<{text:string, threadId:string|null, toolCalls:object[], rawToolSegCount:number, spiralDetected:boolean, spiralRecovered:boolean, warnings:object[]}>}
 */
export async function chatTurn({ management, configId, message, threadId, capabilities, pageContext, fetchImpl = fetch, signal }) {
  const token = await management.sessions.createConversationToken({ configId });
  const session = new KalturaChatSession({
    token: ksString(token),
    ...(threadId ? { threadId } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(process.env.AGENTIC_GENIE_URL ? { genieUrl: process.env.AGENTIC_GENIE_URL } : {}),
    toolSpiralLimit: TOOL_SPIRAL_HARD_LIMIT,
    sessionCompleteOnEnd: false,
    fetch: fetchImpl,
    logger: () => {},
  });

  const toolCalls = [];
  const warnings = [];
  let spiralDetected = false;
  session.on('toolCall', (call) => toolCalls.push(call));
  session.on('warning', (w) => warnings.push(w));
  session.on('toolSpiralDetected', () => { spiralDetected = true; });

  try {
    session.connect();
    if (pageContext) session.setDynamicPrompt(pageContext);
    const r = await session.sendText(message, { signal });
    const rawToolSegCount = r.segments.filter((s) => s.type === 'tool').length;
    return {
      text: r.text.trim(),
      threadId: r.threadId ?? threadId ?? null,
      toolCalls,
      rawToolSegCount,
      spiralDetected,
      spiralRecovered: false,
      warnings,
    };
  } finally {
    session.disconnect();
  }
}
