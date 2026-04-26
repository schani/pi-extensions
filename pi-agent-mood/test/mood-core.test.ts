import test from "node:test";
import assert from "node:assert/strict";

import {
	buildConversationTextFromEntries,
	evaluationByteLengthFromEntries,
	evaluationScheduleFromEntries,
	findMatchingModels,
	lastUtf8Bytes,
	normalizeMoodResult,
	renderMessage,
	renderToolCall,
	shouldEvaluate,
	truncateUtf8Bytes,
} from "../extensions/mood-core.ts";

test("findMatchingModels prefers exact model ids over provider/id interpretation", () => {
	const models = [
		{ provider: "google", id: "gemini-3.1-flash-lite-preview" },
		{ provider: "openrouter", id: "google/gemini-3.1-flash-lite-preview" },
	];

	const matches = findMatchingModels(models, "google/gemini-3.1-flash-lite-preview");

	assert.deepEqual(matches, [{ model: models[1], match: "id" }]);
});

test("findMatchingModels falls back to provider/id when no exact id exists", () => {
	const models = [{ provider: "anthropic", id: "claude-haiku-4-5" }];

	const matches = findMatchingModels(models, "anthropic/claude-haiku-4-5");

	assert.deepEqual(matches, [{ model: models[0], match: "provider/id" }]);
});

test("shouldEvaluate uses first 128 B update, then 512 B / 2 KB thresholds", () => {
	assert.equal(shouldEvaluate(127, 0), false);
	assert.equal(shouldEvaluate(128, 0), true);
	assert.equal(shouldEvaluate(511, 128), false);
	assert.equal(shouldEvaluate(512, 128), true);
	assert.equal(shouldEvaluate(1023, 512), false);
	assert.equal(shouldEvaluate(1024, 512), true);

	assert.equal(shouldEvaluate(5 * 1024, 4 * 1024), false);
	assert.equal(shouldEvaluate(6 * 1024, 4 * 1024), true);
});

test("shouldEvaluate applies first 128 B and small thresholds after a user-message reset point", () => {
	assert.equal(shouldEvaluate(100 * 1024 + 127, 99 * 1024, false, 100 * 1024), false);
	assert.equal(shouldEvaluate(100 * 1024 + 128, 99 * 1024, false, 100 * 1024), true);
	assert.equal(shouldEvaluate(100 * 1024 + 511, 100 * 1024 + 128, false, 100 * 1024), false);
	assert.equal(shouldEvaluate(100 * 1024 + 512, 100 * 1024 + 128, false, 100 * 1024), true);
	assert.equal(shouldEvaluate(100 * 1024 + 1023, 100 * 1024 + 512, false, 100 * 1024), false);
	assert.equal(shouldEvaluate(100 * 1024 + 1024, 100 * 1024 + 512, false, 100 * 1024), true);
	assert.equal(shouldEvaluate(100 * 1024 + 6 * 1024, 100 * 1024 + 4 * 1024, false, 100 * 1024), true);
});

test("UTF-8 truncation never splits multibyte characters", () => {
	const text = "abc🙂def";
	const truncated = truncateUtf8Bytes(text, 6);
	assert.equal(truncated.text, "abc");
	assert.equal(truncated.truncated, true);

	const tail = lastUtf8Bytes(text, 6);
	assert.equal(tail, "def");
});

test("normalizeMoodResult does not fabricate missing words or emoji", () => {
	assert.deepEqual(normalizeMoodResult({ activity: { word: "Reading" }, mood: { emoji: "🤔" } }), {
		activity: { word: "reading" },
		mood: { emoji: "🤔" },
	});
	assert.deepEqual(normalizeMoodResult({}), {});
});

test("evaluationByteLengthFromEntries counts every assistant tool call as 256 bytes", () => {
	const total = evaluationByteLengthFromEntries([
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
				],
			},
		},
	]);

	assert.equal(total, 5 + 256 * 2);
});

test("evaluationScheduleFromEntries resets cadence at the latest user message", () => {
	const entries = [
		{
			type: "message",
			message: { role: "user", content: "u".repeat(1000) },
		},
		{
			type: "message",
			message: { role: "assistant", content: "a".repeat(10 * 1024) },
		},
		{
			type: "message",
			message: { role: "user", content: "next" },
		},
		{
			type: "message",
			message: { role: "assistant", content: "ok" },
		},
	];

	const schedule = evaluationScheduleFromEntries(entries);
	assert.equal(schedule.latestUserStartBytes, 1000 + 10 * 1024);
	assert.equal(schedule.bytesSinceLatestUser, 6);
	assert.equal(schedule.stepBytes, 512);
});

test("renderToolCall includes read path", () => {
	assert.equal(
		renderToolCall({ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }),
		'<tool_call name="read" path="src/index.ts" />',
	);
});

test("renderToolCall includes write path and content byte count", () => {
	assert.equal(
		renderToolCall({ type: "toolCall", name: "write", arguments: { path: "out.txt", content: "hello" } }),
		'<tool_call name="write" path="out.txt" write_bytes="5" />',
	);
});

test("renderToolCall truncates bash commands to 256 bytes and reports full length", () => {
	const command = "x".repeat(300);
	const rendered = renderToolCall({ type: "toolCall", name: "bash", arguments: { command } });

	assert.match(rendered ?? "", /^<tool_call name="bash" command="x+/);
	assert.match(rendered ?? "", /command_bytes="300" truncated="true" \/>$/);
	assert.equal(rendered!.includes(command), false);
});

test("renderMessage includes read result byte metadata when truncation details are available", () => {
	const rendered = renderMessage({
		role: "toolResult",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: "shown" }],
		details: { truncation: { totalBytes: 1234 } },
	});

	assert.equal(rendered, '<tool_result name="read" status="success" read_bytes="1234" shown_bytes="5" />');
});

test("renderToolCall includes search pattern and scope", () => {
	assert.equal(
		renderToolCall({ type: "toolCall", name: "grep", arguments: { pattern: "TODO", path: "src", glob: "*.ts" } }),
		'<tool_call name="grep" pattern="TODO" path="src" glob="*.ts" />',
	);
});

test("renderMessage includes grep result counts", () => {
	const rendered = renderMessage({
		role: "toolResult",
		toolName: "grep",
		isError: false,
		content: [{ type: "text", text: "src/a.ts:1: TODO one\nsrc/b.ts:2: TODO two\n[notice]" }],
	});

	assert.equal(rendered, '<tool_result name="grep" status="success" results="2" />');
});

test("renderMessage reports grep lower bound when match limit was reached", () => {
	const rendered = renderMessage({
		role: "toolResult",
		toolName: "grep",
		isError: false,
		content: [{ type: "text", text: "src/a.ts:1: TODO" }],
		details: { matchLimitReached: 100 },
	});

	assert.equal(rendered, '<tool_result name="grep" status="success" results="100" result_count_lower_bound="true" />');
});

test("buildConversationTextFromEntries redacts secrets and includes richer tool info", () => {
	const text = buildConversationTextFromEntries([
		{
			type: "message",
			message: { role: "user", content: "token=abc123 email me@example.com" },
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I'll inspect it." },
					{ type: "toolCall", name: "read", arguments: { path: "src/app.ts" } },
				],
			},
		},
	]);

	assert.match(text, /token=\[REDACTED\]/);
	assert.match(text, /\[REDACTED_EMAIL\]/);
	assert.match(text, /<user_message>/);
	assert.match(text, /<assistant_message>/);
	assert.match(text, /<tool_call name="read" path="src\/app.ts" \/>/);
});
