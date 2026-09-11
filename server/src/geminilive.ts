/**
 * Per-session Gemini Live upstream connection via official @google/genai SDK.
 *
 * Gemini Live is full-duplex: real-time 24kHz PCM audio in both directions.
 * Audio produced by Gemini is forwarded directly into the HeyGen LiveAvatar
 * media server.
 */

import { GoogleGenAI, Modality, Type } from "@google/genai";
import type { Turn } from "../../shared/messages";
import { TOOLS } from "../../shared/tools";
import { config } from "./config";
import {
  DEFAULT_GREETING,
  DEFAULT_INSTRUCTIONS,
  GREETING_PREAMBLE,
  LESSON_DIRECTIVE,
} from "./prompts";
import { TurnProjector } from "./turns";

export type AppendKind = "instructions" | "commentary" | "thinking";

export interface GeminiLiveEvents {
  onReady(): void;
  onAudio(audioB64: string): void;
  onTurn(turn: Turn): void;
  onUserTurnStarted(): void;
  onToolCall(
    name: string | null,
    args: Record<string, unknown>,
  ): Record<string, unknown>;
  onError(message: string): void;
}

export class GeminiLiveBridge {
  private session: any = null;
  private turns: TurnProjector;
  private closed = false;
  private onClosedResolve: (() => void) | null = null;

  constructor(
    private readonly events: GeminiLiveEvents,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.turns = new TurnProjector({
      onTurn: (turn) => this.events.onTurn(turn),
      onUserTurnStarted: () => this.events.onUserTurnStarted(),
    });
  }

  async run(): Promise<void> {
    const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

    const functionDeclarations = TOOLS.map((def) => ({
      name: def.name,
      description: def.description,
      parameters: {
        type: Type.OBJECT,
        properties: Object.fromEntries(
          Object.entries(def.parameters).map(([k, v]) => [
            k,
            {
              type:
                ((v as any).type || "string").toUpperCase() === "OBJECT"
                  ? Type.OBJECT
                  : Type.STRING,
              description: (v as any).description,
            },
          ]),
        ),
        required: def.required,
      },
    }));

    const systemText = [
      DEFAULT_INSTRUCTIONS,
      LESSON_DIRECTIVE,
      "When teaching a new Japanese word or phrase, pronounce it slowly and clearly, twice, and call show_term_card with the term, reading, and meaning.",
    ].join("\n\n");

    return new Promise<void>(async (resolve) => {
      this.onClosedResolve = resolve;

      try {
        this.log(`connecting to Gemini Live API with model ${config.gemini.model}...`);
        this.session = await ai.live.connect({
          model: config.gemini.model,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: config.gemini.voice,
                },
              },
            },
            systemInstruction: {
              parts: [{ text: systemText }],
            },
            tools: [{ functionDeclarations }],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
          callbacks: {
            onopen: () => {
              this.log("Gemini Live WebSocket open");
            },
            onmessage: (msg: any) => {
              this.handleServerMessage(msg);
            },
            onerror: (err: any) => {
              const errMsg = err?.message || err?.toString?.() || "Unknown error";
              this.log(`Gemini Live error: ${errMsg}`);
              this.events.onError(errMsg);
            },
            onclose: (e: any) => {
              this.log(`Gemini Live closed: code=${e?.code} reason=${e?.reason}`);
              this.cleanup();
            },
          },
        });
      } catch (err: any) {
        this.log(`Gemini Live connection failed: ${err.message}`);
        this.events.onError(err.message);
        resolve();
      }
    });
  }

  private handleServerMessage(msg: any): void {
    if (config.gemini.debug) {
      this.log(`Gemini msg: ${Object.keys(msg).join(", ")}`);
    }

    if (msg.setupComplete) {
      this.log("Gemini Live setup complete");
      this.events.onReady();
      this.sendGreeting();
    }

    if (msg.serverContent) {
      const sc = msg.serverContent;

      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.data) {
            this.events.onAudio(part.inlineData.data);
          }
        }
      }

      if (sc.outputTranscription?.text) {
        this.turns.fragment("assistant", sc.outputTranscription.text, null, null);
      }

      if (sc.inputTranscription?.text) {
        this.turns.fragment("user", sc.inputTranscription.text, null, null);
      }

      if (sc.interrupted) {
        this.log("Gemini Live user interrupted");
        this.events.onUserTurnStarted();
      }

      if (sc.turnComplete) {
        this.turns.close("assistant");
      }
    }

    if (msg.toolCall?.functionCalls) {
      const responses: Array<{ id: string; name?: string; response: { result: Record<string, unknown> } }> = [];
      for (const call of msg.toolCall.functionCalls) {
        this.log(`Gemini Live tool call: ${call.name} (id: ${call.id})`);
        const result = this.events.onToolCall(
          call.name,
          (call.args as Record<string, unknown>) ?? {},
        );
        responses.push({
          id: call.id,
          name: call.name,
          response: { result },
        });
      }
      try {
        this.session?.sendToolResponse({ functionResponses: responses });
      } catch (err: any) {
        this.log(`Error sending tool response: ${err.message}`);
      }
    }
  }

  private micBuffer: Buffer[] = [];
  private micBytes = 0;
  private micFlushTimer: NodeJS.Timeout | null = null;
  private readonly CHUNK_THRESHOLD = 4800; // ~100ms of 24kHz PCM16 mono

  sendMicAudio(audioB64: string): void {
    if (!this.session || this.closed) return;
    const buf = Buffer.from(audioB64, "base64");
    this.micBuffer.push(buf);
    this.micBytes += buf.length;

    if (this.micBytes >= this.CHUNK_THRESHOLD) {
      this.flushMicAudio();
    } else if (!this.micFlushTimer) {
      this.micFlushTimer = setTimeout(() => this.flushMicAudio(), 100);
    }
  }

  private flushMicAudio(): void {
    if (this.micFlushTimer) {
      clearTimeout(this.micFlushTimer);
      this.micFlushTimer = null;
    }
    if (this.micBytes === 0 || !this.session || this.closed) return;
    const combined = Buffer.concat(this.micBuffer);
    this.micBuffer = [];
    this.micBytes = 0;

    try {
      this.session.sendRealtimeInput({
        audio: {
          data: combined.toString("base64"),
          mimeType: "audio/pcm;rate=24000",
        },
      });
    } catch (err: any) {
      this.log(`Failed to send mic audio: ${err.message}`);
    }
  }

  append(kind: AppendKind, content: string): void {
    if (!this.session || this.closed) return;
    try {
      this.log(`Gemini append [${kind}]: ${content.slice(0, 60)}...`);
      this.session.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [{ text: `[${kind}]: ${content}` }],
          },
        ],
        turnComplete: true,
      });
    } catch (err: any) {
      this.log(`Failed to append ${kind}: ${err.message}`);
    }
  }

  private sendGreeting(): void {
    const greeting = DEFAULT_GREETING;
    if (!greeting) return;
    try {
      this.log("Sending greeting trigger to Gemini Live...");
      this.session?.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [{ text: GREETING_PREAMBLE + greeting }],
          },
        ],
        turnComplete: true,
      });
    } catch (err: any) {
      this.log(`Failed to send greeting: ${err.message}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.session?.close();
    } catch {}
    this.cleanup();
  }

  private cleanup(): void {
    if (this.onClosedResolve) {
      const r = this.onClosedResolve;
      this.onClosedResolve = null;
      r();
    }
  }
}
