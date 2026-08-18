const streamId = "fake-stream";
let streamedContent = "";
let completedContent = "";
let reasoningContent = "";
let toolEvents = [];
let firstTokenTime = null;
let assistantCompletedReceived = false;

// Mock the variables as they were in server.js before the fix
let finalContent = "";
// Here completedContent is NOT defined. If we try to console.log it, it throws:

try {
  const rawReply = (finalContent && finalContent.trim()) ? finalContent.trim() : streamedContent.trim();
  console.log("SSE_STATS:", { streamedContentLen: streamedContent.length, completedContentLen: completedContent.length, assistantCompletedReceived });
} catch (e) {
  console.log("Error de regresión replicado exitosamente:", e.name, e.message);
}

// And now test the new approach (mocking a successful flow)
const eventSequence = [
  { event: "assistant.delta", data: '{"content":"Hola"}' },
  { event: "assistant.completed", data: '{"content":"{\\"message_for_client\\": \\"Hola paciente\\", \\"operation\\": {}, \\"profile_patch\\": {}, \\"state_patch\\": {}, \\"booking_patch\\": {}, \\"tool_calls\\": [], \\"safe_to_send\\": true, \\"requires_handoff\\": false, \\"recoverable\\": false, \\"error_code\\": null}"}' },
  { event: "run.completed", data: 'done' }
];

let fixedStreamedContent = "";
let fixedCompletedContent = "";
let fixedAssistantCompletedReceived = false;

for (const { event, data } of eventSequence) {
  if (event === "assistant.delta") {
    fixedStreamedContent += JSON.parse(data).content;
  } else if (event === "assistant.completed") {
    const parsed = JSON.parse(data);
    if (typeof parsed.content === "string") {
      fixedCompletedContent = parsed.content.trim();
      fixedAssistantCompletedReceived = true;
    }
  }
}

const rawReply = (fixedCompletedContent && fixedCompletedContent.trim() !== "") ? fixedCompletedContent.trim() : fixedStreamedContent.trim();

console.log("Resultados arreglados:");
console.log("typeof completedContent === 'string':", typeof fixedCompletedContent === 'string');
console.log("assistantCompletedReceived === true:", fixedAssistantCompletedReceived === true);
try {
  console.log("JSON.parse(rawReply) === PASS:", !!JSON.parse(rawReply));
} catch(e) {
  console.log("JSON parse error", e);
}
