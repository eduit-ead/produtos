/**
 * Esquema central dos campos de conteúdo visual e editorial.
 *
 * Este arquivo define:
 * - as colunas de conteúdo autorizadas na planilha;
 * - as regras de validação de cada campo;
 * - o formato do JSON de lote;
 * - mensagens de erro padronizadas.
 */

const CONTENT_COLUMNS = [
  "descricao_curta",
  "visual_tema",
  "visual_personagem",
  "visual_ambiente",
  "visual_objetos",
  "visual_atividade",
  "visual_composicao",
  "visual_evitar",
  "prompt_imagem",
  "conteudo_status",
];

const OUTPUT_FIELDS = [
  "course_id",
  "descricao_curta",
  "visual_tema",
  "visual_personagem",
  "visual_ambiente",
  "visual_objetos",
  "visual_atividade",
  "visual_composicao",
  "visual_evitar",
  "prompt_imagem",
  "conteudo_status",
];

const SOURCE_FIELDS = [
  "course_id",
  "Curso",
  "Formação",
  "Modalidade",
  "Duração",
  "Classificação",
  "Descrição",
  "Mercado de Trabalho",
  "area de atuação",
];

const VALIDATION = {
  descricao_curta: {
    minLength: 100,
    maxLength: 160,
  },
  visual_tema: {
    maxLength: 200,
  },
  visual_personagem: {
    maxLength: 400,
  },
  visual_ambiente: {
    maxLength: 300,
  },
  visual_objetos: {
    maxLength: 300,
  },
  visual_atividade: {
    maxLength: 300,
  },
  visual_composicao: {
    maxLength: 600,
  },
  visual_evitar: {
    maxLength: 600,
  },
  prompt_imagem: {
    maxLength: 2000,
  },
  conteudo_status: {
    allowed: ["rascunho", "aprovado", "rejeitado"],
    default: "rascunho",
  },
};

const FORBIDDEN_PROMPT_TERMS = [
  "logo",
  "logotipo",
  "marca",
  "brand",
  "texto",
  "textos",
  "título",
  "titulo",
  "nome do curso",
  "preço",
  "preco",
  "moldura",
  "frame",
  "gradiente",
  "card completo",
  "cartão completo",
  "cruzeiro do sul",
  "universidade",
];

// Única exceção para "marca": a expressão de restrição "marca-d'água".
// A palavra isolada "marca" continua proibida em qualquer outro contexto.
const WATERMARK_PATTERN = /marca[\s-]*d[''`´’][aá]gua/gi;

function findForbiddenPromptTerms(prompt) {
  const lower = prompt.toLowerCase();
  const withoutWatermark = lower.replace(WATERMARK_PATTERN, "");

  return FORBIDDEN_PROMPT_TERMS.filter((term) => {
    const haystack = term === "marca" ? withoutWatermark : lower;
    return haystack.includes(term.toLowerCase());
  });
}

function createEmptyRecord(courseId = "") {
  return {
    course_id: courseId,
    descricao_curta: "",
    visual_tema: "",
    visual_personagem: "",
    visual_ambiente: "",
    visual_objetos: "",
    visual_atividade: "",
    visual_composicao: "",
    visual_evitar: "",
    prompt_imagem: "",
    conteudo_status: VALIDATION.conteudo_status.default,
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRecord(record, options = {}) {
  const errors = [];

  if (!record || typeof record !== "object") {
    return ["Registro inválido."];
  }

  if (!isNonEmptyString(record.course_id)) {
    errors.push("course_id é obrigatório.");
  }

  for (const field of OUTPUT_FIELDS) {
    if (field === "course_id") continue;

    if (!(field in record)) {
      errors.push(`Campo obrigatório ausente: ${field}.`);
      continue;
    }

    const value = record[field];

    if (field === "conteudo_status") {
      if (!VALIDATION.conteudo_status.allowed.includes(value)) {
        errors.push(
          `conteudo_status deve ser um dos valores: ${VALIDATION.conteudo_status.allowed.join(
            ", "
          )}.`
        );
      }
      continue;
    }

    if (!isNonEmptyString(value)) {
      errors.push(`Campo ${field} não pode estar vazio.`);
      continue;
    }

    const trimmed = value.trim();

    if (VALIDATION[field]) {
      if (VALIDATION[field].minLength && trimmed.length < VALIDATION[field].minLength) {
        errors.push(
          `${field} deve ter no mínimo ${VALIDATION[field].minLength} caracteres (atual: ${trimmed.length}).`
        );
      }
      if (VALIDATION[field].maxLength && trimmed.length > VALIDATION[field].maxLength) {
        errors.push(
          `${field} deve ter no máximo ${VALIDATION[field].maxLength} caracteres (atual: ${trimmed.length}).`
        );
      }
    }
  }

  // Validações específicas
  if (isNonEmptyString(record.descricao_curta)) {
    const desc = record.descricao_curta.trim();
    if (desc.includes("  ")) {
      errors.push("descricao_curta não deve conter espaços duplos.");
    }
  }

  if (isNonEmptyString(record.prompt_imagem)) {
    const found = findForbiddenPromptTerms(record.prompt_imagem);
    if (found.length > 0) {
      errors.push(
        `prompt_imagem contém termos não permitidos: ${found.join(", ")}.`
      );
    }
  }

  if (isNonEmptyString(record.visual_composicao)) {
    const comp = record.visual_composicao.toLowerCase();
    if (!comp.includes("inferior esquerda") && !comp.includes("esquerda inferior")) {
      errors.push(
        "visual_composicao deve reservar a região inferior esquerda para logo e texto."
      );
    }
  }

  if (options.requireRascunho && record.conteudo_status !== "rascunho") {
    errors.push("conteudo_status deve ser 'rascunho' nesta etapa.");
  }

  return errors;
}

function validateBatch(records, courseIdsInBatch = [], options = {}) {
  const errors = [];
  const seenIds = new Set();

  if (!Array.isArray(records)) {
    return ["O lote deve ser um array de registros."];
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const recordErrors = validateRecord(record, options);

    if (recordErrors.length > 0) {
      errors.push(`Registro ${i + 1} (${record.course_id || "sem id"}):`);
      for (const err of recordErrors) {
        errors.push(`  - ${err}`);
      }
    }

    if (record.course_id) {
      if (seenIds.has(record.course_id)) {
        errors.push(`course_id duplicado no lote: ${record.course_id}`);
      }
      seenIds.add(record.course_id);

      if (courseIdsInBatch.length > 0 && !courseIdsInBatch.includes(record.course_id)) {
        errors.push(
          `course_id ${record.course_id} não pertence a este lote.`
        );
      }
    }
  }

  return errors;
}

module.exports = {
  CONTENT_COLUMNS,
  OUTPUT_FIELDS,
  SOURCE_FIELDS,
  VALIDATION,
  FORBIDDEN_PROMPT_TERMS,
  findForbiddenPromptTerms,
  createEmptyRecord,
  validateRecord,
  validateBatch,
};
