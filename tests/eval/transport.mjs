/**
 * Headless converse transport for the Nova eval, record-only. Nova's single client tool
 * (`go_to`, see provision.mjs) is fire-and-forget (`waitForResponse:false`): the brain never
 * waits for the browser, so a headless caller has nothing to ACK. This iterates
 * `Conversations#stream()`'s async generator directly (not `send()`, which fully drains before
 * returning) so a spiraling turn can be abandoned the moment it trips the hard limit below.
 */
import { parseToolCall, SPIRAL_RECOVERY_PREFIX } from '../../vendor/sdk/src/core/stream.js';

const SPOKEN_TYPES = new Set(['text', 'avatar', 'avatar-filler']);

// KalturaAvatarSession's own circuit breaker (session.js `_checkHardToolSpiral`) was built after
// a live incident where the brain re-emitted the SAME tool call 438x over 9 minutes with zero
// narration — it counts raw `type:"tool"` segments (dedup-independent, since a spiral IS repeats
// of the same call) and, past a hard limit, abandons the stuck turn and resends the visitor's
// message once more prefixed with SPIRAL_RECOVERY_PREFIX. This headless transport bypasses
// KalturaAvatarSession entirely (no socket, no cold-reconnect), so without an equivalent it has
// NONE of that protection. A smaller limit than the SDK's default (30) is used here
// deliberately — this is a batch-eval budget, not a live conversation, so the goal is "clearly
// spiraling, not just a legitimate multi-tool turn," not exact parity with interactive timing.
export const TOOL_SPIRAL_HARD_LIMIT = 6;

/**
 * Run one headless conversation turn and record every tool call the brain emits.
 * @param {object} opts
 * @param {import('../../vendor/sdk/src/management/index.js').Management} opts.management
 * @param {number} opts.configId
 * @param {string} opts.message
 * @param {string|null} [opts.threadId]
 * @param {object} [opts.capabilities] per-message capabilities override, forwarded verbatim to
 *   `conversations.stream()` (e.g. `{use_knowledge_base:'on'}` to probe RAG for one turn without
 *   touching the live agent's stored capability state — see conversations.stream()'s doc comment
 *   on the stored-DISABLED-veto vs. stored-off-can-be-overridden distinction).
 * @param {typeof fetch} [opts.fetchImpl] ignored here (the SDK client owns its fetch); part of the
 *   signature only so engine.mjs can call either transport with the same options object.
 * @param {object} [opts.pageContext] ignored here (no socket, so no `setDynamicPrompt()`); same
 *   shared-signature reason as `fetchImpl`. chat-transport.mjs honours both.
 * @param {AbortSignal} [opts.signal] forwarded straight to `conversations.stream()` — the eval's
 *   own turn-level timeout (see engine.mjs's `withTimeout`) MUST abort this when it fires, or the
 *   abandoned stream keeps its connection open and this function's `for await` loop keeps
 *   running detached, which was observed live to keep the whole eval process alive well after
 *   the run finished and printed its report (the CLI never actually exited).
 * @returns {Promise<{text:string, threadId:string|null, toolCalls:object[], rawToolSegCount:number, spiralDetected:boolean, spiralRecovered:boolean}>}
 */
// fetchImpl/pageContext are intentionally unused here (shared signature, see JSDoc).
export async function streamTurn({ management, configId, message, threadId, capabilities, fetchImpl, pageContext, signal }) {
  async function runOnce(userMessage, tid) {
    const token = await management.sessions.createConversationToken({ configId });
    const gen = management.conversations.stream({ userMessage, ...(tid ? { threadId: tid } : {}), ...(capabilities ? { capabilities } : {}), signal }, token);

    let text = '';
    let outThreadId = tid || null;
    const toolCalls = [];
    let rawToolSegCount = 0;

    for await (const seg of gen) {
      if (seg.threadId && !outThreadId) outThreadId = seg.threadId;
      if (seg.type && SPOKEN_TYPES.has(seg.type) && seg.content) text += seg.content;
      if (seg.type === 'tool') rawToolSegCount++;
      const call = parseToolCall(seg);
      if (call) toolCalls.push(call);
      // Abandon a spiraling stream rather than keep consuming it — mirrors _checkHardToolSpiral
      // abandoning the stuck turn instead of waiting for the brain to stop on its own (it doesn't).
      if (rawToolSegCount >= TOOL_SPIRAL_HARD_LIMIT) {
        return { text: text.trim(), threadId: outThreadId, toolCalls, rawToolSegCount, spiraled: true };
      }
    }
    return { text: text.trim(), threadId: outThreadId, toolCalls, rawToolSegCount, spiraled: false };
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
