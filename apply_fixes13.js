const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // Replace runStreamFlow's timing logic
  const target = `    const resStream = await consumeHermesStreamWithRetry(streamId);
      answer = resStream.answer;
      if (resStream.firstTokenTime) firstTokenMs = resStream.firstTokenTime - startTimestamp;
      if (resStream.sessionId) sessionId = resStream.sessionId;
  };`;
  
  const replacement = `    const streamStartedAt = Date.now();
    const resStream = await consumeHermesStreamWithRetry(streamId);
    answer = resStream.answer;
    
    try {
      if (
        typeof resStream.firstTokenTime === "number" &&
        Number.isFinite(resStream.firstTokenTime)
      ) {
        firstTokenMs = Math.max(
          0,
          resStream.firstTokenTime - streamStartedAt
        );
      } else {
        firstTokenMs = null;
      }
    } catch (_) {
      firstTokenMs = null;
    }
    
    if (resStream.sessionId) sessionId = resStream.sessionId;
  };`;
  
  if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('server.js', code);
    console.log("Fix applied successfully.");
  } else {
    console.log("Could not find target block in server.js!");
  }
}

applyFixes();
