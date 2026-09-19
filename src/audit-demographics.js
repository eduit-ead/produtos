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

// Metas demográficas globais (soma exata = 128, método dos maiores restos)
const TARGETS = {
  gender: {
    mulher: 77,
    homem: 51,
  },
  ethnicity: {
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

  if (PEOPLE_COUNT_PATTERNS.grupo.test(combined)) return "grupo (3+)";
  if (PEOPLE_COUNT_PATTERNS.duas.test(combined)) return "duas pessoas";

  const pluralSignals = /\b(dois|duas|ambos|ambas|todos|todas|colegas|alunos|estudantes|profissionais)\b/i;
  if (pluralSignals.test(combined)) return "duas ou mais";

  if (/sem personagem principal/i.test(combined)) return "sem personagem";

  return "uma pessoa";
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
  const analyzed = courses.map((course) => {
    const person = course.visual_personagem || "";
    const activity = course.visual_atividade || "";
    const prompt = course.prompt_imagem || "";
    const allText = `${person} ${activity} ${prompt}`;

    const gender = classifyGender(person, activity, prompt);
    const ethnicity = classifyEthnicity(person, prompt);
    const age = extractAge(allText);
    const peopleCount = classifyPeopleCount(person, activity, prompt);
    const diversityInGroup = hasDiversityInGroup(person, activity, prompt);
    const prohibited = findProhibitedTerms(allText);
    const ambiguous = findAmbiguousDemographic(allText);
    const stereotypeAlerts = checkStereotype(course, gender, ethnicity, peopleCount);

    return {
      ...course,
      analise: {
        genero: gender,
        etnia: ethnicity,
        idade: age,
        quantidade_pessoas: peopleCount,
        diversidade_em_grupo: diversityInGroup,
        termos_proibidos: prohibited,
        termos_ambiguos: ambiguous,
        alertas_estereotipo: stereotypeAlerts,
        sem_informacao_suficiente:
          gender === "não identificado" && ethnicity === "não identificado" && age === null,
      },
    };
  });

  return analyzed;
}

function computeStats(analyzed) {
  const total = analyzed.length;
  const withPerson = analyzed.filter((c) => c.analise.quantidade_pessoas !== "sem personagem");
  const totalWithPerson = withPerson.length;

  // Gênero bruto
  const genderCounts = {};
  // Gênero ajustado: coletivo misto conta como 0.5 mulher e 0.5 homem
  const genderAdjusted = { mulher: 0, homem: 0, nao_identificado: 0 };

  // Etnia bruta
  const ethnicityCounts = {};
  // Etnia ajustada: múltiplas etnias são distribuídas igualmente
  const ethnicityAdjusted = { parda: 0, negra: 0, branca: 0, indigena: 0, asiatica: 0, outra: 0, nao_identificado: 0 };

  const peopleCounts = {};
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

    genderCounts[a.genero] = (genderCounts[a.genero] || 0) + 1;
    if (a.genero === "mulher") {
      genderAdjusted.mulher += 1;
    } else if (a.genero === "homem") {
      genderAdjusted.homem += 1;
    } else if (a.genero === "coletivo misto") {
      genderAdjusted.mulher += 0.5;
      genderAdjusted.homem += 0.5;
    } else {
      genderAdjusted.nao_identificado += 1;
    }

    ethnicityCounts[a.etnia] = (ethnicityCounts[a.etnia] || 0) + 1;
    if (a.etnia.startsWith("múltipla")) {
      const parts = a.etnia.replace("múltipla: ", "").split(", ").map((s) => s.trim());
      const weight = 1 / parts.length;
      for (const part of parts) {
        const key = part === "outra" ? "outra" : part;
        if (ethnicityAdjusted[key] !== undefined) {
          ethnicityAdjusted[key] += weight;
        } else {
          ethnicityAdjusted.outra += weight;
        }
      }
    } else if (a.etnia === "não identificado") {
      ethnicityAdjusted.nao_identificado += 1;
    } else if (ethnicityAdjusted[a.etnia] !== undefined) {
      ethnicityAdjusted[a.etnia] += 1;
    } else {
      ethnicityAdjusted.outra += 1;
    }

    peopleCounts[a.quantidade_pessoas] = (peopleCounts[a.quantidade_pessoas] || 0) + 1;

    if (a.idade !== null) ageSum.push(a.idade);
    else ageMissing.push(c);

    if (a.sem_informacao_suficiente) noInfo.push(c);
    if (a.termos_proibidos.length > 0) prohibitedHits.push(c);
    if (a.termos_ambiguos.length > 0) ambiguousHits.push(c);
    if (a.alertas_estereotipo.length > 0) stereotypeHits.push(c);
    if (a.diversidade_em_grupo && a.quantidade_pessoas !== "uma pessoa" && a.quantidade_pessoas !== "sem personagem") {
      groupDiversity.push(c);
    }

    if (a.genero === "não identificado" && a.etnia === "não identificado" && a.idade === null) {
      unidentified.push(c);
    }
  }

  const avgAge = ageSum.length > 0 ? ageSum.reduce((a, b) => a + b, 0) / ageSum.length : 0;

  // Concentração de características em cursos similares
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
    const genderMono = items.every((c) => c.analise.genero === items[0].analise.genero);
    const ethMono = items.every((c) => c.analise.etnia === items[0].analise.etnia);

    if (genderMono && items[0].analise.genero !== "não identificado") {
      concentrationAlerts.push({
        tipo: "gênero idêntico na classificação",
        classificacao: cls,
        valor: items[0].analise.genero,
        quantidade: items.length,
        cursos: items.map((c) => c.curso),
      });
    }
    if (ethMono && items[0].analise.etnia !== "não identificado") {
      concentrationAlerts.push({
        tipo: "etnia idêntica na classificação",
        classificacao: cls,
        valor: items[0].analise.etnia,
        quantidade: items.length,
        cursos: items.map((c) => c.curso),
      });
    }
  }

  return {
    total,
    total_com_personagem: totalWithPerson,
    genero: { counts: genderCounts, percentages: Object.fromEntries(
      Object.entries(genderCounts).map(([k, v]) => [k, percentage(v, total)])
    ) },
    genero_ajustado: {
      counts: genderAdjusted,
      percentages: Object.fromEntries(
        Object.entries(genderAdjusted).map(([k, v]) => [k, percentage(v, total)])
      ),
    },
    etnia: { counts: ethnicityCounts, percentages: Object.fromEntries(
      Object.entries(ethnicityCounts).map(([k, v]) => [k, percentage(v, total)])
    ) },
    etnia_ajustada: {
      counts: ethnicityAdjusted,
      percentages: Object.fromEntries(
        Object.entries(ethnicityAdjusted).map(([k, v]) => [k, percentage(v, total)])
      ),
    },
    quantidade_pessoas: { counts: peopleCounts, percentages: Object.fromEntries(
      Object.entries(peopleCounts).map(([k, v]) => [k, percentage(v, total)])
    ) },
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
  return `${current.toFixed(1)}/${target} (${sign}${diff.toFixed(1)})`;
}

function generateMarkdown(stats) {
  let md = `# Auditoria Demográfica dos Cursos\n\n`;
  md += `**Total de cursos analisados:** ${stats.total}\n\n`;

  md += `## Metas globais (counts determinísticos, soma = 128)\n\n`;
  md += `### Gênero\n`;
  md += `- Mulher: ${TARGETS.gender.mulher}\n`;
  md += `- Homem: ${TARGETS.gender.homem}\n\n`;
  md += `### Perfil étnico-racial\n`;
  md += `- Parda: ${TARGETS.ethnicity.parda}\n`;
  md += `- Negra: ${TARGETS.ethnicity.negra}\n`;
  md += `- Branca: ${TARGETS.ethnicity.branca}\n`;
  md += `- Outra (indígena, asiática etc.): ${TARGETS.ethnicity.outra}\n\n`;
  md += `### Quantidade de pessoas\n`;
  md += `- Uma pessoa: ${TARGETS.peopleCount.uma}\n`;
  md += `- Duas pessoas: ${TARGETS.peopleCount.duas}\n`;
  md += `- Grupo (3+): ${TARGETS.peopleCount.grupo}\n\n`;

  md += `## Resultado geral\n\n`;

  md += `### Gênero (classificação bruta)\n\n`;
  for (const [k, v] of Object.entries(stats.genero.percentages)) {
    md += `- ${k}: ${v}% (${stats.genero.counts[k]} cursos)\n`;
  }
  md += `\n`;

  md += `### Gênero ajustado (coletivos mistos contados como 0.5 mulher + 0.5 homem)\n\n`;
  md += `- mulher: ${stats.genero_ajustado.percentages.mulher}% (${stats.genero_ajustado.counts.mulher.toFixed(1)}) — ${formatDiff(stats.genero_ajustado.counts.mulher, TARGETS.gender.mulher)}\n`;
  md += `- homem: ${stats.genero_ajustado.percentages.homem}% (${stats.genero_ajustado.counts.homem.toFixed(1)}) — ${formatDiff(stats.genero_ajustado.counts.homem, TARGETS.gender.homem)}\n`;
  md += `\n`;

  md += `### Perfil étnico-racial ajustado (múltiplas identidades distribuídas igualmente no curso)\n\n`;
  for (const [k, target] of Object.entries(TARGETS.ethnicity)) {
    const current = stats.etnia_ajustada.counts[k] || 0;
    md += `- ${k}: ${stats.etnia_ajustada.percentages[k] || "0.00"}% (${current.toFixed(1)}) — ${formatDiff(current, target)}\n`;
  }
  md += `\n`;

  md += `### Etnia (classificação bruta)\n\n`;
  for (const [k, v] of Object.entries(stats.etnia.percentages)) {
    md += `- ${k}: ${v}% (${stats.etnia.counts[k]} cursos)\n`;
  }
  md += `\n`;

  md += `### Quantidade de pessoas\n\n`;
  for (const [k, v] of Object.entries(stats.quantidade_pessoas.percentages)) {
    md += `- ${k}: ${v}% (${stats.quantidade_pessoas.counts[k]} cursos)\n`;
  }
  md += `\n`;

  md += `### Quantidade de pessoas vs meta\n\n`;
  md += `- uma pessoa: ${formatDiff(stats.quantidade_pessoas.counts["uma pessoa"] || 0, TARGETS.peopleCount.uma)}\n`;
  md += `- duas pessoas: ${formatDiff(stats.quantidade_pessoas.counts["duas pessoas"] || 0, TARGETS.peopleCount.duas)}\n`;
  md += `- grupo (3+): ${formatDiff(stats.quantidade_pessoas.counts["grupo (3+)"] || 0, TARGETS.peopleCount.grupo)}\n\n`;

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

  const genderWoman = stats.genero_ajustado.counts.mulher;
  const parda = stats.etnia_ajustada.counts.parda;
  const negra = stats.etnia_ajustada.counts.negra;
  const branca = stats.etnia_ajustada.counts.branca;
  const uma = stats.quantidade_pessoas.counts["uma pessoa"] || 0;
  const duas = stats.quantidade_pessoas.counts["duas pessoas"] || 0;
  const grupo = stats.quantidade_pessoas.counts["grupo (3+)"] || 0;

  const adjustments = [];
  if (genderWoman < TARGETS.gender.mulher) {
    adjustments.push(`aumentar protagonismo feminino em ${(TARGETS.gender.mulher - genderWoman).toFixed(1)} cursos (atual ${genderWoman.toFixed(1)}, meta ${TARGETS.gender.mulher})`);
  }
  if (genderWoman > TARGETS.gender.mulher) {
    adjustments.push(`reduzir protagonismo feminino em ${(genderWoman - TARGETS.gender.mulher).toFixed(1)} cursos (atual ${genderWoman.toFixed(1)}, meta ${TARGETS.gender.mulher})`);
  }
  if (parda < TARGETS.ethnicity.parda) {
    adjustments.push(`aumentar representação parda em ${(TARGETS.ethnicity.parda - parda).toFixed(1)} cursos (atual ${parda.toFixed(1)}, meta ${TARGETS.ethnicity.parda})`);
  }
  if (parda > TARGETS.ethnicity.parda) {
    adjustments.push(`reduzir representação parda em ${(parda - TARGETS.ethnicity.parda).toFixed(1)} cursos`);
  }
  if (negra < TARGETS.ethnicity.negra) {
    adjustments.push(`aumentar representação negra em ${(TARGETS.ethnicity.negra - negra).toFixed(1)} cursos`);
  }
  if (negra > TARGETS.ethnicity.negra) {
    adjustments.push(`reduzir representação negra em ${(negra - TARGETS.ethnicity.negra).toFixed(1)} cursos (atual ${negra.toFixed(1)}, meta ${TARGETS.ethnicity.negra})`);
  }
  if (branca < TARGETS.ethnicity.branca) {
    adjustments.push(`aumentar representação branca em ${(TARGETS.ethnicity.branca - branca).toFixed(1)} cursos`);
  }
  if (branca > TARGETS.ethnicity.branca) {
    adjustments.push(`reduzir representação branca em ${(branca - TARGETS.ethnicity.branca).toFixed(1)} cursos (atual ${branca.toFixed(1)}, meta ${TARGETS.ethnicity.branca})`);
  }
  if (duas < TARGETS.peopleCount.duas) {
    adjustments.push(`aumentar cenas com duas pessoas em ${(TARGETS.peopleCount.duas - duas).toFixed(1)} cursos (atual ${duas}, meta ${TARGETS.peopleCount.duas})`);
  }
  if (grupo > TARGETS.peopleCount.grupo) {
    adjustments.push(`reduzir cenas com grupos grandes em ${(grupo - TARGETS.peopleCount.grupo).toFixed(1)} cursos (atual ${grupo}, meta ${TARGETS.peopleCount.grupo})`);
  }
  if (uma > TARGETS.peopleCount.uma) {
    adjustments.push(`reduzir cenas com uma pessoa em ${(uma - TARGETS.peopleCount.uma).toFixed(1)} cursos (atual ${uma}, meta ${TARGETS.peopleCount.uma})`);
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

async function main() {
  console.log("Carregando planilha...");
  const courses = await loadCourses();
  console.log(`Cursos encontrados: ${courses.length}`);

  console.log("Analisando conteúdos...");
  const analyzed = analyzeCourses(courses);
  const stats = computeStats(analyzed);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const jsonPath = path.join(OUTPUT_DIR, "auditoria-demografica.json");
  const mdPath = path.join(OUTPUT_DIR, "auditoria-demografica.md");

  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ stats, cursos: analyzed }, null, 2),
    "utf8"
  );
  fs.writeFileSync(mdPath, generateMarkdown(stats, analyzed), "utf8");

  console.log("\n================================");
  console.log("AUDITORIA DEMOGRÁFICA CONCLUÍDA");
  console.log("================================");
  console.log(`Cursos analisados: ${stats.total}`);
  console.log(`Sem informação suficiente: ${stats.nao_identificados.total_ocorrencias}`);
  console.log(`Termos proibidos: ${stats.termos_proibidos.total_ocorrencias}`);
  console.log(`Alertas de estereótipo: ${stats.alertas_estereotipo.total_ocorrencias}`);
  console.log(`Concentrações: ${stats.concentracao.length}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`MD:   ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
