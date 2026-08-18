const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// 1. Status Correcto
content = content.replace(
  "const finalStatus = status === 'buffered' ? 'buffered' : 'ok';",
  `let finalStatus = status;
    if (status !== 'buffered' && status !== 'error') {
      if (result?.safe_to_send === true && result?.response_sent === true) {
        finalStatus = 'ok';
      } else {
        finalStatus = 'error';
      }
    }`
);

// 6. Active Stream Conflict (fix status to error immediately and dont use Requires Handoff)
content = content.replace(
  `error_code: "ACTIVE_STREAM_CONFLICT",
        provider_error_code: "ACTIVE_STREAM_CONFLICT",`,
  `error_code: "ACTIVE_STREAM_CONFLICT",
        provider_error_code: "ACTIVE_STREAM_CONFLICT",`
);

// Wait, the status is already "error" in conflict? Let's check:
//       finalStatus = "error";
//       finalRoute = "error";
// That was done in the previous step. BUT the conflict response might not have requires_handoff false.
// It is false already in my previous fix.

// 3. Telefono
content = content.replace(
  "function getPatientDisplayName(patient) {",
  `function extractPhone(normalized, payload) {
  return normalized?.conversation?.phone || normalized?.patient?.phone || payload?.conversation?.phone || payload?.patient?.phone || null;
}

function getPatientDisplayName(patient) {`
);

content = content.replace(/if \(patient\.name\) return patient\.name;/g, "");

content = content.replace(
  "patient_display_name: extra.patient_display_name || null,",
  `patient_display_name: extra.patient_display_name || null,
        phone: extra.phone || null,
        hermes_first_token_ms: extra.hermes_first_token_ms || null,
        tool_duration_ms: extra.tool_duration_ms || null,`
);
content = content.replace(
  "patient_display_name: extra.patient_display_name || null,",
  `patient_display_name: extra.patient_display_name || null,
        phone: extra.phone || null,
        hermes_first_token_ms: extra.hermes_first_token_ms || null,
        tool_duration_ms: extra.tool_duration_ms || null,`
);

content = content.replace(
  /patient_display_name: getPatientDisplayName\(normalized\?\.patient\),/g,
  `patient_display_name: getPatientDisplayName(normalized?.patient),
          phone: extractPhone(normalized, payload),
          hermes_first_token_ms: hermesFirstTokenMs,`
);

// 2. Finalizacion rapida
content = content.replace(
  `let accumulatedAnswer = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";

    try {
      while (true) {
        const { value, done } = await reader.read();`,
  `let accumulatedAnswer = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let firstTokenTime = null;
    let lastEventTime = Date.now();
    let activeTool = false;

    try {
      while (true) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 500));
        const result = await Promise.race([readPromise, timeoutPromise]);
        
        if (result.timeout) {
           const inactiveMs = Date.now() - lastEventTime;
           if (inactiveMs >= 2000 && accumulatedAnswer.length > 0 && !activeTool) {
             console.log("[Adapter] Fast stream finish due to inactivity");
             break;
           }
           continue;
        }

        const { value, done } = result;
        lastEventTime = Date.now();`
);

content = content.replace(
  `if (eventName === "token") {
              const token = isJson ? (parsed.text || parsed.token || parsed.content || "") : dataStr;`,
  `if (eventName === "token") {
              if (!firstTokenTime) firstTokenTime = Date.now();
              const token = isJson ? (parsed.text || parsed.token || parsed.content || "") : dataStr;`
);

content = content.replace(
  `} else if (eventName === "reasoning") {`,
  `} else if (eventName === "tool" || eventName === "tool_call") {
              activeTool = true;
            } else if (eventName === "tool_result" || eventName === "tool_end") {
              activeTool = false;
            } else if (eventName === "reasoning") {`
);

content = content.replace(
  `return accumulatedAnswer;`,
  `return { answer: accumulatedAnswer, firstTokenTime };`
);

content = content.replace(
  `async function consumeHermesStreamWithRetry(streamId) {
    try {
      return await consumeHermesStream(streamId);
    } catch (error) {
      if (error.message.includes("HTTP 401") || error.message.includes("HTTP 403")) {
        console.warn("Stream connection returned unauthorized/forbidden, retrying login...");
        hermesCookie = "";
        await hermesLogin();
        return await consumeHermesStream(streamId);
      }
      throw error;
    }
  }`,
  `async function consumeHermesStreamWithRetry(streamId) {
    try {
      return await consumeHermesStream(streamId);
    } catch (error) {
      if (error.message.includes("HTTP 401") || error.message.includes("HTTP 403")) {
        console.warn("Stream connection returned unauthorized/forbidden, retrying login...");
        hermesCookie = "";
        await hermesLogin();
        return await consumeHermesStream(streamId);
      }
      throw error;
    }
  }` // No change here, we will just destructure at call site.
);

content = content.replace(
  `let answer = "";
    let conflict = false;
    let activeStreamId = "";`,
  `let answer = "";
    let conflict = false;
    let activeStreamId = "";
    let firstTokenMs = null;
    let startTimestamp = Date.now();`
);

content = content.replace(
  `answer = await consumeHermesStreamWithRetry(streamId);`,
  `const res = await consumeHermesStreamWithRetry(streamId);
      answer = res.answer;
      if (res.firstTokenTime) firstTokenMs = res.firstTokenTime - startTimestamp;`
);

content = content.replace(
  `return {
      sessionId,
      streamId,
      answer,
      conflict,
      activeStreamId
    };`,
  `return {
      sessionId,
      streamId,
      answer,
      conflict,
      activeStreamId,
      firstTokenMs
    };`
);

content = content.replace(
  `let result;
    try {
      result = await sendMessageToHermes(payload);
      hermesDurationMs = Date.now() - hermesStartTime;`,
  `let result;
    let hermesFirstTokenMs = null;
    try {
      result = await sendMessageToHermes(payload);
      hermesDurationMs = Date.now() - hermesStartTime;
      hermesFirstTokenMs = result.firstTokenMs;`
);

// 5. Sesion Persistente & cookie-parser
content = content.replace(
  `const app = express();`,
  `const app = express();\nconst cookieParser = require('cookie-parser');\napp.use(cookieParser());`
);

content = content.replace(
  `function requireDebugAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader === \`Bearer \${DASHBOARD_PASSWORD}\`) {
    return next();
  }
  const token = req.query.token;
  if (token && token === DASHBOARD_PASSWORD) {
    return next();
  }
  res.status(401).send("Unauthorized");
}`,
  `function requireDebugAuth(req, res, next) {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '') || req.cookies?.dashboard_session;
  if (token === DASHBOARD_PASSWORD) {
    res.cookie('dashboard_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    return next();
  }
  res.status(401).send("Unauthorized");
}`
);

content = content.replace(
  `app.get("/debug/events", requireDebugAuth, async (req, res) => {`,
  `app.post("/debug/logout", (req, res) => {
  res.clearCookie('dashboard_session');
  res.json({ ok: true });
});

app.get("/debug/events", requireDebugAuth, async (req, res) => {`
);

// UI modifications for dashboard telemetry fields 
content = content.replace(
  `<div><strong>Total Tokens:</strong> \${event.total_tokens ?? 'N/A'}</div>`,
  `<div><strong>Total Tokens:</strong> \${event.total_tokens ?? 'N/A'}</div>
   <div><strong>Teléfono:</strong> \${event.phone ?? 'N/A'}</div>
   <div><strong>Hermes First Token:</strong> \${event.hermes_first_token_ms !== null ? event.hermes_first_token_ms + 'ms' : 'N/A'}</div>
   <div><strong>Tool Duration:</strong> \${event.tool_duration_ms !== null ? event.tool_duration_ms + 'ms' : 'N/A'}</div>`
);

content = content.replace(
  `<div><span class="label">Duration:</span> <span class="value">\${ev.duration_ms}ms</span></div>`,
  `<div><span class="label">Duration:</span> <span class="value">\${ev.duration_ms}ms</span></div>
   <div><span class="label">Phone:</span> <span class="value">\${ev.phone || 'N/A'}</span></div>`
);


// 7. Tool MCP duration (extract from sessionData if possible)
// We already extract tool_names, let's extract tool_duration_ms if available.
content = content.replace(
  `extractedToolCalls.push({ name, status });`,
  `const duration = tc.duration_ms || tc.execution_time_ms || null;
            extractedToolCalls.push({ name, status, duration });`
);

// calculate tool_duration_ms total in tokenUsage
content = content.replace(
  `token_lookup_attempts: attempts,`,
  `tool_duration_ms: (function() {
      try {
         const msgs = session.messages || session.history || [];
         let total = 0;
         for (const m of msgs) {
            const arr = m.tool_calls || m.tools || [];
            for (const t of arr) {
               total += (t.duration_ms || t.execution_time_ms || 0);
            }
         }
         return total > 0 ? total : null;
      } catch(e) { return null; }
    })(),
    token_lookup_attempts: attempts,`
);

// pass tool_duration_ms to finishAdapterEvent
content = content.replace(
  `tool_status: toolStatus`,
  `tool_status: toolStatus,
        tool_duration_ms: tokenUsage?.tool_duration_ms || null`
);


fs.writeFileSync('server.js', content, 'utf8');
console.log('Modifications applied!');
