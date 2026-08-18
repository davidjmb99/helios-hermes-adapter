const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // Fix variable name mismatch that caused ReferenceError:
  // The SSE stats console log expects completedContent, but the function used finalContent.
  
  // Target in line 1027/1028
  const targetSSE = `const rawReply = (finalContent && finalContent.trim()) ? finalContent.trim() : streamedContent.trim();
  console.log("SSE_STATS:", { streamedContentLen: streamedContent.length, completedContentLen: completedContent.length, assistantCompletedReceived });`;

  // We should change the variables inside consumeHermesStream to match what the user requested: completedContent & assistantCompletedReceived
  // Also adjust the final extraction
  
  const oldDeclarations = `let streamedContent = "";
  let finalContent = "";
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;`;
  
  const newDeclarations = `let streamedContent = "";
  let completedContent = "";
  let reasoningContent = "";
  let toolEvents = [];
  let firstTokenTime = null;
  let assistantCompletedReceived = false;`;
  
  code = code.replace(oldDeclarations, newDeclarations);
  
  const oldAssistantCompleted = `} else if (evName === "assistant.completed") {
      if (isJson && typeof parsed.content === "string") {
        finalContent = parsed.content;
      } else if (isJson && parsed.message && typeof parsed.message.content === "string") {
        finalContent = parsed.message.content;
      }
    } else if`;
    
  const newAssistantCompleted = `} else if (evName === "assistant.completed") {
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
    
  code = code.replace(oldAssistantCompleted, newAssistantCompleted);
  
  const oldRawReply = `const rawReply = (finalContent && finalContent.trim()) ? finalContent.trim() : streamedContent.trim();
  console.log("SSE_STATS:", { streamedContentLen: streamedContent.length, completedContentLen: completedContent.length, assistantCompletedReceived });
  return { answer: rawReply, firstTokenTime };`;
  
  const newRawReply = `const rawReply = (completedContent && completedContent.trim() !== "") ? completedContent.trim() : streamedContent.trim();
  return { answer: rawReply, firstTokenTime, assistantCompletedReceived };`;
  
  code = code.replace(oldRawReply, newRawReply);
  
  fs.writeFileSync('server.js', code);
  console.log("Fixes applied successfully.");
}

applyFixes();
