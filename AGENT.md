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
