const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // Change the declarations in consumeHermesStream
  const oldDecl = `  let streamedContent = "";
  let completedContent = "";
  let assistantCompletedReceived = false;
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;`;
  
  const newDecl = `  let streamedContent = "";
  let completedContent = "";
  let assistantCompletedReceived = false;
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;
  let sessionId = null;
  let tokenUsage = null;`;
  
  code = code.replace(oldDecl, newDecl);

  // In processEvent, capture sessionId and tokenUsage
  const oldProcess = `  const processEvent = (eventName, dataStr) => {
    let parsed = {};
    let isJson = false;
    try { parsed = JSON.parse(dataStr); isJson = true; } catch (_) {}
    const evName = eventName || (isJson ? parsed.event : "") || "";

    if (evName === "assistant.delta"`;
    
  const newProcess = `  const processEvent = (eventName, dataStr) => {
    let parsed = {};
    let isJson = false;
    try { parsed = JSON.parse(dataStr); isJson = true; } catch (_) {}
    const evName = eventName || (isJson ? parsed.event : "") || "";

    if (isJson) {
      if (parsed.session_id) sessionId = parsed.session_id;
      if (parsed.usage || parsed.token_usage) tokenUsage = parsed.usage || parsed.token_usage;
    }

    if (evName === "assistant.delta"`;

  code = code.replace(oldProcess, newProcess);

  // In the return, use the real variables instead of null
  const oldReturn = `  return { 
    answer: rawReply,
    firstTokenTime,
    assistantCompletedReceived,
    sessionId: null,
    streamId: null,
    tokenUsage: null,
    toolCalls: toolEvents
  };`;
  
  const newReturn = `  return { 
    answer: rawReply,
    firstTokenTime,
    assistantCompletedReceived,
    sessionId,
    streamId,
    tokenUsage,
    toolCalls: toolEvents
  };`;

  code = code.replace(oldReturn, newReturn);
  
  // Also, update sendMessageToHermes so it can use these if returned
  const oldSend = `    const resStream = await consumeHermesStreamWithRetry(streamId);
      answer = resStream.answer;
      if (resStream.firstTokenTime) firstTokenMs = resStream.firstTokenTime - startTimestamp;
  };`;
  const newSend = `    const resStream = await consumeHermesStreamWithRetry(streamId);
      answer = resStream.answer;
      if (resStream.firstTokenTime) firstTokenMs = resStream.firstTokenTime - startTimestamp;
      if (resStream.sessionId) sessionId = resStream.sessionId;
      // We pass the resStream tokenUsage and toolCalls implicitly or let the outer scope fetch them
  };`;
  code = code.replace(oldSend, newSend);

  fs.writeFileSync('server.js', code);
  console.log("Fixes applied successfully.");
}

applyFixes();
