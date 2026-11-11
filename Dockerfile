FROM node:20-alpine

# Install build dependencies for better-sqlite3 and openssl for certs
RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Create persistent data directory for SQLite, covers, and TLS certificates
RUN mkdir -p /app/data/covers /app/data/certs

ENV NODE_ENV=production
ENV PORT=3000
ENV HTTPS_PORT=3443
ENV DATA_DIR=/app/data

EXPOSE 3000 3443

CMD ["npm", "start"]
