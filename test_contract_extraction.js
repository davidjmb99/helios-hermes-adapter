const assert = require("assert");
const {
  findBalancedJsonObjects,
  isValidHermesContract,
  extractLastValidHermesContract,
  normalizeAdapterResponse
} = require("./contract-parser");

const mockValidContract = {
  message_for_client: "¡Hola! ¿Cómo estás?",
  operation: { type: "chat", status: "success", summary: "Conversación normal" },
  profile_patch: {},
  state_patch: {},
  booking_patch: {},
  tool_calls: [],
  safe_to_send: true,
  requires_handoff: false,
  recoverable: false,
  error_code: null
};

const makeContractStr = (fields = {}) => {
  return JSON.stringify({ ...mockValidContract, ...fields });
};

// Fixture real
const realFixtureText = `El paciente quiere una cita pero no tengo datos de identidad. Debo solicitar nombre, apellidos y correo juntos.
{"message_for_client":"¡Hola! Encantada de ayudarte a agendar una cita 😊 Para empezar, ¿podrías decirme tu nombre completo y un correo electrónico para poder gestionarla?","operation":{"type":"identity_requested","status":"success","summary":"Se solicitaron los datos necesarios para identificar al paciente."},"profile_patch":{},"state_patch":{"pending_question":"patient_identity","pending_intent":"create_appointment","last_intent":"appointment_request"},"booking_patch":{},"tool_calls":[],"safe_to_send":true,"requires_handoff":false,"recoverable":false,"error_code":null}`;

const testCases = {
  "A. JSON único y completo": {
    input: makeContractStr(),
    expectedOk: true,
    expectedReply: "¡Hola! ¿Cómo estás?",
    expectedErrorCode: null
  },
  "B. Texto de razonamiento + JSON válido": {
    input: "El paciente quiere agendar una cita.\n" + makeContractStr({ message_for_client: "Hola, soy el asistente." }),
    expectedOk: true,
    expectedReply: "Hola, soy el asistente.",
    expectedErrorCode: null
  },
  "C. <think>...</think> + JSON válido": {
    input: "<think>El paciente saludó, responder con saludo</think>\n" + makeContractStr({ message_for_client: "Buenos días." }),
    expectedOk: true,
    expectedReply: "Buenos días.",
    expectedErrorCode: null
  },
  "D. JSON parcial + JSON completo válido": {
    input: '{"message_for_client": "Incomp' + makeContractStr({ message_for_client: "Hola de nuevo." }),
    expectedOk: true,
    expectedReply: "Hola de nuevo.",
    expectedErrorCode: null
  },
  "E. Dos JSON completos, solo el último cumple contrato": {
    input: '{"key": "value"}\n' + makeContractStr({ message_for_client: "Contrato válido." }),
    expectedOk: true,
    expectedReply: "Contrato válido.",
    expectedErrorCode: null
  },
  "F. Dos contratos completos: seleccionar el último": {
    input: makeContractStr({ message_for_client: "Primer contrato." }) + "\n" + makeContractStr({ message_for_client: "Segundo contrato." }),
    expectedOk: true,
    expectedReply: "Segundo contrato.",
    expectedErrorCode: null
  },
  "G. Objeto auxiliar antes del contrato final": {
    input: '{"some_unrelated_tool_data": { "nested": 123 }}\n' + makeContractStr({ message_for_client: "Contrato final." }),
    expectedOk: true,
    expectedReply: "Contrato final.",
    expectedErrorCode: null
  },
  "H. Llaves dentro de message_for_client": {
    input: makeContractStr({ message_for_client: "Hola {nombre}" }),
    expectedOk: true,
    expectedReply: "Hola {nombre}",
    expectedErrorCode: null
  },
  "I. Comillas escapadas dentro de message_for_client": {
    input: makeContractStr({ message_for_client: 'Hola "paciente", ¿cómo estás?' }),
    expectedOk: true,
    expectedReply: 'Hola "paciente", ¿cómo estás?',
    expectedErrorCode: null
  },
  "J. Objetos anidados dentro de operation/state_patch": {
    input: makeContractStr({
      message_for_client: "Ok, agendado.",
      operation: { type: "booking", status: "success", detail: { nested: { val: 42 } } },
      state_patch: { data: { inner: [1, 2, 3] } }
    }),
    expectedOk: true,
    expectedReply: "Ok, agendado.",
    expectedErrorCode: null
  },
  "K. JSON incompleto al final: seleccionar el último contrato completo anterior": {
    input: makeContractStr({ message_for_client: "Contrato completo anterior." }) + '\n{"message_for_client": "Contrato truncado al final',
    expectedOk: true,
    expectedReply: "Contrato completo anterior.",
    expectedErrorCode: null
  },
  "L. Ningún contrato válido: INVALID_HERMES_CONTRACT": {
    input: "Esto no contiene ningún JSON en absoluto o es inválido.",
    expectedOk: false,
    expectedReply: "",
    expectedErrorCode: "INVALID_HERMES_CONTRACT"
  },
  "M. Contrato con operation como array: rechazar": {
    input: makeContractStr({ operation: [1, 2, 3] }),
    expectedOk: false,
    expectedReply: "",
    expectedErrorCode: "INVALID_HERMES_CONTRACT"
  },
  "N. Contrato sin tool_calls: rechazar": {
    input: JSON.stringify({
      message_for_client: "Falta tool_calls",
      operation: {},
      profile_patch: {},
      state_patch: {},
      booking_patch: {},
      safe_to_send: true,
      requires_handoff: false,
      recoverable: false,
      error_code: null
    }),
    expectedOk: false,
    expectedReply: "",
    expectedErrorCode: "INVALID_HERMES_CONTRACT"
  },
  "O. Contrato safe_to_send=false: no producir reply enviable": {
    input: makeContractStr({ safe_to_send: false, message_for_client: "Mensaje no seguro" }),
    expectedOk: false,
    expectedReply: "",
    expectedErrorCode: null
  },
  "P. El texto de reasoning nunca aparece en reply": {
    input: "Razonamiento secreto del modelo que no debe filtrarse.\n" + makeContractStr({ message_for_client: "Respuesta correcta." }),
    expectedOk: true,
    expectedReply: "Respuesta correcta.",
    expectedErrorCode: null
  },
  "T. Contrato con razonamiento dentro de message_for_client": {
    input: makeContractStr({ message_for_client: "<think>razonamiento interno</think> Hola paciente." }),
    expectedOk: false,
    expectedReply: "",
    expectedErrorCode: "INTERNAL_REASONING_IN_CLIENT_MESSAGE"
  },
  "U. Frase legítima con responder": {
    input: makeContractStr({ message_for_client: "Puedes responder este mensaje con tu disponibilidad." }),
    expectedOk: true,
    expectedReply: "Puedes responder este mensaje con tu disponibilidad.",
    expectedErrorCode: null
  },
  "V. Frase legítima con el paciente": {
    input: makeContractStr({ message_for_client: "El paciente puede traer sus estudios anteriores." }),
    expectedOk: true,
    expectedReply: "El paciente puede traer sus estudios anteriores.",
    expectedErrorCode: null
  }
};

let allPass = true;

console.log("=== EJECUTANDO PRUEBAS OBLIGATORIAS (A-V) ===");
for (const [name, test] of Object.entries(testCases)) {
  try {
    const res = normalizeAdapterResponse({ answer: test.input });
    
    // Validar ok
    if (res.ok !== test.expectedOk) {
      throw new Error(`Expected ok=${test.expectedOk}, got ok=${res.ok}`);
    }
    // Validar reply
    if (res.reply !== test.expectedReply) {
      throw new Error(`Expected reply="${test.expectedReply}", got reply="${res.reply}"`);
    }
    // Validar error_code
    if (res.error_code !== test.expectedErrorCode) {
      throw new Error(`Expected error_code=${test.expectedErrorCode}, got error_code=${res.error_code}`);
    }
    
    // W. Nunca existe una salida con ok=false y safe_to_send=true
    if (res.ok === false && res.safe_to_send === true) {
      throw new Error("Violación de seguridad W: salida tiene ok=false pero safe_to_send=true");
    }

    // Regla P: El texto de reasoning nunca aparece en reply
    if (test.expectedOk && test.input.includes("Razonamiento") && res.reply.includes("Razonamiento")) {
      throw new Error("El razonamiento se filtró en reply!");
    }

    // Corrección 2 para caso T (patches vacíos y tool_calls vacío)
    if (name.startsWith("T.")) {
      if (
        Object.keys(res.profile_patch).length !== 0 ||
        Object.keys(res.state_patch).length !== 0 ||
        Object.keys(res.booking_patch).length !== 0 ||
        res.tool_calls.length !== 0 ||
        res.message_for_client !== "" ||
        res.safe_to_send !== false
      ) {
        throw new Error("Caso T: no devolvió patches vacíos, tool_calls vacío o message_for_client vacío");
      }
    }

    console.log(`✅ ${name}: PASS`);
  } catch (e) {
    console.error(`❌ ${name}: FAIL - ${e.message}`);
    allPass = false;
  }
}

console.log("\n=== EJECUTANDO PRUEBA DE FIXTURE REAL (X) ===");
try {
  const res = normalizeAdapterResponse({ answer: realFixtureText });
  assert.strictEqual(res.ok, true, "El fixture real debería ser válido (ok=true)");
  assert.ok(res.reply.startsWith("¡Hola!"), "La respuesta debe empezar con ¡Hola!");
  assert.strictEqual(
    res.message_for_client,
    "¡Hola! Encantada de ayudarte a agendar una cita 😊 Para empezar, ¿podrías decirme tu nombre completo y un correo electrónico para poder gestionarla?",
    "message_for_client coincide exactamente"
  );
  assert.strictEqual(res.safe_to_send, true, "safe_to_send debe ser true");
  assert.strictEqual(res.error_code, null, "error_code debe ser null");
  assert.ok(!res.reply.includes("identidad"), "El razonamiento externo no debe aparecer en la respuesta");
  console.log("✅ Fixture Real: PASS");
} catch (e) {
  console.error("❌ Fixture Real: FAIL -", e.message);
  allPass = false;
}

if (allPass) {
  console.log("\n🎉 ¡TODAS LAS PRUEBAS DE EXTRACCIÓN Y SEGURIDAD PASARON! 🎉");
  process.exit(0);
} else {
  console.error("\n❌ ALGUNAS PRUEBAS FALLARON.");
  process.exit(1);
}
