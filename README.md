# helios-hermes-adapter

Adaptador de producción entre Helios Gateway y el perfil dedicado `helios` de
Hermes Agent.

Hermes se utiliza como arnés: su código no se modifica ni se mantiene un fork.
El perfil `helios` conserva su SOUL, modelo, memoria y herramientas MCP. El
adaptador se limita al transporte, aislamiento de conversaciones, validación y
normalización del contrato.

## Flujo recomendado

```text
Chatwoot / WhatsApp
→ Helios Gateway
→ helios-hermes-adapter
→ Hermes Agent API, perfil helios, puerto 8643
→ helios-hermes-adapter
→ Helios Gateway
→ paciente
```

El transporte antiguo por Hermes WebUI continúa disponible únicamente para un
rollback controlado.

## Responsabilidades

El adaptador:

1. Valida el token compartido con Helios Gateway.
2. Valida y aísla el contexto de tenant, clínica y perfil.
3. Construye una conversación opaca y estable por contacto/conversación.
4. Llama a `POST /v1/responses` del gateway oficial de Hermes Agent.
5. Deriva una clave de idempotencia estable desde los IDs originales de los
   mensajes; usa `trace_id` solo cuando el origen no aporta esos IDs.
6. Extrae solo el mensaje final del asistente.
7. Normaliza el contrato moderno y sus campos de compatibilidad.
8. Registra telemetría sin exponer secretos ni datos del paciente.

El adaptador no decide lógica clínica, comercial ni de agenda y no modifica el
comportamiento del perfil `helios`.

## Endpoints

- `GET /`: información básica.
- `GET /health`: configuración segura, sin valores secretos.
- `POST /helios/message`: endpoint autenticado para Helios Gateway.

```http
Authorization: Bearer <HERMES_API_KEY>
Content-Type: application/json
```

## Configuración recomendada en Coolify

No guardar valores reales en GitHub.

```env
NODE_ENV=production
PORT=3000

# Token compartido Gateway → Adapter
HERMES_API_KEY=

# Transporte oficial por perfil
HERMES_TRANSPORT=agent_api
HERMES_PROFILE=helios
HERMES_AGENT_API_BASE_URL=http://<servicio-interno-hermes>:8643
HERMES_AGENT_API_KEY=
HERMES_AGENT_MODEL=helios
HERMES_TIMEOUT_MS=30000

# Mapa autorizado de cuentas/tenants
CHATWOOT_TENANT_CONTEXTS_JSON=

DEBUG_USERNAME=
DEBUG_PASSWORD=
DEBUG_TOKEN=
```

`HERMES_AGENT_API_BASE_URL` debe usar la red privada de Coolify siempre que
ambos servicios estén en el mismo servidor o red. No se necesita publicar el
puerto 8643 en Internet.

La clave de `HERMES_AGENT_API_KEY` pertenece al gateway de Hermes Agent. Es
distinta del token `HERMES_API_KEY` que protege la entrada al adaptador.

## Requisito previo de producción

El proceso siguiente debe estar supervisado de forma permanente:

```bash
hermes -p helios gateway run
```

No basta con dejarlo en segundo plano dentro de una sesión de terminal. En
Coolify debe ejecutarse como proceso principal de un servicio o mediante el
supervisor ya utilizado por el contenedor. El perfil y su estado deben residir
en un volumen persistente.

Antes de activar el nuevo transporte deben pasar:

```text
gateway iniciado: sí
puerto: 8643
health: PASS
readiness: PASS
modelo anunciado: helios
chat completion: PASS
HubSpot MCP disponible: sí
Cal.com MCP disponibles: 4
supervisión tras reinicio: PASS
```

## Activación gradual

1. Hacer permanente el proceso `helios` en Coolify.
2. Reiniciar el servicio Hermes y repetir health, readiness y chat completion.
3. Desplegar esta versión del adaptador sin cambiar todavía el Gateway.
4. Confirmar en `/health`:
   - `hermes_transport: "agent_api"`
   - `hermes_agent_api_base_url_configured: true`
   - `hermes_agent_api_key_configured: true`
   - `hermes_agent_model: "helios"`
5. Probar `POST /helios/message` con una conversación de prueba.
6. Probar desde WhatsApp: conversación simple, creación de contacto y consulta
   de disponibilidad.
7. Observar errores, latencia y duplicados antes de ampliar tráfico.

## Rollback

No existe fallback automático entre API y WebUI. Es intencionado: repetir una
petición después de una herramienta de HubSpot o Cal.com podría duplicar una
acción.

La idempotencia del Adapter evita volver a ejecutar el mismo lote de mensajes
en Hermes dentro de la ventana de deduplicación del API. No sustituye la
garantía de entrega del Gateway: el envío a Chatwoot debe usar una bandeja de
salida persistente con clave única por mensaje de origen y registrar el ID del
mensaje saliente antes de considerar completado el evento.

Para volver temporalmente al transporte anterior:

```env
HERMES_TRANSPORT=webui
HERMES_WEBUI_BASE_URL=https://<hermes-webui>
HERMES_WEBUI_PASSWORD=
HERMES_CWD=/home/hermeswebui/.hermes/profiles/helios/workspace/helios
HERMES_SESSION_STORE_PATH=/tmp/helios-hermes-sessions.json
```

Después se redepliega únicamente el adaptador.

## Seguridad

Los secretos deben permanecer únicamente en Coolify:

- `HERMES_API_KEY`
- `HERMES_AGENT_API_KEY`
- `HERMES_WEBUI_PASSWORD`
- claves de proveedores, Supabase y Chatwoot

El endpoint `/health` solo indica si cada valor está configurado. No devuelve
claves, contraseñas ni tokens.

## Desarrollo y verificación

```bash
npm ci
npm test
npm start
```

```bash
docker build -t helios-hermes-adapter .
docker run --env-file .env -p 3000:3000 helios-hermes-adapter
```
