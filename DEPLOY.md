# Deploy no Easypanel — fase 1

Um único contêiner Node.js. PostgreSQL, autenticação obrigatória e publicação de imagens ficam para as fases seguintes. O processo escuta em `0.0.0.0` na porta `PORT` (padrão `3000`) e grava arquivos em `/app/persistent`.

## Teste local com Docker

```bash
docker build -t bwipoart .
docker volume create bwipoart_data
docker run -d --name bwipoart \
  -p 3000:3000 \
  -e AUTH_DISABLED=true \
  -e OPENAI_API_KEY= \
  -v bwipoart_data:/app/persistent \
  bwipoart
```

Health check: `http://127.0.0.1:3000/api/health`.

Compose de referência: `docker-compose.example.yml`.

```bash
docker compose -f docker-compose.example.yml up -d --build
```

## Easypanel

1. Crie um serviço do tipo App a partir deste repositório, com o Dockerfile na raiz.
2. Porta do contêiner: `3000` (ou o valor de `PORT`).
3. Deixe o Easypanel terminar o HTTPS no proxy. A aplicação fala só HTTP e já usa `trust proxy`.
4. Monte um volume persistente em `/app/persistent`.
5. Não monte o código-fonte por cima de `/app`.
6. Defina as variáveis abaixo no painel. Não envie o arquivo `.env` na imagem.

### Volume

Caminho no contêiner: `/app/persistent`.

Esse diretório guarda, na mesma estrutura do projeto:

| Caminho no volume | Conteúdo |
| --- | --- |
| `data/templates` | Templates personalizados |
| `data/assets` | Assets e fotografias aprovadas |
| `data/collections` | Configuração das coleções |
| `data/imports` | Bases e planilhas importadas |
| `input/cursos.xlsx` | Planilha legada de cursos |
| `input/backups` | Backups gerados na sincronização XLSX |
| `input/cache` | Cache de imagens baixadas da planilha |
| `output/ai-catalog` | Imagens, metadados, manifestos, jobs e histórico de peças (`finished/`) |
| `output/exports` | Planilhas exportadas |
| `output/final` | PNGs finais do fluxo legado |
| `output/whatsapp` | JPEGs do fluxo legado |

Na primeira subida, templates, assets e a coleção padrão que vierem na imagem são copiados para o volume somente se ainda não existirem. Arquivos já presentes no volume não são substituídos.

### Variáveis

```env
HOST=0.0.0.0
PORT=3000
NODE_ENV=production
APP_RUNTIME_DIR=/app/persistent
STORAGE_PROVIDER=local
STORAGE_LOCAL_DIR=/app/persistent/output/ai-catalog
AI_CATALOG_DIR=/app/persistent/output/ai-catalog
AUTH_DISABLED=true
OPENAI_API_KEY=
```

`AUTH_DISABLED=true` mantém o serviço no ar até a fase de autenticação. Quando a senha for ativada, defina `AUTH_DISABLED=false`, `APP_ACCESS_PASSWORD` e `APP_SESSION_SECRET` (mínimo 32 caracteres).

`DATABASE_URL` pode ser declarada agora, apontando para o PostgreSQL do servidor pelo nome do serviço (não use `localhost`). A aplicação ainda não abre essa conexão.

A chave OpenAI fica só no painel. O frontend recebe apenas se ela está configurada, nunca o valor.

### Atualizar sem perder arquivos

1. Faça backup do volume `/app/persistent`.
2. Publique a nova imagem.
3. Recrie o serviço mantendo o mesmo volume.

O health check da imagem consulta `GET /api/health`.
