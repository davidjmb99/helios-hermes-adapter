const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // 1. Health endpoint
  const healthRegex = /app\.get\("\/health", \(req, res\) => \{\s*res\.json\(\{/m;
  const healthReplacement = `app.get("/health", (req, res) => {
    res.json({
      build_commit: process.env.BUILD_COMMIT || process.env.GIT_COMMIT || (() => { try { return require('child_process').execSync('git rev-parse HEAD').toString().trim(); } catch(_) { return 'unknown'; } })(),`;
  code = code.replace(healthRegex, healthReplacement);

  // 2. consumeHermesStream
  const streamRegex = /async function consumeHermesStream\(streamId\) \{[\s\S]*?return \{ answer: rawReply, firstTokenTime \};\n\}/;
  const newStreamFunc = `async function consumeHermesStream(streamId) {
  if (!hermesCookie) await hermesLogin();
  const url = \`\${HERMES_WEBUI_BASE_URL}/api/chat/stream?stream_id=\${streamId}\`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HERMES_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { method: "GET", headers: { cookie: hermesCookie }, signal: controller.signal });
  } catch (error) { clearTimeout(timeout); throw error; }
  if (!response.ok) {
    clearTimeout(timeout);
    const text = await response.text();
    throw new Error(\`Hermes stream connection failed HTTP \${response.status}: \${text.slice(0, 300)}\`);
  }

  let streamedContent = "";
  let completedContent = "";
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;
  let assistantCompletedReceived = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  const getEventType = (parsed) => parsed.event || parsed.type || "";
  const getAssistantDeltaContent = (parsed) => parsed.content || parsed.text || parsed.token || parsed.message?.content || "";
  const getAssistantCompletedContent = (parsed) => parsed.content || parsed.message?.content || "";
  const getReasoningContent = (parsed) => parsed.reasoning_content || parsed.reasoning || parsed.delta?.reasoning || "";
  const getToolProgressName = (parsed) => parsed.tool_name || parsed.name || parsed.tool?.name || "";

  const processEvent = (eventName, dataStr) => {
    let parsed = {};
    let isJson = false;
    try { parsed = JSON.parse(dataStr); isJson = true; } catch (_) {}
    const evName = eventName || (isJson ? getEventType(parsed) : "") || "";

    if (evName === "assistant.delta" || evName === "token") {
      const content = isJson ? getAssistantDeltaContent(parsed) : dataStr;
      if (content && !firstTokenTime) firstTokenTime = Date.now();
      streamedContent += content;
    } else if (evName === "reasoning_delta" || evName === "reasoning_content" || evName === "reasoning") {
      reasoningContent += isJson ? getReasoningContent(parsed) : dataStr;
    } else if (evName === "tool.progress" || evName === "tool" || evName === "tool_call") {
      if (isJson) {
        const toolName = getToolProgressName(parsed);
        if (toolName !== "_thinking") {
          toolEvents.push({ name: toolName, status: parsed.status || "started", duration_ms: parsed.duration_ms || null, result_code: parsed.result_code || null });
        }
      }
    } else if (evName === "assistant.completed") {
      const content = isJson ? getAssistantCompletedContent(parsed) : dataStr;
      if (content) {
        completedContent = content;
        assistantCompletedReceived = true;
      }
    } else if (evName === "error") {
      const errorMsg = isJson ? (parsed.error || parsed.message || dataStr) : dataStr;
      throw new Error(\`Hermes stream reported error: \${errorMsg}\`);
    } else if (["run.completed", "done", "complete", "completed"].includes(evName)) {
      return true;
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\\r?\\n/);
      buffer = lines.pop();
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
        if (dataStr !== "[DONE]" && dataStr !== "done") processEvent(currentEvent, dataStr);
      }
    }
  } finally {
    clearTimeout(timeout);
    try { reader.cancel(); } catch (_) {}
  }
  const rawReply = (completedContent && completedContent.trim()) ? completedContent.trim() : streamedContent.trim();
  return { answer: rawReply, firstTokenTime };
}`;
  code = code.replace(streamRegex, newStreamFunc);

  // 3. app.post
  // Insert processingStage at the beginning of app.post
  const appPostRegex = /app\.post\("\/helios\/message", async \(req, res\) => \{/;
  code = code.replace(appPostRegex, `app.post("/helios/message", async (req, res) => {
  let processingStage = "request_received";
  let requestPhone = null;
  let requestPatientDisplayName = "Contacto sin identificar";
`);

  const telemetryCtxRegex = /const telemetryCtx = await startAdapterEvent\(req\.body \|\| \{\}\);/;
  code = code.replace(telemetryCtxRegex, `processingStage = "telemetry_started";
  const telemetryCtx = await startAdapterEvent(req.body || {});`);

  const normalizedRegex = /try \{\s*normalized = normalizeGatewayPayload\(payload\);\s*\} catch \(err\) \{\s*normalized = \{ raw: payload \};\s*\}/;
  code = code.replace(normalizedRegex, `try {
    normalized = normalizeGatewayPayload(payload);
    requestPhone = normalized.conversation?.phone || normalized.patient?.phone || payload.conversation?.phone || payload.patient?.phone || null;
    if (normalized.patient?.profile_complete && normalized.patient?.first_name && normalized.patient?.last_name) {
      requestPatientDisplayName = normalized.patient.first_name + " " + normalized.patient.last_name;
    } else if (normalized.patient?.chatwoot_display_name) {
      requestPatientDisplayName = normalized.patient.chatwoot_display_name;
    }
  } catch (err) {
    normalized = { raw: payload };
  }`);

  const startHermesRegex = /result = await sendMessageToHermes\(payload\);/;
  code = code.replace(startHermesRegex, `processingStage = "message_sent";
      result = await sendMessageToHermes(payload);`);

  const extractSessionRegex = /sessionId = result\.sessionId \|\| "";\s*streamId = result\.streamId \|\| "";/;
  code = code.replace(extractSessionRegex, `processingStage = "assistant_completed_received";
    sessionId = result.sessionId || "";
    streamId = result.streamId || "";`);

  const normalizeResponseRegex = /const normalizedResponse = normalizeAdapterResponse\(result\);/;
  code = code.replace(normalizeResponseRegex, `processingStage = "contract_parsing";
    const normalizedResponse = normalizeAdapterResponse(result);
    processingStage = "contract_validated";`);

  const finishTelemetryRegex = /await finishAdapterEvent\(\s*telemetryCtx,/;
  code = code.replace(finishTelemetryRegex, `processingStage = "telemetry_finishing";
    await finishAdapterEvent(
      telemetryCtx,`);

  const returnResRegex = /return res\.json\(normalizedResponse\);/;
  code = code.replace(returnResRegex, `processingStage = "response_returned";
    return res.json(normalizedResponse);`);

  const catchBlockRegex = /} catch \(error\) {[\s\S]*?console\.error\("Adapter error:", error\);/;
  code = code.replace(catchBlockRegex, `} catch (error) {
    console.error("Adapter error in stage:", processingStage, error.name, error.code, error.message);`);

  // Override context variables in failAdapterEvent and finishAdapterEvent inside app.post
  // Replace: patient_display_name: getPatientDisplayName(normalized?.patient),
  code = code.replace(/patient_display_name: getPatientDisplayName\(normalized\?\.patient\)/g, `patient_display_name: requestPatientDisplayName`);
  // Replace: phone: extractPhone(normalized, payload),
  code = code.replace(/phone: extractPhone\(normalized, payload\)/g, `phone: requestPhone`);

  // Also replace session_id and stream_id in the finish/fail calls if missing, we'll just add them
  const finishCtxRegex = /hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' \? hermesFirstTokenMs : null,/g;
  code = code.replace(finishCtxRegex, `hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
          session_id: sessionId,
          stream_id: streamId,
          processing_stage: processingStage,`);

  // Add error normalization rule
  const errNormRegex = /const normalizedError = normalizeProviderError\(error\);/;
  const newErrNorm = `let normalizedError = normalizeProviderError(error);
    if (["assistant_completed_received", "contract_parsing", "contract_validated"].includes(processingStage) && (error.name === "SyntaxError" || error.message.includes("JSON") || error.message.includes("contrato"))) {
      normalizedError = {
        ok: false,
        intent: "technical_error",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "INVALID_HERMES_CONTRACT"
      };
    }`;
  code = code.replace(errNormRegex, newErrNorm);

  fs.writeFileSync('server.js', code);
  console.log("Fixes applied successfully.");
}

applyFixes();
