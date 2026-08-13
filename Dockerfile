# ── Organízalo.AI Backend ────────────────────────────────────────────────────
# Incluye Chromium para WhatsApp Web (whatsapp-web.js + puppeteer)
# Compatible con Railway, Fly.io, y cualquier host Linux.

FROM node:22-slim

# Instalar Chromium y sus dependencias
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto \
    fonts-noto-cjk \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Variables de entorno para puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Instalar dependencias primero (capa cacheada)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar el código
COPY . .

# Crear directorio de datos persistente
# En Railway: montar un volumen en /app/data
RUN mkdir -p /app/data /app/.wwebjs_auth

EXPOSE 3001

CMD ["node", "src/index.js"]
