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
  bondPct: $("bondPct"),
  bondFill: $("bondFill"),
  bondLabel: $("bondLabel"),
  traits: $("traits"),
  memList: $("memList"),
  memCount: $("memCount"),
  forgetBtn: $("forgetBtn"),
  langBadge: $("langBadge"),
  installBtn: $("installBtn"),
  menuBtn: $("menuBtn"),
  backdrop: $("backdrop"),
  relationship: $("relationship"),
  pronoun: $("pronoun"),
};

const state = {
  messages: load("oshadi_history", []),
  userName: "",
  mood: "happy",
  moods: {},
  traitDefs: {},
  traits: {},
  facts: [],
  affection: 20,
  relationship: "partner",
  pronoun: "he",
  busy: false,
};

// ---------- boot ----------
init();

async function init() {
  els.userName.addEventListener("input", () => {
    state.userName = els.userName.value.trim();
    saveTraits();
  });

  els.composer.addEventListener("submit", onSend);
  els.clearBtn.addEventListener("click", clearChat);
  els.forgetBtn.addEventListener("click", forgetMe);

  setupPWA();
  setupMobileMenu();

  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    state.moods = cfg.moods || {};
    state.mood = cfg.defaultMood || "happy";
    state.traitDefs = cfg.traitDefs || {};
    if (cfg.activity) setActivity(cfg.activity);

    // fill mood dropdown
    for (const [key, m] of Object.entries(state.moods)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = `${m.emoji} ${m.label}`;
      els.moodOverride.appendChild(opt);
    }

    // load her persona (memory) from the server
    const p = cfg.persona || {};
    state.userName = p.userName || "";
    state.traits = p.traits || {};
    state.facts = p.facts || [];
    state.affection = p.affection ?? 20;
    state.relationship = p.relationship || "partner";
    state.pronoun = p.pronoun || "he";
    els.userName.value = state.userName;
    buildSelect(els.relationship, cfg.relationshipDefs, state.relationship, (d) => `${d.emoji} ${d.label}`);
    buildSelect(els.pronoun, cfg.pronounDefs, state.pronoun, (d) => d.label);
    els.relationship.addEventListener("change", () => { state.relationship = els.relationship.value; saveTraits(); });
    els.pronoun.addEventListener("change", () => { state.pronoun = els.pronoun.value; saveTraits(); });
    buildSliders();
    renderMemory();
    setBond(state.affection, p.affectionLabel);

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

// fill a <select> from a defs object {key:{...}} with a label fn
function buildSelect(el, defs, selected, labelFn) {
  el.innerHTML = "";
  for (const [key, def] of Object.entries(defs || {})) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = labelFn(def);
    if (key === selected) opt.selected = true;
    el.appendChild(opt);
  }
}

// ---------- personality sliders ----------
function buildSliders() {
  const host = els.traits;
  host.querySelectorAll(".trait").forEach((n) => n.remove());
  for (const [key, def] of Object.entries(state.traitDefs)) {
    const val = state.traits[key] ?? def.default;
    const wrap = document.createElement("div");
    wrap.className = "trait";
    wrap.innerHTML = `
      <div class="trait-head"><span>${def.emoji} ${def.label}</span><b id="tv-${key}">${val}</b></div>
      <input type="range" min="0" max="100" value="${val}" id="tr-${key}" />`;
    host.appendChild(wrap);
    const input = wrap.querySelector("input");
    input.addEventListener("input", () => {
      state.traits[key] = +input.value;
      $(`tv-${key}`).textContent = input.value;
      saveTraits();
    });
  }
}

let traitTimer = null;
function saveTraits() {
  clearTimeout(traitTimer);
  traitTimer = setTimeout(() => {
    fetch("/api/traits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        traits: state.traits,
        userName: state.userName,
        relationship: state.relationship,
        pronoun: state.pronoun,
      }),
    }).catch(() => {});
  }, 400);
}

// ---------- language badge ----------
function setLangBadge(lang, fallback) {
  const si = lang === "sinhala";
  els.langBadge.textContent = si ? "සිං" : "EN";
  els.langBadge.classList.toggle("si", si);
  els.langBadge.title = si
    ? fallback
      ? "Sinhala (add a Gemini key for the best Sinhala)"
      : "Sinhala · Gemini 2.5 Flash"
    : "English";
  if (si && fallback && !sessionStorage.getItem("siWarn")) {
    sessionStorage.setItem("siWarn", "1");
    toast("🌐 Speaking <b>Sinhala</b> — add a free <b>Gemini</b> key in .env for the best Sinhala 💕");
  }
}

// ---------- PWA: install + service worker ----------
let deferredPrompt = null;
function setupPWA() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () =>
      navigator.serviceWorker.register("/sw.js").catch(() => {})
    );
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    els.installBtn.hidden = false;
  });
  els.installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    els.installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    els.installBtn.hidden = true;
    toast("💖 OSHADI installed! Open her any time like an app.");
  });
}

// ---------- mobile slide-in menu ----------
function setupMobileMenu() {
  const open = () => { document.body.classList.add("show-panel"); els.backdrop.classList.add("show"); };
  const close = () => { document.body.classList.remove("show-panel"); els.backdrop.classList.remove("show"); };
  els.menuBtn.addEventListener("click", () =>
    document.body.classList.contains("show-panel") ? close() : open()
  );
  els.backdrop.addEventListener("click", close);
  // close after picking something on mobile
  els.moodOverride.addEventListener("change", close);
}

// ---------- bond + memory ----------
function setBond(value, label) {
  state.affection = value;
  const v = Math.round(value);
  els.bondPct.textContent = v + "%";
  els.bondFill.style.width = v + "%";
  if (label) els.bondLabel.textContent = label;
}

function renderMemory() {
  els.memCount.textContent = state.facts.length;
  if (!state.facts.length) {
    els.memList.innerHTML = `<li class="memory-empty">She's still getting to know you…</li>`;
    return;
  }
  els.memList.innerHTML = "";
  for (const f of state.facts) {
    const li = document.createElement("li");
    li.textContent = f;
    els.memList.appendChild(li);
  }
}

async function forgetMe() {
  if (!confirm("Make OSHADI forget everything she's learned about you?")) return;
  await fetch("/api/forget", { method: "POST" }).catch(() => {});
  state.facts = [];
  state.affection = 20;
  state.userName = "";
  els.userName.value = "";
  renderMemory();
  setBond(20, "still getting to know you");
  toast("💔 <b>OSHADI</b> forgot everything… start fresh?");
}

// After a reply, refresh her memory from the server (she may have learned).
async function refreshMemory() {
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    const p = cfg.persona || {};
    const before = state.facts.length;
    state.facts = p.facts || state.facts;
    state.traits = p.traits || state.traits;
    renderMemory();
    setBond(p.affection ?? state.affection, p.affectionLabel);
    if (state.facts.length > before) {
      const newest = state.facts[state.facts.length - 1];
      toast(`🧠 <b>OSHADI remembered:</b> ${escapeHtml(newest)}`);
    }
  } catch {}
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
        if (typeof evt.affection === "number") setBond(evt.affection, evt.affectionLabel);
        if (evt.language) setLangBadge(evt.language, evt.sinhalaFallback);
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
    // she may have just learned something — refresh her memory panel
    refreshMemory();
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

let toastTimer = null;
function toast(html) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.innerHTML = html;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
