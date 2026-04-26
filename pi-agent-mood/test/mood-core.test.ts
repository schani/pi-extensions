import test from "node:test";
import assert from "node:assert/strict";

import {
	buildConversationTextFromEntries,
	evaluationByteLengthFromEntries,
	findMatchingModels,
	lastUtf8Bytes,
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

test("shouldEvaluate uses 512 B steps below 5 KB and 2 KB steps at/above 5 KB", () => {
	assert.equal(shouldEvaluate(511, 0), false);
	assert.equal(shouldEvaluate(512, 0), true);
	assert.equal(shouldEvaluate(1023, 512), false);
	assert.equal(shouldEvaluate(1024, 512), true);

	assert.equal(shouldEvaluate(5 * 1024, 4 * 1024), false);
	assert.equal(shouldEvaluate(6 * 1024, 4 * 1024), true);
});

test("UTF-8 truncation never splits multibyte characters", () => {
	const text = "abc🙂def";
	const truncated = truncateUtf8Bytes(text, 6);
	assert.equal(truncated.text, "abc");
	assert.equal(truncated.truncated, true);

	const tail = lastUtf8Bytes(text, 6);
	assert.equal(tail, "def");
});

test("evaluationByteLengthFromEntries counts every assistant tool call as 128 bytes", () => {
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

	assert.equal(total, 5 + 128 * 2);
});

test("renderToolCall includes read path", () => {
	assert.equal(
		renderToolCall({ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }),
		'Assistant used tool: read (path="src/index.ts")',
	);
});

test("renderToolCall includes write path and content byte count", () => {
	assert.equal(
		renderToolCall({ type: "toolCall", name: "write", arguments: { path: "out.txt", content: "hello" } }),
		'Assistant used tool: write (path="out.txt", write=5 B)',
	);
});

test("renderToolCall truncates bash commands to 256 bytes and reports full length", () => {
	const command = "x".repeat(300);
	const rendered = renderToolCall({ type: "toolCall", name: "bash", arguments: { command } });

	assert.match(rendered ?? "", /^Assistant used tool: bash \(command="x+/);
	assert.match(rendered ?? "", /… \(300 B total\)\)$/);
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

	assert.equal(rendered, "Tool happened: read (success, read=1.2 KB, shown=5 B)");
});

test("renderToolCall includes search pattern and scope", () => {
	assert.equal(
		renderToolCall({ type: "toolCall", name: "grep", arguments: { pattern: "TODO", path: "src", glob: "*.ts" } }),
		'Assistant used tool: grep (pattern="TODO", path="src", glob="*.ts")',
	);
});

test("renderMessage includes grep result counts", () => {
	const rendered = renderMessage({
		role: "toolResult",
		toolName: "grep",
		isError: false,
		content: [{ type: "text", text: "src/a.ts:1: TODO one\nsrc/b.ts:2: TODO two\n[notice]" }],
	});

	assert.equal(rendered, "Tool happened: grep (success, results=2)");
});

test("renderMessage reports grep lower bound when match limit was reached", () => {
	const rendered = renderMessage({
		role: "toolResult",
		toolName: "grep",
		isError: false,
		content: [{ type: "text", text: "src/a.ts:1: TODO" }],
		details: { matchLimitReached: 100 },
	});

	assert.equal(rendered, "Tool happened: grep (success, results>=100)");
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
	assert.match(text, /Assistant used tool: read \(path="src\/app.ts"\)/);
});
