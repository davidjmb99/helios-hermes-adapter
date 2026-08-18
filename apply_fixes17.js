const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // 1. Add withTimeout
  const withTimeoutDef = `
function withTimeout(promise, ms, fallbackValue) {
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
    code = code.replace('const crypto = require("crypto");', 'const crypto = require("crypto");\n' + withTimeoutDef);
  } else {
    const regex = /function withTimeout\([\s\S]*?\n\}/;
    code = code.replace(regex, withTimeoutDef.trim());
  }

  // 2. Fix response_sent in finishAdapterEvent
  const oldFinishEvent = `        finishAdapterEvent(
          telemetryCtx,
          finalStatus,
          { ...normalizedResponse, response_sent: true },
          hermesDurationMs,`;
  const newFinishEvent = `        finishAdapterEvent(
          telemetryCtx,
          finalStatus,
          { ...normalizedResponse, response_sent: false },
          hermesDurationMs,`;
  if (code.includes(oldFinishEvent)) {
    code = code.replace(oldFinishEvent, newFinishEvent);
  } else {
    // maybe it has `response_sent: normalizedResponse.response_sent === true` ?
    const oldFinishEvent2 = `        finishAdapterEvent(
          telemetryCtx,
          finalStatus,
          { ...normalizedResponse, response_sent: normalizedResponse.response_sent === true },
          hermesDurationMs,`;
    if (code.includes(oldFinishEvent2)) {
      code = code.replace(oldFinishEvent2, newFinishEvent);
    }
  }

  // 3. Fix the catch block headersSent
  const oldCatch = `    } catch (_) {}

  } catch (error) {
    console.error("Adapter error:", error);
    finalStatus = "error";`;
    
  const newCatch = `    } catch (_) {}

  } catch (error) {
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
    
  if (code.includes(oldCatch)) {
    code = code.replace(oldCatch, newCatch);
  } else {
    // maybe just `} catch (error) {`
    const oldCatch2 = `  } catch (error) {
    console.error("Adapter error:", error);
    finalStatus = "error";
    finalRoute = "error";`;
    const newCatch2 = `  } catch (error) {
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
    finalStatus = "error";
    finalRoute = "error";`;
    code = code.replace(oldCatch2, newCatch2);
  }

  fs.writeFileSync('server.js', code);
  console.log("Fixes applied successfully.");
}

applyFixes();
