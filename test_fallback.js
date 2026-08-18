const eventSequence = [
  { event: "assistant.delta", data: '{"content":"{\\"message_for_client\\": \\"Fallback exitoso\\", \\"operation\\": {}, \\"profile_patch\\": {}, \\"state_patch\\": {}, \\"booking_patch\\": {}, \\"tool_calls\\": [], \\"safe_to_send\\": true, \\"requires_handoff\\": false, \\"recoverable\\": false, \\"error_code\\": null}"}' },
  { event: "run.completed", data: 'done' }
];

let streamedContent = "";
let completedContent = "";
let assistantCompletedReceived = false;
let firstTokenTime = null;

const streamStartedAt = Date.now() - 50; // Mock delay

for (const { event, data } of eventSequence) {
  if (event === "assistant.delta") {
    if (!firstTokenTime) firstTokenTime = Date.now();
    streamedContent += JSON.parse(data).content;
  }
}

const rawReply = completedContent.trim() !== "" ? completedContent.trim() : streamedContent.trim();
let firstTokenMs = null;
try {
  if (typeof firstTokenTime === "number" && Number.isFinite(firstTokenTime)) {
    firstTokenMs = Math.max(0, firstTokenTime - streamStartedAt);
  }
} catch (_) {}

console.log("Resultados arreglados:");
console.log("assistantCompletedReceived === false:", assistantCompletedReceived === false);
console.log("rawReply uses streamedContent:", rawReply === streamedContent.trim());
console.log("firstTokenTime existe:", firstTokenTime !== null);
console.log("firstTokenMs:", firstTokenMs);

try {
  const parsed = JSON.parse(rawReply);
  console.log("JSON.parse(rawReply) === PASS:", !!parsed);
  console.log("reply = message_for_client:", parsed.message_for_client === "Fallback exitoso");
} catch(e) {
  console.log("JSON parse error", e);
}
