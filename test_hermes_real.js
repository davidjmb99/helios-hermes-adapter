const http = require('http');

const payload = JSON.stringify({
  trace_id: "test-trace-" + Date.now(),
  tenant_id: "democoi1",
  conversation_id: "conv-12345",
  contact_id: "7",
  message_text: "Hola, necesito cancelar mi cita médica de mañana por la tarde porque estoy enfermo.",
  first_name: "TestUser",
  last_name: "Prueba",
  phone: "+584125207119",
  isNewPatient: false
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/helios/message',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log("Status Code:", res.statusCode);
    console.log("Respuesta Completa del Adapter:", data);
    try {
      const parsed = JSON.parse(data);
      console.log("=== ANÁLISIS DE LA RESPUESTA ===");
      console.log("Reply recibido:", parsed.reply);
      console.log("¿Es texto plano o JSON serializado?");
      
      let isJson = false;
      try {
         const hermesRaw = JSON.parse(parsed.reply);
         isJson = true;
         console.log("Hermes devolvió un JSON con estas llaves:", Object.keys(hermesRaw));
         if (hermesRaw.message_for_client) console.log("Contiene: message_for_client");
         if (hermesRaw.reply_text) console.log("Contiene: reply_text");
         if (hermesRaw.reply) console.log("Contiene: reply");
      } catch (e) {
         console.log("Hermes devolvió TEXTO PLANO directamente.");
      }
      
      if (!isJson) {
         console.log("\n==> CONCLUSIÓN: Hermes devuelve texto plano. No se debe desplegar el bloqueo estricto (JSON-only) todavía.");
      } else {
         console.log("\n==> CONCLUSIÓN: Hermes ya devuelve JSON estructurado.");
      }
    } catch(e) {
      console.log("Error parseando respuesta del Adapter", e);
    }
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.write(payload);
req.end();
