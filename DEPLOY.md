# Deploy do MVP

Guia curto para rodar local, publicar em container e manter dados entre atualizações.

## Rodar local

```bash
cp .env.example .env
# edite .env com suas variáveis
npm ci
npm run template:editor
```

Acesse `http://127.0.0.1:3000`.

## Build Docker

```bash
docker build -t produtos-app .
```

## Publicar no Easypanel

1. Envie o repositório para um registry privado ou conecte o Git no Easypanel.
2. Defina o **Dockerfile** como `Dockerfile` na raiz.
3. Crie um volume persistente e monte em `/app/data`.
4. Configure as variáveis de ambiente abaixo.
5. Exponha a porta configurada em `PORT` (padrão `3000`).

## Configurar volume

O container espera um volume em `/app/data`. Todos os dados de runtime (coleções, templates, assets, catálogo e exports) são gravados lá. Sem volume, os dados somem ao recriar o container.

Exemplo com Docker Compose:

```bash
cp docker-compose.example.yml docker-compose.yml
# ajuste as variáveis no .env ou diretamente no compose
docker compose up -d
```

## Configurar OpenAI

Preencha no `.env` ou no painel do Easypanel:

```env
OPENAI_API_KEY=sk-...
```

Se a chave estiver ausente ou for um placeholder (`sk-...`), a geração real de imagens será desabilitada no frontend e o status do sistema exibirá aviso.

## Configurar storage

### Local (padrão)

```env
STORAGE_PROVIDER=local
STORAGE_LOCAL_DIR=/app/data/output/ai-catalog
```

Os arquivos ficam no volume persistente. Nenhuma dependência extra.

### S3 / R2 / Supabase Storage via S3 compatível

```env
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://s3.amazonaws.com
S3_REGION=us-east-1
S3_BUCKET=meu-bucket
S3_PREFIX=produtos/
S3_PUBLIC_BASE_URL=https://meu-bucket.s3.amazonaws.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false
```

> Compatível com AWS S3, Cloudflare R2 e Supabase Storage via endpoint S3 compatível. Credenciais nunca são expostas no frontend, logs, metadata ou respostas da API.

## Backup do volume

Faça backup periódico do diretório `/app/data`. Com Docker Compose:

```bash
docker compose cp app:/app/data ./backup-$(date +%Y%m%d)
```

Ou compacte diretamente o volume `app_data`.

## Atualizar versão sem perder dados

1. Faça backup do volume.
2. Faça pull/build da nova imagem.
3. Recrie o container mantendo o mesmo volume `app_data`.

```bash
docker compose pull
docker compose up -d
```

Os dados em `/app/data` permanecem intactos porque estão fora da imagem.

## Autenticação

Opcional. Para exigir senha de acesso:

```env
APP_ACCESS_PASSWORD=senha-forte
APP_SESSION_SECRET=um-segredo-longo-e-aleatorio
AUTH_DISABLED=false
```

Em desenvolvimento, se `APP_ACCESS_PASSWORD` não for definida ou `AUTH_DISABLED=true`, o acesso fica aberto. Em produção (`NODE_ENV=production`) o servidor recusa inicializar sem `APP_ACCESS_PASSWORD` e `APP_SESSION_SECRET`.
