# helios-hermes-adapter

Adapter de producción entre Helios Gateway y Hermes WebUI usando el perfil `helios`.

Este servicio recibe eventos estructurados desde `helios-gateway`, valida la solicitud con un token compartido, crea o reutiliza una sesión de Hermes por conversación/contacto de Chatwoot, envía el payload original del gateway a Hermes y devuelve una respuesta normalizada al gateway.

El adapter no toma decisiones clínicas, comerciales ni de agenda. Hermes perfil `helios` es el cerebro.

## Flujo de producción

```text
Chatwoot / WhatsApp
→ helios-gateway
→ helios-hermes-adapter
→ Hermes WebUI perfil helios
→ helios-gateway
→ Respuesta al paciente en Chatwoot
```

## Responsabilidad del adapter

Este servicio debe actuar solo como capa técnica de transporte entre Helios Gateway y Hermes.

Debe hacer:

```text
1. Validar la API key compartida.
2. Recibir el payload del gateway.
3. Crear o reutilizar una sesión Hermes por conversación/contacto.
4. Enviar el payload a Hermes.
5. Recibir la respuesta de Hermes.
6. Devolver una respuesta normalizada al gateway.
```

No debe hacer:

```text
- Decidir intención clínica.
- Decidir si agenda, cancela o reprograma.
- Inventar respuestas al paciente.
- Cambiar reglas del perfil helios.
- Forzar lógica dental.
- Modificar el comportamiento del cerebro Hermes.
```

## Endpoints

### GET /

Devuelve información básica del servicio.

### GET /health

Devuelve el estado del servicio y configuración segura.

No expone claves ni contraseñas.

### POST /helios/message

Endpoint principal usado por `helios-gateway`.

Headers requeridos:

```http
Authorization: Bearer <HERMES_API_KEY>
Content-Type: application/json
```

## Variables de entorno requeridas

Estas variables se configuran en Coolify.

No colocar valores reales dentro de GitHub.

```env
NODE_ENV=production
PORT=3000

HERMES_API_KEY=
HERMES_PROFILE=helios
HERMES_CWD=/home/hermeswebui/.hermes/profiles/helios/workspace/helios

HERMES_WEBUI_BASE_URL=https://hermes.servicios.escala365.com
HERMES_WEBUI_PASSWORD=

HERMES_TIMEOUT_MS=30000
HERMES_SESSION_STORE_PATH=/tmp/helios-hermes-sessions.json

DEBUG_USERNAME=democoi1
DEBUG_PASSWORD=democoi1
DEBUG_TOKEN=
```

## Modelo de IA

El adapter no debe forzar el modelo si Hermes perfil `helios` ya tiene configurado su modelo principal.

Estas variables son opcionales:

```env
HERMES_MODEL=
HERMES_MODEL_PROVIDER=
```

Déjalas vacías o sin crear en Coolify si Hermes ya tiene configurado el modelo correcto.

## Seguridad

Nunca subir claves reales a este repositorio.

Los secretos deben quedarse únicamente en Coolify:

```text
- HERMES_API_KEY
- HERMES_WEBUI_PASSWORD
- claves de proveedores de IA
- tokens de Chatwoot
- claves de Supabase
- contraseñas
- bearer tokens
```

## Estrategia de despliegue en producción

No reemplazar el adapter actual directamente sin prueba previa.

Orden recomendado:

```text
1. Desplegar este repositorio como una nueva app en Coolify.
2. Usar un dominio temporal.
3. Copiar las variables reales desde el adapter actual.
4. Probar /health.
5. Probar POST /helios/message.
6. Apuntar temporalmente helios-gateway hacia el nuevo adapter.
7. Probar una conversación real desde WhatsApp/Chatwoot.
8. Si todo funciona, mover el dominio final al nuevo adapter.
9. Mantener el adapter viejo disponible unos días como rollback.
```

## Dominio temporal recomendado

```text
helioshermesadapter-v2.servicios.escala365.com
```

## Dominio de producción final

```text
helioshermesadapter.servicios.escala365.com
```

## Ejecución local

```bash
npm install
npm start
```

## Docker

```bash
docker build -t helios-hermes-adapter .
docker run --env-file .env -p 3000:3000 helios-hermes-adapter
```

## Notas importantes

El adapter debe pasar el payload del gateway a Hermes sin convertirlo en una decisión.

Hermes perfil `helios` contiene el contexto, la memoria, las reglas, el modelo y la lógica de respuesta.

Si Hermes devuelve un error técnico del proveedor, el adapter puede proteger al paciente devolviendo una respuesta segura de handoff técnico, pero no debe tomar decisiones clínicas.
