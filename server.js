// ============================================================
//  OSHADI AI Dashboard — server
//  - Serves the web dashboard (public/)
//  - Proxies chat to a FREE AI provider (Groq / OpenRouter / Gemini)
//  - Streams the reply back to the browser in real time (SSE)
// ============================================================

import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  buildSystemPrompt,
  buildLearningPrompt,
  nextMood,
  pickActivity,
  partOfDay,
  affectionDelta,
  affectionLabel,
  defaultTraits,
  detectLanguage,
  TRAITS,
  MOODS,
  RELATIONSHIPS,
  PRONOUNS,
  DEFAULT_RELATIONSHIP,
  DEFAULT_PRONOUN,
  DEFAULT_MOOD,
} from "./persona.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- Long-term memory (persisted to disk) ------------------
// This is how OSHADI "learns": facts, bond level, traits and the
// last-seen time all survive server restarts.
const DATA_DIR = path.join(__dirname, "data");
const MEM_PATH = path.join(DATA_DIR, "memory.json");

function freshMemory() {
  return {
    userName: "",
    facts: [],
    affection: 20,
    traits: defaultTraits(),
    lastSeen: null,
    totalMessages: 0,
    mood: DEFAULT_MOOD,
    language: "english", // sticky language preference
    relationship: DEFAULT_RELATIONSHIP, // how she relates to the user
    pronoun: DEFAULT_PRONOUN, // how she refers to the user
  };
}

// Moods that only make sense in a romantic relationship.
const ROMANTIC_MOODS = new Set(["romantic", "flirty", "jealous"]);

let memory = loadMemory();

function loadMemory() {
  try {
    const raw = fs.readFileSync(MEM_PATH, "utf8");
    return { ...freshMemory(), ...JSON.parse(raw) };
  } catch {
    return freshMemory();
  }
}

function saveMemory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MEM_PATH, JSON.stringify(memory, null, 2));
  } catch (e) {
    console.error("Could not save memory:", e.message);
  }
}

const PROVIDER = (process.env.PROVIDER || "groq").toLowerCase();

// ---- Provider configuration --------------------------------
// English (default) provider — Groq or OpenRouter.
function englishConfig() {
  if (PROVIDER === "openrouter") {
    return {
      name: "openrouter",
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
  if (PROVIDER === "gemini") return geminiConfig();
  // default: groq
  return {
    name: "groq",
    type: "openai",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    extraHeaders: {},
  };
}

// Gemini — used automatically for Sinhala.
function geminiConfig() {
  return {
    name: "gemini",
    type: "gemini",
    key: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  };
}

// Choose the provider for a given language, with graceful fallback.
function pickProvider(language) {
  if (language === "sinhala") {
    const g = geminiConfig();
    if (g.key) return g;
    // No Gemini key yet → fall back to the English provider (still tries Sinhala).
    return englishConfig();
  }
  return englishConfig();
}

// Expose mood metadata, persona state + setup status to the frontend.
app.get("/api/config", (req, res) => {
  const cfg = englishConfig();
  const gem = geminiConfig();
  res.json({
    provider: cfg.name,
    model: cfg.model,
    configured: Boolean(cfg.key),
    sinhalaModel: gem.model,
    sinhalaReady: Boolean(gem.key), // Gemini key present → great Sinhala
    moods: MOODS,
    defaultMood: DEFAULT_MOOD,
    activity: pickActivity(),
    partOfDay: partOfDay(),
    traitDefs: TRAITS,
    relationshipDefs: RELATIONSHIPS,
    pronounDefs: PRONOUNS,
    // her current persona state (her "memory")
    persona: {
      userName: memory.userName,
      affection: memory.affection,
      affectionLabel: affectionLabel(memory.affection, pronounObj()),
      traits: memory.traits,
      facts: memory.facts,
      relationship: memory.relationship,
      pronoun: memory.pronoun,
      totalMessages: memory.totalMessages,
      lastSeen: memory.lastSeen,
    },
  });
});

// The object-form pronoun for the current user (him/her/them).
function pronounObj() {
  return (PRONOUNS[memory.pronoun] || PRONOUNS[DEFAULT_PRONOUN]).obj;
}

// Update her personality dials (sliders), name, relationship + pronoun. Persisted.
app.post("/api/traits", (req, res) => {
  const { traits = {}, userName, relationship, pronoun } = req.body || {};
  for (const k of Object.keys(TRAITS)) {
    if (typeof traits[k] === "number") {
      memory.traits[k] = Math.max(0, Math.min(100, Math.round(traits[k])));
    }
  }
  if (typeof userName === "string") memory.userName = userName.trim().slice(0, 40);
  if (relationship && RELATIONSHIPS[relationship]) memory.relationship = relationship;
  if (pronoun && PRONOUNS[pronoun]) memory.pronoun = pronoun;
  saveMemory();
  res.json({
    ok: true,
    traits: memory.traits,
    userName: memory.userName,
    relationship: memory.relationship,
    pronoun: memory.pronoun,
  });
});

// Wipe what she has learned (fresh start).
app.post("/api/forget", (req, res) => {
  memory = freshMemory();
  saveMemory();
  res.json({ ok: true });
});

// Remember her last activity so it doesn't change every single message.
let currentActivity = pickActivity();

// ---- Chat endpoint (streaming) -----------------------------
app.post("/api/chat", async (req, res) => {
  const { messages = [], mood = DEFAULT_MOOD } = req.body || {};

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastText = lastUser?.content || "";

  // --- decide language + which provider to use ---
  const { language, explicit } = detectLanguage(lastText, memory.language);
  if (explicit) memory.language = explicit; // remember an explicit switch
  const cfg = pickProvider(language);
  const usedFallback = language === "sinhala" && cfg.name !== "gemini";

  if (!cfg.key) {
    return res.status(400).json({
      error: `No API key set for provider "${cfg.name}". Copy .env.example to .env and add your free key.`,
    });
  }

  // --- update her bond/affection from what he said ---
  memory.affection = clamp(memory.affection + affectionDelta(lastText), 0, 100);

  // --- how long since he last texted (for "missed you") ---
  const now = Date.now();
  const minutesAway = memory.lastSeen ? (now - memory.lastSeen) / 60000 : null;

  // --- mood + activity for this reply ---
  let newMood = nextMood(memory.mood || mood, lastText);
  // In a platonic relationship, swap romantic moods for warm friendly ones.
  const isRomantic = (RELATIONSHIPS[memory.relationship] || {}).romantic;
  if (!isRomantic && ROMANTIC_MOODS.has(newMood)) {
    newMood = ["caring", "happy", "playful", "curious"][Math.floor(Math.random() * 4)];
  }
  memory.mood = newMood;
  currentActivity = pickActivity(currentActivity);

  // SSE headers — stream to the browser as tokens arrive.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Tell the client her mood, activity, bond + which language/model is live.
  send(res, {
    type: "mood",
    mood: newMood,
    activity: currentActivity,
    affection: Math.round(memory.affection),
    affectionLabel: affectionLabel(memory.affection, pronounObj()),
    language,
    model: cfg.model,
    provider: cfg.name,
    sinhalaFallback: usedFallback,
  });

  const system = buildSystemPrompt({
    language,
    relationship: memory.relationship,
    pronoun: memory.pronoun,
    userName: memory.userName,
    mood: newMood,
    activity: currentActivity,
    traits: memory.traits,
    affection: memory.affection,
    facts: memory.facts,
    minutesAway,
  });

  let fullReply = "";
  try {
    const onToken = (t) => {
      fullReply += t;
      send(res, { type: "token", token: t });
    };
    if (cfg.type === "gemini") {
      await streamGemini(cfg, system, messages, onToken);
    } else {
      await streamOpenAI(cfg, system, messages, onToken);
    }
    send(res, { type: "done" });
  } catch (err) {
    console.error("Chat error:", err);
    send(res, { type: "error", error: String(err.message || err) });
  }

  // --- bookkeeping + learning (after the reply) ---
  memory.lastSeen = now;
  memory.totalMessages += 1;
  saveMemory();
  res.end();

  // Learn new durable facts every few messages (non-blocking).
  if (fullReply && memory.totalMessages % 2 === 0) {
    learnFromChat(cfg, [...messages, { role: "assistant", content: fullReply }]).catch((e) =>
      console.error("Learning skipped:", e.message)
    );
  }
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---- Learning: extract durable facts about the user --------
async function learnFromChat(cfg, messages) {
  const recent = trim(messages).slice(-12);
  if (!recent.length) return;
  const sys = buildLearningPrompt(memory.facts);
  const transcript = recent
    .map((m) => `${m.role === "assistant" ? "OSHADI" : "User"}: ${m.content}`)
    .join("\n");

  const raw = await chatComplete(cfg, sys, [
    { role: "user", content: `Conversation:\n${transcript}\n\nReturn the JSON array of new facts.` },
  ]);

  const facts = parseFacts(raw);
  if (!facts.length) return;

  // de-dupe (case-insensitive) and cap the memory size
  const known = new Set(memory.facts.map((f) => f.toLowerCase()));
  let added = false;
  for (const f of facts) {
    const key = f.toLowerCase();
    if (f.length > 2 && !known.has(key)) {
      memory.facts.push(f);
      known.add(key);
      added = true;
    }
  }
  if (added) {
    memory.facts = memory.facts.slice(-50);
    saveMemory();
    console.log("💭 OSHADI learned:", facts.join(" | "));
  }
}

function parseFacts(raw) {
  if (!raw) return [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(match ? match[0] : raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string").map((s) => s.trim()) : [];
  } catch {
    return [];
  }
}

// Helper: write one SSE event.
function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ---- OpenAI-compatible streaming (Groq / OpenRouter) -------
// Calls onToken(text) for each chunk as it streams in.
async function streamOpenAI(cfg, system, messages, onToken) {
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
        if (delta) onToken(delta);
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
  }
}

// ---- Gemini streaming --------------------------------------
async function streamGemini(cfg, system, messages, onToken) {
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
        if (delta) onToken(delta);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- Non-streaming completion (used for fact extraction) ---
async function chatComplete(cfg, system, messages) {
  if (cfg.type === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${cfg.key}`;
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.2 },
      }),
    });
    const j = await r.json();
    return j.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
  // openai-compatible
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.key}`,
      ...(cfg.extraHeaders || {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "";
}

// Keep only the last ~20 messages so the request stays small.
function trim(messages) {
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-20);
}

app.listen(PORT, "0.0.0.0", () => {
  const cfg = englishConfig();
  const gem = geminiConfig();
  console.log("\n  💖  OSHADI is awake at  http://localhost:" + PORT);
  console.log(`      English: ${cfg.name} · ${cfg.model}` + (cfg.key ? " ✓" : " ⚠ no key"));
  console.log(`      Sinhala: gemini · ${gem.model}` + (gem.key ? " ✓" : " ⚠ add GEMINI_API_KEY for great Sinhala"));
  console.log("");
});
