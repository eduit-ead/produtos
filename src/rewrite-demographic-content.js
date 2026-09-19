/**
 * Reescreve os campos visuais dos cursos selecionados no plano de reequilíbrio
 * demográfico e gera:
 *   - output/ai-pilot/reequilibrio-conteudo-output.json
 *   - output/ai-pilot/catalogo-personas.json
 *
 * Não chama APIs externas, não modifica a planilha e não gera imagens.
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { OUTPUT_FIELDS } = require("./content-schema");
const { loadCourses, analyzeCourses, TARGETS, getSecondaryEthnicity } = require("./audit-demographics");

const ROOT = path.resolve(__dirname, "..");
const INPUT_FILE = path.join(ROOT, "input", "cursos.xlsx");
const OUTPUT_DIR = path.join(ROOT, "output", "ai-pilot");
const PLAN_FILE = path.join(OUTPUT_DIR, "plano-reequilibrio-demografico.json");
const SHEET_NAME = "Graduação";
const PRESERVED_SLUGS = new Set([
  "artes-visuais",
  "ciberseguranca",
  "nutricao",
  "gestao-publica",
]);

const GENDER_SWAPS = {
  mulher: "homem",
  homem: "mulher",
};

const GENDER_PHRASE_SWAPS = {
  "jovem mulher": "jovem homem",
  "jovem homem": "jovem mulher",
  "mulher negra": "homem negro",
  "homem negro": "mulher negra",
  "mulher parda": "homem pardo",
  "homem pardo": "mulher parda",
  "mulher branca": "homem branco",
  "homem branco": "mulher branca",
  "mulher brasileira": "homem brasileiro",
  "homem brasileiro": "mulher brasileira",
  "mulher de": "homem de",
  "homem de": "mulher de",
  "profissional brasileira": "profissional brasileiro",
  "profissional brasileiro": "profissional brasileira",
  "professora": "professor",
  "professor": "professora",
  "aluna": "aluno",
  "aluno": "aluna",
  "coordenadora": "coordenador",
  "coordenador": "coordenadora",
  "gestora": "gestor",
  "gestor": "gestora",
  "engenheira": "engenheiro",
  "engenheiro": "engenheira",
  "desenvolvedora": "desenvolvedor",
  "desenvolvedor": "desenvolvedora",
  "enfermeira": "enfermeiro",
  "enfermeiro": "enfermeira",
  "pedagoga": "pedagogo",
  "pedagogo": "pedagoga",
  "técnica": "técnico",
  "técnico": "técnica",
  "brasileira": "brasileiro",
  "brasileiro": "brasileira",
  "feminina": "masculina",
  "masculina": "feminina",
  "feminino": "masculino",
  "masculino": "feminino",
};

const ETHNICITY_PHRASE_SWAPS = {
  "negra → parda": {
    "pele negra": "pele parda",
    "pele escura": "pele parda",
    "pele retinta": "pele parda",
    "cabelo crespo": "cabelo ondulado",
    "cabelo cacheado": "cabelo ondulado",
    "cabelo afro": "cabelo ondulado",
    "mulher negra": "mulher parda",
    "homem negro": "homem pardo",
    "pessoa negra": "pessoa parda",
    "negra brasileira": "parda brasileira",
    "negro brasileiro": "pardo brasileiro",
    "morena": "parda",
    "moreno": "pardo",
    " negra": " parda",
    " negro": " pardo",
  },
  "branca → parda": {
    "pele branca": "pele parda",
    "pele clara": "pele parda",
    "pele rosada": "pele parda",
    "cabelo claro": "cabelo castanho",
    "cabelo louro": "cabelo castanho",
    "cabelo loiro": "cabelo castanho",
    "loira": "morena",
    "loiro": "moreno",
    "mulher branca": "mulher parda",
    "homem branco": "homem pardo",
    "pessoa branca": "pessoa parda",
    "branca brasileira": "parda brasileira",
    "branco brasileiro": "pardo brasileiro",
    " branca": " parda",
    " branco": " pardo",
  },
  "parda → negra": {
    "pele parda": "pele negra",
    "pardo": "negro",
    "parda": "negra",
  },
  "parda → branca": {
    "pele parda": "pele branca",
    "pardo": "branco",
    "parda": "branca",
  },
  "negra → branca": {
    "pele negra": "pele branca",
    "pele escura": "pele branca",
    "cabelo crespo": "cabelo liso claro",
    "cabelo cacheado": "cabelo liso claro",
    "mulher negra": "mulher branca",
    "homem negro": "homem branco",
    "pessoa negra": "pessoa branca",
    " negra": " branca",
    " negro": " branco",
  },
  "branca → negra": {
    "pele branca": "pele negra",
    "pele clara": "pele negra",
    "cabelo claro": "cabelo crespo",
    "cabelo louro": "cabelo crespo",
    "cabelo loiro": "cabelo crespo",
    "loira": "mulher negra",
    "loiro": "homem negro",
    "mulher branca": "mulher negra",
    "homem branco": "homem negro",
    "pessoa branca": "pessoa negra",
    " branca": " negra",
    " branco": " negro",
  },
  "branca → outra (indígena/asiática)": {
    "pele branca": "traços indígenas",
    "pele clara": "traços indígenas",
    "pele rosada": "traços indígenas",
    "cabelo claro": "cabelo liso escuro",
    "cabelo louro": "cabelo liso escuro",
    "cabelo loiro": "cabelo liso escuro",
    "loira": "mulher de traços indígenas",
    "loiro": "homem de traços indígenas",
    "mulher branca": "mulher de traços indígenas",
    "homem branco": "homem de traços indígenas",
    "pessoa branca": "pessoa de traços indígenas",
    " branca": " de traços indígenas",
    " branco": " de traços indígenas",
  },
  "negra → outra (indígena/asiática)": {
    "pele negra": "traços indígenas",
    "pele escura": "ascendência asiática",
    "pele retinta": "ascendência asiática",
    "cabelo crespo": "cabelo liso escuro",
    "cabelo cacheado": "cabelo liso escuro",
    "cabelo afro": "cabelo liso escuro",
    "mulher negra": "mulher de traços indígenas",
    "homem negro": "homem de traços indígenas",
    "pessoa negra": "pessoa de traços indígenas",
    " negra": " de traços indígenas",
    " negro": " de traços indígenas",
  },
  "parda → outra (indígena/asiática)": {
    "pele parda": "traços indígenas",
    "mulher parda": "mulher de traços indígenas",
    "homem pardo": "homem de traços indígenas",
    "pessoa parda": "pessoa de traços indígenas",
    " parda": " de traços indígenas",
    " pardo": " de traços indígenas",
  },
};

function replacePhrases(text, map) {
  let result = text;
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const regex = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    result = result.replace(regex, map[key]);
  }
  return result;
}

function applyGenderSwap(text, fromGender, toGender) {
  if (fromGender === toGender) return text;

  const directionalMap = {};
  for (const [k, v] of Object.entries(GENDER_PHRASE_SWAPS)) {
    if (fromGender === "mulher" && toGender === "homem") {
      directionalMap[k] = v;
    } else if (fromGender === "homem" && toGender === "mulher") {
      directionalMap[v] = k;
    }
  }

  if (fromGender === "mulher" && toGender === "homem") {
    directionalMap.mulher = "homem";
  } else if (fromGender === "homem" && toGender === "mulher") {
    directionalMap.homem = "mulher";
  }

  return replacePhrases(text, directionalMap);
}

function applyEthnicitySwap(text, actionName) {
  const key = actionName.split(" → ").slice(0, 2).join(" → ");
  const map = ETHNICITY_PHRASE_SWAPS[key] || ETHNICITY_PHRASE_SWAPS["qualquer → outra"];
  if (!map) return text;
  return replacePhrases(text, map);
}

function complementaryGender(gender) {
  return gender === "mulher" ? "homem" : "mulher";
}

function complementaryEthnicity(ethnicity) {
  const order = ["parda", "negra", "branca"];
  const idx = order.indexOf(ethnicity);
  if (idx >= 0) return order[(idx + 1) % order.length];
  return "parda";
}

function extractAge(text) {
  const m = text.match(/cerca de (\d{2}) anos/);
  return m ? parseInt(m[1], 10) : 28;
}

function addSecondPerson(record, proposta, secondaryEthnicity) {
  const pg = proposta.genero;
  const secondaryDesc = describeSecondaryShort(pg, secondaryEthnicity);

  let person = record.visual_personagem || "";
  person = person.replace(/\.$/, "");
  if (!/protagonista|à direita/i.test(person)) {
    person += ", protagonista à direita";
  }
  person += `; ao centro, ${secondaryDesc}, colabora na cena. Cena com duas pessoas.`;
  record.visual_personagem = person;

  let atividade = record.visual_atividade || "";
  atividade = atividade.replace(/\.$/, "");
  atividade += " Ambas as pessoas participam da atividade com funções reais.";
  record.visual_atividade = atividade;

  let composicao = record.visual_composicao || "";
  if (composicao) composicao = composicao.replace(/\.$/, "") + " ";
  composicao += "Duas pessoas: protagonista à direita, segunda pessoa à direita/central, inferior esquerda livre.";
  record.visual_composicao = composicao;

  let evitar = record.visual_evitar || "";
  if (evitar) evitar = evitar.replace(/\.$/, "") + " ";
  evitar += "Não adicionar pessoa decorativa.";
  record.visual_evitar = evitar;
}

function reduceGroupToTwo(record, proposta, secondaryEthnicity) {
  const pg = proposta.genero;
  const secondaryDesc = describeSecondaryShort(pg, secondaryEthnicity);

  // Preserva o visual_personagem original, removendo sinais de grupo e ajustando para duas pessoas
  let person = record.visual_personagem || "";
  person = person
    .replace(/\bgrupo\b|\bequipe\b|\bturma\b|\bcolegas\b|\bvárias pessoas\b|\bvários\b|\bambos\b|\bambas\b/gi, "duas pessoas")
    .replace(/\bdemonstrando\b/gi, "demonstra")
    .replace(/\bmostrando\b/gi, "mostra")
    .replace(/\bapontando\b/gi, "aponta")
    .replace(/\borganizando\b/gi, "organiza")
    .replace(/\bdistribuindo\b/gi, "distribui")
    .replace(/\.$/, ", protagonista à direita");

  if (!/protagonista|à direita/i.test(person)) {
    person += ", protagonista à direita";
  }
  person += `; ao centro, ${secondaryDesc}, como segunda pessoa relevante. Cena com duas pessoas.`;
  record.visual_personagem = person;

  let atividade = record.visual_atividade || "";
  atividade = atividade.replace(/\.$/, "");
  atividade += " Ambas em participação real, sem personagens periféricos.";
  record.visual_atividade = atividade;

  let composicao = record.visual_composicao || "";
  if (composicao) composicao = composicao.replace(/\.$/, "") + " ";
  composicao += "Duas pessoas: protagonista à direita e segunda pessoa à direita/central, inferior esquerda livre.";
  record.visual_composicao = composicao;

  let evitar = record.visual_evitar || "";
  if (evitar) evitar = evitar.replace(/\.$/, "") + " ";
  evitar += "Não manter grupo grande; apenas duas funções principais.";
  record.visual_evitar = evitar;
}

function describeSecondaryShort(protagonistGender, secondaryEthnicity) {
  const gender = complementaryGender(protagonistGender);
  const genderNoun = gender === "mulher" ? "mulher" : "homem";
  const ethnicAdj = secondaryEthnicity === "parda" ? "parda" : secondaryEthnicity === "negra" ? "negra" : secondaryEthnicity === "outra" ? "traços indígenas" : "branca";
  return `${genderNoun} de pele ${ethnicAdj}`;
}

function applyPeopleCountChange(record, proposta, secondaryEthnicity) {
  const from = record.analise ? record.analise.quantidade_pessoas : "uma pessoa";
  const to = proposta.quantidade_pessoas;

  if (from === "uma pessoa" && to === "duas pessoas") {
    addSecondPerson(record, proposta, secondaryEthnicity);
  } else if (from === "grupo (3+)" && to === "duas pessoas") {
    reduceGroupToTwo(record, proposta, secondaryEthnicity);
  }
}

function rebuildPrompt(record) {
  // Atualiza o prompt com base nos campos visuais revisados
  let prompt = record.prompt_imagem || "";

  // Aplica as mesmas transformações de gênero e etnia no prompt
  // (já foram aplicadas antes, mas garantimos consistência)
  const fields = [
    "visual_personagem",
    "visual_atividade",
    "visual_ambiente",
    "visual_objetos",
    "visual_composicao",
    "visual_evitar",
  ];

  // Se o prompt original tinha trechos que não estão mais nos campos, tentamos preservar
  // a estrutura geral. Aqui apenas reforçamos a presença das descrições atualizadas.
  const person = record.visual_personagem || "";
  const activity = record.visual_atividade || "";
  const environment = record.visual_ambiente || "";
  const objects = record.visual_objetos || "";

  // Remove menções antigas de quantidade
  prompt = prompt.replace(/\b(uma pessoa|uma única pessoa|apenas uma pessoa)\b/gi, "duas pessoas");
  prompt = prompt.replace(/\b(grupo|equipe|turma|várias pessoas|vários colegas)\b/gi, "duas pessoas");

  // Se o prompt não menciona duas pessoas e deveria, adiciona
  if (record.visual_personagem && record.visual_personagem.includes("segunda pessoa")) {
    if (!/duas pessoas|segunda pessoa/i.test(prompt)) {
      prompt = prompt.replace(/\.$/, "") + ` Cena com duas pessoas: ${person}.`;
    }
  }

  // Garante termos respeitosos
  prompt = prompt.replace(/\bmulato\b|\bmulata\b/gi, "pessoa parda");

  record.prompt_imagem = prompt;
}

function applyActions(record, acoes, proposta, secondaryEthnicity) {
  // Anexa análise atual para referência
  if (!record.analise) {
    record.analise = {
      protagonista: { genero: proposta.genero, perfil_etnico_racial: proposta.etnia },
      quantidade_pessoas: proposta.quantidade_pessoas,
    };
  }

  const fromGender = record.analise.protagonista.genero;
  const fromEthnicity = record.analise.protagonista.perfil_etnico_racial;
  const fromPeople = record.analise.quantidade_pessoas;

  for (const acao of acoes) {
    if (acao === "homem → mulher" || acao === "mulher → homem") {
      const toGender = acao === "homem → mulher" ? "mulher" : "homem";
      for (const field of ["visual_personagem", "visual_atividade", "visual_composicao", "visual_evitar", "prompt_imagem"]) {
        if (record[field]) {
          record[field] = applyGenderSwap(record[field], fromGender, toGender);
        }
      }
      record.analise.protagonista.genero = toGender;
    } else if (acao.includes("→ parda") || acao.includes("→ negra") || acao.includes("→ branca") || acao.includes("→ outra")) {
      for (const field of ["visual_personagem", "visual_atividade", "visual_composicao", "visual_evitar", "prompt_imagem"]) {
        if (record[field]) {
          record[field] = applyEthnicitySwap(record[field], acao);
        }
      }
      const toEthnicity = acao.split(" → ")[1].replace(" (indígena/asiática)", "");
      record.analise.protagonista.perfil_etnico_racial = toEthnicity;
    } else if (acao.includes("→ duas pessoas") || acao.includes("→ uma pessoa") || acao.includes("→ grupo")) {
      applyPeopleCountChange(record, proposta, secondaryEthnicity);
      const toPeople = acao.split(" → ")[1];
      record.analise.quantidade_pessoas = toPeople;
    }
  }

  rebuildPrompt(record);
}

async function loadAllCourses() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(INPUT_FILE);
  const sheet = workbook.getWorksheet(SHEET_NAME);

  const headerMap = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headerMap[cell.value] = colNumber;
  });

  const courses = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const courseId = String(row.getCell(headerMap["course_id"]).value || row.getCell(headerMap["slug"]).value || "").trim();
    if (!courseId) continue;

    const record = {
      course_id: courseId,
      slug: String(row.getCell(headerMap["slug"]).value || "").trim(),
      Curso: String(row.getCell(headerMap["Curso"]).value || "").trim(),
      Classificação: String(row.getCell(headerMap["Classificação"]).value || "").trim(),
    };

    for (const field of OUTPUT_FIELDS) {
      if (field === "course_id") continue;
      record[field] = String(row.getCell(headerMap[field]).value || "").trim();
    }

    courses.push(record);
  }

  return courses;
}

function buildCatalog(allCourses, rewrittenMap, auditAnalyzed, secondaryEthMap) {
  return allCourses.map((course) => {
    const analyzed = auditAnalyzed.find((c) => c.course_id === course.course_id);
    const rewritten = rewrittenMap.get(course.course_id);

    const source = rewritten || analyzed;
    const isRewritten = !!rewritten;

    const protagonist = source.analise.protagonista;
    const quantidade = source.analise.quantidade_pessoas;
    const secondaries = isRewritten
      ? extractSecondariesFromRecord(
          rewritten,
          protagonist.genero,
          quantidade,
          quantidade !== "uma pessoa" ? secondaryEthMap.get(course.course_id) : null
        )
      : (analyzed.analise.personagens_secundarios || []);

    return {
      course_id: course.course_id,
      slug: course.slug,
      curso: course.Curso,
      origem: isRewritten ? "reequilibrado" : "original",
      protagonista: {
        genero: protagonist.genero,
        perfil_etnico_racial: protagonist.perfil_etnico_racial,
        idade: protagonist.idade || extractAge(course.visual_personagem || source.visual_personagem || ""),
        funcao: protagonist.funcao || inferFunction(course),
      },
      quantidade_pessoas: quantidade === "grupo (3+)" ? 3 : quantidade === "duas pessoas" ? 2 : 1,
      personagens_secundarios: secondaries,
    };
  });
}

function extractSecondariesFromRecord(record, protagonistGender, peopleCount, secondaryEthnicity) {
  if (peopleCount === "uma pessoa") return [];
  if (!secondaryEthnicity) return [];

  const activity = record.visual_atividade || "";
  const gender = complementaryGender(protagonistGender);
  const ethnicity = secondaryEthnicity;
  const funcao = peopleCount === "duas pessoas" ? `${activity} (segundo personagem)` : `${activity} (equipe de apoio)`;

  return [
    {
      genero: gender,
      perfil_etnico_racial: ethnicity,
      funcao: funcao,
      participacao_real: true,
    },
  ];
}

function inferFunction(course) {
  return course.visual_atividade || `atividade principal de ${course.Curso}`;
}

function buildSecondaryEthnicityMap(allCourses, planMap, auditAnalyzed) {
  const analyzedMap = new Map(auditAnalyzed.map((c) => [c.course_id, c.analise]));
  const withSecondaries = [];

  for (const course of allCourses) {
    const planItem = planMap.get(course.course_id);
    let hasSecondaries;
    if (planItem) {
      const proposta = deriveProposta(planItem.classificacao_atual, planItem.acoes);
      hasSecondaries = proposta.quantidade_pessoas !== "uma pessoa";
    } else {
      const analise = analyzedMap.get(course.course_id);
      hasSecondaries = analise && analise.quantidade_pessoas !== "uma pessoa";
    }
    if (hasSecondaries) withSecondaries.push(course.course_id);
  }

  const map = new Map();
  withSecondaries.forEach((course_id, idx) => {
    map.set(course_id, getSecondaryEthnicity(idx));
  });
  return map;
}

async function main() {
  if (!fs.existsSync(PLAN_FILE)) {
    throw new Error(`Plano não encontrado: ${PLAN_FILE}`);
  }

  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
  const planMap = new Map(plan.cursos.map((c) => [c.course_id, c]));

  console.log("Carregando todos os cursos da planilha...");
  const allCourses = await loadAllCourses();
  console.log(`Cursos carregados: ${allCourses.length}`);

  console.log("Carregando análise demográfica atual...");
  const auditCourses = await loadCourses();
  const auditAnalyzed = analyzeCourses(auditCourses);

  const secondaryEthMap = buildSecondaryEthnicityMap(allCourses, planMap, auditAnalyzed);

  const rewrittenRecords = [];
  const rewrittenMap = new Map();

  for (const course of allCourses) {
    const planItem = planMap.get(course.course_id);
    if (!planItem) continue;

    const proposta = deriveProposta(planItem.classificacao_atual, planItem.acoes);

    // Anexa análise original para guiar transformações
    const analyzed = auditAnalyzed.find((c) => c.course_id === course.course_id);
    course.analise = analyzed ? analyzed.analise : null;

    applyActions(course, planItem.acoes, proposta, secondaryEthMap.get(course.course_id));

    // Remove campos auxiliares antes de salvar
    delete course.analise;
    delete course.Curso;
    delete course.Classificação;
    delete course.slug;

    // Garante conteudo_status
    course.conteudo_status = "rascunho";

    rewrittenRecords.push(course);
    rewrittenMap.set(course.course_id, { ...course, analise: analyzed.analise });
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Gera catálogo de personas
  const catalog = buildCatalog(allCourses, rewrittenMap, auditAnalyzed, secondaryEthMap);
  const catalogPath = path.join(OUTPUT_DIR, "catalogo-personas.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ gerado_em: new Date().toISOString(), total: catalog.length, cursos: catalog }, null, 2), "utf8");

  // Gera lote de reescrita
  const outputPath = path.join(OUTPUT_DIR, "reequilibrio-conteudo-output.json");
  fs.writeFileSync(outputPath, JSON.stringify(rewrittenRecords, null, 2), "utf8");

  console.log("\n================================");
  console.log("REESCRITA DEMOGRÁFICA CONCLUÍDA");
  console.log("================================");
  console.log(`Cursos reescritos: ${rewrittenRecords.length}`);
  console.log(`Catálogo: ${catalogPath}`);
  console.log(`Lote: ${outputPath}`);
}

function deriveProposta(atual, acoes) {
  const proposta = {
    genero: atual.genero,
    etnia: atual.etnia,
    quantidade_pessoas: atual.quantidade_pessoas,
  };
  for (const acao of acoes) {
    if (acao === "homem → mulher") proposta.genero = "mulher";
    else if (acao === "mulher → homem") proposta.genero = "homem";
    else if (acao.includes("→ parda")) proposta.etnia = "parda";
    else if (acao.includes("→ negra")) proposta.etnia = "negra";
    else if (acao.includes("→ branca")) proposta.etnia = "branca";
    else if (acao.includes("→ outra")) proposta.etnia = "outra";
    else if (acao === "uma pessoa → duas pessoas" || acao === "grupo → duas pessoas") proposta.quantidade_pessoas = "duas pessoas";
    else if (acao === "uma pessoa → grupo" || acao === "duas pessoas → grupo") proposta.quantidade_pessoas = "grupo (3+)";
    else if (acao === "duas pessoas → uma pessoa" || acao === "grupo → uma pessoa") proposta.quantidade_pessoas = "uma pessoa";
  }
  return proposta;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  applyGenderSwap,
  applyEthnicitySwap,
};
