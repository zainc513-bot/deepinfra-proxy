# DeepInfra OpenAI-Compatible Proxy

A lightweight, high-performance proxy that translates standard OpenAI API requests into DeepInfra API requests. 

This proxy was specifically built and optimized for **`zai-org/glm-5.3-flash`**, solving the common issues of slow streaming and indefinite hanging by forcing reasoning limits and optimizing TCP packet delivery.

## 🚀 Features

- **OpenAI API Compatible:** Works with any client or library that supports the OpenAI format (SillyTavern, JanitorAI, LangChain, etc.).
- **Instant Streaming:** Uses TCP `setNoDelay` and strips unnecessary stream options to guarantee token-by-token delivery without buffering.
- **GLM Speed Fix:** Automatically forces `reasoning_effort: "low"` for GLM models so it doesn't spend 60 seconds thinking before generating the first token.
- **Reasoning Token Tracking:** Real-time console logs showing exactly how many reasoning tokens the model is generating.
- **Tool Call Recovery:** Automatically catches and repairs leaked `<tool_call>` tags in the text stream and converts them to proper OpenAI tool calls.
- **SSE Heartbeats:** Sends keep-alive pings every 10 seconds so the connection never drops during long generations.

---

## 🛠️ Deployment (Render)

1. Create a new **Web Service** on [Render](https://render.com).
2. Connect this GitHub repository.
3. Set the **Environment Variables** (see below).
4. Deploy!

---

## ⚙️ Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `NIM_API_KEY` | Your DeepInfra API Key (starts with `dp-...`) | **Required** |
| `CLIENT_AUTH_KEY` | The secret password your clients will use to authenticate with your proxy | **Required** |
| `NIM_API_BASE` | The DeepInfra API base URL | `https://api.deepinfra.com/v1/openai` |
| `DEFAULT_MAX_TOKENS` | Max tokens if the client doesn't specify | `4096` |
| `SHOW_REASONING` | Set to `true` to pass reasoning tokens back to the client | `false` |

---

## 💻 Usage

Point your OpenAI-compatible client to your Render URL, and use your `CLIENT_AUTH_KEY` as the API key.

### Example (cURL)

```bash
curl -X POST https://your-render-url.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_CLIENT_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
