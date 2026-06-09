# 💖 OSHADI — your AI girl dashboard

A white & pink web dashboard that lets you chat in **real time** with **OSHADI**,
an AI that acts like a sweet human girl with changing **moods** (happy, playful,
shy, romantic, sleepy, caring, annoyed, sad…). Uses a **free** AI model.

![theme](https://img.shields.io/badge/theme-white%20%26%20pink-ff6fa5)

## ✨ Features
- Real-time **streaming** chat (replies appear word by word)
- **Mood / personality engine** — her tone and the UI colour shift with her mood
- Personalize: she calls you by your name; pick her vibe or let her feel on her own
- Chat history saved in your browser
- Works with **free** providers: **Groq**, **OpenRouter**, or **Google Gemini**
- Fully responsive (works on phone too)

---

## 🚀 Setup (3 steps)

### 1. Install
```powershell
npm install
```

### 2. Add a FREE API key
Copy the example env file and open it:
```powershell
copy .env.example .env
notepad .env
```

Pick **one** provider and paste its free key:

| Provider | Free key page | Put it in |
|----------|---------------|-----------|
| **Groq** (recommended, fast) | https://console.groq.com/keys | `GROQ_API_KEY=` |
| **OpenRouter** (many free models) | https://openrouter.ai/keys | `OPENROUTER_API_KEY=` and set `PROVIDER=openrouter` |
| **Google Gemini** | https://aistudio.google.com/app/apikey | `GEMINI_API_KEY=` and set `PROVIDER=gemini` |

> The default is Groq. If you use another provider, also change the `PROVIDER=` line.

### 3. Run
```powershell
npm start
```
Then open **http://localhost:3000** 💕

---

## 🎀 Customising OSHADI
- Her personality and moods live in **`persona.js`** — edit the text to change how she talks.
- The look (pink/white theme) lives in **`public/style.css`**.

## 🛠 Tech
Node.js + Express backend (streams the AI reply), vanilla HTML/CSS/JS frontend.
No build step, no framework.

## ❓ Troubleshooting
- **"No API key set"** → you didn't create `.env` or left the key blank.
- **Provider error 401/403** → the key is wrong or not activated yet.
- **Nothing streams** → check the terminal running `npm start` for the error.
