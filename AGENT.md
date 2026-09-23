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

## 2026-09-21 — Correção da persistência e organização da revisão de lotes

### Contexto
Aprovação/rejeição de um item aberto a partir de um lote não refletia ao voltar para a tela do lote. A causa era o uso da rota individual `/api/courses/:slug/approve`, que sincronizava o status para todos os jobs contendo o mesmo curso de forma assíncrona e não atualizava o job específico de forma confiável.

### Decisão
- Remover o `syncJobItemStatus` global de `course-production-service.js`: aprovação/rejeição individual não deve mais atualizar automaticamente todos os lotes que contenham o mesmo curso.
- Manter `syncMetadataStatus` para atualizar `metadata.json` em aprovações/rejeições individuais fora de lote.
- Tela individual (`cursos.html`/`cursos.js`) passa a ler `job` da query string. Com `jobId`, usa os endpoints do lote (`/api/batches/:jobId/items/:slug/approve|reject`) e mostra botão "Voltar para revisão do lote". Sem `jobId`, mostra aviso claro de que a aprovação é individual.
- Tela de lote (`batch.html`/`batch.js`) adiciona link "Revisar" por item, filtro de status, resumo com "Aguardando revisão/Aprovados/Rejeitados/Erros" e recarrega o job com `returnToReview=1` ao retornar da revisão individual.
- Home (`index.html`/`home.js`) mostra "Aguardando revisão" no resumo e quantidade pendente por produção recente.
- Endpoints de estado dos lotes (`/api/batches`, `/api/batches/:id`, `/api/batches/:id/items`) retornam `Cache-Control: no-store` para evitar cache do navegador.
- Adicionar `scripts/test-batch-review-persistence.js` validando isolamento por lote, persistência em metadata/manifest, recálculo de estatísticas e cache desabilitado.

### Alternativas descartadas
- Manter `syncJobItemStatus` e apenas melhorar await: descartado porque viola o requisito de não atualizar todos os lotes automaticamente.
- Resolver apenas no frontend com cache-busting: descartado; a causa real era o endpoint/rota errada e a sincronização global.

### Impacto
- Arquivos alterados: `src/course-production-service.js`, `src/template-editor/api.js`, `src/template-editor/public/{batch.*,cursos.*,home.js,index.html}`.
- Arquivos novos: `scripts/test-batch-review-persistence.js`.
- Importação do piloto foi reexecutada para restaurar fundos que haviam sido sobrescritos (motivo externo não identificado); estado final dos três cursos restabelecido com hashes idênticos ao piloto.

## 2026-09-22 — Histórico persistente de peças finalizadas

### Contexto
As peças geradas individualmente em "Criar imagem" eram baixadas no navegador sem registro no servidor; a Biblioteca só listava assets, templates e bases. A produção em lote já persistia cards aprovados via manifest/approvedVisual, mas sem uma galeria unificada. Era necessário separar assets de criação de peças finalizadas, garantir imutabilidade e permitir busca, filtros, paginação e ações (visualizar, baixar, duplicar, excluir).

### Decisão
- Criar `src/finished-pieces/finished-pieces-service.js` como serviço dedicado, reutilizando `StorageProvider` e o diretório de catálogo (`output/ai-catalog/finished`).
- Cada peça finalizada recebe ID único (`fp-{timestamp}-{hash}`), armazena uma cópia imutável do PNG sob a chave `finished/{id}.png` e um registro em `finished/index.json`.
- O registro contém: id, título, template, data, origem (`criar`, `batch`, `migration`), base/item de origem, valores dos campos, referências dos assets e dimensões. Não armazena imagens em base64.
- Novos endpoints em `src/template-editor/api.js`: `POST /api/finished-pieces`, `GET /api/finished-pieces`, `GET /api/finished-pieces/:id`, `DELETE /api/finished-pieces/:id`, `POST /api/finished-pieces/:id/duplicate`, `POST /api/finished-pieces/migrate`.
- Botão "Finalizar e salvar" em `criar.html`/`criar.js`; a duplicação abre `criar.html?duplicate=ID` preenchendo template e valores.
- Nova aba "Peças finalizadas" como primeira aba da Biblioteca, com busca, filtros (template, origem, período), ordenação e paginação.
- Integração na aprovação de lotes (`generic-production-service.js#approveItem`): cria registro de peça `source: "batch"` a partir do `approvedVisual`, copiando o card aprovado para `finished/`, preservando o manifesto original.
- Migração idempotente dos manifestos de lote existentes via `/api/finished-pieces/migrate`; ignora itens sem card, não importa fotos/backgrounds isolados e não apaga arquivos antigos.
- Exclusão de peça remove apenas a cópia final e o registro; assets compartilhados e manifestos permanecem intactos.
- Renderizadores da DNA Work e Cruzeiro, geração OpenAI e fluxo de aprovação de fotografias não foram alterados.

### Alternativas descartadas
- Criar um banco de dados separado ou novo sistema de armazenamento: descartado; reaproveitou-se `StorageProvider` e `output/ai-catalog` já usados pela produção em lote.
- Referenciar diretamente os cards aprovados do lote sem copiar: descartado, pois reexecuções futuras do mesmo slug poderiam sobrescrever o arquivo e quebrar a imutabilidade do histórico.
- Migrar arquivos soltos de `output/final/` e `output/whatsapp/`: descartado por falta de metadados verificáveis; migrou-se apenas manifestos de lote.

### Impacto
- Arquivos novos: `src/finished-pieces/finished-pieces-service.js`, `src/finished-pieces/index.js`, `scripts/test-finished-pieces-stage1.js`, `scripts/test-finished-pieces-stage2.js`.
- Arquivos alterados: `src/template-editor/api.js`, `src/template-editor/public/criar.html`, `src/template-editor/public/criar.js`, `src/template-editor/public/biblioteca.html`, `src/template-editor/public/biblioteca.js`, `src/production/generic-production-service.js`, `AGENT.md`.
- Testes: `scripts/test-finished-pieces-stage1.js` e `scripts/test-finished-pieces-stage2.js` passam; `scripts/test-dna-work-template.js` continua passando.

## 2026-09-23 — Persistência das coleções no PostgreSQL

### Contexto
As coleções e os registros viviam em JSON e planilhas no volume persistente. A conexão com o banco `bwipoart` já existia, mas não podia passar a ser a fonte só porque `DATABASE_URL` estava definida.

### Decisão
- Tabelas únicas `collections` e `collection_records`, com campos dinâmicos em JSONB e a chave `(collection_id, item_id)` usando os IDs já existentes.
- `DATA_SOURCE=files` permanece o padrão. `DATA_SOURCE=postgres` lê e grava coleções e registros no PostgreSQL, sem fallback para arquivo quando o banco falha e sem dual-write.
- Migrations e importação são comandos explícitos. A importação é idempotente e, por padrão, não sobrescreve linha já existente (`--on-conflict=skip`).
- A planilha de origem não é apagada nem substituída. A exportação gera um arquivo novo.

### Alternativas descartadas
- Uma tabela por curso ou planilha: descartada porque as bases têm campos diferentes e os IDs precisam continuar estáveis.
- Gravar no PostgreSQL sempre que `DATABASE_URL` existir: descartado para não misturar arquivo e banco antes da migração ser validada.

### Impacto
- Arquivos novos: `migrations/001_collections_and_records.sql`, `src/db/collections-repository.js`, `src/db/migrate.js`, `src/db/import-collections.js`, `src/collections/store.js`, `scripts/apply-db-migrations.js`, `scripts/migrate-collections-to-postgres.js`.
- As telas passam a consultar o PostgreSQL somente com `DATA_SOURCE=postgres`. Renderizadores, peças finalizadas e publicação de imagens não mudam de formato.
