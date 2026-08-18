const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // Replace definitions
  const targetDeclarations = `  let streamedContent = "";
  let finalContent = "";
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;`;
  
  const replacementDeclarations = `  let streamedContent = "";
  let completedContent = "";
  let assistantCompletedReceived = false;
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;`;
  
  code = code.replace(targetDeclarations, replacementDeclarations);

  // Replace assistant.completed block
  const targetCompleted = `    } else if (evName === "assistant.completed") {
      if (isJson && typeof parsed.content === "string") {
        finalContent = parsed.content;
      } else if (isJson && parsed.message && typeof parsed.message.content === "string") {
        finalContent = parsed.message.content;
      }
    } else if (evName === "error") {`;
    
  const replacementCompleted = `    } else if (evName === "assistant.completed") {
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
    } else if (evName === "error") {`;

  code = code.replace(targetCompleted, replacementCompleted);

  // Replace return block
  const targetReturn = `  const rawReply = (finalContent && finalContent.trim()) ? finalContent.trim() : streamedContent.trim();
  console.log("SSE_STATS:", { streamedContentLen: streamedContent.length, completedContentLen: completedContent.length, assistantCompletedReceived });
  return { answer: rawReply, firstTokenTime };`;
  
  const replacementReturn = `  const rawReply = completedContent.trim() !== "" ? completedContent.trim() : streamedContent.trim();
  console.log("SSE_STATS:", { streamedContentLen: streamedContent.length, completedContentLen: completedContent.length, assistantCompletedReceived });
  return { 
    answer: rawReply, 
    firstTokenTime,
    assistantCompletedReceived,
    sessionId: null,
    streamId: null,
    tokenUsage: null,
    toolCalls: toolEvents
  };`;
  
  code = code.replace(targetReturn, replacementReturn);

  fs.writeFileSync('server.js', code);
  console.log("Fixes applied successfully.");
}

applyFixes();
