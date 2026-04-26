import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { homedir } from "node:os";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { importGlimpse } from "./glimpse-resolver.mjs";
import { getCompanionSocketPath } from "./socket-path.mjs";

const SOCK = getCompanionSocketPath();
const SESSION_ID = randomUUID().slice(0, 8);
const COMPANION_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "companion.mjs");
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "companion.json");
const MOOD_CUSTOM_TYPE = "agent-mood";
const MOOD_POLL_MS = 1500;

type FollowCursorSupport = {
	supported: boolean;
	reason?: string;
};

type MoodPayload = {
	activity?: string;
	activityEmoji?: string;
	mood?: string;
	moodEmoji?: string;
	summary?: string;
	confidence?: number;
	model?: string;
	updatedAt?: number;
	error?: string;
};

function loadEnabled(): boolean {
	try {
		const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
		return data.enabled === true;
	} catch {
		return false;
	}
}

function saveEnabled(value: boolean) {
	try {
		let data: any = {};
		try {
			data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
		} catch {}
		data.enabled = value;
		const dir = dirname(SETTINGS_PATH);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n");
	} catch {}
}

async function getFollowCursorSupport(): Promise<FollowCursorSupport> {
	try {
		const glimpse = (await importGlimpse()) as { getFollowCursorSupport?: () => FollowCursorSupport };
		return glimpse.getFollowCursorSupport?.() ?? { supported: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { supported: false, reason: `glimpseui unavailable: ${message}` };
	}
}

function cleanString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function cleanNumber01(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value));
}

function moodFromEntry(entry: any): MoodPayload | undefined {
	if (!entry || entry.type !== "custom" || entry.customType !== MOOD_CUSTOM_TYPE) return undefined;
	const state = entry.data as any;
	const result = state?.mood;
	if (result && typeof result === "object") {
		return {
			activity: cleanString(result.activity?.word),
			activityEmoji: cleanString(result.activity?.emoji),
			mood: cleanString(result.mood?.word),
			moodEmoji: cleanString(result.mood?.emoji),
			summary: cleanString(result.summary),
			confidence: cleanNumber01(result.confidence),
			model: cleanString(state.model),
			updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : undefined,
		};
	}
	if (typeof state?.error === "string") {
		return { error: state.error };
	}
	return undefined;
}

function latestMood(entries: any[]): MoodPayload | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const mood = moodFromEntry(entries[i]);
		if (mood) return mood;
	}
	return undefined;
}

function newerMood(a: MoodPayload | undefined, b: MoodPayload | undefined): MoodPayload | undefined {
	if (!a) return b;
	if (!b) return a;
	const aTime = a.updatedAt ?? 0;
	const bTime = b.updatedAt ?? 0;
	return bTime > aTime ? b : a;
}

function readMood(ctx: ExtensionContext | undefined): MoodPayload | undefined {
	if (!ctx) return undefined;

	let branchMood: MoodPayload | undefined;
	let globalMood: MoodPayload | undefined;
	try {
		branchMood = latestMood(ctx.sessionManager.getBranch() as any[]);
	} catch {}
	try {
		// pi-agent-mood appends classification results asynchronously while the
		// agent is also appending messages/tool results. Those custom entries can
		// briefly end up as siblings of the active leaf rather than ancestors, so
		// getBranch() alone can miss a fresh mood even though it is in the session.
		globalMood = latestMood(ctx.sessionManager.getEntries() as any[]);
	} catch {}

	return newerMood(branchMood, globalMood);
}

function countMoodEntries(entries: any[]): number {
	let count = 0;
	for (const entry of entries) {
		if (moodFromEntry(entry)) count++;
	}
	return count;
}

function describeMood(mood: MoodPayload | undefined): string {
	if (!mood) return "none";
	if (mood.error) return `error: ${mood.error}`;
	const activity = [mood.activityEmoji, mood.activity].filter(Boolean).join(" ");
	const state = [mood.moodEmoji, mood.mood].filter(Boolean).join(" ");
	const label = [activity, state].filter(Boolean).join(" / ") || "empty mood";
	const suffix = [
		mood.updatedAt ? new Date(mood.updatedAt).toLocaleTimeString() : undefined,
		mood.model,
	]
		.filter(Boolean)
		.join(" · ");
	return suffix ? `${label} (${suffix})` : label;
}

function moodDiagnostics(ctx: ExtensionContext | undefined) {
	if (!ctx) {
		return {
			branchCount: 0,
			allCount: 0,
			branchMood: undefined as MoodPayload | undefined,
			allMood: undefined as MoodPayload | undefined,
			chosenMood: undefined as MoodPayload | undefined,
		};
	}

	let branchEntries: any[] = [];
	let allEntries: any[] = [];
	try {
		branchEntries = ctx.sessionManager.getBranch() as any[];
	} catch {}
	try {
		allEntries = ctx.sessionManager.getEntries() as any[];
	} catch {}
	const branchMood = latestMood(branchEntries);
	const allMood = latestMood(allEntries);
	return {
		branchCount: countMoodEntries(branchEntries),
		allCount: countMoodEntries(allEntries),
		branchMood,
		allMood,
		chosenMood: newerMood(branchMood, allMood),
	};
}

function moodSignature(mood: MoodPayload | undefined): string {
	return JSON.stringify(mood ?? null);
}

export default async function companionExtension(pi: ExtensionAPI) {
	let enabled = loadEnabled();
	let sock: Socket | null = null;
	let lastStatus = "";
	let lastDetail: string | undefined;
	let lastCtx: ExtensionContext | undefined;
	let lastMoodSignature = moodSignature(undefined);
	let lastSentPayload: any;
	let warnedUnsupported = false;
	let moodPoll: ReturnType<typeof setInterval> | undefined;
	const followCursorSupport = await getFollowCursorSupport();

	// ── helpers ────────────────────────────────────────────────────────────────

	function maybeNotifyUnsupported(ctx: ExtensionContext) {
		if (followCursorSupport.supported || warnedUnsupported) return;
		warnedUnsupported = true;
		ctx.ui.notify(`Companion disabled on this platform: ${followCursorSupport.reason}`, "info");
	}

	function currentProject() {
		return basename(lastCtx?.cwd ?? process.cwd()) || "pi";
	}

	function send(status: string, detail?: string) {
		lastStatus = status;
		lastDetail = detail;
		const mood = readMood(lastCtx);
		lastMoodSignature = moodSignature(mood);
		if (!sock || sock.destroyed) return;

		const msg: any = {
			id: SESSION_ID,
			project: currentProject(),
			status,
			detail,
		};
		if (mood) msg.mood = mood;

		if (lastCtx) {
			try {
				const usage = lastCtx.getContextUsage();
				if (usage && usage.percent != null) {
					msg.contextPercent = Math.round(usage.percent);
				}
			} catch {}
		}
		lastSentPayload = msg;
		sock.write(JSON.stringify(msg) + "\n");
	}

	function sendRemove() {
		if (!sock || sock.destroyed) return;
		sock.write(JSON.stringify({ id: SESSION_ID, type: "remove" }) + "\n");
		lastStatus = "";
		lastDetail = undefined;
	}

	function connectToCompanion(): Promise<void> {
		return new Promise((resolve) => {
			sock = connect(SOCK, () => resolve());
			sock.on("error", () => {
				sock = null;
				resolve();
			});
			sock.on("close", () => {
				sock = null;
			});
		});
	}

	async function ensureConnected() {
		if (sock && !sock.destroyed) return;

		// Try connecting to an existing companion.
		await connectToCompanion();
		if (sock) return;

		// Spawn companion and retry.
		const child = spawn(process.execPath, [COMPANION_PATH], {
			detached: true,
			stdio: "ignore",
			windowsHide: process.platform === "win32",
		});
		child.unref();

		// Wait for socket to be available.
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 100));
			await connectToCompanion();
			if (sock) return;
		}
	}

	function startMoodPolling() {
		if (moodPoll) return;
		moodPoll = setInterval(() => {
			if (!enabled || !lastCtx || !lastStatus || !sock || sock.destroyed) return;
			const next = moodSignature(readMood(lastCtx));
			if (next !== lastMoodSignature) send(lastStatus, lastDetail);
		}, MOOD_POLL_MS);
		moodPoll.unref?.();
	}

	function stopMoodPolling() {
		if (!moodPoll) return;
		clearInterval(moodPoll);
		moodPoll = undefined;
	}

	function disconnect() {
		stopMoodPolling();
		if (sock && !sock.destroyed) {
			sendRemove();
			sock.end();
		}
		sock = null;
		lastStatus = "";
		lastDetail = undefined;
	}

	// ── enable / disable ──────────────────────────────────────────────────────

	async function enable(ctx: ExtensionContext) {
		enabled = true;
		saveEnabled(true);
		lastCtx = ctx;
		if (!followCursorSupport.supported) {
			maybeNotifyUnsupported(ctx);
			ctx.ui.setStatus("companion", undefined);
			return;
		}
		await ensureConnected();
		startMoodPolling();
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("companion", theme.fg("accent", "G") + theme.fg("dim", " ·"));
	}

	function disable(ctx: ExtensionContext) {
		enabled = false;
		saveEnabled(false);
		disconnect();
		ctx.ui.setStatus("companion", undefined);
	}

	// ── session start ─────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (enabled) {
			await enable(ctx);
		}
	});

	// ── /companion command ────────────────────────────────────────────────────

	pi.registerCommand("companion", {
		description: "Toggle cursor companion (shows agent activity and mood near cursor)",
		handler: async (_args, ctx) => {
			if (enabled) {
				disable(ctx);
				ctx.ui.notify("Companion disabled", "info");
			} else {
				await enable(ctx);
				if (followCursorSupport.supported) {
					ctx.ui.notify("Companion enabled", "info");
				}
			}
		},
	});

	pi.registerCommand("companion-debug", {
		description: "Show companion socket and mood diagnostics",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			const diag = moodDiagnostics(ctx);
			const connected = sock && !sock.destroyed;
			const lines = [
				`enabled: ${enabled}`,
				`followCursor: ${followCursorSupport.supported}${followCursorSupport.reason ? ` (${followCursorSupport.reason})` : ""}`,
				`socket: ${SOCK}`,
				`connected: ${connected ? "yes" : "no"}`,
				`session id: ${SESSION_ID}`,
				`last status: ${lastStatus || "none"}${lastDetail ? ` (${lastDetail})` : ""}`,
				`branch mood entries: ${diag.branchCount}`,
				`all mood entries: ${diag.allCount}`,
				`branch latest: ${describeMood(diag.branchMood)}`,
				`all latest: ${describeMood(diag.allMood)}`,
				`chosen: ${describeMood(diag.chosenMood)}`,
				`last sent mood: ${describeMood(lastSentPayload?.mood)}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("companion-test-mood", {
		description: "Send a fake mood to the companion to test rendering",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			if (!enabled) await enable(ctx);
			if (!followCursorSupport.supported) return;
			await ensureConnected();
			startMoodPolling();
			const msg = {
				id: SESSION_ID,
				project: currentProject(),
				status: lastStatus || "thinking",
				detail: lastDetail,
				mood: {
					activity: "debugging",
					activityEmoji: "🧪",
					mood: "curious",
					moodEmoji: "🕵️",
					summary: "Manual companion render test",
					confidence: 1,
					model: "test",
					updatedAt: Date.now(),
				},
			};
			lastSentPayload = msg;
			lastMoodSignature = moodSignature(msg.mood);
			if (sock && !sock.destroyed) {
				sock.write(JSON.stringify(msg) + "\n");
				ctx.ui.notify("Sent fake mood to companion. If it does not show, the renderer/socket process is stale or not receiving updates.", "info");
			} else {
				ctx.ui.notify("Companion socket is not connected", "warning");
			}
		},
	});

	pi.registerCommand("companion-restart", {
		description: "Restart the companion connection/process",
		handler: async (_args, ctx) => {
			disconnect();
			await enable(ctx);
			ctx.ui.notify("Companion restarted", "info");
		},
	});

	// ── event handlers ────────────────────────────────────────────────────────

	pi.on("agent_start", async (_event, ctx) => {
		if (!enabled || !followCursorSupport.supported) return;
		lastCtx = ctx;
		await ensureConnected();
		startMoodPolling();
		send("starting");
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled || !followCursorSupport.supported) return;
		lastCtx = ctx;
		send("done");
		setTimeout(() => {
			if (lastStatus === "done") sendRemove();
		}, 3000).unref?.();
	});

	pi.on("message_update", async (_event, ctx) => {
		if (!enabled || !followCursorSupport.supported) return;
		lastCtx = ctx;
		if (lastStatus === "thinking") {
			const next = moodSignature(readMood(lastCtx));
			if (next !== lastMoodSignature) send("thinking", lastDetail);
			return;
		}
		send("thinking");
	});

	pi.on("message_end", async (_event, ctx) => {
		if (!enabled || !followCursorSupport.supported) return;
		lastCtx = ctx;
		const next = moodSignature(readMood(lastCtx));
		if (next !== lastMoodSignature && lastStatus) send(lastStatus, lastDetail);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!enabled || !followCursorSupport.supported) return;
		lastCtx = ctx;
		const next = moodSignature(readMood(lastCtx));
		if (next !== lastMoodSignature && lastStatus) send(lastStatus, lastDetail);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!enabled || !followCursorSupport.supported) return;
		lastCtx = ctx;
		const { toolName, args = {} } = event;

		switch (toolName) {
			case "read":
				send("reading", basename(args.path ?? ""));
				break;
			case "edit":
			case "write":
				send("editing", basename(args.path ?? ""));
				break;
			case "bash":
				send("running", args.command ?? "");
				break;
			case "grep":
			case "find":
			case "ls":
				send("searching", args.pattern ?? args.path ?? "");
				break;
			default:
				send("running", toolName);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!enabled || !followCursorSupport.supported) return;
		lastCtx = ctx;
		if (event.isError) {
			send("error", event.toolName);
		}
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		disconnect();
	});
}
