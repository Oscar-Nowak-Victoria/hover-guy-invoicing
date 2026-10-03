FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium NODE_ENV=production HOST=0.0.0.0 PORT=3000 TZ=Australia/Melbourne
WORKDIR /app
# The database and outbox live in /app/data. Attach a Railway volume there
# (Railway rejects the Docker VOLUME instruction).
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
