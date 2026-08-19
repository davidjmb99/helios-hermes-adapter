FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

# OJO: lista explícita, no `COPY . .`, para no meter node_modules ni los tests.
# Cada módulo nuevo hay que añadirlo AQUÍ o el contenedor arranca y muere con
# MODULE_NOT_FOUND: el build sale bien y el fallo solo aparece al arrancar.
# `node test_dockerfile.js` comprueba que no falte ninguno.
COPY server.js contract-parser.js processing-diagnostics.js tenant-context.js hermes-agent-client.js request-identity.js execution-store.js supabase-assert.js pricing.js cache-delta.js ./

EXPOSE 3000

CMD ["npm", "start"]
