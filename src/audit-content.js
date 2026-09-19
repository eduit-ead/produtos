/**
 * Auditoria somente leitura de lotes de conteúdo de cursos.
 *
 * Comando:
 *   node src/audit-content.js --file=output/content/batch-001-output.json
 *
 * Não altera a planilha, não importa conteúdo e não exporta novos lotes.
 */

const fs = require("fs");
const path = require("path");
const { validateBatch, validateRecord, FORBIDDEN_PROMPT_TERMS } = require("./content-schema");

const ROOT = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(ROOT, "output", "content");

// =============================================================================
// CONSTANTES DE CONFIGURAÇÃO
// =============================================================================

const LIMITS = {
  descricaoMinLength: 100,
  descricaoMaxLength: 160,
  maxDescricaoSimilarityPairs: 5,
  maxVisualSimilarityPairs: 5,
  similarityThresholdDescricao: 0.25,     // aviso se similaridade >= este valor
  visualIndividualWarning: 0.60,            // aviso de colisão visual em campo individual
  visualIndividualError: 0.80,            // erro de colisão visual em campo individual
  visualSignatureWarning: 0.55,           // aviso de colisão na assinatura visual combinada
  visualSignatureError: 0.75,             // erro de colisão na assinatura visual combinada
  repetitionThresholdTema: 1,               // aviso se tema aparece > este número
  repetitionThresholdAmbiente: 1,         // aviso se ambiente aparece > este número
  repetitionThresholdAtividade: 1,          // aviso se atividade aparece > este número
  minCoerenciaMatches: 2,                   // mínimo de atributos visuais presentes no prompt
  forbiddenContextPositive: true,           // proibir termos proibidos em contexto positivo
};

const STOPWORDS = new Set([
  "a", "ao", "aos", "as", "com", "da", "das", "de", "do", "dos", "e", "em", "na", "nas",
  "no", "nos", "o", "os", "ou", "para", "por", "sem", "um", "uma", "que", "se", "em",
  "como", "mais", "mas", "sua", "seu", "nos", "nas", "entre", "sobre", "pelo", "pela",
  "durante", "após", "antes", "até", "desde", "entre", "sob", "tras", "trás", "ante",
  "conforme", "segundo", "durante", "mediante", "exceto", "salvo", "tal", "toda",
  "todo", "todos", "todas", "este", "esta", "estes", "estas", "esse", "essa", "esses",
  "essas", "aquele", "aquela", "aqueles", "aquelas", "isto", "isso", "aquilo",
]);

// Termos genéricicos que, sozinhos, não caracterizam colisão visual entre cursos.
const VISUAL_NOISE_TERMS = new Set([
  "brasileiro", "brasileira", "brasil",
  "contemporaneo", "contemporanea",
  "personagem",
  "cerca",
  "anos",
  "natural",
  "organizado", "organizada",
  "profissional",
  "ambiente",
  "expressao",
]);

const COMMON_OPENERS = ["aprenda", "desenvolva", "prepare-se", "aprofunde", "domine", "conheça"];

const GENDER_TERMS = {
  feminine: ["mulher", "feminina", "feminino", "mulheres", "garota", "jovem mulher", "profissional brasileira"],
  masculine: ["homem", "masculino", "masculina", "homens", "garoto", "jovem homem", "profissional brasileiro"],
  neutral: ["pessoa", "estudante", "profissional", "equipe", "grupo"],
};

const AGE_TERMS = ["cerca de", "aproximadamente", "anos", "idade"];

// =============================================================================
// UTILITÁRIOS
// =============================================================================

function normalizeText(text) {
  if (!text) return "";
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  const normalized = normalizeText(text);
  return normalized
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !VISUAL_NOISE_TERMS.has(t));
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function jaccardSimilarity(a, b) {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

function cosineSimilarity(a, b) {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const vocab = new Set([...tokensA, ...tokensB]);
  const freq = (tokens) => {
    const map = {};
    for (const t of tokens) map[t] = (map[t] || 0) + 1;
    return map;
  };
  const freqA = freq(tokensA);
  const freqB = freq(tokensB);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const term of vocab) {
    const va = freqA[term] || 0;
    const vb = freqB[term] || 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function similarityScore(a, b) {
  return Math.max(jaccardSimilarity(a, b), cosineSimilarity(a, b));
}

function extractOpener(text) {
  const normalized = normalizeText(text);
  const firstWord = normalized.split(/\s+/)[0];
  return firstWord || "";
}

function findRepeatedOpeners(records) {
  const counts = {};
  for (const r of records) {
    const opener = extractOpener(r.descricao_curta || "");
    if (opener) counts[opener] = (counts[opener] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([word, count]) => COMMON_OPENERS.includes(word) && count > 2)
    .map(([word, count]) => ({ word, count }));
}

function findSimilarPairs(records, field, threshold, maxPairs) {
  const pairs = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i][field] || "";
      const b = records[j][field] || "";
      if (!a || !b) continue;
      const score = similarityScore(a, b);
      if (score >= threshold) {
        pairs.push({
          a: records[i].course_id,
          b: records[j].course_id,
          field,
          score: Number(score.toFixed(3)),
          snippetA: a.slice(0, 80),
          snippetB: b.slice(0, 80),
        });
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score).slice(0, maxPairs);
}

function findRepetitions(records, field) {
  const counts = {};
  for (const r of records) {
    const key = normalizeText(r[field] || "");
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([key, count]) => count > 1)
    .map(([key, count]) => ({ value: key, count }));
}

function findForbiddenTermsAllFields(record) {
  const findings = [];
  const positiveFields = [
    "descricao_curta",
    "visual_tema",
    "visual_personagem",
    "visual_ambiente",
    "visual_objetos",
    "visual_atividade",
    "visual_composicao",
    "prompt_imagem",
  ];

  for (const field of positiveFields) {
    const value = record[field] || "";
    if (!value) continue;
    const lower = value.toLowerCase();
    for (const term of FORBIDDEN_PROMPT_TERMS) {
      // Preserva exceção de marca-d'água em composição/evitar
      if (term === "marca") {
        const withoutWatermark = lower.replace(/marca[\s-]*d[''`´’][aá]gua/gi, "");
        if (withoutWatermark.includes("marca")) {
          findings.push({ field, term });
        }
        continue;
      }
      if (lower.includes(term.toLowerCase())) {
        findings.push({ field, term });
      }
    }
  }
  return findings;
}

function checkCoherence(record) {
  const prompt = normalizeText(record.prompt_imagem || "");
  const attrs = [
    record.visual_tema,
    record.visual_personagem,
    record.visual_ambiente,
    record.visual_objetos,
    record.visual_atividade,
  ];
  let matches = 0;
  const missing = [];
  for (const attr of attrs) {
    if (!attr) continue;
    const tokens = tokenize(attr);
    const hasMatch = tokens.some((t) => prompt.includes(t));
    if (hasMatch) {
      matches += 1;
    } else {
      missing.push(attr.slice(0, 40));
    }
  }
  return { matches, missing, total: attrs.filter(Boolean).length };
}

function checkLowerLeftFree(record) {
  const comp = (record.visual_composicao || "").toLowerCase();
  const prompt = (record.prompt_imagem || "").toLowerCase();
  const inComp = comp.includes("inferior esquerda") || comp.includes("esquerda inferior");
  const inPrompt = prompt.includes("inferior esquerda") || prompt.includes("esquerda inferior");
  return { inComp, inPrompt, ok: inComp || inPrompt };
}

function inferGenderAndAgeStats(records) {
  const stats = { feminine: 0, masculine: 0, neutral: 0, unknown: 0, ageMentions: [] };
  for (const r of records) {
    const text = `${r.visual_personagem || ""} ${r.prompt_imagem || ""}`.toLowerCase();
    let detected = false;
    for (const term of GENDER_TERMS.feminine) {
      if (text.includes(term)) { stats.feminine += 1; detected = true; break; }
    }
    if (!detected) {
      for (const term of GENDER_TERMS.masculine) {
        if (text.includes(term)) { stats.masculine += 1; detected = true; break; }
      }
    }
    if (!detected) {
      for (const term of GENDER_TERMS.neutral) {
        if (text.includes(term)) { stats.neutral += 1; detected = true; break; }
      }
    }
    if (!detected) stats.unknown += 1;

    const ageMatches = text.match(/cerca de (\d{2}) anos|aproximadamente (\d{2}) anos|(\d{2}) anos/);
    if (ageMatches) {
      const age = parseInt(ageMatches[1] || ageMatches[2] || ageMatches[3], 10);
      if (!isNaN(age)) stats.ageMentions.push({ course_id: r.course_id, age });
    }
  }
  return stats;
}

function isEmptyRecord(record) {
  const fields = [
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
  return fields.some((f) => !record[f] || record[f].toString().trim() === "");
}

// =============================================================================
// AUDITORIA
// =============================================================================

function audit(records) {
  const errors = [];
  const warnings = [];
  const infos = [];

  // Estrutura e campos obrigatórios
  if (!Array.isArray(records)) {
    return { ok: false, errors: [{ level: "erro", message: "O arquivo deve conter um array." }] };
  }

  infos.push({ level: "info", message: `Total de registros no lote: ${records.length}.` });

  // Validação via schema
  const schemaErrors = validateBatch(records, [], { requireRascunho: true });
  if (schemaErrors.length > 0) {
    for (const err of schemaErrors) {
      errors.push({ level: "erro", message: err });
    }
  }

  // course_id ausente
  for (const r of records) {
    if (!r.course_id || r.course_id.toString().trim() === "") {
      errors.push({ level: "erro", message: "Registro com course_id ausente." });
    }
  }

  // course_id duplicado
  const idCounts = {};
  for (const r of records) {
    if (!r.course_id) continue;
    idCounts[r.course_id] = (idCounts[r.course_id] || 0) + 1;
  }
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 1) {
      errors.push({ level: "erro", message: `course_id duplicado: "${id}" aparece ${count} vezes.` });
    }
  }

  // Campos vazios
  for (const r of records) {
    if (isEmptyRecord(r)) {
      const emptyFields = [
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
      ].filter((f) => !r[f] || r[f].toString().trim() === "");
      errors.push({
        level: "erro",
        message: `Campos vazios em "${r.course_id}": ${emptyFields.join(", ")}.`,
      });
    }
  }

  // Descrição tamanho e aberturas
  for (const r of records) {
    const desc = (r.descricao_curta || "").trim();
    const len = desc.length;
    if (len > 0 && (len < LIMITS.descricaoMinLength || len > LIMITS.descricaoMaxLength)) {
      warnings.push({
        level: "aviso",
        message: `descricao_curta de "${r.course_id}" tem ${len} caracteres (esperado: ${LIMITS.descricaoMinLength}-${LIMITS.descricaoMaxLength}).`,
      });
    }
  }

  const openers = findRepeatedOpeners(records);
  for (const o of openers) {
    warnings.push({
      level: "aviso",
      message: `Abertura "${o.word}" repetida ${o.count} vezes nas descrições. Variar inícios reduz monotonia.`,
    });
  }

  // Descrições semelhantes
  const similarDescs = findSimilarPairs(
    records,
    "descricao_curta",
    LIMITS.similarityThresholdDescricao,
    LIMITS.maxDescricaoSimilarityPairs
  );
  for (const pair of similarDescs) {
    warnings.push({
      level: "aviso",
      message: `Descrições de "${pair.a}" e "${pair.b}" são similares (score ${pair.score}). Revisar originalidade.`,
    });
  }

  // Repetições de tema, ambiente e atividade
  const temaReps = findRepetitions(records, "visual_tema");
  for (const rep of temaReps) {
    warnings.push({
      level: "aviso",
      message: `Tema "${rep.value}" repetido ${rep.count} vezes no lote.`,
    });
  }

  const ambReps = findRepetitions(records, "visual_ambiente");
  for (const rep of ambReps) {
    warnings.push({
      level: "aviso",
      message: `Ambiente "${rep.value}" repetido ${rep.count} vezes no lote.`,
    });
  }

  const ativReps = findRepetitions(records, "visual_atividade");
  for (const rep of ativReps) {
    warnings.push({
      level: "aviso",
      message: `Atividade "${rep.value}" repetida ${rep.count} vezes no lote.`,
    });
  }

  // Colisões visuais em campos individuais
  const individualVisualPairs = [];
  const visualFields = ["visual_personagem", "visual_ambiente", "visual_objetos", "visual_atividade"];
  for (const field of visualFields) {
    const pairs = findSimilarPairs(records, field, LIMITS.visualIndividualWarning, 100);
    for (const p of pairs) {
      individualVisualPairs.push(p);
      const level = p.score >= LIMITS.visualIndividualError ? "erro" : "aviso";
      const msg = `Colisão visual ${level === "erro" ? "forte" : "moderada"} entre "${p.a}" e "${p.b}" no campo ${p.field} (score ${p.score}).`;
      if (level === "erro") {
        errors.push({ level, message: msg });
      } else {
        warnings.push({ level, message: msg });
      }
    }
  }

  // Colisão na assinatura visual combinada
  function visualSignature(record) {
    return [record.visual_tema, record.visual_ambiente, record.visual_objetos, record.visual_atividade]
      .filter(Boolean)
      .join(" ");
  }
  const signatureVisualPairs = findSimilarPairs(
    records.map((r) => ({ ...r, _signature: visualSignature(r) })),
    "_signature",
    LIMITS.visualSignatureWarning,
    100
  ).map((p) => ({ ...p, field: "assinatura_visual" }));
  for (const p of signatureVisualPairs) {
    const level = p.score >= LIMITS.visualSignatureError ? "erro" : "aviso";
    const msg = `Colisão na assinatura visual combinada entre "${p.a}" e "${p.b}" (score ${p.score}).`;
    if (level === "erro") {
      errors.push({ level, message: msg });
    } else {
      warnings.push({ level, message: msg });
    }
  }

  const topVisualPairs = [...individualVisualPairs, ...signatureVisualPairs]
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMITS.maxVisualSimilarityPairs);

  // Termos proibidos em qualquer campo positivo
  for (const r of records) {
    const findings = findForbiddenTermsAllFields(r);
    if (findings.length > 0) {
      const grouped = {};
      for (const f of findings) {
        grouped[f.field] = grouped[f.field] || [];
        grouped[f.field].push(f.term);
      }
      for (const [field, terms] of Object.entries(grouped)) {
        errors.push({
          level: "erro",
          message: `Termos proibidos em "${r.course_id}.${field}": ${[...new Set(terms)].join(", ")}.`,
        });
      }
    }
  }

  // Coerência entre atributos visuais e prompt_imagem
  for (const r of records) {
    const coherence = checkCoherence(r);
    if (coherence.total > 0 && coherence.matches < Math.min(LIMITS.minCoerenciaMatches, coherence.total)) {
      warnings.push({
        level: "aviso",
        message: `prompt_imagem de "${r.course_id}" parece pouco coerente com os atributos visuais (só ${coherence.matches}/${coherence.total} atributos refletidos).`,
      });
    }
  }

  // Região inferior esquerda
  for (const r of records) {
    const ll = checkLowerLeftFree(r);
    if (!ll.ok) {
      errors.push({
        level: "erro",
        message: `"${r.course_id}" não orienta deixar a região inferior esquerda livre em visual_composicao ou prompt_imagem.`,
      });
    } else if (!ll.inComp) {
      warnings.push({
        level: "aviso",
        message: `"${r.course_id}" orienta a região inferior esquerda apenas no prompt_imagem, não em visual_composicao.`,
      });
    }
  }

  // conteudo_status
  for (const r of records) {
    if (r.conteudo_status !== "rascunho") {
      errors.push({
        level: "erro",
        message: `"${r.course_id}" tem conteudo_status="${r.conteudo_status}", esperado "rascunho".`,
      });
    }
  }

  // Estatísticas demográficas declaradas (informativo, sem inferir etnia)
  const demo = inferGenderAndAgeStats(records);
  infos.push({
    level: "info",
    message: `Distribuição declarada de gênero: feminino ${demo.feminine}, masculino ${demo.masculine}, neutro ${demo.neutral}, não identificado ${demo.unknown}.`,
  });
  if (demo.ageMentions.length > 0) {
    const ages = demo.ageMentions.map((m) => m.age);
    const avg = ages.reduce((a, b) => a + b, 0) / ages.length;
    const min = Math.min(...ages);
    const max = Math.max(...ages);
    infos.push({
      level: "info",
      message: `Faixa etária declarada: média ${avg.toFixed(1)} anos, mínimo ${min}, máximo ${max}.`,
    });
  }

  const ok = errors.length === 0;

  return {
    ok,
    summary: {
      total: records.length,
      errors: errors.length,
      warnings: warnings.length,
      infos: infos.length,
      canImport: ok,
    },
    errors,
    warnings,
    infos,
    details: {
      repeatedOpeners: openers,
      similarDescriptions: similarDescs,
      repeatedThemes: temaReps,
      repeatedEnvironments: ambReps,
      repeatedActivities: ativReps,
      topVisualSimilarities: topVisualPairs,
      demographicStats: demo,
    },
  };
}

// =============================================================================
// RELATÓRIO MD
// =============================================================================

function generateMarkdown(audit, inputPath) {
  const { ok, summary, errors, warnings, infos, details } = audit;

  let md = `# Auditoria de Conteúdo\n\n`;
  md += `**Arquivo auditado:** \`${inputPath}\`\n\n`;
  md += `**Data:** ${new Date().toISOString()}\n\n`;
  md += `## Resumo\n\n`;
  md += `- Total de registros: ${summary.total}\n`;
  md += `- Erros: ${summary.errors}\n`;
  md += `- Avisos: ${summary.warnings}\n`;
  md += `- Informações: ${summary.infos}\n`;
  md += `- Pode ser importado: ${summary.canImport ? "Sim" : "Não"}\n\n`;

  md += `## Erros (${errors.length})\n\n`;
  if (errors.length === 0) {
    md += "Nenhum erro encontrado.\n\n";
  } else {
    for (const e of errors) {
      md += `- **${e.level.toUpperCase()}:** ${e.message}\n`;
    }
    md += "\n";
  }

  md += `## Avisos (${warnings.length})\n\n`;
  if (warnings.length === 0) {
    md += "Nenhum aviso encontrado.\n\n";
  } else {
    for (const w of warnings) {
      md += `- **${w.level.toUpperCase()}:** ${w.message}\n`;
    }
    md += "\n";
  }

  md += `## Informações (${infos.length})\n\n`;
  for (const i of infos) {
    md += `- **${i.level.toUpperCase()}:** ${i.message}\n`;
  }
  md += "\n";

  md += `## Detalhes Estatísticos\n\n`;

  md += `### Aberturas Repetidas\n\n`;
  if (details.repeatedOpeners.length === 0) {
    md += "Nenhuma abertura repetida mais de 2 vezes.\n\n";
  } else {
    for (const o of details.repeatedOpeners) {
      md += `- \"${o.word}\": ${o.count} ocorrências\n`;
    }
    md += "\n";
  }

  md += `### Descrições Semelhantes\n\n`;
  if (details.similarDescriptions.length === 0) {
    md += "Nenhum par de descrições similar encontrado.\n\n";
  } else {
    for (const p of details.similarDescriptions) {
      md += `- **${p.a}** ↔ **${p.b}** (score ${p.score})\n`;
      md += `  - A: ${p.snippetA}...\n`;
      md += `  - B: ${p.snippetB}...\n`;
    }
    md += "\n";
  }

  md += `### Temas, Ambientes e Atividades Repetidos\n\n`;
  const reps = [
    ...details.repeatedThemes.map((r) => ({ ...r, type: "Tema" })),
    ...details.repeatedEnvironments.map((r) => ({ ...r, type: "Ambiente" })),
    ...details.repeatedActivities.map((r) => ({ ...r, type: "Atividade" })),
  ];
  if (reps.length === 0) {
    md += "Nenhuma repetição encontrada.\n\n";
  } else {
    for (const r of reps) {
      md += `- **${r.type}:** ${r.value} (${r.count}x)\n`;
    }
    md += "\n";
  }

  md += `### Maior Semelhança Visual entre Pares (Revisão por IA / Amostragem Humana)\n\n`;
  if (details.topVisualSimilarities.length === 0) {
    md += "Nenhum par com similaridade visual acima do limite.\n\n";
  } else {
    for (const p of details.topVisualSimilarities) {
      md += `- **${p.a}** ↔ **${p.b}** | campo: \`${p.field}\` | score: ${p.score}\n`;
      md += `  - A: ${p.snippetA}...\n`;
      md += `  - B: ${p.snippetB}...\n`;
    }
    md += "\n";
  }

  md += `### Distribuição Declarada\n\n`;
  const demo = details.demographicStats;
  md += `- Feminino: ${demo.feminine}\n`;
  md += `- Masculino: ${demo.masculine}\n`;
  md += `- Neutro: ${demo.neutral}\n`;
  md += `- Não identificado: ${demo.unknown}\n`;
  if (demo.ageMentions.length > 0) {
    const ages = demo.ageMentions.map((m) => m.age);
    const avg = ages.reduce((a, b) => a + b, 0) / ages.length;
    md += `- Idade média declarada: ${avg.toFixed(1)} anos (min ${Math.min(...ages)}, max ${Math.max(...ages)})\n`;
  }
  md += "\n";

  md += `---\n\n`;
  md += `*Esta auditoria é somente leitura e não altera a planilha nem os registros de origem.*\n`;

  return md;
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  let file = null;
  for (const arg of args) {
    if (arg.startsWith("--file=")) {
      file = arg.replace("--file=", "");
    }
  }
  return { file };
}

async function main() {
  const { file } = parseArgs();

  if (!file) {
    console.error("Uso: node src/audit-content.js --file=output/content/batch-XXX-output.json");
    process.exit(1);
  }

  const inputPath = path.isAbsolute(file) ? file : path.join(ROOT, file);

  if (!fs.existsSync(inputPath)) {
    console.error(`Arquivo não encontrado: ${inputPath}`);
    process.exit(1);
  }

  let records;
  try {
    records = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (err) {
    console.error(`Erro ao ler JSON: ${err.message}`);
    process.exit(1);
  }

  const result = audit(records);

  const rawName = path.basename(inputPath, ".json");
  const baseName = rawName.endsWith("-output") ? rawName.slice(0, -"-output".length) : rawName;
  const jsonOutput = path.join(CONTENT_DIR, `${baseName}-audit.json`);
  const mdOutput = path.join(CONTENT_DIR, `${baseName}-audit.md`);

  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  fs.writeFileSync(jsonOutput, JSON.stringify(result, null, 2), "utf8");
  fs.writeFileSync(mdOutput, generateMarkdown(result, file), "utf8");

  console.log("\n================================");
  console.log("AUDITORIA FINALIZADA");
  console.log("================================");
  console.log(`Registros auditados: ${result.summary.total}`);
  console.log(`Erros:   ${result.summary.errors}`);
  console.log(`Avisos:  ${result.summary.warnings}`);
  console.log(`Infos:   ${result.summary.infos}`);
  console.log(`Importação permitida: ${result.summary.canImport ? "Sim" : "Não"}`);
  console.log(`JSON: ${jsonOutput}`);
  console.log(`MD:   ${mdOutput}`);

  if (result.errors.length > 0) {
    console.log("\nErros encontrados:");
    for (const e of result.errors) {
      console.log(`  - ${e.message}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log("\nAvisos encontrados:");
    for (const w of result.warnings.slice(0, 10)) {
      console.log(`  - ${w.message}`);
    }
    if (result.warnings.length > 10) {
      console.log(`  ... e mais ${result.warnings.length - 10} avisos no relatório.`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
