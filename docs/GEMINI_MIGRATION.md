# Migration from OpenAI GPT-Live to Google Gemini Live API

This document details the architectural and implementation changes made to migrate the HeyGen LiveAvatar reference demo from **OpenAI GPT-Live** (`gpt-live-1` + Responses API) to **Google Gemini Live API** (`gemini-2.5-flash-native-audio-latest`).

---

## 1. Background & Motivation

The original HeyGen reference implementation used OpenAI's real-time voice protocol:
- An upstream WebSocket connection to `wss://api.openai.com/v1/live/sessions` (`gpt-live-1`).
- Delegation to a second backend model (`gpt-5.4-nano` via the Responses API) whenever tool calls were needed.
- Complex turn projection to reconcile audio deltas without native timeline fields.

**Why Gemini Live?**
1. **Unified Multimodal Intelligence**: Gemini 2.5 Flash Native Audio (`gemini-2.5-flash-native-audio-latest`) natively accepts and emits conversational audio in real time without needing a separate model for tool execution.
2. **Direct Function Calling**: Gemini Live supports native tool declarations within the same bidirectional session. There is no need for model delegation or multi-hop round trips to trigger on-screen visual overlays.
3. **Open Ecosystem & Cost Efficiency**: Eliminates dependence on OpenAI credentials and credits, allowing developers to build on Google AI Studio's Gemini infrastructure.

---

## 2. Architectural Comparison

### Previous Architecture (OpenAI GPT-Live)
```
Browser Mic ──► Node Orchestrator ──► OpenAI GPT-Live (wss://api.openai.com)
                                             │
                                     (Delegated turn)
                                             ▼
                                     OpenAI Responses API (tools)
                                             │
Node Orchestrator ◄── Audio + Tools ─────────┘
        │
        ├──► LiveAvatar Media Server (ws)
        └──► Browser (LiveKit + Overlays)
```

### New Architecture (Google Gemini Live)
```
Browser Mic ──► Node Orchestrator ──► Google Gemini Live API (@google/genai)
                                             │
                                   (Native Audio & Tools)
                                             │
Node Orchestrator ◄── Audio + Tools ─────────┘
        │
        ├──► LiveAvatar Media Server (ws)
        └──► Browser (LiveKit + Overlays)
```

---

## 3. Realtime Connection & Protocol

The bridge implementation lives in `server/src/geminilive.ts` using the official `@google/genai` SDK:

```typescript
import { GoogleGenAI, Modality, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

const session = await ai.live.connect({
  model: config.gemini.model, // gemini-2.5-flash-native-audio-latest
  config: {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: config.gemini.voice, // Aoede
        },
      },
    },
    systemInstruction: { parts: [{ text: systemText }] },
    tools: [{ functionDeclarations }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  },
  callbacks: {
    onopen: () => { ... },
    onmessage: (msg) => { ... },
    onerror: (err) => { ... },
    onclose: (e) => { ... },
  }
});
```

### Protocol Lifecycle
1. **`setupComplete`**: The connection handshake finishes and Gemini confirms the system prompt, modalities, voice, and tool definitions.
2. **Greeting Initialization**: The orchestrator sends a `sendClientContent` turn triggering the opening Japanese tutor greeting.
3. **Continuous Audio Ingestion**: Browser mic audio is downsampled to 24kHz PCM16, buffered into ~85–100ms frames, and forwarded to `session.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=24000" } })`.
4. **Streaming Response**: Gemini streams audio chunks via `serverContent.modelTurn.parts` (`inlineData.data`), and transcripts via `serverContent.outputTranscription`.

---

## 4. Audio Pipeline & Zero-Transcoding

| Stage | Format | Sample Rate | Channels | Notes |
| --- | --- | --- | --- | --- |
| **Browser Mic Capture** | PCM Float32 → Int16 | 24,000 Hz | Mono | Buffered in AudioWorklet (`web/src/micCapture.ts`) to 2,048 samples |
| **Server → Gemini Live** | Raw PCM16 Base64 | 24,000 Hz | Mono | Sent via `sendRealtimeInput` with `audio/pcm;rate=24000` |
| **Gemini Live Output** | Raw PCM16 Base64 | 24,000 Hz | Mono | Received in `part.inlineData.data` |
| **Server → HeyGen Avatar** | Raw PCM16 Base64 | 24,000 Hz | Mono | Sent directly via `agent.speak` packets |
| **HeyGen → Browser** | WebRTC Opus | 48,000 Hz | Stereo | Delivered via LiveKit Cloud |

Because both Gemini Live's native output and HeyGen's LITE media server speak raw 24kHz PCM16, **no resampling or audio transcoding was required**, preserving audio fidelity and ensuring minimal latency.

### Audio Backpressure Prevention
The original AudioWorklet in `micCapture.ts` posted messages every 128 samples (~5ms), generating over 375 WebSocket frames per second. This caused upstream connection drops (`1011: Deadline expired before operation could complete`).
- **Fix**: The AudioWorklet now buffers downsampled samples into 2,048-sample (~85ms) frames before dispatching to the main thread.
- **Server Coalescing**: `server/src/geminilive.ts` enforces a 4,800-byte (~100ms) threshold before calling `session.sendRealtimeInput`.

---

## 5. Tool & Function Calling

Visual tool definitions from `shared/tools.ts` are mapped directly to Gemini's `FunctionDeclaration` schema:

```typescript
const functionDeclarations = TOOLS.map((def) => ({
  name: def.name,
  description: def.description,
  parameters: {
    type: Type.OBJECT,
    properties: Object.fromEntries(
      Object.entries(def.parameters).map(([k, v]) => [
        k,
        {
          type: ((v as any).type || "string").toUpperCase() === "OBJECT" ? Type.OBJECT : Type.STRING,
          description: (v as any).description,
        },
      ]),
    ),
    required: def.required,
  },
}));
```

When Gemini invokes a function:
1. `msg.toolCall.functionCalls` arrives on the WebSocket.
2. The orchestrator dispatches the call locally via `dispatchToolCall()` in `server/src/tools.ts`.
3. The UI overlay message `{ type: "ui", widget: "term_card", props }` is emitted to the browser.
4. The tool result is returned via `session.sendToolResponse({ functionResponses: [...] })`.

---

## 6. Interruption & Barge-In

Natural conversation requires that users can interrupt the avatar mid-sentence:
1. When the user begins speaking while Gemini is talking, Gemini's server-side VAD detects speech.
2. Gemini sends `serverContent.interrupted: true`.
3. The orchestrator captures this signal and emits `onUserTurnStarted()`.
4. The media server leg sends an `agent.interrupt` command to the HeyGen media server, immediately flushing any queued audio chunks so the avatar stops talking without lag.

---

## 7. Environment Variable Changes

| Old Variable | New Variable | Default / Recommended Value | Description |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | `GEMINI_API_KEY` | *(Required)* | Google Gemini API Key |
| `GPT_LIVE_MODEL` | `GEMINI_MODEL` | `gemini-2.5-flash-native-audio-latest` | Gemini Live conversational model |
| `GPT_LIVE_VOICE` | `GEMINI_VOICE` | `Aoede` | Natural conversational voice |
| `GPT_LIVE_DEBUG` | `GEMINI_DEBUG` | `0` or `1` | Verbose upstream WebSocket logging |
| `GPT_LIVE_RESPONSES_MODEL` | *(Removed)* | N/A | No longer needed (Gemini handles tools natively) |

---

## 8. Summary of Files Changed

- **`server/package.json`**: Added `@google/genai`.
- **`server/src/geminilive.ts`**: New Gemini Live client bridge.
- **`server/src/gptlive.ts`**: Removed old OpenAI bridge.
- **`server/src/config.ts`**: Replaced OpenAI config with Gemini config.
- **`server/src/session.ts`**: Replaced `GptLiveBridge` with `GeminiLiveBridge`.
- **`web/src/micCapture.ts`**: Added AudioWorklet buffering for stable streaming.
- **`web/index.html`**: Updated title, headings, and copy.
- **`scripts/check-env.mjs` & `scripts/setup.mjs`**: Updated key verification to use Google Gemini endpoints.
- **`.env.example` & `.env`**: Replaced OpenAI settings with Gemini configuration.
