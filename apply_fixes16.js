const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // 1. Ensure withTimeout is defined
  const withTimeoutDef = `
function withTimeout(promise, ms, fallbackValue) {
  // Asegurar que si la promesa rechaza después del timeout, el error es capturado
  const safePromise = promise.catch(err => {
    console.error("Secondary operation late rejection:", err.message);
    return fallbackValue;
  });
  
  return Promise.race([
    safePromise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms))
  ]).catch(err => {
    console.error("Timeout/Error in secondary operation:", err.message);
    return fallbackValue;
  });
}
`;
  if (!code.includes("function withTimeout")) {
    const importStr = "const crypto = require('crypto');";
    code = code.replace(importStr, importStr + "\n" + withTimeoutDef);
  } else {
    // If somehow it was defined, replace it
    const regex = /function withTimeout\([\s\S]*?\n\}/;
    code = code.replace(regex, withTimeoutDef.trim());
  }

  // 2. Fix response_sent to false in finishAdapterEvent
  const oldFinish = `          { ...normalizedResponse, response_sent: true },`;
  const newFinish = `          { ...normalizedResponse, response_sent: false },`;
  code = code.replace(oldFinish, newFinish);

  // 3. Fix the catch block to check res.headersSent
  const oldCatch = `  } catch (error) {
    console.error("Adapter error:", error);
    finalStatus = "error";`;
    
  const newCatch = `  } catch (error) {
    if (res.headersSent) {
      console.error("Error after headers sent:", error);
      try {
        await finishAdapterEvent(telemetryCtx, "error", null, hermesDurationMs, null, {
           intent: "error_tecnico",
           error_msg: error.message
        });
      } catch (_) {}
      return;
    }
    
    console.error("Adapter error:", error);
    finalStatus = "error";`;
    
  code = code.replace(oldCatch, newCatch);

  fs.writeFileSync('server.js', code);
  console.log("Fixes applied successfully.");
}

applyFixes();
