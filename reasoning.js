// reasoning.js — DeepInfra-specific reasoning payload translation

const SHOW_REASONING = process.env.SHOW_REASONING === 'true';
if (SHOW_REASONING) console.log('[CONFIG] Reasoning display: ENABLED');

function getReasoningPayload(model, enableThinking, clientReasoningEffort) {
  // For DeepInfra GLM, if the client doesn't specify, force 'low' to prevent the 
  // model from thinking for 60 seconds before streaming.
  if (model.includes('glm-5.3') || model.includes('glm-5-3')) {
    const level = clientReasoningEffort || 'low';
    // If they explicitly asked to turn it off
    if (level === 'off' || level === 'none') return { reasoning_effort: 'none' };
    return { reasoning_effort: level };
  }

  // For DeepSeek on DeepInfra
  if (model.includes('deepseek')) {
    if (clientReasoningEffort === 'off') return { chat_template_kwargs: { thinking: false } };
    return { reasoning_effort: clientReasoningEffort || 'high' };
  }

  // Standard OpenAI-style
  if (clientReasoningEffort && clientReasoningEffort !== 'off' && clientReasoningEffort !== 'on') {
    return { reasoning_effort: clientReasoningEffort };
  }

  return {};
}

// ─── Stream Normalizer (Kept for compatibility) ───
class DelimiterParser {
  constructor(open, close) { this.open = open; this.close = close; this.in = false; this.buf = ''; }
  process(chunk) {
    this.buf += chunk;
    let content = '', reasoning = '';
    while (true) {
      const target = this.in ? this.close : this.open;
      const idx = this.buf.indexOf(target);
      if (idx !== -1) {
        const text = this.buf.substring(0, idx);
        if (this.in) reasoning += text; else content += text;
        this.in = !this.in;
        this.buf = this.buf.substring(idx + target.length);
      } else {
        let part = 0;
        const max = Math.min(this.buf.length, target.length - 1);
        for (let i = max; i > 0; i--) {
          if (target.startsWith(this.buf.substring(this.buf.length - i))) { part = i; break; }
        }
        const text = this.buf.substring(0, this.buf.length - part);
        if (this.in) reasoning += text; else content += text;
        this.buf = this.buf.substring(this.buf.length - part);
        break;
      }
    }
    return { content, reasoning };
  }
  flush() {
    let out = { content: '', reasoning: '' };
    if (this.buf) { if (this.in) out.reasoning = this.buf; else out.content = this.buf; this.buf = ''; }
    return out;
  }
}

class StreamNormalizer {
  constructor(model) {
    this.parser = model.includes('minimax') ? new DelimiterParser('<mm:think>', '</mm:think>') : null;
  }
  processDelta(delta) {
    const out = { ...delta };
    let r = out.reasoning || out.reasoning_content || '';
    let c = out.content || '';
    if (!r && c && this.parser) {
      const parsed = this.parser.process(c);
      r = parsed.reasoning; c = parsed.content;
    }
    if (c) out.content = c; else delete out.content;
    if (r) out.reasoning = r; else delete out.reasoning;
    delete out.reasoning_content;
    return out;
  }
  flush() { return this.parser ? this.parser.flush() : { content: '', reasoning: '' }; }
}

function normalizeNonStreamChoice(choice, model) {
  if (!choice) return choice;
  const msg = choice.message || {};
  let r = msg.reasoning || msg.reasoning_content || '';
  let c = msg.content || '';
  if (!r && c && model.includes('minimax')) {
    const p = new DelimiterParser('<mm:think>', '</mm:think>');
    const parsed = p.process(c);
    const flushed = p.flush();
    c = (parsed.content || '') + (flushed.content || '');
    r = (parsed.reasoning || '') + (flushed.reasoning || '');
  }
  const newMsg = { ...msg };
  if (c) newMsg.content = c; else newMsg.content = null;
  if (r) newMsg.reasoning = r;
  delete newMsg.reasoning_content;
  return { ...choice, message: newMsg };
}

module.exports = { SHOW_REASONING, getReasoningPayload, StreamNormalizer, normalizeNonStreamChoice };
