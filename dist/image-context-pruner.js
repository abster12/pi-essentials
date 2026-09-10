// src/image-context-pruner.ts
var PLACEHOLDER = { type: "text", text: "[image \u2014 already processed in earlier turn]" };
function toPiImage(block) {
  if (block?.type !== "image" && block?.type !== "image_url") return null;
  const data = block.data ?? block.source?.data;
  const mimeType = block.mimeType ?? block.source?.mediaType ?? "image/png";
  if (typeof data !== "string" || !data) return null;
  return { type: "image", data, mimeType };
}
function isImageBlock(block) {
  return block?.type === "image" || block?.type === "image_url";
}
function pruneImageContext(messages) {
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
      content: msg.content.map((block) => {
        if (!isImageBlock(block)) return block;
        if (!keep) return PLACEHOLDER;
        return toPiImage(block) ?? PLACEHOLDER;
      })
    };
  });
}
function image_context_pruner_default(pi) {
  pi.on("context", async (event, _ctx) => {
    return { messages: pruneImageContext(event.messages) };
  });
}
export {
  image_context_pruner_default as default,
  pruneImageContext,
  toPiImage
};
//# sourceMappingURL=image-context-pruner.js.map
