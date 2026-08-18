const http = require('http');

async function runTest() {
  console.log("=== PRUEBA DE ARRANQUE === ");
  console.log("Servidor Adapter levantado (verificado en logs).");

  console.log("\n=== PRUEBA DE GET /debug/events ===");
  const resDebug = await new Promise((resolve) => {
    http.get('http://localhost:3000/debug/events', (res) => {
      let data = '';
      res.on('data', c => data+=c);
      res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(data)}));
    });
  });
  console.log("Status GET /debug/events:", resDebug.status);
  console.log("Eventos en BD:", resDebug.data.events?.length);

  console.log("\n=== PRUEBA DE EVENTO REAL (MOCK HERMES) ===");
  
  const payload = JSON.stringify({
    trace_id: "test-trace-" + Date.now(),
    tenant_id: "democoi1",
    conversation_id: "conv-12345",
    contact_id: "7",
    message_text: "Hola, quiero saber mi cita",
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
    res.on('end', async () => {
      console.log("Status Code /helios/message:", res.statusCode);
      console.log("Respuesta del Adapter:", data);
      
      // Esperar un segundo para que el evento se termine de insertar
      await new Promise(r => setTimeout(r, 1000));
      
      console.log("\n=== VALIDACIÓN DE EVENTO EN BD ===");
      http.get('http://localhost:3000/debug/events?limit=1', (res2) => {
        let d2 = '';
        res2.on('data', c => d2+=c);
        res2.on('end', () => {
          const evData = JSON.parse(d2).events[0];
          console.log("Último evento insertado:");
          console.log(JSON.stringify(evData, null, 2));
          
          if(evData.status === 'ok' || evData.status === 'handoff' || evData.status === 'error') {
             console.log("✅ Evento persistido correctamente con status:", evData.status);
          }
          if(evData.error_code !== "INVALID_CLIENT_MESSAGE") {
             console.log("✅ No hay INVALID_CLIENT_MESSAGE.");
          }
          if(evData.trace_id.startsWith("test-trace")) {
             console.log("✅ Trace ID empata.");
          }
        });
      });
    });
  });

  req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
  });
  
  req.write(payload);
  req.end();
}

runTest();
