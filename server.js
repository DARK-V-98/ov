// ============================================================
//  OSHADI AI Dashboard — server
//  - Serves the web dashboard (public/)
//  - Proxies chat to a FREE AI provider (Groq / OpenRouter / Gemini)
//  - Streams the reply back to the browser in real time (SSE)
// ============================================================

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildSystemPrompt,
  nextMood,
  pickActivity,
  partOfDay,
  MOODS,
  DEFAULT_MOOD,
} from "./persona.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PROVIDER = (process.env.PROVIDER || "groq").toLowerCase();

// ---- Provider configuration --------------------------------
function providerConfig() {
  if (PROVIDER === "openrouter") {
    return {
      type: "openai",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
      extraHeaders: {
        "HTTP-Referer": "http://localhost:" + PORT,
        "X-Title": "OSHADI AI Dashboard",
      },
    };
  }
  if (PROVIDER === "gemini") {
    return {
      type: "gemini",
      key: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    };
  }
  // default: groq
  return {
    type: "openai",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    extraHeaders: {},
  };
}

// Expose mood metadata + setup status to the frontend.
app.get("/api/config", (req, res) => {
  const cfg = providerConfig();
  res.json({
    provider: PROVIDER,
    model: cfg.model,
    configured: Boolean(cfg.key),
    moods: MOODS,
    defaultMood: DEFAULT_MOOD,
    activity: pickActivity(),
    partOfDay: partOfDay(),
  });
});

// Remember her last activity so it doesn't change every single message.
let currentActivity = pickActivity();

// ---- Chat endpoint (streaming) -----------------------------
app.post("/api/chat", async (req, res) => {
  const cfg = providerConfig();
  const { messages = [], userName = "", mood = DEFAULT_MOOD } = req.body || {};

  if (!cfg.key) {
    return res.status(400).json({
      error:
        `No API key set for provider "${PROVIDER}". Copy .env.example to .env and add your free key.`,
    });
  }

  // Decide her next mood from the latest user message.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const newMood = nextMood(mood, lastUser?.content || "");

  // Drift her activity a little (mostly keeps the same one).
  currentActivity = pickActivity(currentActivity);

  // SSE headers — stream to the browser as tokens arrive.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Tell the client her mood + activity for this reply.
  send(res, { type: "mood", mood: newMood, activity: currentActivity });

  const system = buildSystemPrompt({ userName, mood: newMood, activity: currentActivity });

  try {
    if (cfg.type === "gemini") {
      await streamGemini(cfg, system, messages, res);
    } else {
      await streamOpenAI(cfg, system, messages, res);
    }
    send(res, { type: "done" });
  } catch (err) {
    console.error("Chat error:", err);
    send(res, { type: "error", error: String(err.message || err) });
  }
  res.end();
});

// Helper: write one SSE event.
function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ---- OpenAI-compatible streaming (Groq / OpenRouter) -------
async function streamOpenAI(cfg, system, messages, res) {
  const payload = {
    model: cfg.model,
    stream: true,
    temperature: 0.9,
    messages: [{ role: "system", content: system }, ...trim(messages)],
  };

  const upstream = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key}`,
      ...(cfg.extraHeaders || {}),
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    throw new Error(`Provider error ${upstream.status}: ${errText.slice(0, 300)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) send(res, { type: "token", token: delta });
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
  }
}

// ---- Gemini streaming --------------------------------------
async function streamGemini(cfg, system, messages, res) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse&key=${cfg.key}`;

  const contents = trim(messages).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.9 },
  };

  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    throw new Error(`Provider error ${upstream.status}: ${errText.slice(0, 300)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      try {
        const json = JSON.parse(data);
        const delta = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (delta) send(res, { type: "token", token: delta });
      } catch {
        /* ignore */
      }
    }
  }
}

// Keep only the last ~20 messages so the request stays small.
function trim(messages) {
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-20);
}

app.listen(PORT, () => {
  const cfg = providerConfig();
  console.log("\n  💖  OSHADI is awake at  http://localhost:" + PORT);
  console.log(`      provider: ${PROVIDER}  |  model: ${cfg.model}`);
  if (!cfg.key) {
    console.log("\n  ⚠  No API key yet. Copy .env.example to .env and add your free key.\n");
  } else {
    console.log("");
  }
});
