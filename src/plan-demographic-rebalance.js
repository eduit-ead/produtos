/**
 * Plano determinístico de reequilíbrio demográfico dos 128 cursos.
 *
 * Lê a auditoria demográfica, seleciona o menor número possível de cursos
 * para aproximar as metas determinísticas e gera instruções de revisão.
 *
 * Não modifica a planilha nem os conteúdos.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const AUDIT_FILE = path.join(ROOT, "output", "ai-pilot", "auditoria-demografica.json");
const OUTPUT_DIR = path.join(ROOT, "output", "ai-pilot");

const TARGETS = {
  protagonistGender: { mulher: 77, homem: 51 },
  protagonistEthnicity: { parda: 58, negra: 32, branca: 32, outra: 6 },
  peopleCount: { uma: 90, duas: 32, grupo: 6 },
};

const PRESERVED_SLUGS = new Set([
  "artes-visuais",
  "ciberseguranca",
  "nutricao",
  "gestao-publica",
]);

const GENDER_ACTIONS = [
  { name: "homem → mulher", delta: { mulher: 1, homem: -1 } },
  { name: "mulher → homem", delta: { mulher: -1, homem: 1 } },
];

const ETHNICITY_ACTIONS = [
  { name: "branca → parda", delta: { parda: 1, branca: -1 } },
  { name: "negra → parda", delta: { parda: 1, negra: -1 } },
  { name: "parda → negra", delta: { negra: 1, parda: -1 } },
  { name: "parda → branca", delta: { branca: 1, parda: -1 } },
  { name: "branca → negra", delta: { negra: 1, branca: -1 } },
  { name: "negra → branca", delta: { branca: 1, negra: -1 } },
  { name: "branca → outra (indígena/asiática)", delta: { outra: 1, branca: -1 } },
  { name: "negra → outra (indígena/asiática)", delta: { outra: 1, negra: -1 } },
  { name: "parda → outra (indígena/asiática)", delta: { outra: 1, parda: -1 } },
  { name: "outra → parda", delta: { parda: 1, outra: -1 } },
  { name: "outra → negra", delta: { negra: 1, outra: -1 } },
  { name: "outra → branca", delta: { branca: 1, outra: -1 } },
];

const PEOPLE_ACTIONS = [
  { name: "uma pessoa → duas pessoas", delta: { duas: 1, uma: -1 } },
  { name: "grupo → duas pessoas", delta: { duas: 1, grupo: -1 } },
  { name: "uma pessoa → grupo", delta: { grupo: 1, uma: -1 } },
  { name: "duas pessoas → uma pessoa", delta: { uma: 1, duas: -1 } },
  { name: "duas pessoas → grupo", delta: { grupo: 1, duas: -1 } },
  { name: "grupo → uma pessoa", delta: { uma: 1, grupo: -1 } },
];

function loadAudit() {
  if (!fs.existsSync(AUDIT_FILE)) {
    throw new Error(`Arquivo de auditoria não encontrado: ${AUDIT_FILE}`);
  }
  return JSON.parse(fs.readFileSync(AUDIT_FILE, "utf8"));
}

function deriveProposta(atual, acoes) {
  const proposta = {
    genero: atual.genero,
    etnia: atual.etnia,
    quantidade_pessoas: atual.quantidade_pessoas,
  };
  for (const acao of acoes) {
    if (acao === "homem → mulher") {
      proposta.genero = "mulher";
    } else if (acao === "mulher → homem") {
      proposta.genero = "homem";
    } else if (acao.includes("→ parda")) {
      proposta.etnia = "parda";
    } else if (acao.includes("→ negra")) {
      proposta.etnia = "negra";
    } else if (acao.includes("→ branca")) {
      proposta.etnia = "branca";
    } else if (acao.includes("→ outra")) {
      proposta.etnia = "outra (indígena/asiática)";
    } else if (acao === "uma pessoa → duas pessoas" || acao === "grupo → duas pessoas") {
      proposta.quantidade_pessoas = "duas pessoas";
    } else if (acao === "uma pessoa → grupo" || acao === "duas pessoas → grupo") {
      proposta.quantidade_pessoas = "grupo (3+)";
    } else if (acao === "duas pessoas → uma pessoa" || acao === "grupo → uma pessoa") {
      proposta.quantidade_pessoas = "uma pessoa";
    }
  }
  return proposta;
}

function absSum(deficits) {
  return Object.values(deficits).reduce((a, b) => a + Math.abs(b), 0);
}

function applyAction(state, actionDelta) {
  for (const [key, value] of Object.entries(actionDelta)) {
    state[key] = (state[key] || 0) + value;
  }
}

function computeBenefit(currentDeficits, actionDelta) {
  const before = absSum(currentDeficits);
  const simulated = { ...currentDeficits };
  applyAction(simulated, actionDelta);
  const after = absSum(simulated);
  return before - after;
}

function findBestCourseAction(course, currentDeficits) {
  const gender = course.analise.protagonista.genero;
  const ethnicity = course.analise.protagonista.perfil_etnico_racial;
  const people = course.analise.quantidade_pessoas;

  let bestBenefit = 0;
  let bestActions = [];

  const genderOptions = [null, ...GENDER_ACTIONS.filter((a) => a.name.startsWith(`${gender} →`))];
  const ethnicityOptions = [null, ...ETHNICITY_ACTIONS.filter((a) => a.name.startsWith(`${ethnicity} →`))];
  const peopleOptions = [null, ...PEOPLE_ACTIONS.filter((a) => a.name.startsWith(`${people.replace(" (3+)", "")} →`))];

  for (const g of genderOptions) {
    for (const e of ethnicityOptions) {
      for (const p of peopleOptions) {
        const actions = [g, e, p].filter(Boolean);
        if (actions.length === 0) continue;

        const delta = {};
        for (const action of actions) {
          for (const [k, v] of Object.entries(action.delta)) {
            delta[k] = (delta[k] || 0) + v;
          }
        }

        const benefit = computeBenefit(currentDeficits, delta);
        if (benefit > bestBenefit) {
          bestBenefit = benefit;
          bestActions = actions.map((a) => a.name);
        }
      }
    }
  }

  return { benefit: bestBenefit, actions: bestActions };
}

function buildPlan(courses) {
  const eligible = courses
    .filter((c) => !PRESERVED_SLUGS.has(c.slug))
    .sort((a, b) => a.course_id.localeCompare(b.course_id));

  // Deficits = atual - meta. Valor negativo indica necessidade de aumentar;
  // valor positivo indica excesso a reduzir.
  const totals = {
    mulher: courses.filter((c) => c.analise.protagonista.genero === "mulher").length,
    homem: courses.filter((c) => c.analise.protagonista.genero === "homem").length,
    parda: courses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "parda").length,
    negra: courses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "negra").length,
    branca: courses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "branca").length,
    outra: courses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "outra").length,
    uma: courses.filter((c) => c.analise.quantidade_pessoas === "uma pessoa").length,
    duas: courses.filter((c) => c.analise.quantidade_pessoas === "duas pessoas").length,
    grupo: courses.filter((c) => c.analise.quantidade_pessoas === "grupo (3+)").length,
  };

  const deficits = {
    mulher: totals.mulher - TARGETS.protagonistGender.mulher,
    homem: totals.homem - TARGETS.protagonistGender.homem,
    parda: totals.parda - TARGETS.protagonistEthnicity.parda,
    negra: totals.negra - TARGETS.protagonistEthnicity.negra,
    branca: totals.branca - TARGETS.protagonistEthnicity.branca,
    outra: totals.outra - TARGETS.protagonistEthnicity.outra,
    uma: totals.uma - TARGETS.peopleCount.uma,
    duas: totals.duas - TARGETS.peopleCount.duas,
    grupo: totals.grupo - TARGETS.peopleCount.grupo,
  };

  const selected = [];
  const remaining = [...eligible];
  const classSelectionCounts = {};
  const MAX_PER_CLASSIFICATION = 7;

  function runSelectionRound(applyDiversityLimit) {
    while (absSum(deficits) > 0 && remaining.length > 0) {
      let bestIndex = -1;
      let bestBenefit = 0;
      let bestActions = [];

      for (let i = 0; i < remaining.length; i++) {
        const course = remaining[i];
        const cls = course.classificacao || "Sem classificação";
        const clsCount = classSelectionCounts[cls] || 0;

        const { benefit, actions } = findBestCourseAction(course, deficits);
        const diversityPenalty = applyDiversityLimit && clsCount >= MAX_PER_CLASSIFICATION ? -Infinity : 0;
        const adjustedBenefit = benefit + diversityPenalty;

        if (adjustedBenefit > bestBenefit) {
          bestBenefit = adjustedBenefit;
          bestIndex = i;
          bestActions = actions;
        }
      }

      if (bestBenefit <= 0) break;

      const course = remaining[bestIndex];
      classSelectionCounts[course.classificacao || "Sem classificação"] =
        (classSelectionCounts[course.classificacao || "Sem classificação"] || 0) + 1;
      remaining.splice(bestIndex, 1);

      selected.push({
      course_id: course.course_id,
      slug: course.slug,
      curso: course.curso,
      classificacao: course.classificacao,
      acoes: bestActions,
      analise_atual: {
        genero: course.analise.protagonista.genero,
        etnia: course.analise.protagonista.perfil_etnico_racial,
        quantidade_pessoas: course.analise.quantidade_pessoas,
      },
      prompt_imagem: course.prompt_imagem,
      visual_personagem: course.visual_personagem,
      visual_atividade: course.visual_atividade,
    });

    // Recalcular delta combinado das ações selecionadas e aplicar nos deficits
    const delta = {};
    const allActions = [...GENDER_ACTIONS, ...ETHNICITY_ACTIONS, ...PEOPLE_ACTIONS];
    for (const actionName of bestActions) {
      const action = allActions.find((a) => a.name === actionName);
      if (action) {
        for (const [k, v] of Object.entries(action.delta)) {
          delta[k] = (delta[k] || 0) + v;
        }
      }
    }
      applyAction(deficits, delta);
    }
  }

  runSelectionRound(true);
  runSelectionRound(false);

  return { selected, finalDeficits: deficits };
}

function distributionAfterPlan(initialCourses, selected) {
  const totals = {
    mulher: initialCourses.filter((c) => c.analise.protagonista.genero === "mulher").length,
    homem: initialCourses.filter((c) => c.analise.protagonista.genero === "homem").length,
    parda: initialCourses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "parda").length,
    negra: initialCourses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "negra").length,
    branca: initialCourses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "branca").length,
    outra: initialCourses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "outra").length,
    uma: initialCourses.filter((c) => c.analise.quantidade_pessoas === "uma pessoa").length,
    duas: initialCourses.filter((c) => c.analise.quantidade_pessoas === "duas pessoas").length,
    grupo: initialCourses.filter((c) => c.analise.quantidade_pessoas === "grupo (3+)").length,
  };

  const allActions = [...GENDER_ACTIONS, ...ETHNICITY_ACTIONS, ...PEOPLE_ACTIONS];
  for (const s of selected) {
    for (const actionName of s.acoes) {
      const action = allActions.find((a) => a.name === actionName);
      if (action) {
        for (const [k, v] of Object.entries(action.delta)) {
          totals[k] += v;
        }
      }
    }
  }

  return totals;
}

function generateMarkdown(plan, projected) {
  let md = `# Plano de Reequilíbrio Demográfico\n\n`;
  md += `**Total de cursos:** 128\n`;
  md += `**Cursos preservados (pilotos):** ${Array.from(PRESERVED_SLUGS).join(", ")}\n`;
  md += `**Cursos selecionados para revisão:** ${plan.length}\n\n`;

  md += `## Metas determinísticas (counts inteiros, soma = 128)\n\n`;
  md += `### Protagonista — gênero\n`;
  md += `- Mulheres: ${TARGETS.protagonistGender.mulher}\n`;
  md += `- Homens: ${TARGETS.protagonistGender.homem}\n\n`;
  md += `### Protagonista — perfil étnico-racial\n`;
  md += `- Pardas: ${TARGETS.protagonistEthnicity.parda}\n`;
  md += `- Negras: ${TARGETS.protagonistEthnicity.negra}\n`;
  md += `- Brancas: ${TARGETS.protagonistEthnicity.branca}\n`;
  md += `- Outras: ${TARGETS.protagonistEthnicity.outra}\n\n`;
  md += `### Quantidade de pessoas\n`;
  md += `- Uma pessoa: ${TARGETS.peopleCount.uma}\n`;
  md += `- Duas pessoas: ${TARGETS.peopleCount.duas}\n`;
  md += `- Grupo (3+): ${TARGETS.peopleCount.grupo}\n\n`;

  md += `## Distribuição anterior vs projetada\n\n`;
  md += `| Dimensão | Anterior | Projetada | Meta |\n`;
  md += `|----------|----------|-----------|------|\n`;
  md += `| Mulheres | ${plan._initial.mulher} | ${projected.mulher} | ${TARGETS.protagonistGender.mulher} |\n`;
  md += `| Homens | ${plan._initial.homem} | ${projected.homem} | ${TARGETS.protagonistGender.homem} |\n`;
  md += `| Pardas | ${plan._initial.parda} | ${projected.parda} | ${TARGETS.protagonistEthnicity.parda} |\n`;
  md += `| Negras | ${plan._initial.negra} | ${projected.negra} | ${TARGETS.protagonistEthnicity.negra} |\n`;
  md += `| Brancas | ${plan._initial.branca} | ${projected.branca} | ${TARGETS.protagonistEthnicity.branca} |\n`;
  md += `| Outras | ${plan._initial.outra} | ${projected.outra} | ${TARGETS.protagonistEthnicity.outra} |\n`;
  md += `| Uma pessoa | ${plan._initial.uma} | ${projected.uma} | ${TARGETS.peopleCount.uma} |\n`;
  md += `| Duas pessoas | ${plan._initial.duas} | ${projected.duas} | ${TARGETS.peopleCount.duas} |\n`;
  md += `| Grupo (3+) | ${plan._initial.grupo} | ${projected.grupo} | ${TARGETS.peopleCount.grupo} |\n\n`;

  const genderSum = projected.mulher + projected.homem;
  const ethnicitySum = projected.parda + projected.negra + projected.branca + projected.outra;
  const peopleSum = projected.uma + projected.duas + projected.grupo;
  const dimensionsClose128 = genderSum === 128 && ethnicitySum === 128 && peopleSum === 128;

  const residuals = [];
  if (projected.negra !== TARGETS.protagonistEthnicity.negra) residuals.push(`negra ${projected.negra}/${TARGETS.protagonistEthnicity.negra}`);
  if (projected.branca !== TARGETS.protagonistEthnicity.branca) residuals.push(`branca ${projected.branca}/${TARGETS.protagonistEthnicity.branca}`);
  if (projected.parda !== TARGETS.protagonistEthnicity.parda) residuals.push(`parda ${projected.parda}/${TARGETS.protagonistEthnicity.parda}`);
  if (projected.outra !== TARGETS.protagonistEthnicity.outra) residuals.push(`outra ${projected.outra}/${TARGETS.protagonistEthnicity.outra}`);

  md += `**Soma das dimensões = 128:** ${dimensionsClose128 ? "Sim" : "Não"}\n\n`;
  md += residuals.length > 0
    ? `**Ajustes residuais:** ${residuals.join(", ")}.\n\n`
    : "**Nenhum ajuste residual identificado.**\n\n";

  md += `## Cursos selecionados (${plan.length})\n\n`;
  for (const s of plan) {
    const proposta = deriveProposta(s.analise_atual, s.acoes);
    md += `### ${s.curso} (${s.slug})\n\n`;
    md += `- **course_id:** ${s.course_id}\n`;
    md += `- **Classificação do curso:** ${s.classificacao || "—"}\n`;
    md += `- **Classificação atual:** gênero=${s.analise_atual.genero}, etnia=${s.analise_atual.etnia}, pessoas=${s.analise_atual.quantidade_pessoas}\n`;
    md += `- **Classificação proposta:** gênero=${proposta.genero}, etnia=${proposta.etnia}, pessoas=${proposta.quantidade_pessoas}\n`;
    md += `- **Ações propostas:** ${s.acoes.join("; ")}\n`;
    md += `- **Motivos da seleção:** ${s.acoes.map((a) => `Corrigir desequilíbrio: ${a}.`).join(" ")}\n`;
    md += `- **Campos que futuramente precisariam ser revisados:** \`visual_personagem\`, \`visual_atividade\`, \`prompt_imagem\`\n`;
    md += `- **Atividade e ambiente a preservar:** atividade central, ambiente, tema, objetos e identidade do curso.\n`;
    md += `- **Instrução textual objetiva:** Reescrever visual_personagem, visual_atividade e prompt_imagem mantendo atividade, ambiente, tema e objetos; aplicar: ${s.acoes.join("; ")}.\n\n`;
  }

  const targetsMet =
    projected.mulher === TARGETS.protagonistGender.mulher &&
    projected.homem === TARGETS.protagonistGender.homem &&
    projected.parda === TARGETS.protagonistEthnicity.parda &&
    projected.negra === TARGETS.protagonistEthnicity.negra &&
    projected.branca === TARGETS.protagonistEthnicity.branca &&
    projected.outra === TARGETS.protagonistEthnicity.outra &&
    projected.uma === TARGETS.peopleCount.uma &&
    projected.duas === TARGETS.peopleCount.duas &&
    projected.grupo === TARGETS.peopleCount.grupo;

  const combinedCount = plan.filter((s) => s.acoes.length >= 2).length;
  const combinedByDimension = {
    3: plan.filter((s) => s.acoes.length === 3).length,
    2: plan.filter((s) => s.acoes.length === 2).length,
    1: plan.filter((s) => s.acoes.length === 1).length,
  };

  md += `## Resumo executivo\n\n`;
  md += `- Cursos selecionados: **${plan.length}**\n`;
  md += `- Pilotos preservados: **${PRESERVED_SLUGS.size}**\n`;
  md += `- Ajustes combinados (≥2 dimensões): **${combinedCount}** (${combinedByDimension[3]} de 3 dimensões, ${combinedByDimension[2]} de 2 dimensões, ${combinedByDimension[1]} de 1 dimensão)\n`;
  md += `- Soma das dimensões = 128: **${dimensionsClose128 ? "sim" : "não"}**\n`;
  md += `- Metas individuais atingidas: **${targetsMet ? "sim" : "parcial"}**\n`;
  md += `- Nenhuma descrição curta alterada\n`;
  md += `- Nenhum conteúdo modificado automaticamente\n\n`;

  md += `*Plano gerado de forma determinística, ordenado por course_id. Nenhum conteúdo foi alterado.*\n`;

  return md;
}

function main() {
  const audit = loadAudit();
  const courses = audit.cursos;

  const initialTotals = {
    mulher: courses.filter((c) => c.analise.protagonista.genero === "mulher").length,
    homem: courses.filter((c) => c.analise.protagonista.genero === "homem").length,
    parda: courses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "parda").length,
    negra: courses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "negra").length,
    branca: courses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "branca").length,
    outra: courses.filter((c) => c.analise.protagonista.perfil_etnico_racial === "outra").length,
    uma: courses.filter((c) => c.analise.quantidade_pessoas === "uma pessoa").length,
    duas: courses.filter((c) => c.analise.quantidade_pessoas === "duas pessoas").length,
    grupo: courses.filter((c) => c.analise.quantidade_pessoas === "grupo (3+)").length,
  };

  const { selected, finalDeficits } = buildPlan(courses);
  const projected = distributionAfterPlan(courses, selected);

  const combinedCount = selected.filter((s) => s.acoes.length >= 2).length;
  const combinedByDimension = {
    3: selected.filter((s) => s.acoes.length === 3).length,
    2: selected.filter((s) => s.acoes.length === 2).length,
    1: selected.filter((s) => s.acoes.length === 1).length,
  };

  const planData = {
    gerado_em: new Date().toISOString(),
    metas: TARGETS,
    cursos_preservados: Array.from(PRESERVED_SLUGS),
    total_cursos: courses.length,
    cursos_selecionados: selected.length,
    ajustes_combinados_total: combinedCount,
    ajustes_combinados_por_dimensao: combinedByDimension,
    distribuicao_anterior: initialTotals,
    distribuicao_projetada: projected,
    deficits_finais: finalDeficits,
    metas_nao_atingidas: [
      ...(projected.negra !== TARGETS.protagonistEthnicity.negra ? ["negra"] : []),
      ...(projected.branca !== TARGETS.protagonistEthnicity.branca ? ["branca"] : []),
      ...(projected.parda !== TARGETS.protagonistEthnicity.parda ? ["parda"] : []),
      ...(projected.outra !== TARGETS.protagonistEthnicity.outra ? ["outra"] : []),
    ],
    cursos: selected.map((s) => ({
      course_id: s.course_id,
      slug: s.slug,
      curso: s.curso,
      classificacao: s.classificacao,
      classificacao_atual: {
        genero: s.analise_atual.genero,
        etnia: s.analise_atual.etnia,
        quantidade_pessoas: s.analise_atual.quantidade_pessoas,
      },
      classificacao_proposta: deriveProposta(s.analise_atual, s.acoes),
      acoes: s.acoes,
      motivos_selecao: [
        "Ajustar distribuição demográfica global sem perder identidade do curso.",
        ...s.acoes.map((a) => `Corrigir desequilíbrio: ${a}.`),
      ],
      campos_revisar: ["visual_personagem", "visual_atividade", "prompt_imagem"],
      atividade_ambiente_preservar: "Manter atividade central, ambiente, tema, objetos e identidade do curso.",
      instrucao_textual: `Reescrever visual_personagem, visual_atividade e prompt_imagem mantendo atividade, ambiente, tema e objetos; aplicar: ${s.acoes.join("; ")}.`,
    })),
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const jsonPath = path.join(OUTPUT_DIR, "plano-reequilibrio-demografico.json");
  const mdPath = path.join(OUTPUT_DIR, "plano-reequilibrio-demografico.md");

  fs.writeFileSync(jsonPath, JSON.stringify(planData, null, 2), "utf8");

  selected._initial = initialTotals;
  fs.writeFileSync(mdPath, generateMarkdown(selected, projected), "utf8");

  console.log("\n================================");
  console.log("PLANO DE REEQUILÍBRIO CONCLUÍDO");
  console.log("================================");
  console.log(`Cursos selecionados: ${selected.length}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`MD:   ${mdPath}`);

  console.log("\nDistribuição anterior:");
  for (const [k, v] of Object.entries(initialTotals)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log("\nDistribuição projetada:");
  for (const [k, v] of Object.entries(projected)) {
    const target =
      TARGETS.protagonistGender[k] || TARGETS.protagonistEthnicity[k] || TARGETS.peopleCount[k];
    console.log(`  ${k}: ${v}${target !== undefined ? ` / ${target}` : ""}`);
  }
}

main();
