const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // Replace finalContent entirely with completedContent
  // This avoids tricky string matching
  
  // 1. Let declarations
  const oldDecl1 = `let streamedContent = "";
  let finalContent = "";
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;`;
  
  const newDecl1 = `let streamedContent = "";
  let completedContent = "";
  let assistantCompletedReceived = false;
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;
  let sessionId = null;
  let tokenUsage = null;`;
  
  code = code.replace(oldDecl1, newDecl1);

  // 2. processEvent capturing
  const oldProcess1 = `    } else if (evName === "assistant.completed") {
      if (isJson && typeof parsed.content === "string") {
        finalContent = parsed.content;
      } else if (isJson && parsed.message && typeof parsed.message.content === "string") {
        finalContent = parsed.message.content;
      }
    } else if`;
    
  const newProcess1 = `    } else if (evName === "assistant.completed") {
      let contentToSave = null;
      if (isJson && typeof parsed.content === "string") {
        contentToSave = parsed.content;
      } else if (isJson && parsed.message && typeof parsed.message.content === "string") {
        contentToSave = parsed.message.content;
      } else if (!isJson && dataStr.trim() !== "") {
        contentToSave = dataStr;
      }
      
      if (typeof contentToSave === "string" && contentToSave.trim()) {
        completedContent = contentToSave.trim();
        assistantCompletedReceived = true;
      }
    } else if`;
    
  code = code.replace(oldProcess1, newProcess1);
  
  // Also add capturing sessionId inside processEvent right at the top
  const oldProcStart = `  const processEvent = (eventName, dataStr) => {
    let parsed = {};
    let isJson = false;
    try { parsed = JSON.parse(dataStr); isJson = true; } catch (_) {}
    const evName = eventName || (isJson ? parsed.event : "") || "";

    if (evName === "assistant.delta"`;
    
  const newProcStart = `  const processEvent = (eventName, dataStr) => {
    let parsed = {};
    let isJson = false;
    try { parsed = JSON.parse(dataStr); isJson = true; } catch (_) {}
    const evName = eventName || (isJson ? parsed.event : "") || "";

    if (isJson) {
      if (parsed.session_id) sessionId = parsed.session_id;
      if (parsed.usage || parsed.token_usage) tokenUsage = parsed.usage || parsed.token_usage;
    }

    if (evName === "assistant.delta"`;
    
  code = code.replace(oldProcStart, newProcStart);

  // 3. rawReply
  const oldReturn1 = `  const rawReply = (finalContent && finalContent.trim()) ? finalContent.trim() : streamedContent.trim();
  console.log("SSE_STATS:", { streamedContentLen: streamedContent.length, completedContentLen: completedContent.length, assistantCompletedReceived });
  return { answer: rawReply, firstTokenTime };`;
  
  const newReturn1 = `  const rawReply = completedContent.trim() !== "" ? completedContent.trim() : streamedContent.trim();
  console.log("SSE_STATS:", { streamedContentLen: streamedContent.length, completedContentLen: completedContent.length, assistantCompletedReceived });
  return { 
    answer: rawReply,
    firstTokenTime,
    assistantCompletedReceived,
    sessionId,
    streamId,
    tokenUsage,
    toolCalls: toolEvents
  };`;
  
  code = code.replace(oldReturn1, newReturn1);
  
  // 4. Update sendMessageToHermes
  const oldSend1 = `    const resStream = await consumeHermesStreamWithRetry(streamId);
      answer = resStream.answer;
      if (resStream.firstTokenTime) firstTokenMs = resStream.firstTokenTime - startTimestamp;
  };`;
  const newSend1 = `    const resStream = await consumeHermesStreamWithRetry(streamId);
      answer = resStream.answer;
      if (resStream.firstTokenTime) firstTokenMs = resStream.firstTokenTime - startTimestamp;
      if (resStream.sessionId) sessionId = resStream.sessionId;
  };`;
  
  code = code.replace(oldSend1, newSend1);
  
  // Verify replace happened
  if (!code.includes("completedContent.trim() !== \"\"")) {
     console.error("Replacement of finalContent failed!!!");
  } else {
     fs.writeFileSync('server.js', code);
     console.log("Fixes applied successfully.");
  }

}

applyFixes();
