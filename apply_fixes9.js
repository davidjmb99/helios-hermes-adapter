const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // Change the variable declarations
  const oldDecl = `let streamedContent = "";
  let finalContent = "";
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;`;
  
  const newDecl = `let streamedContent = "";
  let completedContent = "";
  let assistantCompletedReceived = false;
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;`;
  
  if (code.includes(oldDecl)) {
    code = code.replace(oldDecl, newDecl);
  } else {
    console.error("Could not find old declarations!");
  }

  // Change the assistant.completed logic
  const oldComp = `} else if (evName === "assistant.completed") {
      if (isJson && typeof parsed.content === "string") {
        finalContent = parsed.content;
      } else if (isJson && parsed.message && typeof parsed.message.content === "string") {
        finalContent = parsed.message.content;
      }
    } else if`;
    
  const newComp = `} else if (evName === "assistant.completed") {
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

  if (code.includes(oldComp)) {
    code = code.replace(oldComp, newComp);
  } else {
    console.error("Could not find assistant.completed logic!");
  }

  // Change the return section
  const oldRet = `  const rawReply = (finalContent && finalContent.trim()) ? finalContent.trim() : streamedContent.trim();
  console.log("SSE_STATS:", { streamedContentLen: streamedContent.length, completedContentLen: completedContent.length, assistantCompletedReceived });
  return { answer: rawReply, firstTokenTime };`;

  const newRet = `  const rawReply = completedContent.trim() !== "" ? completedContent.trim() : streamedContent.trim();
  
  return { 
    answer: rawReply, 
    firstTokenTime,
    assistantCompletedReceived,
    sessionId: null,
    streamId: null,
    tokenUsage: null,
    toolCalls: toolEvents
  };`;

  if (code.includes(oldRet)) {
    code = code.replace(oldRet, newRet);
  } else {
    console.error("Could not find return section!");
    // It's possible the user's codebase was already broken or partially updated.
    // Let's try an alternative return block without console.log
    const fallbackRet = `  const rawReply = (finalContent && finalContent.trim()) ? finalContent.trim() : streamedContent.trim();
  return { answer: rawReply, firstTokenTime };`;
    
    if (code.includes(fallbackRet)) {
      code = code.replace(fallbackRet, newRet);
      console.log("Found fallback return section.");
    }
  }

  fs.writeFileSync('server.js', code);
  console.log("Fixes applied successfully.");
}

applyFixes();
