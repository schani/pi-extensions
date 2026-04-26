import { complete, parseJsonWithRepair } from "@mariozechner/pi-ai";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	buildConversationTextFromEntries,
	buildMoodPrompt,
	CUSTOM_TYPE,
	DEFAULT_MODEL_PRIORITY,
	evaluationScheduleFromEntries,
	extractJsonObject,
	findMatchingModels,
	lastUtf8Bytes,
	normalizeMoodResult,
	shouldEvaluate,
	SNAPSHOT_BYTES,
	type MoodState,
} from "./mood-core.ts";

type MoodModelDiagnostic = {
	spec: string;
	candidates: Array<{
		model: string;
		match: "id" | "provider/id";
		status: "usable" | "auth-error" | "no-auth";
		reason?: string;
	}>;
};

type MoodModelResolution = {
	model?: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	diagnostics: MoodModelDiagnostic[];
	error?: string;
};

let currentState: MoodState = {};
let lastAttemptedAtBytes = 0;
let inFlight = false;
let pending = false;
let latestLiveMessage: unknown;
let disposed = false;
let warnedNoModel = false;
let currentPi: ExtensionAPI | undefined;

function getFlagString(pi: ExtensionAPI, name: string, fallback: string): string {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getFlagBoolean(pi: ExtensionAPI, name: string): boolean {
	return pi.getFlag(name) === true;
}

function getModelPriority(pi: ExtensionAPI): string[] {
	const explicitModel = getFlagString(pi, "agent-mood-model", "");
	const priority = getFlagString(pi, "agent-mood-models", DEFAULT_MODEL_PRIORITY)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);

	return explicitModel ? [explicitModel, ...priority.filter((value) => value !== explicitModel)] : priority;
}

function formatModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function formatDiagnostics(result: MoodModelResolution, pi: ExtensionAPI): string {
	const priority = getModelPriority(pi);
	const lines = [`Priority: ${priority.join(", ")}`];
	for (const diagnostic of result.diagnostics) {
		if (diagnostic.candidates.length === 0) {
			lines.push(`- ${diagnostic.spec}: no matching model in pi registry`);
			continue;
		}
		lines.push(`- ${diagnostic.spec}:`);
		for (const candidate of diagnostic.candidates) {
			const suffix = candidate.reason ? ` (${candidate.reason})` : "";
			lines.push(`  - ${candidate.model} via ${candidate.match}: ${candidate.status}${suffix}`);
		}
	}
	return lines.join("\n");
}

async function resolveMoodModel(ctx: ExtensionContext, pi: ExtensionAPI): Promise<MoodModelResolution> {
	const models = ctx.modelRegistry.getAll() as Model<Api>[];
	const priority = getModelPriority(pi);
	const diagnostics: MoodModelDiagnostic[] = [];

	for (const spec of priority) {
		const matches = findMatchingModels(models, spec) as Array<{ model: Model<Api>; match: "id" | "provider/id" }>;
		const diagnostic: MoodModelDiagnostic = { spec, candidates: [] };
		diagnostics.push(diagnostic);

		for (const match of matches) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(match.model);
			if (!auth.ok) {
				diagnostic.candidates.push({
					model: formatModel(match.model),
					match: match.match,
					status: "auth-error",
					reason: auth.error,
				});
				continue;
			}
			if (!auth.apiKey && !auth.headers) {
				diagnostic.candidates.push({
					model: formatModel(match.model),
					match: match.match,
					status: "no-auth",
					reason: "getApiKeyAndHeaders returned neither apiKey nor headers",
				});
				continue;
			}

			diagnostic.candidates.push({ model: formatModel(match.model), match: match.match, status: "usable" });
			return { model: match.model, apiKey: auth.apiKey, headers: auth.headers, diagnostics };
		}
	}

	return {
		diagnostics,
		error: `No configured mood model.\n${formatDiagnostics({ diagnostics }, pi)}`,
	};
}

function buildConversationText(ctx: ExtensionContext, liveMessage?: unknown): string {
	return buildConversationTextFromEntries(ctx.sessionManager.getBranch() as any[], liveMessage);
}

async function askMoodModel(ctx: ExtensionContext, pi: ExtensionAPI, snapshot: string): Promise<MoodState> {
	const resolved = await resolveMoodModel(ctx, pi);
	if (!resolved.model) {
		return { error: resolved.error };
	}

	const response = await complete(
		resolved.model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildMoodPrompt(snapshot) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			maxTokens: 180,
			temperature: 0,
			signal: ctx.signal,
			reasoningEffort: "minimal",
		},
	);

	const text = (response as AssistantMessage).content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	const parsed = parseJsonWithRepair<unknown>(extractJsonObject(text));
	return {
		mood: normalizeMoodResult(parsed),
		model: formatModel(resolved.model),
		updatedAt: Date.now(),
	};
}

function renderStatus(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	if (currentState.mood) {
		const { activity, mood } = currentState.mood;
		ctx.ui.setStatus(CUSTOM_TYPE, `${activity.emoji} ${activity.word} / ${mood.emoji} ${mood.word}`);
	} else if (currentState.error) {
		ctx.ui.setStatus(CUSTOM_TYPE, currentState.error.startsWith("No configured mood model") ? "mood: no model" : "mood: error");
	} else {
		ctx.ui.setStatus(CUSTOM_TYPE, "mood: waiting");
	}

	if (!currentPi || !getFlagBoolean(currentPi, "agent-mood-widget")) {
		ctx.ui.setWidget(CUSTOM_TYPE, undefined);
		return;
	}

	if (currentState.mood) {
		const confidence = Math.round(currentState.mood.confidence * 100);
		ctx.ui.setWidget(CUSTOM_TYPE, [
			`Agent mood: ${currentState.mood.activity.emoji} ${currentState.mood.activity.word} / ${currentState.mood.mood.emoji} ${currentState.mood.mood.word}`,
			currentState.mood.summary ? `Why: ${currentState.mood.summary}` : "Why: model did not provide a reason",
			`Confidence: ${confidence}%${currentState.model ? ` • ${currentState.model}` : ""}`,
		]);
	} else {
		ctx.ui.setWidget(CUSTOM_TYPE, [currentState.error ?? "Waiting for enough conversation to classify mood..."]);
	}
}

async function maybeEvaluate(ctx: ExtensionContext, pi: ExtensionAPI, liveMessage?: unknown, force = false) {
	if (disposed) return;

	latestLiveMessage = liveMessage;
	const branch = ctx.sessionManager.getBranch() as any[];
	const conversationText = buildConversationTextFromEntries(branch, liveMessage);
	const schedule = evaluationScheduleFromEntries(branch, liveMessage);
	const totalBytes = schedule.totalBytes;

	if (!shouldEvaluate(totalBytes, lastAttemptedAtBytes, force, schedule.latestUserStartBytes)) {
		renderStatus(ctx);
		return;
	}

	if (inFlight) {
		pending = true;
		return;
	}

	inFlight = true;
	pending = false;
	lastAttemptedAtBytes = totalBytes;

	try {
		const snapshot = lastUtf8Bytes(conversationText, SNAPSHOT_BYTES);
		const nextState = await askMoodModel(ctx, pi, snapshot);
		if (disposed) return;

		currentState = { ...nextState, totalBytes };
		if (nextState.error) {
			if (!warnedNoModel && ctx.hasUI) {
				ctx.ui.notify(nextState.error, "warning");
				warnedNoModel = true;
			}
		} else {
			pi.appendEntry(CUSTOM_TYPE, currentState);
		}
		renderStatus(ctx);
	} catch (error) {
		if (!disposed) {
			currentState = {
				...currentState,
				error: error instanceof Error ? error.message : String(error),
				totalBytes,
			};
			renderStatus(ctx);
		}
	} finally {
		inFlight = false;
		if (pending && !disposed) {
			pending = false;
			void maybeEvaluate(ctx, pi, latestLiveMessage, false);
		}
	}
}

function restoreState(ctx: ExtensionContext) {
	currentState = {};
	lastAttemptedAtBytes = 0;
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		if (entry.data && typeof entry.data === "object") {
			currentState = entry.data as MoodState;
			lastAttemptedAtBytes = currentState.totalBytes ?? lastAttemptedAtBytes;
		}
	}
}

async function showMoodModel(ctx: ExtensionCommandContext, pi: ExtensionAPI) {
	const resolved = await resolveMoodModel(ctx, pi);
	if (!ctx.hasUI) return;
	if (resolved.model) {
		ctx.ui.notify(`Mood model: ${formatModel(resolved.model)}\n${formatDiagnostics(resolved, pi)}`, "info");
	} else {
		ctx.ui.notify(resolved.error ?? `No mood model resolved\n${formatDiagnostics(resolved, pi)}`, "warning");
	}
}

export default function agentMoodExtension(pi: ExtensionAPI) {
	currentPi = pi;

	pi.registerFlag("agent-mood-model", {
		type: "string",
		description: "Single mood model to use before the priority list, e.g. openrouter/anthropic/claude-haiku-4.5",
		default: "",
	});
	pi.registerFlag("agent-mood-models", {
		type: "string",
		description: "Comma-separated mood model priority list",
		default: DEFAULT_MODEL_PRIORITY,
	});
	pi.registerFlag("agent-mood-widget", {
		type: "boolean",
		description: "Show a detailed agent mood widget above the editor",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		disposed = false;
		warnedNoModel = false;
		restoreState(ctx);
		renderStatus(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		void maybeEvaluate(ctx, pi, event.message, false);
	});

	pi.on("message_end", async (event, ctx) => {
		void maybeEvaluate(ctx, pi, event.message, false);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
		renderStatus(ctx);
		void maybeEvaluate(ctx, pi, undefined, false);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		disposed = true;
	});

	pi.registerCommand("mood", {
		description: "Show the agent's current model-classified mood",
		handler: async (_args, ctx) => {
			renderStatus(ctx);
			if (!ctx.hasUI) return;
			if (currentState.mood) {
				const confidence = Math.round(currentState.mood.confidence * 100);
				ctx.ui.notify(
					`${currentState.mood.activity.emoji} ${currentState.mood.activity.word} / ${currentState.mood.mood.emoji} ${currentState.mood.mood.word} (${confidence}%)`,
					"info",
				);
			} else {
				ctx.ui.notify(currentState.error ?? "No mood classified yet", currentState.error ? "warning" : "info");
			}
		},
	});

	pi.registerCommand("mood-refresh", {
		description: "Force-refresh the agent mood using the mood model",
		handler: async (_args, ctx) => {
			await maybeEvaluate(ctx, pi, undefined, true);
		},
	});

	pi.registerCommand("mood-model", {
		description: "Show which mood model will be used, or why none is usable",
		handler: async (_args, ctx) => showMoodModel(ctx, pi),
	});

	pi.registerCommand("mood-models", {
		description: "Show which mood model will be used, or why none is usable",
		handler: async (_args, ctx) => showMoodModel(ctx, pi),
	});
}
