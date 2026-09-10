import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pruneImageContext, toPiImage } from "../image-context-pruner.js";

describe("toPiImage", () => {
	it("passes through Pi { data, mimeType }", () => {
		assert.deepEqual(toPiImage({ type: "image", data: "abc", mimeType: "image/jpeg" }), {
			type: "image",
			data: "abc",
			mimeType: "image/jpeg",
		});
	});

	it("rewrites Anthropic { source } so OpenAI gets real base64", () => {
		assert.deepEqual(
			toPiImage({ type: "image", source: { type: "base64", mediaType: "image/png", data: "iVBORw" } as any }),
			{ type: "image", data: "iVBORw", mimeType: "image/png" },
		);
	});

	it("returns null when data is missing (would 400 as undefined;base64,undefined)", () => {
		assert.equal(toPiImage({ type: "image", source: { type: "base64" } as any }), null);
	});
});

describe("pruneImageContext", () => {
	it("keeps the latest image, normalized, and strips earlier ones", () => {
		const messages = [
			{ role: "user", content: [{ type: "image", data: "old", mimeType: "image/png" }, { type: "text", text: "a" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{
				role: "user",
				content: [
					{ type: "image", source: { data: "new", mediaType: "image/png" } },
					{ type: "text", text: "b" },
				],
			},
		];
		const out = pruneImageContext(messages);
		assert.equal((out[0].content as any)[0].type, "text");
		assert.deepEqual((out[2].content as any)[0], { type: "image", data: "new", mimeType: "image/png" });
	});

	it("drops a latest image that has no usable payload", () => {
		const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: "hi" }] }];
		const out = pruneImageContext(messages);
		assert.equal((out[0].content as any)[0].type, "text");
	});
});
