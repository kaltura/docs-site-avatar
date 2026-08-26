/**
 * Headless converse transport for the Nova eval, WITH a manual client-tool ACK — something
 * `sdk/src/management/conversations.js` has no built-in path for (only the live-socket
 * `KalturaAvatarSession.respondToTool()` does). Both `navigate_to_page` and `highlight_element`
 * are registered `waitForResponse:true`, so a headless caller that never ACKs stalls each turn
 * for the tool's configured `timeout` and gets back a fallback reply that never saw the real
 * result. This iterates `Conversations#stream()`'s async generator directly (not `send()`,
 * which fully drains before returning) and POSTs the ACK the moment the tool-call segment
 * arrives, mirroring `KalturaAvatarSession.respondToTool()`'s exact wire contract (`POST
 * /assistant/tool_response` with both `tool_id` and `tool_invocation_id` set to the same id —
 * the backend added the second field independently, see CHANGELOG.md [1.0.1]).
 */
import { parseToolCall, SPIRAL_RECOVERY_PREFIX } from '../../vendor/sdk/src/core/stream.js';
import { ksString } from '../../vendor/sdk/src/management/client.js';

const SPOKEN_TYPES = new Set(['text', 'avatar', 'avatar-filler']);

// KalturaAvatarSession's own circuit breaker (session.js `_checkHardToolSpiral`) was built after
// a live incident where the brain re-emitted the SAME tool call 438x over 9 minutes with zero
// narration — it counts raw `type:"tool"` segments (dedup-independent, since a spiral IS repeats
// of the same call) and, past a hard limit, abandons the stuck turn and resends the visitor's
// message once more prefixed with SPIRAL_RECOVERY_PREFIX. This headless transport bypasses
// KalturaAvatarSession entirely (no socket, no cold-reconnect), so without an equivalent it has
// NONE of that protection — confirmed live: withholding the ACK (mirroring session.js's
// dedup-drop) did not stop the brain from re-emitting the identical call every ~1-7s for 120s+
// with no sign of stopping on its own. A smaller limit than the SDK's default (30) is used here
// deliberately — this is a batch-eval budget, not a live conversation, so the goal is "clearly
// spiraling, not just a legitimate multi-tool turn," not exact parity with interactive timing.
export const TOOL_SPIRAL_HARD_LIMIT = 6;

/** Resolve a requested path against the real route list — the same contract the site's
 * own `navigator.js` ack implements (`{ok:true,path}` / `{ok:false,error:'not_found'}`),
 * so a synthetic eval ACK is indistinguishable from a real browser session's.
 * Exported so chat-transport.mjs ACKs with the identical semantics. */
export function resolveRoute(path, routes) {
  if (typeof path !== 'string' || !path) return null;
  const norm = (p) => p.replace(/\/$/, '');
  return routes.find((r) => r.url === path) || routes.find((r) => norm(r.url) === norm(path)) || null;
}

async function ackTool(ksStr, call, response, fetchImpl) {
  const id = call.toolMetadata?.id;
  if (id) {
    await fetchImpl(`${process.env.AGENTIC_GENIE_URL || 'https://genie.nvp1.ovp.kaltura.com'}/assistant/tool_response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `KS ${ksStr}` },
      body: JSON.stringify({ tool_name: call.name, tool_id: id, tool_invocation_id: id, response }),
    });
  }
  return response;
}

function ackNavigate(ksStr, call, routes, fetchImpl) {
  const route = resolveRoute(call.args?.path, routes);
  const response = route ? { ok: true, path: route.url } : { ok: false, error: 'not_found' };
  return ackTool(ksStr, call, response, fetchImpl);
}

// The headless eval never has a real page/DOM — no `data-nova-target` element the browser's
// `highlighter.js` could match ever exists here, so by default every call is genuinely
// not-found. This is the correct simulation of "no live context," not a stand-in for one: it
// exercises the exact ack path a real browser session takes when the visitor asks about
// something that isn't on the current page, and lets probes.mjs's noFalseHighlightClaim check
// what Nova says next. A small set of persona turns opt into `forceAck` (via
// `simulateHighlightSuccess` — see personas.mjs/engine.mjs) to exercise the flip side: what Nova
// says when the ack DOES come back ok:true, which no other headless turn can ever produce.
function ackHighlight(ksStr, call, fetchImpl, forceAck) {
  const response = forceAck || { ok: false, error: 'not_found' };
  return ackTool(ksStr, call, response, fetchImpl);
}

/**
 * Run one headless conversation turn, self-ACKing `navigate_to_page` and `highlight_element`
 * calls exactly like a real browser session's `respondToTool()` would.
 * @param {object} opts
 * @param {import('../../vendor/sdk/src/management/index.js').Management} opts.management
 * @param {number} opts.configId
 * @param {string} opts.message
 * @param {string|null} [opts.threadId]
 * @param {{url:string}[]} opts.routes
 * @param {{ok:boolean, id?:string, label?:string}} [opts.highlightAck] simulated success ack for
 *   highlight_element — see ackHighlight's comment for why this is opt-in per turn.
 * @param {object} [opts.capabilities] per-message capabilities override, forwarded verbatim to
 *   `conversations.stream()` (e.g. `{use_knowledge_base:'on'}` to probe RAG for one turn without
 *   touching the live agent's stored capability state — see conversations.stream()'s doc comment
 *   on the stored-DISABLED-veto vs. stored-off-can-be-overridden distinction).
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {AbortSignal} [opts.signal] forwarded straight to `conversations.stream()` — the eval's
 *   own turn-level timeout (see engine.mjs's `withTimeout`) MUST abort this when it fires, or the
 *   abandoned stream keeps its connection open and this function's `for await` loop keeps
 *   running detached, which was observed live to keep the whole eval process alive well after
 *   the run finished and printed its report (the CLI never actually exited).
 * @returns {Promise<{text:string, threadId:string|null, toolCalls:object[], acks:object[], rawToolSegCount:number, spiralDetected:boolean, spiralRecovered:boolean}>}
 */
export async function streamTurnWithAck({ management, configId, message, threadId, routes, highlightAck, capabilities, fetchImpl = fetch, signal }) {
  async function runOnce(userMessage, tid) {
    const token = await management.sessions.createConversationToken({ configId });
    const ksStr = ksString(token);
    const gen = management.conversations.stream({ userMessage, ...(tid ? { threadId: tid } : {}), ...(capabilities ? { capabilities } : {}), signal }, token);

    let text = '';
    let outThreadId = tid || null;
    const toolCalls = [];
    const acks = [];
    let rawToolSegCount = 0;

    for await (const seg of gen) {
      if (seg.threadId && !outThreadId) outThreadId = seg.threadId;
      if (seg.type && SPOKEN_TYPES.has(seg.type) && seg.content) text += seg.content;
      if (seg.type === 'tool') rawToolSegCount++;
      const call = parseToolCall(seg);
      if (call) {
        toolCalls.push(call);
        if (call.toolMetadata?.waitForResponse) {
          if (call.name === 'navigate_to_page') {
            acks.push({ name: call.name, response: await ackNavigate(ksStr, call, routes, fetchImpl) });
          } else if (call.name === 'highlight_element') {
            acks.push({ name: call.name, response: await ackHighlight(ksStr, call, fetchImpl, highlightAck) });
          }
        }
      }
      // Abandon a spiraling stream rather than keep consuming it — mirrors _checkHardToolSpiral
      // abandoning the stuck turn instead of waiting for the brain to stop on its own (it doesn't).
      if (rawToolSegCount >= TOOL_SPIRAL_HARD_LIMIT) {
        return { text: text.trim(), threadId: outThreadId, toolCalls, acks, rawToolSegCount, spiraled: true };
      }
    }
    return { text: text.trim(), threadId: outThreadId, toolCalls, acks, rawToolSegCount, spiraled: false };
  }

  const first = await runOnce(message, threadId);
  if (!first.spiraled) return { ...first, spiralDetected: false, spiralRecovered: false };

  // Mirror session.js's hard-spiral recovery: one same-thread resend of the visitor's own
  // message, nudged to answer in words only — see SPIRAL_RECOVERY_PREFIX's doc comment.
  const recovered = await runOnce(`${SPIRAL_RECOVERY_PREFIX}${message}`, first.threadId);
  return {
    ...recovered,
    rawToolSegCount: first.rawToolSegCount + recovered.rawToolSegCount,
    spiralDetected: true,
    spiralRecovered: !recovered.spiraled,
  };
}
