# Imagem de produção do serviço de catálogo de imagens.
FROM node:20-slim

WORKDIR /app

# Instala dependências do sistema necessárias para o sharp/libvips.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    libvips \
    && rm -rf /var/lib/apt/lists/*

# Cria usuário não-root para execução do serviço.
RUN groupadd -r app && useradd -r -g app -d /app app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=app:app . .

# Garante que o diretório de runtime persistente seja gravável pelo usuário app.
RUN mkdir -p /app/data && chown -R app:app /app/data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV APP_RUNTIME_DIR=/app/data
ENV STORAGE_PROVIDER=local
ENV STORAGE_LOCAL_DIR=/app/data/output/ai-catalog
ENV AI_CATALOG_DIR=/app/data/output/ai-catalog

VOLUME /app/data

EXPOSE 3000

USER app

CMD ["npm", "run", "template:editor"]
