// server.js — Clean OpenAI-compatible proxy (DeepInfra Optimized)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { timingSafeEqual, createHash } = require('crypto');
const { SHOW_REASONING, getReasoningPayload, StreamNormalizer, normalizeNonStreamChoice } = require('./reasoning');
const { extractLeakedToolCalls, ToolCallStreamRecovery } = require('./tools');

const app = express();
const PORT = process.env.PORT || 3000;

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://api.deepinfra.com/v1/openai'; 
const NIM_API_KEY = process.env.NIM_API_KEY;
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY;

// Renamed from ADMIN_PASSWORD so it looks innocuous
const SYS_OPS_KEY = process.env.SYS_OPS_KEY; 
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const ENABLE_THINKING_MODE = process.env.ENABLE_THINKING_MODE === 'true';

const MAX_TOKENS_LIMIT = 65536;
const DEFAULT_MAX_TOKENS = Number(process.env.DEFAULT_MAX_TOKENS) || 4096;
const HEARTBEAT_INTERVAL_MS = 10000;
const REQUEST_TIMEOUT_MS = 90000;
const THINKING_DEADLINE_MS = 90000;

// Security State
const blockedIPs = new Set();
const flaggedRequests = [];
const rateLimits = new Map();

const SUS_WORDS = ['csam', 'child porn', 'kill yourself', 'make a bomb', 'terrorist attack', 'meth recipe'];

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const nim = axios.create({ baseURL: NIM_API_BASE, httpsAgent: keepAliveAgent });

function validateConfig() {
  if (!NIM_API_KEY) { console.error('[FATAL] NIM_API_KEY is required.'); process.exit(1); }
  if (!CLIENT_AUTH_KEY) { console.error('[FATAL] CLIENT_AUTH_KEY is required for users.'); process.exit(1); }
  if (!SYS_OPS_KEY) { console.error('[FATAL] SYS_OPS_KEY is required for system operations.'); process.exit(1); }
}
validateConfig();

const MODEL_MAPPING = {
  'gpt-4': 'meta-llama/Meta-Llama-3.1-70B-Instruct',
  'gpt-3.5-turbo': 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  'gpt-4-flash': 'zai-org/glm-5.3-flash', 
  'glm-flash': 'zai-org/glm-5.3-flash',           
  'zai-org/GLM-5.3-Flash': 'zai-org/glm-5.3-flash',
  'deepseek': 'deepseek-ai/DeepSeek-V3',
  'llama-3.1-8b': 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  'claude-3-sonnet': 'mistralai/Mixtral-8x7B-Instruct-v0.1',
  'mistral': 'mistralai/Mistral-7B-Instruct-v0.3'
};

const DEFAULT_MODEL = 'zai-org/glm-5.3-flash';

function resolveModelId(name) {
  if (typeof name !== 'string') return null;
  if (MODEL_MAPPING[name]) return MODEL_MAPPING[name];
  if (/^[\w.-]+\/[\w.:-]+$/.test(name)) return name;
  return null;
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function safeTimingEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

function getIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ─── 1. SECURITY MIDDLEWARE (IP Block & Rate Limit) ───
app.use((req, res, next) => {
  const ip = getIP(req);
  if (blockedIPs.has(ip)) {
    return res.status(403).json({ error: { message: 'Your IP has been blocked by the administrator.', type: 'security_error' } });
  }

  const now = Date.now();
  if (!rateLimits.has(ip)) rateLimits.set(ip, { count: 1, lastReset: now });
  else {
    const limit = rateLimits.get(ip);
    if (now - limit.lastReset > 60000) {
      limit.count = 1;
      limit.lastReset = now;
    } else {
      limit.count++;
      if (limit.count > 60) {
        blockedIPs.add(ip);
        return res.status(429).json({ error: { message: 'Rate limit exceeded. IP auto-blocked.', type: 'rate_limit' } });
      }
    }
  }
  next();
});

// ─── 2. WEBSITE PASSWORD ───
app.use((req, res, next) => {
  // We only protect the UI files (HTML/CSS/JS), not the API
  if (req.method === 'GET' && req.path !== '/health' && req.path !== '/v1/models' && !req.path.startsWith('/v1/chat') && !req.path.startsWith('/_sys')) {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    
    // UI is locked behind the SYS_OPS_KEY
    if (login && password && safeTimingEqual(password, SYS_OPS_KEY)) return next();
    
    res.set('WWW-Authenticate', 'Basic realm="Proxy Dashboard"');
    return res.status(401).send('Authentication required.');
  }
  next();
});

// ─── 3. Serve UI ───
app.use(express.static(path.join(__dirname, 'public')));

// ─── 4. API AUTH ───
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/v1/models' || req.path.startsWith('/_sys')) return next();
  
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token || !CLIENT_AUTH_KEY || !safeTimingEqual(token, CLIENT_AUTH_KEY)) {
    return res.status(403).json({ error: { message: 'Forbidden', type: 'authentication_error', code: 403 } });
  }
  next();
});

// ─── 5. HIDDEN SYSTEM ROUTES (Renamed from /admin) ───
app.use('/_sys', (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token || !safeTimingEqual(token, SYS_OPS_KEY)) {
    // Return standard 404 so attackers think the route doesn't exist
    return res.status(404).json({ error: { message: 'Not Found' } });
  }
  next();
});

app.get('/_sys/blocked', (req, res) => res.json(Array.from(blockedIPs)));
app.post('/_sys/block', (req, res) => {
  if (req.body.ip) blockedIPs.add(req.body.ip);
  res.json({ success: true });
});
app.post('/_sys/unblock', (req, res) => {
  if (req.body.ip) blockedIPs.delete(req.body.ip);
  res.json({ success: true });
});
app.get('/_sys/flagged', (req, res) => res.json(flaggedRequests));
app.delete('/_sys/flagged', (req, res) => {
  flaggedRequests.length = 0;
  res.json({ success: true });
});

// ─── 6. HELPER FUNCTIONS ───
function safeWrite(res, data) {
  try { if (!res.writableEnded && !res.destroyed) res.write(data); } catch {}
}

function finishStreamWithNotice(res, text) {
  if (text) safeWrite(res, `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
  safeWrite(res, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  safeWrite(res, 'data: [DONE]\n\n');
  if (!res.writableEnded) res.end();
}

function getErrorMessage(err) {
  if (!err) return 'Unknown error';
  const d = err.response?.data;
  let msg = typeof d === 'string' ? d : d?.error?.message || d?.message || d?.detail;
  return String(msg || err.message || 'Request failed').slice(0, 300);
}

async function postToUpstream(payload, signal) {
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort); }
  
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, REQUEST_TIMEOUT_MS);

  try {
    const res = await nim.post('/chat/completions', payload, {
      headers: { Authorization: `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      responseType: payload.stream ? 'stream' : 'json',
      timeout: 0, signal: ac.signal
    });
    return res;
  } catch (err) {
    if (timedOut) { const e = new Error(`Timeout after ${REQUEST_TIMEOUT_MS}ms`); e.timedOut = true; throw e; }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/v1/models', (req, res) => {
  res.json({ object: 'list', data: Object.keys(MODEL_MAPPING).map(id => ({ id, object: 'model', owned_by: 'proxy' })) });
});

// ─── 7. CHAT COMPLETION ───
app.post('/v1/chat/completions', async (req, res) => {
  const startTime = Date.now();
  const ip = getIP(req);
  let upstreamStream = null;
  let heartbeat = null;
  let progressTimer = null;
  let cleanup = null;
  const abortController = new AbortController();

  res.on('close', () => {
    if (heartbeat) clearInterval(heartbeat);
    if (progressTimer) clearInterval(progressTimer);
    if (res.writableFinished) return;
    abortController.abort();
    if (cleanup) cleanup();
    if (upstreamStream && !upstreamStream.destroyed) upstreamStream.destroy();
  });

  try {
    const isStream = !!req.body.stream;
    
    // MODERATION FILTER
    const messageText = JSON.stringify(req.body.messages || '').toLowerCase();
    const violatedWord = SUS_WORDS.find(w => messageText.includes(w));
    
    if (violatedWord) {
      const flag = {
        time: Date.now(),
        ip: ip,
        prompt: messageText.slice(0, 500) + '...',
        reason: `Matched keyword: ${violatedWord}`
      };
      flaggedRequests.push(flag);
      if (flaggedRequests.length > 50) flaggedRequests.shift();

      if (DISCORD_WEBHOOK_URL) {
        axios.post(DISCORD_WEBHOOK_URL, {
          content: `🚨 **Security Alert: Sus Request Blocked**\n**IP:** ${ip}\n**Reason:** ${flag.reason}\n**Prompt:** \`\`\`${flag.prompt}\`\`\``
        }).catch(() => {});
      }

      return res.status(400).json({ 
        error: { message: 'Request flagged by security filter.', type: 'moderation_block', code: 400 } 
      });
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      
      if (res.socket) res.socket.setNoDelay(true);
      safeWrite(res, ': connected\n\n');
      heartbeat = setInterval(() => safeWrite(res, ': keep-alive\n\n'), HEARTBEAT_INTERVAL_MS);
    }

    const { model, max_tokens, temperature, reasoning_effort, tools } = req.body;
    const primary = resolveModelId(model) || DEFAULT_MODEL;
    const hasTools = !!tools;

    const baseReq = {
      ...req.body,
      temperature: temperature ?? 0.7,
      max_tokens: Math.min(max_tokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_LIMIT),
      stream: isStream
    };
    delete baseReq.model; 
    delete baseReq.reasoning_effort;
    delete baseReq.stream_options; 

    const payload = { ...baseReq, model: primary, ...getReasoningPayload(primary, ENABLE_THINKING_MODE, reasoning_effort) };
    console.log(`[UPSTREAM] ${ip} -> ${primary} | payload: ${JSON.stringify(payload.reasoning_effort || {})}`);

    const response = await postToUpstream(payload, abortController.signal);
    const usedModel = primary;

    if (!isStream) {
      const data = response.data;
      const choices = (data.choices || []).map((c, i) => {
        const norm = normalizeNonStreamChoice(c, usedModel);
        let content = norm.message?.content || '';
        
        let recovered = [];
        if (hasTools) {
          const r = extractLeakedToolCalls(content);
          content = r.content; recovered = r.toolCalls;
        }

        const finalMsg = { ...norm.message, content };
        const allTools = [...(norm.message.tool_calls || []), ...recovered];
        
        if (allTools.length > 0) {
          finalMsg.tool_calls = allTools;
          if (recovered.length > 0) norm.finish_reason = 'tool_calls';
          if (!finalMsg.content) finalMsg.content = null;
        }

        if (!SHOW_REASONING) { delete finalMsg.reasoning; delete finalMsg.reasoning_content; }
        return { ...norm, index: i, message: finalMsg };
      });

      res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);
      return res.json({ ...data, model: usedModel, choices });
    }

    upstreamStream = response.data;
    const decoder = new StringDecoder('utf8');
    const normalizer = new StreamNormalizer(usedModel);
    const toolRecovery = hasTools ? new ToolCallStreamRecovery() : null;
    
    let buffer = '', reasoningOpen = false, stats = { chars: 0, reason: 0 }, sawTool = false;

    progressTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const rTokens = Math.round(stats.reason / 4);
      const cTokens = Math.round(stats.chars / 4);
      let phase = cTokens > 0 ? "Streaming" : "Thinking";
      console.log(`[PROGRESS] ${usedModel} | ${elapsed}s | Phase: ${phase} | Reason: ~${rTokens} tk | Content: ~${cTokens} tk`);
    }, 5000);

    const processLine = (line) => {
      if (!line.startsWith('data: ')) return;
      if (line.trim() === 'data: [DONE]') return;

      try {
        const data = JSON.parse(line.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (delta && delta.tool_calls) sawTool = true;

        if (delta) {
          const norm = normalizer.processDelta(delta);
          stats.chars += (norm.content || '').length;
          if (norm.reasoning) stats.reason += norm.reasoning.length;

          let outContent = '';
          if (SHOW_REASONING && req.headers['x-reasoning-format'] === 'inline') {
            if (norm.reasoning && !reasoningOpen) { outContent += `<thinking>\n${norm.reasoning}`; reasoningOpen = true; }
            else if (norm.reasoning) outContent += norm.reasoning;

            if (norm.content && reasoningOpen) { outContent += `\n</thinking>\n\n${norm.content}`; reasoningOpen = false; }
            else if (norm.content) outContent += norm.content;
          } else {
            outContent = norm.content || '';
          }

          if (toolRecovery) {
            const r = toolRecovery.process(outContent);
            outContent = r.content;
            if (r.toolCallDeltas.length > 0) {
              sawTool = true;
              delta.tool_calls = [...(delta.tool_calls || []), ...r.toolCallDeltas];
              if (data.choices[0]) data.choices[0].finish_reason = 'tool_calls';
            }
          }

          if (outContent) delta.content = outContent; else delete delta.content;
          
          if (SHOW_REASONING && norm.reasoning) {
            delta.reasoning = norm.reasoning;
            delta.reasoning_content = norm.reasoning;
          } else {
            delete delta.reasoning;
            delete delta.reasoning_content;
          }
        }
        safeWrite(res, `data: ${JSON.stringify(data)}\n\n`);
      } catch (err) {}
    };

    const onEnd = () => {
      if (progressTimer) clearInterval(progressTimer);
      buffer += decoder.end();
      if (buffer.trim()) processLine(buffer);

      const flushed = normalizer.flush();
      let outContent = flushed.content || '';
      const outReasoning = flushed.reasoning || '';
      let flushedTools = [];

      if (outReasoning) stats.reason += outReasoning.length;

      if (toolRecovery) {
        const r = toolRecovery.process(outContent);
        outContent = r.content; flushedTools = r.toolCallDeltas;
        const left = toolRecovery.flush();
        if (left) outContent += left;
      }

      if (flushedTools.length > 0) {
        safeWrite(res, `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: flushedTools }, finish_reason: 'tool_calls' }] })}\n\n`);
      }

      let finalContent = '';
      if (SHOW_REASONING && req.headers['x-reasoning-format'] === 'inline') {
        if (outReasoning) {
          if (!reasoningOpen) { finalContent = `<thinking>\n${outReasoning}`; reasoningOpen = true; }
          else finalContent = outReasoning;
        }
        if (outContent) {
          if (reasoningOpen) { finalContent += `\n</thinking>\n\n${outContent}`; reasoningOpen = false; }
          else finalContent += outContent;
        }
        if (reasoningOpen) finalContent += '\n</thinking>\n\n';
      } else {
        finalContent = outContent;
      }

      if (finalContent) {
        safeWrite(res, `data: ${JSON.stringify({ choices: [{ delta: { content: finalContent }, finish_reason: null }] })}\n\n`);
      }

      if (SHOW_REASONING && !req.headers['x-reasoning-format'] && outReasoning) {
        safeWrite(res, `data: ${JSON.stringify({ choices: [{ delta: { reasoning: outReasoning, reasoning_content: outReasoning }, finish_reason: null }] })}\n\n`);
      }

      console.log(`[SPEED] ${usedModel} finished in ${((Date.now() - startTime)/1000).toFixed(1)}s`);
      safeWrite(res, 'data: [DONE]\n\n');
      if (!res.writableEnded) res.end();
    };

    upstreamStream.on('data', chunk => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    });

    upstreamStream.on('end', onEnd);
    upstreamStream.on('error', (err) => {
      if (progressTimer) clearInterval(progressTimer);
      if (!res.writableEnded) finishStreamWithNotice(res, `\n\n[Stream Error: ${err.message}]`);
    });

    const deadline = setTimeout(() => {
      if (stats.chars > 0 || stats.reason > 0 || sawTool) return;
      if (upstreamStream && !upstreamStream.destroyed) upstreamStream.destroy();
      finishStreamWithNotice(res, `\n\n[Proxy: Deadline reached without output.]`);
    }, THINKING_DEADLINE_MS);

    cleanup = () => { 
      clearTimeout(deadline); 
      if (progressTimer) clearInterval(progressTimer); 
      upstreamStream.removeAllListeners(); 
      upstreamStream.on('error', () => {}); 
    };

  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    if (progressTimer) clearInterval(progressTimer);
    if (cleanup) cleanup();
    if (abortController.signal.aborted) return;

    const msg = getErrorMessage(err);
    console.error(`[PROXY] Request failed: ${msg}`);

    if (!res.headersSent) {
      res.status(err.response?.status || (err.timedOut ? 504 : 500)).json({
        error: { message: msg, type: 'invalid_request_error', code: err.response?.status || 500 }
      });
    } else {
      finishStreamWithNotice(res, `\n\n[Proxy Error: ${msg}]`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`[PROXY] DeepInfra Proxy running on port ${PORT}`);
});
