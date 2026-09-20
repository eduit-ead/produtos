# Imagem de produção do serviço de catálogo de imagens.
FROM node:20-slim

WORKDIR /app

# Instala dependências do sistema necessárias para o sharp e outras libs nativas.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    libvips \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV HOST=0.0.0.0
ENV PORT=3000
ENV STORAGE_PROVIDER=local
ENV STORAGE_LOCAL_DIR=/app/output/ai-catalog
ENV AI_CATALOG_DIR=/app/output/ai-catalog

EXPOSE 3000

CMD ["node", "src/template-editor/server.js"]
