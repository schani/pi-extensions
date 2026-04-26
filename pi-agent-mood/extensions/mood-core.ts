const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CUSTOM_TYPE = "agent-mood";
export const DEFAULT_MODEL_PRIORITY =
	"google/gemini-3.1-flash-lite-preview,anthropic/claude-haiku-4.5,openai/gpt-5.4-nano";
export const SMALL_CONVERSATION_BYTES = 5 * 1024;
export const FIRST_UPDATE_BYTES = 128;
export const SMALL_UPDATE_STEP_BYTES = 512;
export const NORMAL_UPDATE_STEP_BYTES = 2 * 1024;
export const SNAPSHOT_BYTES = 10 * 1024;
export const SHELL_COMMAND_PREVIEW_BYTES = 256;
export const TOOL_CALL_EVALUATION_BYTES = 256;

export type MoodResult = {
	activity: {
		word: string;
		emoji: string;
	};
	mood: {
		word: string;
		emoji: string;
	};
	summary: string;
	confidence: number;
};

export type MoodState = {
	mood?: MoodResult;
	model?: string;
	updatedAt?: number;
	totalBytes?: number;
	error?: string;
	resetStartBytes?: number;
};

export type ModelLike = {
	provider: string;
	id: string;
};

export type ModelMatch = {
	model: ModelLike;
	match: "id" | "provider/id";
};

export function byteLength(text: string): number {
	return encoder.encode(text).byteLength;
}

export function formatBytes(bytes: number | undefined): string | undefined {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function lastUtf8Bytes(text: string, maxBytes: number): string {
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= maxBytes) return text;

	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && (bytes[start] & 0b1100_0000) === 0b1000_0000) {
		start++;
	}
	return decoder.decode(bytes.slice(start));
}

export function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; totalBytes: number; truncated: boolean } {
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= maxBytes) return { text, totalBytes: bytes.byteLength, truncated: false };

	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) {
		end--;
	}
	return { text: decoder.decode(bytes.slice(0, end)), totalBytes: bytes.byteLength, truncated: true };
}

export function asTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: string; text?: unknown };
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts;
}

export function toolCallCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let count = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ((part as { type?: string }).type === "toolCall") count++;
	}
	return count;
}

export function redact(text: string): string {
	return text
		.replace(/\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat|glpat|xox[baprs])-[-_A-Za-z0-9]{16,}\b/g, "[REDACTED_SECRET]")
		.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
		.replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function findMatchingModels<T extends ModelLike>(models: T[], spec: string): Array<{ model: T; match: ModelMatch["match"] }> {
	const exactIdMatches = models
		.filter((model) => model.id === spec)
		.map((model) => ({ model, match: "id" as const }));
	if (exactIdMatches.length > 0) return exactIdMatches;

	const slash = spec.indexOf("/");
	if (slash > 0) {
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		return models
			.filter((model) => model.provider === provider && model.id === id)
			.map((model) => ({ model, match: "provider/id" as const }));
	}

	return [];
}

export function updateStepFor(totalBytes: number): number {
	return totalBytes < SMALL_CONVERSATION_BYTES ? SMALL_UPDATE_STEP_BYTES : NORMAL_UPDATE_STEP_BYTES;
}

export function shouldEvaluate(totalBytes: number, lastAttemptedAtBytes: number, force = false, resetAtBytes = 0): boolean {
	if (force) return totalBytes > 0;
	const reset = Math.max(0, Math.min(resetAtBytes, totalBytes));
	const bytesSinceReset = totalBytes - reset;
	if (bytesSinceReset < FIRST_UPDATE_BYTES) return false;

	const lastSinceReset = Math.max(0, lastAttemptedAtBytes - reset);
	if (lastSinceReset === 0) return true;

	const step = updateStepFor(bytesSinceReset);
	return Math.floor(bytesSinceReset / step) > Math.floor(lastSinceReset / step);
}

function pathFromArgs(args: any): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	return typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function attrs(values: Record<string, string | number | boolean | undefined>): string {
	const rendered = Object.entries(values)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}="${escapeAttr(String(value))}"`)
		.join(" ");
	return rendered ? ` ${rendered}` : "";
}

function cdata(text: string): string {
	return `<![CDATA[${text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function taggedText(tag: string, text: string): string {
	return `<${tag}>\n${cdata(text)}\n</${tag}>`;
}

function shellCommandPreview(command: string): { preview: string; totalBytes: number; truncated: boolean } {
	const preview = truncateUtf8Bytes(command, SHELL_COMMAND_PREVIEW_BYTES);
	return { preview: preview.text, totalBytes: preview.totalBytes, truncated: preview.truncated };
}

function shellCommandAttrs(command: string): Record<string, string | number | boolean> {
	const commandPreview = shellCommandPreview(command);
	return {
		command: commandPreview.preview,
		command_bytes: commandPreview.totalBytes,
		truncated: commandPreview.truncated || undefined,
	};
}

function contentBytes(content: unknown): number | undefined {
	const text = asTextParts(content).join("\n");
	return text ? byteLength(text) : undefined;
}

function countSearchResultLines(text: string): number {
	if (text.trim() === "No matches found") return 0;
	return text
		.split("\n")
		.filter((line) => !line.startsWith("[") && /:\d+:/.test(line))
		.length;
}

function searchPatternFromArgs(args: any): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	for (const key of ["pattern", "query", "search", "text"] as const) {
		if (typeof args[key] === "string") return args[key];
	}
	return undefined;
}

export function renderToolCall(block: { name?: unknown; arguments?: unknown }): string | undefined {
	if (typeof block.name !== "string") return undefined;
	const name = block.name;
	const args = block.arguments as any;

	if (name === "bash") {
		const command = typeof args?.command === "string" ? args.command : undefined;
		return `<tool_call${attrs({ name, ...(command ? shellCommandAttrs(command) : {}) })} />`;
	}

	if (name === "read") {
		const path = pathFromArgs(args);
		return `<tool_call${attrs({ name, path })} />`;
	}

	if (name === "write") {
		const path = pathFromArgs(args);
		const bytes = typeof args?.content === "string" ? byteLength(args.content) : undefined;
		return `<tool_call${attrs({ name, path, write_bytes: bytes })} />`;
	}

	if (name === "edit") {
		const path = pathFromArgs(args);
		const edits = Array.isArray(args?.edits) ? args.edits : [];
		const newBytes = edits.reduce((sum: number, edit: any) => sum + (typeof edit?.newText === "string" ? byteLength(edit.newText) : 0), 0);
		return `<tool_call${attrs({ name, path, edits: edits.length || undefined, new_text_bytes: newBytes || undefined })} />`;
	}

	if (name === "grep" || name === "search") {
		const pattern = searchPatternFromArgs(args);
		const path = pathFromArgs(args);
		const glob = typeof args?.glob === "string" ? args.glob : undefined;
		return `<tool_call${attrs({ name, pattern, path, glob })} />`;
	}

	return `<tool_call${attrs({ name })} />`;
}

export function renderToolResult(message: any): string | undefined {
	if (!message || typeof message !== "object" || message.role !== "toolResult" || typeof message.toolName !== "string") {
		return undefined;
	}

	const status = message.isError ? "error" : "success";
	const details = message.details ?? {};
	const truncation = details.truncation;

	if (message.toolName === "read") {
		const shown = contentBytes(message.content);
		const total = typeof truncation?.totalBytes === "number" ? truncation.totalBytes : undefined;
		return `<tool_result${attrs({ name: message.toolName, status, read_bytes: total ?? shown, shown_bytes: shown !== total ? shown : undefined })} />`;
	}

	if (message.toolName === "write" || message.toolName === "edit") {
		const diffBytes = typeof details.diff === "string" ? byteLength(details.diff) : undefined;
		return `<tool_result${attrs({ name: message.toolName, status, diff_bytes: diffBytes })} />`;
	}

	if (message.toolName === "bash") {
		const shown = contentBytes(message.content);
		const total = typeof truncation?.totalBytes === "number" ? truncation.totalBytes : undefined;
		return `<tool_result${attrs({ name: message.toolName, status, output_bytes: total ?? shown, shown_bytes: shown !== total ? shown : undefined })} />`;
	}

	if (message.toolName === "grep" || message.toolName === "search") {
		const text = asTextParts(message.content).join("\n");
		const shownResults = countSearchResultLines(text);
		const limitReached = typeof details.matchLimitReached === "number" ? details.matchLimitReached : undefined;
		return `<tool_result${attrs({ name: message.toolName, status, results: limitReached ?? shownResults, result_count_lower_bound: limitReached !== undefined || undefined })} />`;
	}

	return `<tool_result${attrs({ name: message.toolName, status })} />`;
}

export function renderMessage(message: any): string | undefined {
	if (!message || typeof message !== "object") return undefined;

	if (message.role === "user") {
		const text = asTextParts(message.content).join("\n").trim();
		return text ? taggedText("user_message", text) : undefined;
	}

	if (message.role === "assistant") {
		const lines: string[] = [];
		const text = asTextParts(message.content).join("\n").trim();
		if (text) lines.push(taggedText("assistant_message", text));
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (!part || typeof part !== "object") continue;
				const block = part as { type?: string; name?: unknown; arguments?: unknown };
				if (block.type === "toolCall") {
					const rendered = renderToolCall(block);
					if (rendered) lines.push(rendered);
				}
			}
		}
		return lines.length > 0 ? lines.join("\n") : undefined;
	}

	if (message.role === "toolResult") {
		return renderToolResult(message);
	}

	if (message.role === "bashExecution") {
		const command = typeof message.command === "string" ? message.command : undefined;
		return `<user_bash${attrs({ ...(command ? shellCommandAttrs(command) : {}) })} />`;
	}

	if (message.role === "branchSummary" && typeof message.summary === "string") {
		return taggedText("branch_summary", message.summary);
	}

	if (message.role === "compactionSummary" && typeof message.summary === "string") {
		return taggedText("compaction_summary", message.summary);
	}

	return undefined;
}

export function buildConversationTextFromEntries(entries: any[], liveMessage?: unknown): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const rendered = renderMessage(entry.message);
		if (rendered) sections.push(rendered);
	}

	const liveRendered = renderMessage(liveMessage);
	if (liveRendered && sections[sections.length - 1] !== liveRendered) {
		sections.push(liveRendered);
	}

	return redact(sections.join("\n\n"));
}

export function evaluationBytesForMessage(message: any): number {
	if (!message || typeof message !== "object") return 0;

	let total = byteLength(asTextParts(message.content).join("\n"));
	if (message.role === "assistant") {
		total += toolCallCount(message.content) * TOOL_CALL_EVALUATION_BYTES;
	}
	return total;
}

export type EvaluationSchedule = {
	totalBytes: number;
	latestUserStartBytes: number;
	bytesSinceLatestUser: number;
	stepBytes: number;
};

export function evaluationScheduleFromEntries(entries: any[], liveMessage?: unknown): EvaluationSchedule {
	let totalBytes = 0;
	let latestUserStartBytes = 0;
	let lastRendered: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "user") latestUserStartBytes = totalBytes;
		totalBytes += evaluationBytesForMessage(entry.message);
		lastRendered = renderMessage(entry.message);
	}

	const liveRendered = renderMessage(liveMessage);
	if (liveRendered && liveRendered !== lastRendered) {
		const message = liveMessage as any;
		if (message?.role === "user") latestUserStartBytes = totalBytes;
		totalBytes += evaluationBytesForMessage(liveMessage);
	}

	const bytesSinceLatestUser = totalBytes - latestUserStartBytes;
	return {
		totalBytes,
		latestUserStartBytes,
		bytesSinceLatestUser,
		stepBytes: updateStepFor(bytesSinceLatestUser),
	};
}

export function evaluationByteLengthFromEntries(entries: any[], liveMessage?: unknown): number {
	return evaluationScheduleFromEntries(entries, liveMessage).totalBytes;
}

export function buildMoodPrompt(snapshot: string): string {
	return [
		"You are a mood classifier for a coding agent UI.",
		"Infer the agent's current state from the recent transcript below.",
		"Important: focus on the latest assistant message and latest events. Do not average the mood across the whole input.",
		"The agent does not have real feelings; 'mood' is just a playful UI label for its apparent current stance.",
		"Choose your own one-word activity label and one-word mood label. Do not use a fixed taxonomy.",
		"Choose one emoji for the activity and one emoji for the mood.",
		"Return only JSON with this exact shape:",
		'{"activity":{"word":"one-word-lowercase","emoji":"emoji"},"mood":{"word":"one-word-lowercase","emoji":"emoji"},"summary":"short reason, max 12 words","confidence":0.0}',
		"",
		"Recent transcript, truncated to the latest 10 KB. It uses structured tags: <user_message>, <assistant_message>, <tool_call>, <tool_result>, <user_bash>, <branch_summary>, and <compaction_summary>.",
		"<transcript>",
		snapshot,
		"</transcript>",
	].join("\n");
}

export function extractJsonObject(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return trimmed;

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	if (fenced?.startsWith("{")) return fenced;

	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
	return trimmed;
}

function cleanOneWord(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const cleaned = value.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
	return cleaned || fallback;
}

function cleanShortText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim().replace(/\s+/g, " ").slice(0, 120);
}

function cleanEmoji(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	return value.trim().slice(0, 8) || fallback;
}

export function normalizeMoodResult(value: unknown): MoodResult {
	const data = value as any;
	const confidence = typeof data?.confidence === "number" ? Math.max(0, Math.min(1, data.confidence)) : 0;
	return {
		activity: {
			word: cleanOneWord(data?.activity?.word, "working"),
			emoji: cleanEmoji(data?.activity?.emoji, "⚙️"),
		},
		mood: {
			word: cleanOneWord(data?.mood?.word, "focused"),
			emoji: cleanEmoji(data?.mood?.emoji, "🎯"),
		},
		summary: cleanShortText(data?.summary),
		confidence,
	};
}
