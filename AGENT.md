# Decisões do Agente

## 2026-09-20 — Batch production, storage and XLSX sync architecture

### Contexto
Implementar a primeira versão completa do fluxo de produção em lote, organização de arquivos, exportação WhatsApp, sincronização controlada com XLSX e preparação para armazenamento local ou bucket.

### Decisão
- Adotar estrutura determinística de arquivos por curso em `output/ai-catalog/<slug>/`:
  - `<slug>-fundo.png`
  - `<slug>-card.png`
  - `<slug>-whatsapp.jpg`
  - `metadata.json`
- Centralizar nomes em `src/batch/naming.js` (`courseFiles(slug)`).
- Criar `StorageProvider` desacoplada, com `LocalStorageProvider` ativo via `STORAGE_PROVIDER=local`.
- Cada curso possui `metadata.json` com status, hashes, timestamps, custo e storage keys.
- Lotes são jobs JSON em `output/ai-catalog/jobs/<jobId>.json` com estados de job e itens.
- Atualização da planilha é ação explícita via `/api/xlsx/sync` ou exportação `/api/xlsx/export`; dry-run via `/api/xlsx/sync-preview`.
- Nunca escrever na planilha automaticamente; sempre fazer backup antes.
- Docker e `.env.example` para futura publicação; sem deploy agora.

### Contratos principais

#### `StorageProvider`
```js
{
  async save(key, buffer, { contentType }),
  async exists(key),
  async getPublicUrl(key),
  async delete(key),
  async healthCheck()
}
```
Para local, `key = "<slug>/<tipo>"` e URL pública `"/api/files/<encodedKey>"`.

#### `courseFiles(slug)`
Retorna `{ slug, fundo: "<slug>-fundo.png", card: "<slug>-card.png", whatsapp: "<slug>-whatsapp.jpg" }`.

#### `metadata.json` por curso
```json
{
  "course_id": "...",
  "slug": "...",
  "curso": "...",
  "template_id": "cruzeiro-graduacao-v1",
  "prompt": "...",
  "model": "gpt-image-2.5-flare",
  "quality": "medium",
  "size": "1024x1024",
  "cost_usd": 0,
  "background_origin": "original | ia | upload",
  "files": { "fundo": "...", "card": "...", "whatsapp": "..." },
  "storage": { "provider": "local", "keys": { "fundo": "...", "card": "...", "whatsapp": "..." } },
  "urls": { "fundo": "...", "card": "...", "whatsapp": "..." },
  "hashes": { "fundo": "sha256", "card": "...", "whatsapp": "..." },
  "status": "pendente | gerando_fundo | fundo_gerado | renderizando_card | gerando_whatsapp | pronto_revisao | aprovado | rejeitado | erro | cancelado",
  "timestamps": { "generated_at": ..., "rendered_at": ..., "whatsapp_at": ..., "approved_at": ..., "rejected_at": ... },
  "error": null,
  "attempts": 0
}
```

#### Job de lote
```json
{
  "id": "job-<timestamp>-<random>",
  "status": "criado | executando | pausado | concluido | concluido_com_erros | cancelado | bloqueado",
  "template_id": "cruzeiro-graduacao-v1",
  "background_source": "original | upload | ia",
  "batch_size": 1,
  "concurrency": 1,
  "max_calls": null,
  "max_cost_usd": null,
  "model": "...",
  "quality": "...",
  "size": "...",
  "courses": [ { "course_id", "slug", "status", "error", "attempts", "cost_usd" } ],
  "stats": { "total", "completed", "errors", "approved", "rejected", "calls", "cost_usd" },
  "created_at": "...",
  "started_at": null,
  "completed_at": null,
  "error": null
}
```

#### Endpoints de API
- `GET /api/health`
- Lotes:
  - `GET /api/batches`
  - `POST /api/batches` (criar)
  - `GET /api/batches/:id`
  - `POST /api/batches/:id/start`
  - `POST /api/batches/:id/pause`
  - `POST /api/batches/:id/resume`
  - `POST /api/batches/:id/cancel`
  - `POST /api/batches/:id/retry-errors`
  - `POST /api/batches/:id/retry-rejected`
  - `GET /api/batches/:id/items`
- Cursos (já existentes) + `POST /api/courses/:slug/whatsapp`
- Arquivos:
  - `GET /api/catalog/:slug/:file`
  - `GET /api/files/:encodedKey`
- XLSX:
  - `POST /api/xlsx/sync-preview` (dry-run)
  - `POST /api/xlsx/sync`
  - `POST /api/xlsx/export`

### Alternativas descartadas
- Nomear arquivos com sufixos `-fundo-ia` e `-card-ia`: descartado para manter padrão único e limpo.
- Escrever na planilha automaticamente ao concluir cada imagem: descartado por segurança; optou-se por ação explícita.
- Implementar S3/Supabase agora: descartado; contratos preparados para futura integração.

### Impacto
- Novos módulos em `src/batch/` e `src/storage/`.
- Novas rotas em `src/template-editor/api.js`.
- Novas telas/seções no painel de cursos.
- Novos scripts de teste.
- `server.js` usa `HOST` e `PORT` configuráveis.
- Dockerfile e `.env.example` adicionados.

## 2026-09-20 — Generalização para coleções configuráveis

### Contexto
Transformar o sistema de produção de artes de um fluxo fixo de cursos de graduação em uma plataforma genérica baseada em coleções versionadas (cursos, produtos, posts etc.), preservando a coleção legada e sem duplicar renderizador.

### Decisão
- Coleção é a unidade central: `data/collections/<id>.json` define fonte de dados (XLSX/CSV/JSON), mapeamento de campos, filtros, templates permitidos, filename pattern e colunas de saída.
- Coleção padrão versionada: `data/collections/graduacao-cruzeiro.json` mantém o fluxo legado intacto e não é recriada automaticamente.
- DataSources desacoplados: `src/data-sources/{xlsx,csv,json}-data-source.js` normalizam registros para `{ id, title, slug, fields, prompt, sourceImage, sourceStatus }`.
- `src/production/generic-production-service.js` implementa operações genéricas e delega à API legada (`course-production-service`) quando `collectionId === "graduacao-cruzeiro"`.
- `src/batch/executor.js` carrega um provider por coleção: para a coleção legada usa `loadAllCourses`/`renderCourseCard`; para outras coleções usa DataSource + `renderTemplate`.
- Arquivos de saída por coleção: legado continua em `output/ai-catalog/`; novas coleções usam `output/ai-catalog/<collectionId>/`.
- Segurança de arquivos: imports enviados vão para `data/imports/<collection-id>/`; path traversal bloqueado; API nunca aceita caminho absoluto do navegador.
- Identidade genérica: telas genéricas não mencionam curso/modalidade/Cruzeiro; termos legados ficam apenas na configuração da coleção padrão.
- Templates continuam usando o schema/renderizador genérico já existente; o template legado `cruzeiro-graduacao-v1` é tratado como caso especial fora do renderer genérico.
- S3/Supabase continuam apenas como interfaces/documentação; `LocalStorageProvider` é a única implementação ativa.

### Alternativas descartadas
- Migrar o template Cruzeiro para JSON e usar `renderTemplate`: descartado porque o template aprovado é complexo e a migração introduziria risco visual; mantido como renderizador legado delegado.
- Deletar `course-production-service.js` nesta etapa: descartado para preservar paridade funcional; remoção exigirá comprovação completa.
- Criar um banco/SaaS para coleções: descartado; arquivos JSON versionados atendem à necessidade atual.

### Impacto
- Novos módulos: `src/collections/`, `src/data-sources/`, `src/production/generic-production-service.js`.
- Coleção padrão versionada: `data/collections/graduacao-cruzeiro.json`.
- Novas rotas: `/api/collections/*`, `/api/items*`, endpoints genéricos de batch/export/sync por coleção.
- Telas: `collections.html` para listar/importar coleções; navegação atualizada em todas as páginas; `batch.html` com seletor de coleção/template.
- Testes: `scripts/test-generic-collections.js` cobre graduação legada, CSV, JSON e XLSX.

## 2026-09-20 — FASE 1 e FASE 5 (parcial): Docker, runtime e status do sistema

### Contexto
Preparar o MVP para deploy containerizado com volume persistente e expor, de forma segura, o estado do sistema no frontend.

### Decisão
- Dockerfile baseado em `node:20-slim` com libvips, usuário não-root `app`, `APP_RUNTIME_DIR=/app/data`, volume `/app/data`, `HOST=0.0.0.0` e `CMD npm run template:editor`.
- `.dockerignore` exclui node_modules, .env, outputs finais/whatsapp, .git, zips, caches e tmp.
- `docker-compose.example.yml` mapeia PORT, volume `app_data:/app/data` e variáveis de exemplo.
- Criado `src/config/seed.js` para inicializar runtime e fazer fallback do diretório legado `data/collections`.
- `src/collections/manager.js` mantido usando `RUNTIME.collectionsDir` (já compatível).
- Criado `src/template-editor/system-status.js` com `getSystemStatus()`; rota `/api/health` em `api.js` agora retorna openaiConfigured, storageProvider, authActive e runtimeDirAvailable sem expor segredos.
- Bloco "Status do sistema" adicionado em `index.html`, carregado por `home.js`; helper `loadSystemStatus()`/`isOpenAIConfigured()` adicionado a `shared.js`.
- Botões de geração real desabilitados em `batch.js` e `cursos.js` quando `openaiConfigured === false`.
- Criado `DEPLOY.md` com instruções de local, Docker, Easypanel, volume, OpenAI, storage, backup e atualização.
- `.env.example` atualizado com PORT, HOST, APP_RUNTIME_DIR, APP_ACCESS_PASSWORD, APP_SESSION_SECRET, AUTH_DISABLED, OPENAI_API_KEY, STORAGE_PROVIDER e variáveis S3/Supabase reservadas.
- `src/template-editor/server.js` não foi modificado; anotação de integração entregue para inserção manual de `seedRuntimeDefaults()` no início do servidor.

### Alternativas descartadas
- Alterar `server.js` automaticamente: descartado por requisito explícito de deixar anotação ao coordenador.
- Criar um endpoint `/api/config` com flags: descartado; `/api/health` já atende e é o padrão esperado para health checks.
- Implementar provedores S3/Supabase agora: descartado; interface `StorageProvider` existe e as variáveis ficam reservadas para FASE 5 completa.

### Impacto
- Arquivos criados: `.dockerignore`, `docker-compose.example.yml`, `src/config/seed.js`, `src/template-editor/system-status.js`, `DEPLOY.md`.
- Arquivos alterados: `Dockerfile`, `.env.example`, `src/template-editor/api.js`, `src/template-editor/public/index.html`, `src/template-editor/public/home.css`, `src/template-editor/public/home.js`, `src/template-editor/public/shared.js`, `src/template-editor/public/batch.js`, `src/template-editor/public/cursos.js`.
- Nenhuma dependência nova adicionada.

## 2026-09-21 — Importação de fundos piloto de IA para o fluxo oficial

### Contexto
Incorporar ao fluxo oficial três fundos gerados pelo piloto de IA (Cibersegurança, Gestão Pública, Nutrição), reutilizando os dados oficiais da planilha/coleção e sem fazer novas chamadas à OpenAI.

### Decisão
- Criar `scripts/import-ai-pilot.js` como operação reutilizável e idempotente.
- Usar `APP_RUNTIME_DIR` via `src/config/runtime.js` e `StorageProvider` (`LocalStorageProvider`) para salvar fundo, card e WhatsApp.
- Preservar hash sha256 do fundo piloto: importar buffer original sem re-encode, comparar com versão existente e não sobrescrever se houver hash diferente.
- Renderizar card pelo renderer legado `src/render-card.js` através do adaptador oficial `src/production/generic-production-service.js` (`renderItem`), gerando WhatsApp via `convertCardToWhatsAppJpeg`.
- Registrar background, card e WhatsApp em `metadata.json` por curso e criar um único lote oficial nomeado "Piloto oficial — fundos IA existentes" com itens em `pronto_revisao`.
- Não aprovar automaticamente; não alterar `input/cursos.xlsx`, `output/final`, `output/whatsapp`, `output/ai-pilot`, `src/render-card.js` nem apagar lotes existentes.
- Adicionar `scripts/test-import-ai-pilot.js` para validar via API que o lote aparece, itens estão prontos para revisão e as imagens são servidas corretamente.

### Alternativas descartadas
- Usar `BatchExecutor` para processar o lote: descartado porque o executor espera gerar fundos (OpenAI/original/mock) e não aceita importação de arquivos existentes; optou-se por construir o job já concluído a partir dos arquivos reais.
- Sobrescrever versões existentes sem verificação de hash: descartado para preservar integridade; conflito de hash gera erro.
- Copiar arquivos com caminhos absolutos do Windows: descartado; todos os caminhos são relativos via `path.join` e `ROOT`.

### Impacto
- Novos arquivos: `scripts/import-ai-pilot.js`, `scripts/test-import-ai-pilot.js`.
- Arquivos gerados localmente (gitignored em `output/ai-catalog/`): fundos, cards, WhatsApp, metadata.json e job JSON.
- Nenhuma alteração em arquivos fonte existentes; nenhuma dependência nova.
