const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. REWRITE consumeHermesStream
const streamFuncRegex = /async function consumeHermesStream\(streamId\) \{[\s\S]*?return \{ answer: accumulatedAnswer, firstTokenTime \};\n\}/;
const newStreamFunc = `async function consumeHermesStream(streamId) {
  if (!hermesCookie) {
    await hermesLogin();
  }

  const url = \`\${HERMES_WEBUI_BASE_URL}/api/chat/stream?stream_id=\${streamId}\`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HERMES_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { method: "GET", headers: { cookie: hermesCookie }, signal: controller.signal });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const text = await response.text();
    throw new Error(\`Hermes stream connection failed HTTP \${response.status}: \${text.slice(0, 300)}\`);
  }

  let streamedContent = "";
  let finalContent = "";
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = Date.now();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  const processEvent = (eventName, dataStr) => {
    let parsed = {};
    let isJson = false;
    try { parsed = JSON.parse(dataStr); isJson = true; } catch (_) {}
    const evName = eventName || (isJson ? parsed.event : "") || "";

    if (evName === "assistant.delta" || evName === "token") {
      const token = isJson ? (parsed.text || parsed.token || parsed.content || "") : dataStr;
      streamedContent += token;
    } else if (evName === "reasoning_delta" || evName === "reasoning_content" || evName === "reasoning") {
      const token = isJson ? (parsed.text || parsed.token || parsed.content || "") : dataStr;
      reasoningContent += token;
    } else if (evName === "tool.progress" || evName === "tool" || evName === "tool_call") {
      if (isJson) {
        const toolName = parsed.tool_name || parsed.name || "";
        if (toolName !== "_thinking") {
          toolEvents.push({
            name: toolName,
            status: parsed.status || "started",
            duration_ms: parsed.duration_ms || null,
            result_code: parsed.result_code || null
          });
        }
      }
    } else if (evName === "assistant.completed") {
      if (isJson && typeof parsed.content === "string") {
        finalContent = parsed.content;
      } else if (isJson && parsed.message && typeof parsed.message.content === "string") {
        finalContent = parsed.message.content;
      }
    } else if (evName === "error") {
      const errorMsg = isJson ? (parsed.error || parsed.message || dataStr) : dataStr;
      throw new Error(\`Hermes stream reported error: \${errorMsg}\`);
    } else if (["run.completed", "done", "complete", "completed"].includes(evName)) {
      return true; // Stop processing
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop(); // Mantener línea incompleta en el buffer

      let shouldBreak = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("event:")) {
          currentEvent = trimmed.slice("event:".length).trim();
        } else if (trimmed.startsWith("data:")) {
          const dataStr = trimmed.slice("data:".length).trim();
          if (dataStr === "[DONE]" || dataStr === "done") { shouldBreak = true; break; }
          if (processEvent(currentEvent, dataStr)) { shouldBreak = true; break; }
        }
      }
      if (shouldBreak) break;
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const dataStr = trimmed.slice("data:".length).trim();
        if (dataStr !== "[DONE]" && dataStr !== "done") {
          processEvent(currentEvent, dataStr);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    try { reader.cancel(); } catch (_) {}
  }

  const rawReply = (finalContent && finalContent.trim()) ? finalContent.trim() : streamedContent.trim();
  return { answer: rawReply, firstTokenTime };
}`;

code = code.replace(streamFuncRegex, newStreamFunc);

// 2. REWRITE normalizeAdapterResponse
const normRegex = /function normalizeAdapterResponse\(result\) \{[\s\S]*?function isProviderErrorText/m;
const newNormFunc = `function normalizeAdapterResponse(result) {
  const rawReply = result.answer || "";
  
  let parsedJson = null;
  let isStrictJson = false;

  const trimmed = rawReply.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      parsedJson = JSON.parse(trimmed);
      isStrictJson = true;
    } catch (e) {}
  }

  const isValidContract = 
    parsedJson && 
    typeof parsedJson === "object" &&
    typeof parsedJson.message_for_client === "string" &&
    typeof parsedJson.operation === "object" && parsedJson.operation !== null &&
    typeof parsedJson.profile_patch === "object" && parsedJson.profile_patch !== null &&
    typeof parsedJson.state_patch === "object" && parsedJson.state_patch !== null &&
    typeof parsedJson.booking_patch === "object" && parsedJson.booking_patch !== null &&
    Array.isArray(parsedJson.tool_calls) &&
    typeof parsedJson.safe_to_send === "boolean" &&
    typeof parsedJson.requires_handoff === "boolean" &&
    typeof parsedJson.recoverable === "boolean" &&
    (typeof parsedJson.error_code === "string" || parsedJson.error_code === null);

  if (!isStrictJson || !isValidContract) {
    return {
      ok: false, reply: "", message_for_client: "",
      operation: { type: "technical_error", status: "failed", summary: "Respuesta final de Hermes rechazada por contrato inválido." },
      profile_patch: {}, state_patch: {}, booking_patch: {}, tool_calls: [],
      safe_to_send: false, response_sent: false, requires_handoff: false, recoverable: true, error_code: "INVALID_HERMES_CONTRACT"
    };
  }

  return {
    ok: true,
    reply: parsedJson.message_for_client,
    message_for_client: parsedJson.message_for_client,
    operation: parsedJson.operation,
    profile_patch: parsedJson.profile_patch,
    state_patch: parsedJson.state_patch,
    booking_patch: parsedJson.booking_patch,
    tool_calls: parsedJson.tool_calls,
    safe_to_send: parsedJson.safe_to_send,
    response_sent: false,
    requires_handoff: parsedJson.requires_handoff,
    recoverable: parsedJson.recoverable,
    error_code: parsedJson.error_code
  };
}

function isProviderErrorText`;

code = code.replace(normRegex, newNormFunc);

fs.writeFileSync('server.js', code);
console.log('Done!');
