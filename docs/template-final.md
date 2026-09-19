# Template Final de Cards de Cursos

**Status:** APROVADO EM 17/09/2026  
**Resolução:** 1080 x 1080 px  
**Uso:** Cards quadrados para divulgação de cursos no WhatsApp e redes sociais.

---

## 1. Composição visual (ordem de camadas)

1. **Foto do curso** — fundo, preenchimento `cover` com foco no assunto principal (`position: attention`).
2. **`assets/gradiente-template.png`** — overlay fixo de gradiente escuro.
3. **`assets/moldura-template.png`** — moldura decorativa fixa em azul claro.
4. **Texto dinâmico (SVG)** — título do curso + linha de informações.
5. **`assets/logo-cruzeiro-branco.png`** — logo institucional fixo.

---

## 2. Assets fixos

| Elemento | Arquivo | Tratamento |
|----------|---------|------------|
| Gradiente | `assets/gradiente-template.png` | Redimensionado para 1080x1080, sem recorte diferente |
| Moldura | `assets/moldura-template.png` | Redimensionado para 1080x1080 |
| Logo | `assets/logo-cruzeiro-branco.png` | `trim()` antes de redimensionar para 275 px de largura |

---

## 3. Configuração do template (centralizada em `src/generate.js`)

Todas as constantes visuais estão no objeto `TEMPLATE` em `src/generate.js`, marcado com:

```js
// TEMPLATE VISUAL FINAL APROVADO - NÃO ALTERAR SEM SOLICITAÇÃO EXPLÍCITA
```

### Canvas

- `width`: 1080
- `height`: 1080

### Logo

- `width`: 275 px
- `left`: 90 px
- `top`: 561 px
- `trim`: true

### Título

- `x`: 85 px
- `y`: 728 px
- Fonte: `Inter, Arial, Helvetica, sans-serif`
- Peso: 800
- Cor: `#ffffff`
- `letterSpacing`: -1.2
- `lineHeight`: 1.0
- Largura máxima do bloco: 620 px
- Máximo de linhas: 2 (excepcionalmente 3)

### Tamanhos do título por comprimento

| Caracteres | Tamanho (px) |
|------------|--------------|
| até 16     | 78           |
| 17–24      | 70           |
| 25–34      | 62           |
| 35–48      | 56           |
| acima de 48| 50           |

### Linha de informações

- Posição: 44 px abaixo do final do título
- Fonte: `Inter, Arial, Helvetica, sans-serif`
- Tamanho: 34 px
- Peso: 700
- Cor: `#6EA0FF`
- `letterSpacing`: 0.5
- Separador: ` | `
- Ordem obrigatória: **Modalidade | Formação | Duração**

Exemplo:

```text
EAD | Bacharelado | 8 semestres
```

A duração é normalizada para minúsculas (`semestres`, `anos`, etc.).

### Foto

- Resize: 1080x1080
- `fit`: cover
- `position`: attention
- `brightness`: 0.98
- `saturation`: 0.98

---

## 4. Regras de quebra de título

A função `wrapTitle` distribui as palavras de forma equilibrada, priorizando 2 linhas.

Objetivos:
- evitar linha final muito curta;
- evitar uma única palavra solta na última linha;
- respeitar a largura máxima do bloco de 620 px;
- funcionar bem para nomes como:
  - Design de Interiores
  - Arquitetura e Urbanismo
  - Ciências Biológicas
  - Engenharia de Produção

---

## 5. Elementos dinâmicos vs fixos

### Dinâmicos (vêm da planilha por curso)

- Foto do curso (`imageUrl`)
- Nome do curso (`curso`)
- Modalidade (`modalidade`)
- Formação (`formacao`)
- Duração (`duracao`)

### Fixos (template aprovado)

- Gradiente (`gradiente-template.png`)
- Moldura (`moldura-template.png`)
- Logo (`logo-cruzeiro-branco.png`)
- Tipografia, cores, pesos e espaçamentos
- Composição e ordem de camadas
- Tratamento da foto

---

## 6. Pasta de referência visual

Os PNGs aprovados dos 3 cursos de teste estão copiados em:

```
assets/reference-final/
```

Use esses arquivos como referência visual para detectar regressões futuras.

---

## 7. Arquivos alterados na consolidação

- `src/generate.js` — constantes centralizadas no objeto `TEMPLATE`
- `docs/template-final.md` — este documento
- `assets/reference-final/` — cópia dos cards aprovados

---

## 8. Notas

- Não alterar valores do objeto `TEMPLATE` sem solicitação explícita.
- Não recriar gradiente, moldura, logo ou tipografia via SVG/CSS/código.
- A saída visual deve permanecer pixelmente equivalente aos cards aprovados em `assets/reference-final/`.
