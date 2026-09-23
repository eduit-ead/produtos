# Imagem de produção do BwipoArt.
# Node 22 é a LTS compatível com Sharp 0.35 (binários pré-compilados).
FROM node:22-bookworm-slim

WORKDIR /app

# Fontes e certificados para o Sharp/libvips embutido renderizar texto em SVG.
# Não instala libvips do sistema: o Sharp traz a própria libvips.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fontconfig \
    fonts-liberation \
    util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f \
    && command -v setpriv

RUN groupadd --system app && useradd --system --gid app --home /app --shell /usr/sbin/nologin app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=app:app . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/persistent \
    && chown -R app:app /app/persistent

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV APP_RUNTIME_DIR=/app/persistent
ENV STORAGE_PROVIDER=local

VOLUME /app/persistent

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/template-editor/server.js"]
