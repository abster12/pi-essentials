/**
 * Image Context Pruner
 *
 * Strips base64 image data from all but the most recent user message
 * before each LLM call. Images stay in the session file for history,
 * but don't eat context tokens on subsequent turns.
 *
 * Also rewrites Anthropic-shaped `{ source: { data, mediaType } }` blocks
 * to Pi's `{ data, mimeType }` so OpenAI/xAI don't get `data:undefined`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Imageish = {
	type?: string;
	data?: string;
	mimeType?: string;
	source?: { data?: string; mediaType?: string };
};

const PLACEHOLDER = { type: "text" as const, text: "[image — already processed in earlier turn]" };

export function toPiImage(block: Imageish): { type: "image"; data: string; mimeType: string } | null {
	if (block?.type !== "image" && block?.type !== "image_url") return null;
	const data = block.data ?? block.source?.data;
	const mimeType = block.mimeType ?? block.source?.mediaType ?? "image/png";
	if (typeof data !== "string" || !data) return null;
	return { type: "image", data, mimeType };
}

function isImageBlock(block: Imageish): boolean {
	return block?.type === "image" || block?.type === "image_url";
}

export function pruneImageContext<T extends { role?: string; content?: unknown }>(messages: T[]): T[] {
	let lastUserWithImageIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some(isImageBlock)) {
			lastUserWithImageIdx = i;
			break;
		}
	}

	return messages.map((msg, i) => {
		if (msg.role !== "user" || !Array.isArray(msg.content) || !msg.content.some(isImageBlock)) {
			return msg;
		}
		const keep = i === lastUserWithImageIdx;
		return {
			...msg,
			content: msg.content.map((block: Imageish) => {
				if (!isImageBlock(block)) return block;
				if (!keep) return PLACEHOLDER;
				return toPiImage(block) ?? PLACEHOLDER;
			}),
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event, _ctx) => {
		return { messages: pruneImageContext(event.messages) };
	});
}
