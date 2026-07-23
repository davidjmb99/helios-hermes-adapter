const { normalizeAdapterResponse } = require("./contract-parser");

const tests = [
  { name: "A. Un único JSON completo", input: '{"message_for_client":"Hola","operation":{},"profile_patch":{},"state_patch":{},"booking_patch":{},"tool_calls":[],"safe_to_send":true,"requires_handoff":false,"recoverable":false,"error_code":null}' },
  { name: "B. Reasoning + JSON final", input: '<think>Pensando</think>\n{"message_for_client":"Hola","operation":{},"profile_patch":{},"state_patch":{},"booking_patch":{},"tool_calls":[],"safe_to_send":true,"requires_handoff":false,"recoverable":false,"error_code":null}' },
  { name: "C. JSON parcial + completo", input: '{"message_for_client"\n{"message_for_client":"Hola","operation":{},"profile_patch":{},"state_patch":{},"booking_patch":{},"tool_calls":[],"safe_to_send":true,"requires_handoff":false,"recoverable":false,"error_code":null}' },
  { name: "D. Dos JSON completos", input: '{"message_for_client":"Hola","operation":{},"profile_patch":{},"state_patch":{},"booking_patch":{},"tool_calls":[],"safe_to_send":true,"requires_handoff":false,"recoverable":false,"error_code":null}\n{"message_for_client":"Hola2","operation":{},"profile_patch":{},"state_patch":{},"booking_patch":{},"tool_calls":[],"safe_to_send":true,"requires_handoff":false,"recoverable":false,"error_code":null}' },
  { name: "E. Pensando literal + JSON", input: 'Pensando...\n{"message_for_client":"Hola","operation":{},"profile_patch":{},"state_patch":{},"booking_patch":{},"tool_calls":[],"safe_to_send":true,"requires_handoff":false,"recoverable":false,"error_code":null}' }
];

let allPass = true;
tests.forEach(t => {
  try {
    const res = normalizeAdapterResponse({ answer: t.input });
    console.log(t.name, "=>", res.ok ? "PASS (Valid)" : "FAIL (Invalid)");
    if (!res.ok) {
      console.log("   ", res.error_code || res.intent);
      allPass = false;
    }
  } catch (e) {
    console.log(t.name, "=> THREW EXCEPTION:", e.name, e.message);
    allPass = false;
  }
});

if (allPass) {
  process.exit(0);
} else {
  process.exit(1);
}
