# LiveAvatar × Gemini Live — Realtime Voice Agent

A **Google Gemini Live API** adaptation of HeyGen's LiveAvatar realtime voice agent reference demo.

This project adapts the original [HeyGen LiveAvatar GPT-Live demo](https://github.com/heygen-com/liveavatar-gpt-live-demos) to use Google's **Gemini Live API** (`gemini-2.5-flash-native-audio-latest`) as the realtime speech-to-speech intelligence layer while preserving HeyGen's LiveAvatar and LiveKit streaming presentation layer.

> **Note:** This is an open-source, community-maintained adaptation based on HeyGen's reference implementation. It is not an official HeyGen or Google release.

---

## Overview

The demo delivers an interactive, full-duplex conversational voice agent with an expressive visual persona: an AI **Japanese tutor ("Mariko")** that teaches basic vocabulary out loud, assesses learner pronunciation, and dynamically triggers visual **term cards** (word · reading · meaning) rendered over the video stream via HyperFrames.

The original implementation relied on OpenAI's GPT-Live and Responses APIs. This repository completely replaces the intelligence layer with Google Gemini's bidirectional live audio streaming protocol (`bidiGenerateContent`), eliminating any dependency on OpenAI credentials or billing.

---

## Architecture

```
                       ┌────────────────────────┐
                 ws    │   Local Orchestrator   │   WebSocket    ┌────────────────────────┐
   mic audio ─────────►│     (Express/Node)     │◄──────────────►│    Google Gemini Live   │
  transcripts ◄────────│       server/          │   PCM16 24kHz  │  (gemini-2.5-flash-    │
   tool calls ◄────────│                        │   bidi stream  │   native-audio-latest) │
                       │  audio ──► media server│                └────────────────────────┘
                       └───────────────┬────────┘
  ┌─────────┐                          │ ws (LITE session)
  │ Browser │     LiveKit WebRTC       │ agent.speak (PCM16 24kHz)
  │  (web/) │◄─────────────────────────▼────────┐
  │         │◄────────────────►│   LiveAvatar   │
  └─────────┘    avatar A/V    │  Media Server  │
                               └────────────────┘
```

### Key Architectural Characteristics

1. **Server-Side Credential Isolation**:
   - The browser client **never** holds Gemini API keys or LiveAvatar account secrets.
   - The browser receives an ephemeral LiveKit room token to display the WebRTC video/audio stream, and a local WebSocket connection (`/ws/:id`) for mic streaming and UI overlay events.
2. **Native Audio Compatibility (Zero-Transcoding)**:
   - **Gemini Live** outputs raw **PCM 16-bit mono audio at 24,000 Hz** (`audio/pcm;rate=24000`).
   - **HeyGen LiveAvatar LITE** media servers accept raw **24kHz PCM16** base64 audio frames in `agent.speak` packets.
   - Audio passes directly from Gemini to HeyGen's media server with no resampling or transcoding overhead.
3. **Optimized Client Audio Buffering**:
   - The browser AudioWorklet (`web/src/micCapture.ts`) buffers downsampled microphone samples into ~85ms chunks (2,048 samples) before transmission, avoiding WebSocket frame flooding while maintaining low latency.
4. **Tool / Function Calling**:
   - Visual tools (`show_term_card`, `show_learned_words`, `hide_card`) are declared as native Gemini function declarations.
   - When Gemini invokes a tool during conversation, the orchestrator dispatches `{ type: "ui", widget, props }` to the browser, rendering animated DOM overlays on top of the avatar's WebRTC stream.
5. **Natural Barge-In & Interruption**:
   - Gemini Live's native voice activity detection and interruption events (`serverContent.interrupted`) trigger downstream audio queue purges on the LiveAvatar media server, ensuring immediate and natural speech cutoffs when the user speaks.

---

## Main Features

- 🎙️ **Full-Duplex Voice Conversation**: Realtime speech-to-speech with natural conversational timing and low latency.
- ⚡ **Google Gemini Live API**: Powered by `gemini-2.5-flash-native-audio-latest` with native audio generation and expressiveness.
- 👤 **HeyGen LiveAvatar**: Realistic interactive video avatar streamed over LiveKit WebRTC.
- 🗂️ **Dynamic Visual Overlays**: Animated lesson term cards and recap panels triggered by tool calls and rendered via HyperFrames.
- 📝 **Live Dual Transcription**: Simultaneous real-time transcription for both user speech and avatar speech.
- 🛑 **Interruption / Barge-in**: Speak over the avatar at any time; the avatar immediately yields.
- 🇯🇵 **Japanese Tutor Persona**: Configurable persona located in clean markdown files (`server/prompts/instructions.md` and `server/prompts/greeting.md`).

---

## Supported Tools

| Tool Name | Parameters | Description |
| --- | --- | --- |
| `show_term_card` | `term`, `reading`, `meaning` | Displays an animated lower-third card reinforcing vocabulary in real time. |
| `show_learned_words` | `title` | Triggers a full-screen recap panel reviewing vocabulary recorded during the session. |
| `hide_card` | `reason` | Dismisses any active overlay card before its natural expiration. |

---

## Quickstart

### Prerequisites
- **Node.js** ≥ 20.12
- **pnpm** ≥ 9.0.0
- **HeyGen LiveAvatar API Key**: From [app.liveavatar.com](https://app.liveavatar.com)
- **Google Gemini API Key**: From [Google AI Studio](https://aistudio.google.com/)

### Installation & Setup

```bash
# 1. Clone the repository
git clone https://github.com/mahdijnt/liveavatar-gemini-live-demo.git
cd liveavatar-gemini-live-demo

# 2. Install workspace dependencies
pnpm install

# 3. Interactive environment setup (verifies keys against live APIs)
pnpm run setup

# 4. Start development server
pnpm dev
```

The application will be available at **http://localhost:5173**. Click **"Start talking"**, grant microphone access, and start your conversation with Mariko!

---

## Environment Variables

Configure `.env` at the repository root:

```ini
# Required: HeyGen LiveAvatar API Key
LIVEAVATAR_API_KEY=your_liveavatar_api_key

# Required: Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key

# Model & Voice Settings
GEMINI_MODEL=gemini-2.5-flash-native-audio-latest
GEMINI_VOICE=Aoede

# Avatar Selection (Default avatar provided)
LIVEAVATAR_AVATAR_ID=65f9e3c9-d48b-4118-b73a-4ae2e3cbb8f0

# Optional Settings
# GEMINI_DEBUG=1
# PORT=8787
```

Available Gemini voices: `Aoede`, `Puck`, `Charon`, `Kore`, `Fenrir`.

---

## Project Structure

```
├── docs/
│   ├── ARCHITECTURE.md          # In-depth architectural documentation
│   └── GEMINI_MIGRATION.md      # Detailed GPT-Live to Gemini migration notes
├── scripts/
│   ├── check-env.mjs            # Startup environment variable validation
│   └── setup.mjs                # Interactive API credential setup & verification
├── server/                      # Node.js backend orchestrator
│   ├── prompts/                 # Markdown persona definitions (instructions, greeting)
│   └── src/
│       ├── config.ts            # Environment and runtime configuration
│       ├── geminilive.ts        # Gemini Live API bidirectional bridge (@google/genai)
│       ├── mediaServer.ts       # HeyGen LiveAvatar LITE WebSocket client
│       ├── session.ts           # Multi-leg session coordinator and barge-in logic
│       ├── tools.ts             # Tool dispatcher and session state tracking
│       └── turns.ts             # Streaming transcript and turn projector
├── shared/                      # Shared types, tool schemas, and wire protocols
│   ├── messages.ts              # WebSocket messages between server and browser
│   └── tools.ts                 # JSON schemas for function calling
└── web/                         # Vite + TypeScript browser client
    ├── index.html               # Main UI markup
    ├── public/overlays/         # HyperFrames overlay compositions (GSAP animated)
    └── src/
        ├── livekitRoom.ts       # LiveKit WebRTC client integration
        ├── micCapture.ts        # AudioWorklet PCM downsampler (24kHz)
        └── overlays/            # Overlay widget renderers
```

---

## Development Commands

```bash
# Start both server and client with hot reloading
pnpm dev

# Typecheck all packages
pnpm typecheck

# Build client for production
pnpm build

# Start production server
pnpm start
```

---

## Troubleshooting

- **`Missing required env: GEMINI_API_KEY`**: Run `pnpm run setup` to configure and verify your API keys, or ensure `.env` contains valid credentials.
- **Microphone unavailable**: Ensure your browser has granted microphone access permissions for `http://localhost:5173`.
- **Avatar connects but does not speak**: Ensure your `GEMINI_API_KEY` has access to the Gemini Live API. Enable `GEMINI_DEBUG=1` in `.env` to inspect upstream WebSocket frames.
- **Port 8787 already in use**: Set `PORT=8788` in `.env` and update the proxy configuration in `web/vite.config.ts`.

---

## Attribution & Upstream Project

This repository is derived from the official HeyGen reference integration:
- **Original Repository**: [heygen-com/liveavatar-gpt-live-demos](https://github.com/heygen-com/liveavatar-gpt-live-demos)
- **Original Author**: [HeyGen](https://heygen.com)
- **Adapted By**: [mahdijnt](https://github.com/mahdijnt)

---

## License

This project is licensed under the [MIT License](LICENSE), matching the original repository.

Vendored third-party libraries (such as GSAP in `web/public/overlays/vendor/gsap.min.js`) remain subject to their respective licenses (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
