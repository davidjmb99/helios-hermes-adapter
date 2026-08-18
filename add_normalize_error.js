const fs = require('fs');

let content = fs.readFileSync('server.js', 'utf8');

// We need to implement normalizeProviderError
const normalizeProviderErrorStr = `
function normalizeProviderError(error) {
  const errStr = String(error.message || "").toLowerCase();
  
  const isTimeout = 
    error.name === "AbortError" || 
    error.code === "ECONNABORTED" || 
    error.code === "ETIMEDOUT" || 
    errStr.includes("timeout") ||
    errStr.includes("aborted");

  if (isTimeout) {
    return {
      error_code: "HERMES_TIMEOUT",
      intent: "provider_timeout",
      recoverable: true,
      http_status: 502 // keeping as 502 until proven otherwise
    };
  }

  return {
    error_code: "ADAPTER_EXCEPTION",
    intent: "error_tecnico",
    recoverable: true,
    http_status: 502
  };
}
`;

content = content.replace('app.post("/helios/message", async (req, res) => {', normalizeProviderErrorStr + '\napp.post("/helios/message", async (req, res) => {');

// Now update the catch block to use normalizeProviderError
const oldCatchStr = `    let errorResponse = {};
    if (isAbortError) {
      errorResponse = {
        ok: false,
        route: "error",
        intent: "provider_timeout",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "HERMES_TIMEOUT"
      };
    } else {
      errorResponse = {
        ok: false,
        route: "error",
        intent: "error_tecnico",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "ADAPTER_EXCEPTION",
        metadata: {
          error: error.message
        }
      };
    }`;

const newCatchStr = `    const normalizedError = normalizeProviderError(error);
    const errorResponse = {
      ok: false,
      route: "error",
      intent: normalizedError.intent,
      requires_handoff: false,
      safe_to_send: false,
      response_sent: false,
      recoverable: normalizedError.recoverable,
      error_code: normalizedError.error_code,
      metadata: {
        error: error.message
      }
    };`;

content = content.replace(oldCatchStr, newCatchStr);

// Also replace the rest of the catch block where isAbortError is used
content = content.replace(
  'isAbortError ? "HERMES_TIMEOUT" : "ADAPTER_EXCEPTION"',
  'normalizedError.error_code'
);

content = content.replace(
  'intent: isAbortError ? "provider_timeout" : "error_tecnico",',
  'intent: normalizedError.intent,'
);

content = content.replace(
  'provider_error_code: isAbortError ? "HERMES_TIMEOUT" : null,',
  'provider_error_code: normalizedError.error_code === "HERMES_TIMEOUT" ? "HERMES_TIMEOUT" : null,'
);

content = content.replace(
  'return res.status(isAbortError ? 408 : 502).json(errorResponse);',
  'return res.status(normalizedError.http_status).json(errorResponse);'
);

content = content.replace(
  'const isAbortError = error.name === "AbortError" || error.message.includes("aborted") || error.message.includes("AbortError");',
  ''
);

fs.writeFileSync('server.js', content);
console.log("Updated server.js with normalizeProviderError");
