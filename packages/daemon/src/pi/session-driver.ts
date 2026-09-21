import type { RunSpec, TokenUsage } from "@tower/core";

/**
 * THE SEAM. Everything outside src/pi talks to agent sessions through these types only,
 * so a pi upgrade touches one folder and the daemon is testable with FakeSessionDriver.
 */
export interface SessionDriver {
	start(spec: RunSpec): Promise<RunHandle>;
}

export interface RunHandle {
	readonly sessionId: string;
	readonly pid: number | null;
	onEvent(listener: (event: DriverEvent) => void): () => void;
	/** Sends a prompt; resolves once the session accepted it, not when the work is done. */
	prompt(text: string): Promise<void>;
	/** Delivered after the current turn's tool calls, before the next model call. */
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	answerUi(requestId: string, answer: UiAnswer): void;
	stats(): Promise<RunStats>;
	/** Id of the newest session entry: the restart-safe transcript cursor. */
	lastEntryId(): Promise<string | null>;
	/** Resolves on the next settle (no retries, compaction or queued messages left). No timeout. Rejects if the session exits first. */
	waitSettled(): Promise<void>;
	stop(): Promise<void>;
}

export interface RunStats {
	tokens: TokenUsage;
	costUsd: number;
}

export type UiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface TranscriptMessage {
	role: "user" | "assistant" | "toolResult";
	text: string;
	thinking: string;
	toolCalls: Array<{ id: string; name: string; args: unknown }>;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/** Normalised session events. Deliberately not pi's event union. */
export type DriverEvent =
	| { type: "text"; delta: string }
	| { type: "thinking"; delta: string }
	| { type: "tool_start"; id: string; name: string; args: unknown }
	| { type: "tool_end"; id: string; name: string; isError: boolean; output: string }
	| { type: "message"; message: TranscriptMessage }
	| { type: "queue"; steering: string[]; followUp: string[] }
	| { type: "ui_request"; id: string; method: string; blocking: boolean; payload: Record<string, unknown> }
	| { type: "settled" }
	| { type: "exit"; code: number | null; stderr: string };
