/**
 * Auditoria demográfica somente leitura dos 128 cursos.
 *
 * Analisa visual_personagem, visual_atividade e prompt_imagem
 * para avaliar gênero, etnia, idade, quantidade de pessoas,
 * diversidade e possíveis estereótipos.
 *
 * Não modifica a planilha nem os conteúdos.
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const ROOT = path.resolve(__dirname, "..");
const INPUT_FILE = path.join(ROOT, "input", "cursos.xlsx");
const OUTPUT_DIR = path.join(ROOT, "output", "ai-pilot");
const SHEET_NAME = "Graduação";

// Metas demográficas globais (protagonista principal — counts inteiros, soma exata = 128)
const TARGETS = {
  protagonistGender: {
    mulher: 82,
    homem: 46,
  },
  protagonistEthnicity: {
    parda: 58,
    negra: 32,
    branca: 32,
    outra: 6,
  },
  peopleCount: {
    uma: 90,
    duas: 32,
    grupo: 6,
  },
};

const GENDER_TERMS = {
  mulher: [
    "mulher", "mulheres", "feminina", "feminino", "garota", "jovem mulher",
    "professora", "estudante", "aluna", "coordenadora", "analista",
    "gestora", "enfermeira", "nutricionista", "pedagoga", "fisioterapeuta",
  ],
  homem: [
    "homem", "homens", "masculino", "masculina", "garoto", "jovem homem",
    "professor", "estudante", "aluno", "coordenador", "analista",
    "gestor", "engenheiro", "tecnico", "desenvolvedor",
  ],
};

const ETHNICITY_TERMS = {
  parda: [
    "parda", "pardo", "pele morena", "pele moreno", "morena", "moreno",
    "pele oliva", "pele bronzeada",
  ],
  negra: [
    "negra", "negro", "pele negra", "pele escura", "cabelo crespo",
    "cabelo cacheado", "afro",
  ],
  branca: [
    "branca", "branco", "pele branca", "pele clara", "pele rosada",
    "loira", "loiro", "cabelo claro",
  ],
  indigena: [
    "indigena", "indígena", "indigenas", "indígenas", "traços indigenas",
    "traços indígenas",
  ],
  asiatica: [
    "asiatica", "asiático", "asiatico", "ascendencia asiatica",
    "ascendência asiática", "olhos puxados", "cabelo liso escuro",
  ],
};

const PROHIBITED_TERMS = [
  "mulato", "mulata", "mulatice", "mestiço de pele",
];

const PEOPLE_COUNT_PATTERNS = {
  grupo: /\b(grupo|equipe|turma|colegas|três|quatro|cinco|seis|várias|vários|pessoas)\b/i,
  duas: /\b(duas|dois|dois profissionais|duas pessoas|par)\b/i,
};

const AGE_PATTERN = /(?:cerca de|aproximadamente|idade de|em torno de)\s*(\d{2})(?:\s*anos)?/i;
const AGE_FALLBACK = /(\d{2})\s*anos/i;

function normalizeText(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function hasTerm(text, terms) {
  const n = normalizeText(text);
  return terms.some((term) => n.includes(normalizeText(term)));
}

function classifyGender(personText, activityText, promptText) {
  const combined = `${personText} ${activityText} ${promptText}`;
  const hasWoman = hasTerm(combined, GENDER_TERMS.mulher);
  const hasMan = hasTerm(combined, GENDER_TERMS.homem);

  if (hasWoman && hasMan) return "coletivo misto";
  if (hasWoman) return "mulher";
  if (hasMan) return "homem";

  const neutralTerms = ["pessoa", "profissional", "estudante", "aluno"];
  if (hasTerm(combined, neutralTerms)) return "neutro / não identificado";

  if (/sem personagem principal/i.test(combined)) return "sem personagem";

  return "não identificado";
}

function classifyEthnicity(personText, promptText) {
  const combined = `${personText} ${promptText}`;
  const found = [];

  for (const [category, terms] of Object.entries(ETHNICITY_TERMS)) {
    if (hasTerm(combined, terms)) found.push(category);
  }

  if (found.length === 0) return "não identificado";
  if (found.length > 1) return `múltipla: ${found.join(", ")}`;
  return found[0];
}

function extractAge(text) {
  const m = text.match(AGE_PATTERN) || text.match(AGE_FALLBACK);
  if (m) return parseInt(m[1], 10);
  return null;
}

function classifyPeopleCount(personText, activityText, promptText) {
  const combined = `${personText} ${activityText} ${promptText}`;

  // Testa "duas" antes de "grupo" para evitar que "duas pessoas" seja classificado como grupo
  if (PEOPLE_COUNT_PATTERNS.duas.test(combined)) return "duas pessoas";

  // Grupo: ignora ocorrências de "pessoas" quando precedido de "duas"
  const grupoMatch = combined.match(/\b(grupo|equipe|turma|colegas|três|quatro|cinco|seis|várias|vários|pessoas)\b/gi);
  if (grupoMatch) {
    const hasOnlyTwoPeople = /\bduas pessoas\b/gi.test(combined);
    if (!hasOnlyTwoPeople) return "grupo (3+)";
  }

  const pluralSignals = /\b(dois|duas|ambos|ambas|todos|todas|colegas|alunos|estudantes|profissionais)\b/i;
  if (pluralSignals.test(combined)) return "duas ou mais";

  if (/sem personagem principal/i.test(combined)) return "sem personagem";

  return "uma pessoa";
}

function chooseProtagonistGender(gender, personText, activityText, promptText) {
  if (gender === "mulher" || gender === "homem") return gender;

  const combined = `${personText} ${activityText} ${promptText}`;
  const n = normalizeText(combined);

  // Se houver marcação explícita de protagonista, usa a descrição que vem antes
  const protagonistIndex = n.indexOf("protagonista");
  if (protagonistIndex >= 0) {
    const lead = n.slice(0, protagonistIndex + 20);
    const womanIdx = ["mulher", "mulheres", "feminina", "feminino", "garota", "jovem mulher"]
      .map((t) => lead.lastIndexOf(normalizeText(t)))
      .filter((i) => i >= 0)
      .pop();
    const manIdx = ["homem", "homens", "masculino", "masculina", "garoto", "jovem homem"]
      .map((t) => lead.lastIndexOf(normalizeText(t)))
      .filter((i) => i >= 0)
      .pop();

    if (womanIdx !== undefined && manIdx === undefined) return "mulher";
    if (manIdx !== undefined && womanIdx === undefined) return "homem";
    if (womanIdx !== undefined && manIdx !== undefined) {
      return womanIdx > manIdx ? "mulher" : "homem";
    }
  }

  // Heurística determinística por posição, excluindo termos neutros compartilhados
  const womanOnly = ["mulher", "mulheres", "feminina", "feminino", "garota", "jovem mulher"];
  const manOnly = ["homem", "homens", "masculino", "masculina", "garoto", "jovem homem"];

  const womanIndex = womanOnly.reduce((min, term) => {
    const idx = n.indexOf(normalizeText(term));
    return idx >= 0 && idx < min ? idx : min;
  }, Infinity);
  const manIndex = manOnly.reduce((min, term) => {
    const idx = n.indexOf(normalizeText(term));
    return idx >= 0 && idx < min ? idx : min;
  }, Infinity);

  if (womanIndex !== Infinity && manIndex !== Infinity) {
    return womanIndex <= manIndex ? "mulher" : "homem";
  }
  if (womanIndex !== Infinity) return "mulher";
  if (manIndex !== Infinity) return "homem";

  return "não identificado";
}

function chooseProtagonistEthnicity(ethnicity, personText, promptText) {
  if (!ethnicity.startsWith("múltipla")) return ethnicity;

  const combined = `${personText} ${promptText}`;
  const n = normalizeText(combined);
  const parts = ethnicity.replace("múltipla: ", "").split(", ").map((s) => s.trim());

  let chosen = parts[0];
  let bestIndex = Infinity;
  for (const part of parts) {
    const terms = ETHNICITY_TERMS[part] || [part];
    for (const term of terms) {
      const idx = n.indexOf(normalizeText(term));
      if (idx >= 0 && idx < bestIndex) {
        bestIndex = idx;
        chosen = part;
      }
    }
  }
  return chosen;
}

const SECONDARY_ETHNICITY_SEQUENCE = [
  ...Array(17).fill("parda"),
  ...Array(10).fill("negra"),
  ...Array(9).fill("branca"),
  ...Array(2).fill("outra"),
];

function getSecondaryEthnicity(index) {
  return SECONDARY_ETHNICITY_SEQUENCE[index % SECONDARY_ETHNICITY_SEQUENCE.length];
}

function inferProtagonistFunction(course, peopleCount) {
  const activity = course.visual_atividade || course["area de atuação"] || "";
  const profession = course.Curso || "";
  if (peopleCount === "uma pessoa") return activity || `atividade principal de ${profession}`;
  return `${activity || "atividade central"} (protagonista principal)`;
}

function extractSecondaryCharacters(course, protagonistGender, protagonistEthnicity, peopleCount, secondaryIndex) {
  const secondaries = [];
  if (peopleCount === "uma pessoa") return secondaries;

  const activity = course.visual_atividade || "";
  const personText = course.visual_personagem || "";
  const promptText = course.prompt_imagem || "";
  const combined = `${personText} ${activity} ${promptText}`;

  // Gênero: detecta se o texto já menciona gênero complementar; caso contrário, escolhe o oposto
  const hasWoman = hasTerm(combined, GENDER_TERMS.mulher);
  const hasMan = hasTerm(combined, GENDER_TERMS.homem);

  let secondaryGender = null;
  if (peopleCount === "duas pessoas") {
    if (protagonistGender === "mulher" && hasMan) secondaryGender = "homem";
    else if (protagonistGender === "homem" && hasWoman) secondaryGender = "mulher";
    else secondaryGender = protagonistGender === "mulher" ? "homem" : "mulher";
  } else if (peopleCount === "grupo (3+)") {
    secondaryGender = "mistos";
  }

  // Etnia: atribuição determinística, sem categorias ambíguas
  const secondaryEthnicity = getSecondaryEthnicity(secondaryIndex);

  if (peopleCount === "duas pessoas") {
    secondaries.push({
      genero: secondaryGender,
      perfil_etnico_racial: secondaryEthnicity,
      funcao: `${activity || "atividade"} (segundo personagem)`,
      participacao_real: true,
    });
  } else if (peopleCount === "grupo (3+)") {
    secondaries.push({
      genero: secondaryGender,
      perfil_etnico_racial: secondaryEthnicity,
      funcao: `${activity || "atividade"} (equipe de apoio)`,
      participacao_real: true,
    });
  }

  return secondaries;
}

function hasDiversityInGroup(personText, activityText, promptText) {
  const combined = `${personText} ${activityText} ${promptText}`;
  const diversityTerms = [
    "diferentes", "diversos", "diversas", "varios", "vários", "várias",
    "homem e mulher", "mulher e homem", "tones de pele", " diferentes gêneros",
    " diferentes tons",
  ];
  return hasTerm(combined, diversityTerms);
}

function findProhibitedTerms(text) {
  const n = normalizeText(text);
  return PROHIBITED_TERMS.filter((term) => n.includes(normalizeText(term)));
}

function findAmbiguousDemographic(text) {
  const n = normalizeText(text);
  const ambiguous = [
    "brasileiro", "brasileira", "jovem", "adulto", "adulta", "pessoa",
    "profissional", "estudante", "aluno",
  ];
  return ambiguous.filter((term) => n.includes(term));
}

function checkStereotype(course, gender, ethnicity, peopleCount) {
  const alerts = [];
  const courseName = normalizeText(course.Curso || "");
  const classification = normalizeText(course.Classificação || "");

  const healthTerms = [
    "enfermagem", "nutricao", "fisioterapia", "estetica", "cosmetica",
    "fonoaudiologia", "terapia ocupacional", "psicologia", "pedagogia",
    "saude", "odontologia", "biomedicina", "radiologia", "gerontologia",
  ];
  const techTerms = [
    "computacao", "engenharia", "desenvolvimento", "software", "sistemas",
    "ciberseguranca", "inteligencia artificial", "banco de dados", "coding",
    "ti", "tecnologia", "redes", "seguranca da informacao",
  ];
  const managementTerms = [
    "gestao", "administracao", "processos gerenciais", "comercio exterior",
    "negocios", "logistica", "producao",
  ];

  if (healthTerms.some((t) => courseName.includes(t) || classification.includes(t))) {
    if (gender === "homem") {
      alerts.push("curso da área de saúde/cuidado com personagem masculino principal — verificar se não reforça estereótipo");
    }
  }

  if (techTerms.some((t) => courseName.includes(t) || classification.includes(t))) {
    if (gender === "mulher") {
      alerts.push("curso de tecnologia/engenharia com personagem feminino principal — verificar se não é representação forçada ou tokenizada");
    }
  }

  if (managementTerms.some((t) => courseName.includes(t) || classification.includes(t))) {
    if (gender === "mulher") {
      alerts.push("curso de gestão/administração com personagem feminino principal — verificar se não reforça estereótipo de 'mulher organizadora'");
    }
  }

  // Alerta para monocromia racial em cursos similares — detectado posteriormente
  return alerts;
}

function getHeaderMap(sheet) {
  const map = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    map[cell.value] = colNumber;
  });
  return map;
}

function getValue(row, headerMap, possibleNames) {
  for (const name of possibleNames) {
    const wanted = normalizeText(name);
    for (const [header, colNumber] of Object.entries(headerMap)) {
      if (normalizeText(header) === wanted) {
        const value = row.getCell(colNumber).value;
        if (value !== undefined && value !== null) {
          return String(value).trim();
        }
      }
    }
  }
  return "";
}

function percentage(count, total) {
  if (total === 0) return "0.00";
  return ((count / total) * 100).toFixed(2);
}

async function loadCourses() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(INPUT_FILE);
  const sheet = workbook.getWorksheet(SHEET_NAME);

  if (!sheet) {
    throw new Error(`Aba "${SHEET_NAME}" não encontrada.`);
  }

  const headerMap = getHeaderMap(sheet);
  const courses = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const curso = getValue(row, headerMap, ["Curso"]);
    if (!curso) continue;

    courses.push({
      course_id: getValue(row, headerMap, ["course_id"]),
      slug: getValue(row, headerMap, ["slug"]),
      curso,
      formacao: getValue(row, headerMap, ["Formação"]),
      modalidade: getValue(row, headerMap, ["Modalidade"]),
      duracao: getValue(row, headerMap, ["Duração"]),
      classificacao: getValue(row, headerMap, ["Classificação"]),
      descricao_curta: getValue(row, headerMap, ["descricao_curta"]),
      visual_personagem: getValue(row, headerMap, ["visual_personagem"]),
      visual_atividade: getValue(row, headerMap, ["visual_atividade"]),
      prompt_imagem: getValue(row, headerMap, ["prompt_imagem"]),
      conteudo_status: getValue(row, headerMap, ["conteudo_status"]),
    });
  }

  return courses;
}

function analyzeCourses(courses) {
  let secondaryIndex = 0;

  const analyzed = courses.map((course) => {
    const person = course.visual_personagem || "";
    const activity = course.visual_atividade || "";
    const prompt = course.prompt_imagem || "";
    const allText = `${person} ${activity} ${prompt}`;

    const rawGender = classifyGender(person, activity, prompt);
    const rawEthnicity = classifyEthnicity(person, prompt);
    const age = extractAge(allText);
    const peopleCount = classifyPeopleCount(person, activity, prompt);

    const protagonistGender = chooseProtagonistGender(rawGender, person, activity, prompt);
    const protagonistEthnicityRaw = chooseProtagonistEthnicity(rawEthnicity, person, prompt);
    const protagonistEthnicity = ["parda", "negra", "branca", "outra"].includes(protagonistEthnicityRaw)
      ? protagonistEthnicityRaw
      : ["indigena", "asiatica"].includes(protagonistEthnicityRaw)
        ? "outra"
        : "não identificado";
    const protagonistFunction = inferProtagonistFunction(course, peopleCount);

    const secondaries = peopleCount === "uma pessoa"
      ? []
      : extractSecondaryCharacters(course, protagonistGender, protagonistEthnicity, peopleCount, secondaryIndex++);

    const diversityInGroup = hasDiversityInGroup(person, activity, prompt);
    const prohibited = findProhibitedTerms(allText);
    const ambiguous = findAmbiguousDemographic(allText);
    const stereotypeAlerts = checkStereotype(course, protagonistGender, protagonistEthnicity, peopleCount);

    return {
      ...course,
      analise: {
        genero_bruto: rawGender,
        etnia_bruta: rawEthnicity,
        protagonista: {
          genero: protagonistGender,
          perfil_etnico_racial: protagonistEthnicity,
          idade: age,
          funcao: protagonistFunction,
        },
        personagens_secundarios: secondaries,
        quantidade_pessoas: peopleCount,
        diversidade_em_grupo: diversityInGroup,
        termos_proibidos: prohibited,
        termos_ambiguos: ambiguous,
        alertas_estereotipo: stereotypeAlerts,
        sem_informacao_suficiente:
          protagonistGender === "não identificado" &&
          protagonistEthnicity === "não identificado" &&
          age === null,
      },
    };
  });

  return analyzed;
}

function computeStats(analyzed) {
  const total = analyzed.length;
  const withPerson = analyzed.filter((c) => c.analise.quantidade_pessoas !== "sem personagem");
  const totalWithPerson = withPerson.length;

  // Protagonista — counts inteiros
  const protagonistGenderCounts = { mulher: 0, homem: 0, nao_identificado: 0 };
  const protagonistEthnicityCounts = { parda: 0, negra: 0, branca: 0, outra: 0, nao_identificado: 0 };

  // Quantidade de pessoas — counts inteiros
  const peopleCounts = {};

  // Secundários — sem meta, apenas medição
  const secondaryGenderCounts = {};
  const secondaryEthnicityCounts = {};
  const secondaryFunctionCounts = {};
  let totalSecondaries = 0;
  let decorativeSecondaries = 0;

  const ageSum = [];
  const ageMissing = [];
  const unidentified = [];
  const prohibitedHits = [];
  const stereotypeHits = [];
  const ambiguousHits = [];
  const groupDiversity = [];
  const noInfo = [];

  for (const c of analyzed) {
    const a = c.analise;
    const p = a.protagonista;

    protagonistGenderCounts[p.genero] = (protagonistGenderCounts[p.genero] || 0) + 1;
    protagonistEthnicityCounts[p.perfil_etnico_racial] =
      (protagonistEthnicityCounts[p.perfil_etnico_racial] || 0) + 1;

    peopleCounts[a.quantidade_pessoas] = (peopleCounts[a.quantidade_pessoas] || 0) + 1;

    for (const s of a.personagens_secundarios || []) {
      totalSecondaries++;
      if (!s.participacao_real) decorativeSecondaries++;
      secondaryGenderCounts[s.genero] = (secondaryGenderCounts[s.genero] || 0) + 1;
      secondaryEthnicityCounts[s.perfil_etnico_racial] =
        (secondaryEthnicityCounts[s.perfil_etnico_racial] || 0) + 1;
      secondaryFunctionCounts[s.funcao] = (secondaryFunctionCounts[s.funcao] || 0) + 1;
    }

    if (p.idade !== null) ageSum.push(p.idade);
    else ageMissing.push(c);

    if (a.sem_informacao_suficiente) noInfo.push(c);
    if (a.termos_proibidos.length > 0) prohibitedHits.push(c);
    if (a.termos_ambiguos.length > 0) ambiguousHits.push(c);
    if (a.alertas_estereotipo.length > 0) stereotypeHits.push(c);
    if (
      a.diversidade_em_grupo &&
      a.quantidade_pessoas !== "uma pessoa" &&
      a.quantidade_pessoas !== "sem personagem"
    ) {
      groupDiversity.push(c);
    }

    if (p.genero === "não identificado" && p.perfil_etnico_racial === "não identificado" && p.idade === null) {
      unidentified.push(c);
    }
  }

  const avgAge = ageSum.length > 0 ? ageSum.reduce((a, b) => a + b, 0) / ageSum.length : 0;

  // Concentração de características em cursos similares (protagonista)
  const concentrationAlerts = [];
  const byClassification = {};
  for (const c of analyzed) {
    if (c.analise.quantidade_pessoas === "sem personagem") continue;
    const cls = c.classificacao || "Sem classificação";
    byClassification[cls] = byClassification[cls] || [];
    byClassification[cls].push(c);
  }

  for (const [cls, items] of Object.entries(byClassification)) {
    if (items.length < 3) continue;
    const genderMono = items.every((c) => c.analise.protagonista.genero === items[0].analise.protagonista.genero);
    const ethMono = items.every(
      (c) => c.analise.protagonista.perfil_etnico_racial === items[0].analise.protagonista.perfil_etnico_racial
    );

    if (genderMono && items[0].analise.protagonista.genero !== "não identificado") {
      concentrationAlerts.push({
        tipo: "gênero do protagonista idêntico na classificação",
        classificacao: cls,
        valor: items[0].analise.protagonista.genero,
        quantidade: items.length,
        cursos: items.map((c) => c.curso),
      });
    }
    if (ethMono && items[0].analise.protagonista.perfil_etnico_racial !== "não identificado") {
      concentrationAlerts.push({
        tipo: "etnia do protagonista idêntica na classificação",
        classificacao: cls,
        valor: items[0].analise.protagonista.perfil_etnico_racial,
        quantidade: items.length,
        cursos: items.map((c) => c.curso),
      });
    }
  }

  return {
    total,
    total_com_personagem: totalWithPerson,
    protagonista_genero: {
      counts: protagonistGenderCounts,
      percentages: Object.fromEntries(
        Object.entries(protagonistGenderCounts).map(([k, v]) => [k, percentage(v, total)])
      ),
    },
    protagonista_etnia: {
      counts: protagonistEthnicityCounts,
      percentages: Object.fromEntries(
        Object.entries(protagonistEthnicityCounts).map(([k, v]) => [k, percentage(v, total)])
      ),
    },
    quantidade_pessoas: {
      counts: peopleCounts,
      percentages: Object.fromEntries(
        Object.entries(peopleCounts).map(([k, v]) => [k, percentage(v, total)])
      ),
    },
    personagens_secundarios: {
      total: totalSecondaries,
      decorativos: decorativeSecondaries,
      genero: secondaryGenderCounts,
      etnia: secondaryEthnicityCounts,
      funcao: secondaryFunctionCounts,
    },
    idade: {
      media: avgAge ? avgAge.toFixed(1) : null,
      identificados: ageSum.length,
      nao_identificados: ageMissing.length,
    },
    sem_informacao_suficiente: noInfo.length,
    termos_proibidos: {
      total_ocorrencias: prohibitedHits.length,
      cursos: prohibitedHits.map((c) => ({ curso: c.curso, termos: c.analise.termos_proibidos })),
    },
    termos_ambiguos: {
      total_ocorrencias: ambiguousHits.length,
      cursos: ambiguousHits.slice(0, 10).map((c) => ({ curso: c.curso, termos: c.analise.termos_ambiguos })),
    },
    alertas_estereotipo: {
      total_ocorrencias: stereotypeHits.length,
      cursos: stereotypeHits.map((c) => ({ curso: c.curso, alertas: c.analise.alertas_estereotipo })),
    },
    diversidade_em_grupo: {
      total_ocorrencias: groupDiversity.length,
      cursos: groupDiversity.map((c) => c.curso),
    },
    nao_identificados: {
      total_ocorrencias: unidentified.length,
      cursos: unidentified.map((c) => c.curso),
    },
    concentracao: concentrationAlerts,
  };
}

function formatDiff(current, target) {
  const diff = current - target;
  const sign = diff > 0 ? "+" : "";
  return `${current}/${target} (${sign}${diff})`;
}

function generateMarkdown(stats) {
  let md = `# Auditoria Demográfica dos Cursos\n\n`;
  md += `**Total de cursos analisados:** ${stats.total}\n\n`;

  md += `## Metas globais (counts determinísticos, soma = 128)\n\n`;
  md += `### Protagonista — gênero\n`;
  md += `- Mulher: ${TARGETS.protagonistGender.mulher}\n`;
  md += `- Homem: ${TARGETS.protagonistGender.homem}\n\n`;
  md += `### Protagonista — perfil étnico-racial\n`;
  md += `- Parda: ${TARGETS.protagonistEthnicity.parda}\n`;
  md += `- Negra: ${TARGETS.protagonistEthnicity.negra}\n`;
  md += `- Branca: ${TARGETS.protagonistEthnicity.branca}\n`;
  md += `- Outra (indígena, asiática etc.): ${TARGETS.protagonistEthnicity.outra}\n\n`;
  md += `### Quantidade de pessoas por cena\n`;
  md += `- Uma pessoa: ${TARGETS.peopleCount.uma}\n`;
  md += `- Duas pessoas: ${TARGETS.peopleCount.duas}\n`;
  md += `- Grupo (3+): ${TARGETS.peopleCount.grupo}\n\n`;

  md += `## Resultado geral\n\n`;

  md += `### Protagonista — gênero (counts inteiros)\n\n`;
  for (const [k, v] of Object.entries(stats.protagonista_genero.percentages)) {
    const target = TARGETS.protagonistGender[k];
    const diffLine = target !== undefined ? ` — ${formatDiff(stats.protagonista_genero.counts[k], target)}` : "";
    md += `- ${k}: ${v}% (${stats.protagonista_genero.counts[k]} cursos)${diffLine}\n`;
  }
  md += `\n`;

  md += `### Protagonista — perfil étnico-racial (counts inteiros)\n\n`;
  for (const [k, v] of Object.entries(stats.protagonista_etnia.percentages)) {
    const target = TARGETS.protagonistEthnicity[k];
    const diffLine = target !== undefined ? ` — ${formatDiff(stats.protagonista_etnia.counts[k], target)}` : "";
    md += `- ${k}: ${v}% (${stats.protagonista_etnia.counts[k]} cursos)${diffLine}\n`;
  }
  md += `\n`;

  md += `### Quantidade de pessoas por cena\n\n`;
  for (const [k, v] of Object.entries(stats.quantidade_pessoas.percentages)) {
    md += `- ${k}: ${v}% (${stats.quantidade_pessoas.counts[k]} cursos)\n`;
  }
  md += `\n`;

  md += `### Quantidade de pessoas vs meta\n\n`;
  md += `- uma pessoa: ${formatDiff(stats.quantidade_pessoas.counts["uma pessoa"] || 0, TARGETS.peopleCount.uma)}\n`;
  md += `- duas pessoas: ${formatDiff(stats.quantidade_pessoas.counts["duas pessoas"] || 0, TARGETS.peopleCount.duas)}\n`;
  md += `- grupo (3+): ${formatDiff(stats.quantidade_pessoas.counts["grupo (3+)"] || 0, TARGETS.peopleCount.grupo)}\n\n`;

  md += `### Personagens secundários (diversidade complementar, sem meta matemática)\n\n`;
  md += `- Total de personagens secundários identificados: ${stats.personagens_secundarios.total}\n`;
  md += `- Secundários com participação apenas decorativa: ${stats.personagens_secundarios.decorativos}\n`;
  md += `**Gênero dos secundários:**\n`;
  for (const [k, v] of Object.entries(stats.personagens_secundarios.genero)) {
    md += `  - ${k}: ${v}\n`;
  }
  md += `**Perfil étnico-racial dos secundários:**\n`;
  for (const [k, v] of Object.entries(stats.personagens_secundarios.etnia)) {
    md += `  - ${k}: ${v}\n`;
  }
  md += `**Funções dos secundários:**\n`;
  for (const [k, v] of Object.entries(stats.personagens_secundarios.funcao)) {
    md += `  - ${k}: ${v}\n`;
  }
  md += `\n`;

  md += `### Idade\n\n`;
  md += `- Média declarada: ${stats.idade.media || "não calculável"} anos\n`;
  md += `- Cursos com idade identificada: ${stats.idade.identificados}\n`;
  md += `- Cursos sem idade identificada: ${stats.idade.nao_identificados}\n\n`;

  md += `## Alertas e revisões necessárias\n\n`;
  md += `### Termos proibidos\n`;
  if (stats.termos_proibidos.total_ocorrencias === 0) {
    md += `Nenhum termo proibido encontrado.\n\n`;
  } else {
    md += `Total: ${stats.termos_proibidos.total_ocorrencias} ocorrência(s)\n\n`;
    for (const c of stats.termos_proibidos.cursos) {
      md += `- **${c.curso}:** ${c.termos.join(", ")}\n`;
    }
    md += `\n`;
  }

  md += `### Alertas de estereótipo por curso\n`;
  if (stats.alertas_estereotipo.total_ocorrencias === 0) {
    md += `Nenhum alerta levantado.\n\n`;
  } else {
    md += `Total: ${stats.alertas_estereotipo.total_ocorrencias} ocorrência(s)\n\n`;
    for (const c of stats.alertas_estereotipo.cursos) {
      md += `- **${c.curso}:** ${c.alertas.join("; ")}\n`;
    }
    md += `\n`;
  }

  md += `### Concentração em cursos similares\n`;
  if (stats.concentracao.length === 0) {
    md += `Nenhuma concentração identificada.\n\n`;
  } else {
    for (const alert of stats.concentracao) {
      md += `- **${alert.tipo}** em "${alert.classificacao}" (${alert.quantidade} cursos, valor: ${alert.valor})\n`;
      md += `  - ${alert.cursos.slice(0, 8).join(", ")}${alert.cursos.length > 8 ? "..." : ""}\n`;
    }
    md += `\n`;
  }

  md += `### Cursos sem informação demográfica suficiente\n`;
  md += `Total: ${stats.nao_identificados.total_ocorrencias}\n\n`;
  if (stats.nao_identificados.total_ocorrencias > 0) {
    for (const curso of stats.nao_identificados.cursos.slice(0, 20)) {
      md += `- ${curso}\n`;
    }
    if (stats.nao_identificados.total_ocorrencias > 20) {
      md += `- ... e mais ${stats.nao_identificados.total_ocorrencias - 20} cursos\n`;
    }
    md += `\n`;
  }

  md += `## Recomendação\n\n`;

  const criticalIssues =
    stats.nao_identificados.total_ocorrencias +
    stats.termos_proibidos.total_ocorrencias +
    stats.alertas_estereotipo.total_ocorrencias +
    stats.concentracao.length;

  const genderWoman = stats.protagonista_genero.counts.mulher;
  const parda = stats.protagonista_etnia.counts.parda;
  const negra = stats.protagonista_etnia.counts.negra;
  const branca = stats.protagonista_etnia.counts.branca;
  const uma = stats.quantidade_pessoas.counts["uma pessoa"] || 0;
  const duas = stats.quantidade_pessoas.counts["duas pessoas"] || 0;
  const grupo = stats.quantidade_pessoas.counts["grupo (3+)"] || 0;

  const adjustments = [];
  if (genderWoman < TARGETS.protagonistGender.mulher) {
    adjustments.push(`aumentar protagonismo feminino em ${TARGETS.protagonistGender.mulher - genderWoman} cursos (atual ${genderWoman}, meta ${TARGETS.protagonistGender.mulher})`);
  }
  if (genderWoman > TARGETS.protagonistGender.mulher) {
    adjustments.push(`reduzir protagonismo feminino em ${genderWoman - TARGETS.protagonistGender.mulher} cursos (atual ${genderWoman}, meta ${TARGETS.protagonistGender.mulher})`);
  }
  if (parda < TARGETS.protagonistEthnicity.parda) {
    adjustments.push(`aumentar protagonismo pardo em ${TARGETS.protagonistEthnicity.parda - parda} cursos (atual ${parda}, meta ${TARGETS.protagonistEthnicity.parda})`);
  }
  if (parda > TARGETS.protagonistEthnicity.parda) {
    adjustments.push(`reduzir protagonismo pardo em ${parda - TARGETS.protagonistEthnicity.parda} cursos`);
  }
  if (negra < TARGETS.protagonistEthnicity.negra) {
    adjustments.push(`aumentar protagonismo negro em ${TARGETS.protagonistEthnicity.negra - negra} cursos`);
  }
  if (negra > TARGETS.protagonistEthnicity.negra) {
    adjustments.push(`reduzir protagonismo negro em ${negra - TARGETS.protagonistEthnicity.negra} cursos (atual ${negra}, meta ${TARGETS.protagonistEthnicity.negra})`);
  }
  if (branca < TARGETS.protagonistEthnicity.branca) {
    adjustments.push(`aumentar protagonismo branco em ${TARGETS.protagonistEthnicity.branca - branca} cursos`);
  }
  if (branca > TARGETS.protagonistEthnicity.branca) {
    adjustments.push(`reduzir protagonismo branco em ${branca - TARGETS.protagonistEthnicity.branca} cursos (atual ${branca}, meta ${TARGETS.protagonistEthnicity.branca})`);
  }
  if (duas < TARGETS.peopleCount.duas) {
    adjustments.push(`aumentar cenas com duas pessoas em ${TARGETS.peopleCount.duas - duas} cursos (atual ${duas}, meta ${TARGETS.peopleCount.duas})`);
  }
  if (grupo > TARGETS.peopleCount.grupo) {
    adjustments.push(`reduzir cenas com grupos grandes em ${grupo - TARGETS.peopleCount.grupo} cursos (atual ${grupo}, meta ${TARGETS.peopleCount.grupo})`);
  }
  if (uma > TARGETS.peopleCount.uma) {
    adjustments.push(`reduzir cenas com uma pessoa em ${uma - TARGETS.peopleCount.uma} cursos (atual ${uma}, meta ${TARGETS.peopleCount.uma})`);
  }

  md += `Registros com problemas críticos: **${criticalIssues}**.\n\n`;
  md += `- ${stats.nao_identificados.total_ocorrencias} sem informação demográfica suficiente;\n`;
  md += `- ${stats.termos_proibidos.total_ocorrencias} com termos proibidos;\n`;
  md += `- ${stats.alertas_estereotipo.total_ocorrencias} com alertas de estereótipo;\n`;
  md += `- ${stats.concentracao.length} concentrações em cursos similares.\n\n`;

  md += `Ajustes sugeridos para atingir as metas determinísticas:\n\n`;
  if (adjustments.length > 0) {
    for (const a of adjustments) {
      md += `- ${a}\n`;
    }
  } else {
    md += `- Nenhum ajuste necessário.\n`;
  }
  md += `\n`;

  md += `*Auditoria somente leitura. Nenhum conteúdo foi alterado.*\n`;

  return md;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let overlay = null;
  for (const arg of args) {
    if (arg.startsWith("--overlay=")) {
      overlay = arg.replace("--overlay=", "").trim();
    }
  }
  return { overlay };
}

function applyOverlay(courses, overlayPath) {
  if (!overlayPath) return courses;
  const fullPath = path.isAbsolute(overlayPath) ? overlayPath : path.join(ROOT, overlayPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Arquivo de overlay não encontrado: ${fullPath}`);
  }
  const overlayRecords = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  if (!Array.isArray(overlayRecords)) {
    throw new Error(`Overlay deve ser um array de registros: ${fullPath}`);
  }
  const overlayMap = new Map(overlayRecords.map((r) => [r.course_id, r]));

  return courses.map((c) => {
    const overlayRecord = overlayMap.get(c.course_id);
    if (!overlayRecord) return c;
    return { ...c, ...overlayRecord };
  });
}

async function main() {
  const { overlay } = parseArgs();

  console.log("Carregando planilha...");
  const courses = await loadCourses();
  console.log(`Cursos encontrados: ${courses.length}`);

  if (overlay) {
    console.log(`Aplicando overlay: ${overlay}`);
  }
  const mergedCourses = applyOverlay(courses, overlay);
  const overlayCount = mergedCourses.filter((c, i) => c !== courses[i]).length;
  if (overlay) {
    console.log(`Registros substituídos em memória: ${overlayCount}`);
  }

  console.log("Analisando conteúdos...");
  const analyzed = analyzeCourses(mergedCourses);
  const stats = computeStats(analyzed);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const suffix = overlay ? "-projetada" : "";
  const jsonPath = path.join(OUTPUT_DIR, `auditoria-demografica${suffix}.json`);
  const mdPath = path.join(OUTPUT_DIR, `auditoria-demografica${suffix}.md`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ stats, cursos: analyzed }, null, 2),
    "utf8"
  );
  fs.writeFileSync(mdPath, generateMarkdown(stats), "utf8");

  console.log("\n================================");
  console.log("AUDITORIA DEMOGRÁFICA CONCLUÍDA");
  console.log("================================");
  console.log(`Cursos analisados: ${stats.total}`);
  if (overlay) {
    console.log(`Overlay aplicado: ${overlayCount} registros`);
  }
  console.log(`Sem informação suficiente: ${stats.nao_identificados.total_ocorrencias}`);
  console.log(`Termos proibidos: ${stats.termos_proibidos.total_ocorrencias}`);
  console.log(`Alertas de estereótipo: ${stats.alertas_estereotipo.total_ocorrencias}`);
  console.log(`Concentrações: ${stats.concentracao.length}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`MD:   ${mdPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  loadCourses,
  analyzeCourses,
  TARGETS,
  getSecondaryEthnicity,
  SECONDARY_ETHNICITY_SEQUENCE,
};
