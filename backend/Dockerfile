FROM node:22-bookworm-slim

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      fonts-crosextra-caladea \
      fonts-crosextra-carlito \
      fonts-liberation \
      libreoffice-writer \
      openssl \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/main.js"]
