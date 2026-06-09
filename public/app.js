// ============================================================
//  OSHADI dashboard — frontend logic
//  - real-time streaming chat (Server-Sent Events)
//  - mood engine reflected in the UI
//  - chat history saved in the browser (localStorage)
// ============================================================

const $ = (id) => document.getElementById(id);

const els = {
  messages: $("messages"),
  input: $("input"),
  composer: $("composer"),
  sendBtn: $("sendBtn"),
  typing: $("typing"),
  userName: $("userName"),
  moodOverride: $("moodOverride"),
  clearBtn: $("clearBtn"),
  status: $("status"),
  moodEmoji: $("moodEmoji"),
  moodLabel: $("moodLabel"),
  moodBarFill: $("moodBarFill"),
  brandAvatar: $("brandAvatar"),
  headAvatar: $("headAvatar"),
  headStatus: $("headStatus"),
  headActivity: $("headActivity"),
};

const state = {
  messages: load("oshadi_history", []),
  userName: load("oshadi_name", ""),
  mood: "happy",
  moods: {},
  busy: false,
};

// ---------- boot ----------
init();

async function init() {
  els.userName.value = state.userName;
  els.userName.addEventListener("input", () => {
    state.userName = els.userName.value.trim();
    save("oshadi_name", state.userName);
  });

  els.composer.addEventListener("submit", onSend);
  els.clearBtn.addEventListener("click", clearChat);

  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    state.moods = cfg.moods || {};
    state.mood = cfg.defaultMood || "happy";
    if (cfg.activity) setActivity(cfg.activity);

    // fill mood dropdown
    for (const [key, m] of Object.entries(state.moods)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = `${m.emoji} ${m.label}`;
      els.moodOverride.appendChild(opt);
    }

    if (cfg.configured) {
      setStatus(`💗 ${cfg.provider} · ${cfg.model}`, "good");
    } else {
      setStatus("⚠ No API key — add one in .env", "bad");
    }
    applyMood(state.mood);
  } catch (e) {
    setStatus("⚠ server offline", "bad");
  }

  renderAll();
}

// ---------- sending ----------
async function onSend(e) {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.busy) return;

  els.input.value = "";
  addMessage("user", text);

  state.busy = true;
  els.sendBtn.disabled = true;
  els.typing.hidden = false;
  scrollDown();

  // create the empty assistant bubble we'll stream into
  const override = els.moodOverride.value;
  const startMood = override === "auto" ? state.mood : override;
  const bubble = addMessage("assistant", "", startMood);
  let full = "";
  let replyMood = startMood;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content })),
        userName: state.userName,
        mood: override === "auto" ? state.mood : override,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    await readStream(res, (evt) => {
      if (evt.type === "mood") {
        replyMood = override === "auto" ? evt.mood : override;
        applyMood(replyMood);
        if (evt.activity) setActivity(evt.activity);
        paintBubble(bubble, replyMood); // tint this bubble with her mood
      } else if (evt.type === "token") {
        els.typing.hidden = true;
        full += evt.token;
        bubble.textContent = full;
        scrollDown();
      } else if (evt.type === "error") {
        throw new Error(evt.error);
      }
    });

    if (!full.trim()) {
      bubble.textContent = "mmh… I got a little quiet there 🥺 try again?";
    }
    // persist final text + the mood she sent it in
    const last = state.messages[state.messages.length - 1];
    last.content = bubble.textContent;
    last.mood = replyMood;
    save("oshadi_history", state.messages);
  } catch (err) {
    els.typing.hidden = true;
    bubble.textContent = `💔 ${err.message}`;
    bubble.parentElement.classList.add("error");
  } finally {
    state.busy = false;
    els.sendBtn.disabled = false;
    els.typing.hidden = true;
    els.input.focus();
    scrollDown();
  }
}

// read an SSE stream from a fetch Response
async function readStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------- mood ----------
function applyMood(key) {
  const m = state.moods[key];
  if (!m) return;
  state.mood = key;
  document.documentElement.style.setProperty("--accent", m.accent);
  els.moodEmoji.textContent = m.emoji;
  els.moodLabel.textContent = m.label;
  els.brandAvatar.textContent = m.emoji;
  els.headAvatar.textContent = m.emoji;
  els.headStatus.textContent = `online · feeling ${m.label.toLowerCase()}`;
  els.moodBarFill.style.width = 55 + Math.floor(Math.random() * 40) + "%";
}

// Show what she's doing right now in the header.
function setActivity(act) {
  if (!act) return;
  state.activity = act;
  els.headActivity.textContent = `${act.emoji} ${act.text}`;
}

// Tint a bubble (and show a tiny mood chip) for the given mood.
function paintBubble(bubble, moodKey) {
  const m = state.moods[moodKey];
  if (!m) return;
  const row = bubble.closest(".row");
  if (row) row.style.setProperty("--bm", m.accent);
  let chip = bubble.parentElement.querySelector(".mood-chip");
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "mood-chip";
    bubble.parentElement.appendChild(chip);
  }
  chip.textContent = `${m.emoji} ${m.label}`;
}

// ---------- rendering ----------
function addMessage(role, content, mood) {
  state.messages.push({ role, content, mood });
  save("oshadi_history", state.messages);
  return renderOne(role, content, mood);
}

function renderOne(role, content, mood) {
  // remove welcome screen if present
  const w = els.messages.querySelector(".welcome");
  if (w) w.remove();

  const isHer = role !== "user";
  const moodKey = mood || state.mood;
  const m = state.moods[moodKey];

  const row = document.createElement("div");
  row.className = "row " + (role === "user" ? "me" : "her");
  if (isHer && m) row.style.setProperty("--bm", m.accent);

  const av = document.createElement("div");
  av.className = "av";
  av.textContent = role === "user" ? "🧑" : (m?.emoji || "💖");

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = content;
  wrap.appendChild(bubble);

  // mood chip under her bubbles (only when there's text)
  if (isHer && m && content) {
    const chip = document.createElement("span");
    chip.className = "mood-chip";
    chip.textContent = `${m.emoji} ${m.label}`;
    wrap.appendChild(chip);
  }

  row.appendChild(av);
  row.appendChild(wrap);
  els.messages.appendChild(row);
  scrollDown();
  return bubble;
}

function renderAll() {
  els.messages.innerHTML = "";
  if (!state.messages.length) {
    showWelcome();
    return;
  }
  for (const m of state.messages) renderOne(m.role, m.content, m.mood);
}

function showWelcome() {
  els.messages.innerHTML = `
    <div class="welcome">
      <div class="big">💖</div>
      <h2>Hi, I'm OSHADI</h2>
      <p>Your own little AI girl. Say hi and tell me about your day…<br/>I might be happy, shy, playful or sleepy — depends how I feel 😊</p>
    </div>`;
}

function clearChat() {
  if (!confirm("Clear the whole conversation with OSHADI?")) return;
  state.messages = [];
  save("oshadi_history", state.messages);
  renderAll();
}

// ---------- helpers ----------
function scrollDown() {
  els.messages.scrollTop = els.messages.scrollHeight;
}
function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? " " + kind : "");
}
function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
}
function load(k, fallback) {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
