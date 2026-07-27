FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

COPY server.js contract-parser.js tenant-context.js hermes-agent-client.js request-identity.js execution-store.js supabase-assert.js ./

EXPOSE 3000

CMD ["npm", "start"]
