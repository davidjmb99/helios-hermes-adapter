const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Leer server.js y extraer las funciones para probarlas en aislamiento
const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

// Extraer:
// 1. withTimeout
// 2. finalizeAdapterEventReliably

function extractFunction(code, name) {
  const regex = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = regex.exec(code);
  if (!match) {
    throw new Error(`No se pudo encontrar la función ${name} en server.js`);
  }
  const startIndex = match.index;
  let braceCount = 1;
  let index = code.indexOf('{', startIndex) + 1;
  while (braceCount > 0 && index < code.length) {
    if (code[index] === '{') braceCount++;
    else if (code[index] === '}') braceCount--;
    index++;
  }
  return code.slice(startIndex, index);
}

const withTimeoutCode = extractFunction(serverCode, 'withTimeout');
const finalizeAdapterEventReliablyCode = extractFunction(serverCode, 'finalizeAdapterEventReliably');

// Crear sandbox para ejecutar las funciones con mocks
const sandbox = {
  console,
  setTimeout,
  Symbol,
  Date,
  Error,
  Promise,
  supabase: null,
  logs: [],
  warns: [],
  errors: [],
  finishCalledCount: 0,
  finishDelay: 0,
  finishShouldFail: false,
  fallbackShouldFail: false
};

// Mock de logs de consola
sandbox.console = {
  log: (...args) => {
    sandbox.logs.push(args.join(' '));
    console.log('[Mock Log]', ...args);
  },
  warn: (...args) => {
    sandbox.warns.push(args.join(' '));
    console.warn('[Mock Warn]', ...args);
  },
  error: (...args) => {
    sandbox.errors.push(args.join(' '));
    console.error('[Mock Error]', ...args);
  }
};

// Mock de finishAdapterEvent que incrementa contador y simula retardos/errores
sandbox.finishAdapterEvent = async function(ctx, status, result, hermesDuration, tokenUsage, extra = {}) {
  sandbox.finishCalledCount++;
  if (sandbox.finishShouldFail) {
    return sandbox.TELEMETRY_TIMEOUT;
  }
  if (sandbox.finishDelay > 0) {
    await new Promise(resolve => setTimeout(resolve, sandbox.finishDelay));
  }
  return { data: {}, error: null };
};

// Mock de extractResponsePreview para evitar problemas de parseo de strings con llaves
sandbox.extractResponsePreview = function(responseObj) {
  return "mock-preview";
};

// Mock de Supabase para fallback update
const mockSupabase = {
  from: (table) => {
    return {
      update: (values) => {
        sandbox.supabaseUpdateValues = values;
        return {
          eq: async (column, value) => {
            if (sandbox.fallbackShouldFail) {
              return { data: null, error: { message: "Supabase fallback database update failed" } };
            }
            if (sandbox.fallbackDelay > 0) {
              await new Promise(resolve => setTimeout(resolve, sandbox.fallbackDelay));
            }
            return { data: {}, error: null };
          }
        };
      }
    };
  }
};
sandbox.supabase = mockSupabase;
sandbox.TELEMETRY_TIMEOUT = Symbol("telemetry_timeout");

// Evaluar el código en el sandbox
const fullEvalCode = `
  const console = sandbox.console;
  const extractResponsePreview = sandbox.extractResponsePreview;
  const finishAdapterEvent = sandbox.finishAdapterEvent;
  const supabase = sandbox.supabase;
  const TELEMETRY_TIMEOUT = sandbox.TELEMETRY_TIMEOUT;

  ${withTimeoutCode}
  ${finalizeAdapterEventReliablyCode}
  
  // Hacer la función accesible desde fuera
  sandbox.finalizeAdapterEventReliably = finalizeAdapterEventReliably;
`;

const runInSandbox = new Function('sandbox', fullEvalCode);
runInSandbox(sandbox);

// PRUEBAS

async function runTests() {
  console.log("=== INICIANDO PRUEBAS DE TELEMETRÍA ===");

  // Test Case 1: finishAdapterEvent normal (termina rápido y bien)
  console.log("\n--- TEST 1: finishAdapterEvent normal ---");
  sandbox.logs = [];
  sandbox.warns = [];
  sandbox.errors = [];
  sandbox.finishCalledCount = 0;
  sandbox.finishDelay = 0;
  sandbox.finishShouldFail = false;
  sandbox.fallbackShouldFail = false;

  let telemetryCtx = {
    eventId: "event-123",
    identity: { trace_id: "trace-normal-1" },
    startedAt: Date.now() - 1000,
    closed: false
  };
  let normalizedResponse = { ok: true, safe_to_send: true, error_code: null };
  let debugEvent = { token_usage: { total_tokens: 100 } };

  await sandbox.finalizeAdapterEventReliably(
    telemetryCtx,
    "ok",
    normalizedResponse,
    800,
    debugEvent,
    { route: "hermes" }
  );

  assert.strictEqual(sandbox.finishCalledCount, 1);
  assert.ok(sandbox.logs.some(l => l.includes("adapter_telemetry_finished")));
  assert.strictEqual(sandbox.warns.length, 0);
  assert.strictEqual(sandbox.errors.length, 0);
  console.log("✅ TEST 1: PASSED");

  // Test Case 2: finishAdapterEvent tarda más de 3 segundos (timeout del primario, fallback exitoso)
  console.log("\n--- TEST 2: Primario expira (Timeout > 3s), Fallback exitoso ---");
  sandbox.logs = [];
  sandbox.warns = [];
  sandbox.errors = [];
  sandbox.finishCalledCount = 0;
  sandbox.finishDelay = 3500; // 3.5 segundos (mayor que 3s)
  sandbox.finishShouldFail = false;
  sandbox.fallbackShouldFail = false;
  sandbox.fallbackDelay = 0;
  sandbox.supabaseUpdateValues = null;

  telemetryCtx = {
    eventId: "event-456",
    identity: { trace_id: "trace-timeout-2" },
    startedAt: Date.now() - 2000,
    closed: false
  };

  await sandbox.finalizeAdapterEventReliably(
    telemetryCtx,
    "ok",
    normalizedResponse,
    800,
    debugEvent,
    { route: "hermes" }
  );

  assert.strictEqual(sandbox.finishCalledCount, 1);
  assert.ok(sandbox.warns.some(w => w.includes("adapter_telemetry_primary_failed")));
  assert.ok(sandbox.warns.some(w => w.includes("Primary telemetry finish timed out")));
  assert.ok(sandbox.logs.some(l => l.includes("adapter_telemetry_fallback_finished")));
  assert.ok(sandbox.supabaseUpdateValues !== null);
  assert.strictEqual(sandbox.supabaseUpdateValues.status, "ok");
  assert.strictEqual(sandbox.supabaseUpdateValues.safe_to_send, true);
  assert.strictEqual(sandbox.supabaseUpdateValues.response_sent, false);
  assert.strictEqual(sandbox.supabaseUpdateValues.processing_stage, "response_returned");
  assert.strictEqual(sandbox.errors.length, 0);
  console.log("✅ TEST 2: PASSED");

  // Test Case 3: Primario y Fallback fallan (se reporta el error final sin tumbar la ejecución)
  console.log("\n--- TEST 3: Primario y Fallback fallan ---");
  sandbox.logs = [];
  sandbox.warns = [];
  sandbox.errors = [];
  sandbox.finishCalledCount = 0;
  sandbox.finishDelay = 0;
  sandbox.finishShouldFail = true;
  sandbox.fallbackShouldFail = true;

  telemetryCtx = {
    eventId: "event-789",
    identity: { trace_id: "trace-fail-3" },
    startedAt: Date.now() - 3000,
    closed: false
  };

  await sandbox.finalizeAdapterEventReliably(
    telemetryCtx,
    "error",
    { ok: false, safe_to_send: false, error_code: "TECHNICAL_ERROR" },
    500,
    debugEvent,
    { route: "error" }
  );

  assert.strictEqual(sandbox.finishCalledCount, 1);
  assert.ok(sandbox.warns.some(w => w.includes("adapter_telemetry_primary_failed")));
  assert.ok(sandbox.errors.some(e => e.includes("adapter_telemetry_finalize_failed")));
  assert.ok(sandbox.errors.some(e => e.includes("Fallback telemetry update failed")));
  console.log("✅ TEST 3: PASSED");

  console.log("\n🎉 ¡TODAS LAS PRUEBAS DE TELEMETRÍA FIABLE PASARON CON ÉXITO! 🎉");
}

runTests().catch(err => {
  console.error("❌ Fallo en las pruebas:", err);
  process.exit(1);
});
