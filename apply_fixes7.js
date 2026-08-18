const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // 1. HERMES_API_KEY no está configurada en el adapter
  const target1 = `const configErrorResponse = { ok: false, error: errText };`;
  const replace1 = `const configErrorResponse = {
        ok: false,
        route: "error",
        intent: "error_configuracion",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "HERMES_API_KEY_MISSING",
        metadata: { error_code: "HERMES_API_KEY_MISSING" },
        error: errText
      };`;
  code = code.replace(target1, replace1);

  // 2. Unauthorized access attempt
  const target2 = `const authErrorResponse = { ok: false, error: "Unauthorized" };`;
  const replace2 = `const authErrorResponse = {
        ok: false,
        route: "error",
        intent: "unauthorized",
        requires_handoff: false,
        safe_to_send: false,
        response_sent: false,
        recoverable: true,
        error_code: "UNAUTHORIZED",
        metadata: { error_code: "UNAUTHORIZED" },
        error: "Unauthorized"
      };`;
  code = code.replace(target2, replace2);
  
  // 3. Update debugEvent in catch block
  const targetCatchDebug = `debugEvent.requires_handoff = true;`;
  const replaceCatchDebug = `debugEvent.requires_handoff = normalizedError.requires_handoff;`;
  code = code.replace(targetCatchDebug, replaceCatchDebug);

  fs.writeFileSync('server.js', code);
  console.log("Fixes applied successfully.");
}

applyFixes();
