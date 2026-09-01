FROM node:22-alpine

# CURL, PARA EL HEALTHCHECK DE COOLIFY.
#
# SIN ESTO EL HEALTHCHECK NO COMPRUEBA NADA Y NADIE SE ENTERA. Coolify pide
# http://localhost:3000/health con curl desde dentro del contenedor; en una imagen alpine
# curl no viene, asi que el comando falla con «/bin/sh: curl: not found» Y DEVUELVE CODIGO
# 0 -que significa «todo bien»-. Coolify concluye «healthy» pase lo que pase.
#
# O sea: un detector de humo con la pila quitada. Si el Adapter se cuelga -sigue en pie
# pero deja de responder- Coolify no lo reinicia y no avisa; se descubre porque un paciente
# no recibe respuesta.
#
# El Gateway ya lo tenia; aqui se olvido. Son unos 2 MB.
RUN apk add --no-cache curl

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

# OJO: lista explícita, no `COPY . .`, para no meter node_modules ni los tests.
# Cada módulo nuevo hay que añadirlo AQUÍ o el contenedor arranca y muere con
# MODULE_NOT_FOUND: el build sale bien y el fallo solo aparece al arrancar.
# `node test_dockerfile.js` comprueba que no falte ninguno.
COPY server.js contract-parser.js processing-diagnostics.js tenant-context.js hermes-agent-client.js request-identity.js execution-store.js supabase-assert.js  pricing.js cache-delta.js respuesta-repetida.js sesiones.js almacen-sesiones.js metricas.js filtro-de-cuenta.js sesion-de-panel.js contrasenas.js ./

EXPOSE 3000

CMD ["npm", "start"]
