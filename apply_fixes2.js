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

// 3. Telefono & Display Name
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
          hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,`
);
// Wait, the payload variable might be req.body in some contexts, but inside sendMessageToHermes we have payload, and inside POST we have req.body payload. We will just use payload since in the route it is 'const payload = req.body || {};'. 

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
  `answer = await consumeHermesStreamWithRetry(streamId);`,
  `const resStream = await consumeHermesStreamWithRetry(streamId);
      answer = resStream.answer;
      if (resStream.firstTokenTime) firstTokenMs = resStream.firstTokenTime - startTimestamp;`
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


// 5. Sesion persistente

content = content.replace(
  `if (DEBUG_USERNAME && DEBUG_PASSWORD) {
      const cookieToken = getCookie(req, "debug_token");
      const expectedToken = crypto.createHmac('sha256', sessionSecret)
        .update(\`\${DEBUG_USERNAME}:\${DEBUG_PASSWORD}\`)
        .digest('hex');
      if (cookieToken && safeCompare(cookieToken, expectedToken)) {
        return true;
      }`,
  `if (DEBUG_USERNAME && DEBUG_PASSWORD) {
      const cookieToken = getCookie(req, "debug_token");
      const expectedToken = crypto.createHmac('sha256', sessionSecret)
        .update(\`\${DEBUG_USERNAME}:\${DEBUG_PASSWORD}\`)
        .digest('hex');
      if (cookieToken && safeCompare(cookieToken, expectedToken)) {
        req.renewCookie = true;
        req.expectedToken = expectedToken;
        return true;
      }`
);

content = content.replace(
  `function requireDebugAuth(req, res, next) {
    if (isDebugAuthorized(req)) {
      return next();
    }`,
  `function requireDebugAuth(req, res, next) {
    if (isDebugAuthorized(req)) {
      if (req.renewCookie) {
        const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
        res.setHeader("Set-Cookie", \`debug_token=\${req.expectedToken}; Path=/; HttpOnly; \${isHttps ? "Secure;" : ""} SameSite=Lax; Max-Age=604800\`);
      }
      return next();
    }`
);

content = content.replace(
  `SameSite=Lax; Max-Age=864000\`);`,
  `SameSite=Lax; Max-Age=604800\`);` // 7 dias = 604800s
);

content = content.replace(
  `app.post("/login", (req, res) => {`,
  `app.post("/debug/logout", (req, res) => {
    res.setHeader('Set-Cookie', 'debug_token=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
});\n\napp.post("/login", (req, res) => {`
);

// UI updates
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

// 7. Tool MCP
content = content.replace(
  `extractedToolCalls.push({ name, status });`,
  `const duration = tc.duration_ms || tc.execution_time_ms || null;
            extractedToolCalls.push({ name, status, duration });`
);

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

content = content.replace(
  `tool_status: toolStatus`,
  `tool_status: toolStatus,
        tool_duration_ms: tokenUsage?.tool_duration_ms || null`
);

fs.writeFileSync('server.js', content, 'utf8');
console.log("Success");
