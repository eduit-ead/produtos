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
  gender: { mulher: 77, homem: 51 },
  ethnicity: { parda: 58, negra: 32, branca: 32, outra: 6 },
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
  { name: "coletivo misto → mulher", delta: { mulher: 0.5, homem: -0.5 } },
  { name: "mulher → homem", delta: { mulher: -1, homem: 1 } },
  { name: "coletivo misto → homem", delta: { mulher: -0.5, homem: 0.5 } },
];

const ETHNICITY_ACTIONS = [
  { name: "branca → parda", delta: { parda: 1, branca: -1 } },
  { name: "negra → parda", delta: { parda: 1, negra: -1 } },
  { name: "parda → negra", delta: { negra: 1, parda: -1 } },
  { name: "parda → branca", delta: { branca: 1, parda: -1 } },
  { name: "branca → negra", delta: { negra: 1, branca: -1 } },
  { name: "negra → branca", delta: { branca: 1, negra: -1 } },
  { name: "qualquer → outra (indígena/asiática)", delta: { outra: 1, parda: -0.34, negra: -0.33, branca: -0.33 } },
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

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deriveProposta(atual, acoes) {
  const proposta = {
    genero: atual.genero,
    etnia: atual.etnia,
    quantidade_pessoas: atual.quantidade_pessoas,
  };
  for (const acao of acoes) {
    if (acao === "homem → mulher" || acao === "coletivo misto → mulher") {
      proposta.genero = "mulher";
    } else if (acao === "mulher → homem" || acao === "coletivo misto → homem") {
      proposta.genero = "homem";
    } else if (acao.includes("→ parda")) {
      proposta.etnia = "parda";
    } else if (acao.includes("→ negra")) {
      proposta.etnia = "negra";
    } else if (acao.includes("→ branca")) {
      proposta.etnia = "branca";
    } else if (acao.includes("qualquer → outra")) {
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
  const gender = course.analise.genero;
  const people = course.analise.quantidade_pessoas;
  let ethnicityKey = "outra";
  const etnia = course.analise.etnia;
  if (etnia === "parda") ethnicityKey = "parda";
  else if (etnia === "negra") ethnicityKey = "negra";
  else if (etnia === "branca") ethnicityKey = "branca";

  let bestBenefit = 0;
  let bestActions = [];

  // Gerar todas as combinações de ações possíveis para este curso
  const genderOptions = GENDER_ACTIONS.filter((a) => {
    if (gender === "mulher") return a.name.includes("mulher →") || a.name.includes("coletivo misto → mulher");
    if (gender === "homem") return a.name.includes("homem →") || a.name.includes("coletivo misto → homem");
    if (gender === "coletivo misto") return a.name.startsWith("coletivo misto →");
    return false;
  });

  const ethnicityOptions = ETHNICITY_ACTIONS.filter((a) => {
    if (ethnicityKey === "parda") return a.name.startsWith("parda →");
    if (ethnicityKey === "negra") return a.name.startsWith("negra →");
    if (ethnicityKey === "branca") return a.name.startsWith("branca →");
    return a.name.includes("qualquer → outra");
  });

  const peopleOptions = PEOPLE_ACTIONS.filter((a) => {
    if (people === "uma pessoa") return a.name.startsWith("uma pessoa →");
    if (people === "duas pessoas") return a.name.startsWith("duas pessoas →");
    if (people === "grupo (3+)") return a.name.startsWith("grupo →");
    return false;
  });

  // Incluir a opção de não fazer nada em cada dimensão
  genderOptions.unshift(null);
  ethnicityOptions.unshift(null);
  peopleOptions.unshift(null);

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
    mulher: courses.reduce((sum, c) => sum + (c.analise._genderContribution || 0), 0),
    homem: courses.reduce((sum, c) => sum + (c.analise._homemContribution || 0), 0),
    parda: courses.reduce((sum, c) => sum + (c.analise._pardaContribution || 0), 0),
    negra: courses.reduce((sum, c) => sum + (c.analise._negraContribution || 0), 0),
    branca: courses.reduce((sum, c) => sum + (c.analise._brancaContribution || 0), 0),
    outra: courses.reduce((sum, c) => sum + (c.analise._outraContribution || 0), 0),
    uma: courses.reduce((sum, c) => sum + (c.analise._umaContribution || 0), 0),
    duas: courses.reduce((sum, c) => sum + (c.analise._duasContribution || 0), 0),
    grupo: courses.reduce((sum, c) => sum + (c.analise._grupoContribution || 0), 0),
  };

  const deficits = {
    mulher: totals.mulher - TARGETS.gender.mulher,
    homem: totals.homem - TARGETS.gender.homem,
    parda: totals.parda - TARGETS.ethnicity.parda,
    negra: totals.negra - TARGETS.ethnicity.negra,
    branca: totals.branca - TARGETS.ethnicity.branca,
    outra: totals.outra - TARGETS.ethnicity.outra,
    uma: totals.uma - TARGETS.peopleCount.uma,
    duas: totals.duas - TARGETS.peopleCount.duas,
    grupo: totals.grupo - TARGETS.peopleCount.grupo,
  };

  const selected = [];
  const remaining = [...eligible];
  const classSelectionCounts = {};
  const MAX_PER_CLASSIFICATION = 7;

  const TOLERANCE = 0.01;

  while (absSum(deficits) > TOLERANCE && remaining.length > 0) {
    let bestIndex = -1;
    let bestBenefit = 0;
    let bestActions = [];

    for (let i = 0; i < remaining.length; i++) {
      const course = remaining[i];
      const cls = course.classificacao || "Sem classificação";
      const clsCount = classSelectionCounts[cls] || 0;

      const { benefit, actions } = findBestCourseAction(course, deficits);
      // Penaliza seleção excessiva da mesma classificação para distribuir áreas
      const diversityPenalty = clsCount >= MAX_PER_CLASSIFICATION ? -Infinity : 0;
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
      analise_atual: course.analise,
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

  return { selected, finalDeficits: deficits };
}

function enrichContributions(courses) {
  return courses.map((c) => {
    const a = c.analise;

    // Gênero: bruto
    let genderContribution = 0;
    let homemContribution = 0;
    if (a.genero === "mulher") genderContribution = 1;
    else if (a.genero === "homem") homemContribution = 1;
    else if (a.genero === "coletivo misto") {
      genderContribution = 0.5;
      homemContribution = 0.5;
    }

    // Etnia ajustada
    const ethnicityContribution = {
      parda: 0,
      negra: 0,
      branca: 0,
      outra: 0,
    };

    if (a.etnia.startsWith("múltipla")) {
      const parts = a.etnia.replace("múltipla: ", "").split(", ").map((s) => s.trim());
      const weight = 1 / parts.length;
      for (const part of parts) {
        if (ethnicityContribution[part] !== undefined) {
          ethnicityContribution[part] += weight;
        } else {
          ethnicityContribution.outra += weight;
        }
      }
    } else if (ethnicityContribution[a.etnia] !== undefined) {
      ethnicityContribution[a.etnia] += 1;
    } else {
      ethnicityContribution.outra += 1;
    }

    // Pessoas
    const peopleContribution = {
      uma: 0,
      duas: 0,
      grupo: 0,
    };
    if (a.quantidade_pessoas === "uma pessoa") peopleContribution.uma = 1;
    else if (a.quantidade_pessoas === "duas pessoas") peopleContribution.duas = 1;
    else if (a.quantidade_pessoas === "grupo (3+)") peopleContribution.grupo = 1;

    return {
      ...c,
      analise: {
        ...a,
        _genderContribution: genderContribution,
        _homemContribution: homemContribution,
        _pardaContribution: ethnicityContribution.parda,
        _negraContribution: ethnicityContribution.negra,
        _brancaContribution: ethnicityContribution.branca,
        _outraContribution: ethnicityContribution.outra,
        _umaContribution: peopleContribution.uma,
        _duasContribution: peopleContribution.duas,
        _grupoContribution: peopleContribution.grupo,
      },
    };
  });
}

function distributionAfterPlan(initialCourses, selected) {
  const totals = {
    mulher: 0,
    homem: 0,
    parda: 0,
    negra: 0,
    branca: 0,
    outra: 0,
    uma: 0,
    duas: 0,
    grupo: 0,
  };

  for (const c of initialCourses) {
    const a = c.analise;
    totals.mulher += a._genderContribution || 0;
    totals.homem += a._homemContribution || 0;
    totals.parda += a._pardaContribution || 0;
    totals.negra += a._negraContribution || 0;
    totals.branca += a._brancaContribution || 0;
    totals.outra += a._outraContribution || 0;
    totals.uma += a._umaContribution || 0;
    totals.duas += a._duasContribution || 0;
    totals.grupo += a._grupoContribution || 0;
  }

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

  md += `## Metas determinísticas (soma = 128)\n\n`;
  md += `### Gênero\n`;
  md += `- Mulheres: ${TARGETS.gender.mulher}\n`;
  md += `- Homens: ${TARGETS.gender.homem}\n\n`;
  md += `### Perfil étnico-racial\n`;
  md += `- Pardas: ${TARGETS.ethnicity.parda}\n`;
  md += `- Negras: ${TARGETS.ethnicity.negra}\n`;
  md += `- Brancas: ${TARGETS.ethnicity.branca}\n`;
  md += `- Outras: ${TARGETS.ethnicity.outra}\n\n`;
  md += `### Quantidade de pessoas\n`;
  md += `- Uma pessoa: ${TARGETS.peopleCount.uma}\n`;
  md += `- Duas pessoas: ${TARGETS.peopleCount.duas}\n`;
  md += `- Grupo (3+): ${TARGETS.peopleCount.grupo}\n\n`;

  md += `## Distribuição anterior vs projetada\n\n`;
  md += `| Dimensão | Anterior | Projetada | Meta |\n`;
  md += `|----------|----------|-----------|------|\n`;
  md += `| Mulheres | ${plan._initial.mulher.toFixed(1)} | ${projected.mulher.toFixed(1)} | ${TARGETS.gender.mulher} |\n`;
  md += `| Homens | ${plan._initial.homem.toFixed(1)} | ${projected.homem.toFixed(1)} | ${TARGETS.gender.homem} |\n`;
  md += `| Pardas | ${plan._initial.parda.toFixed(1)} | ${projected.parda.toFixed(1)} | ${TARGETS.ethnicity.parda} |\n`;
  md += `| Negras | ${plan._initial.negra.toFixed(1)} | ${projected.negra.toFixed(1)} | ${TARGETS.ethnicity.negra} |\n`;
  md += `| Brancas | ${plan._initial.branca.toFixed(1)} | ${projected.branca.toFixed(1)} | ${TARGETS.ethnicity.branca} |\n`;
  md += `| Outras | ${plan._initial.outra.toFixed(1)} | ${projected.outra.toFixed(1)} | ${TARGETS.ethnicity.outra} |\n`;
  md += `| Uma pessoa | ${plan._initial.uma.toFixed(1)} | ${projected.uma.toFixed(1)} | ${TARGETS.peopleCount.uma} |\n`;
  md += `| Duas pessoas | ${plan._initial.duas.toFixed(1)} | ${projected.duas.toFixed(1)} | ${TARGETS.peopleCount.duas} |\n`;
  md += `| Grupo (3+) | ${plan._initial.grupo.toFixed(1)} | ${projected.grupo.toFixed(1)} | ${TARGETS.peopleCount.grupo} |\n\n`;

  const genderSum = projected.mulher + projected.homem;
  const ethnicitySum = projected.parda + projected.negra + projected.branca + projected.outra;
  const peopleSum = projected.uma + projected.duas + projected.grupo;
  const dimensionsClose128 =
    Math.abs(genderSum - 128) < 0.01 &&
    Math.abs(ethnicitySum - 128) < 0.01 &&
    Math.abs(peopleSum - 128) < 0.01;

  const residuals = [];
  if (Math.round(projected.negra) !== TARGETS.ethnicity.negra) residuals.push(`negra ${projected.negra.toFixed(1)}/${TARGETS.ethnicity.negra}`);
  if (Math.round(projected.branca) !== TARGETS.ethnicity.branca) residuals.push(`branca ${projected.branca.toFixed(1)}/${TARGETS.ethnicity.branca}`);

  md += `**Soma das dimensões = 128:** ${dimensionsClose128 ? "Sim" : "Não"}\n\n`;
  md += residuals.length > 0
    ? `**Ajustes residuais em etnia (devido a classificações múltiplas):** ${residuals.join(", ")}.\n\n`
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
    Math.round(projected.mulher) === TARGETS.gender.mulher &&
    Math.round(projected.homem) === TARGETS.gender.homem &&
    Math.round(projected.parda) === TARGETS.ethnicity.parda &&
    Math.round(projected.negra) === TARGETS.ethnicity.negra &&
    Math.round(projected.branca) === TARGETS.ethnicity.branca &&
    Math.round(projected.outra) === TARGETS.ethnicity.outra &&
    Math.round(projected.uma) === TARGETS.peopleCount.uma &&
    Math.round(projected.duas) === TARGETS.peopleCount.duas &&
    Math.round(projected.grupo) === TARGETS.peopleCount.grupo;

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
  md += `- Metas individuais atingidas (arredondadas): **${targetsMet ? "sim" : "parcial — ajustes residuais em etnia devido a múltiplas identidades"}**\n`;
  md += `- Nenhuma descrição curta alterada\n`;
  md += `- Nenhum conteúdo modificado automaticamente\n\n`;

  md += `*Plano gerado de forma determinística, ordenado por course_id. Nenhum conteúdo foi alterado.*\n`;

  return md;
}

function main() {
  const audit = loadAudit();
  const courses = enrichContributions(audit.cursos);

  const initialTotals = {
    mulher: courses.reduce((s, c) => s + c.analise._genderContribution, 0),
    homem: courses.reduce((s, c) => s + c.analise._homemContribution, 0),
    parda: courses.reduce((s, c) => s + c.analise._pardaContribution, 0),
    negra: courses.reduce((s, c) => s + c.analise._negraContribution, 0),
    branca: courses.reduce((s, c) => s + c.analise._brancaContribution, 0),
    outra: courses.reduce((s, c) => s + c.analise._outraContribution, 0),
    uma: courses.reduce((s, c) => s + c.analise._umaContribution, 0),
    duas: courses.reduce((s, c) => s + c.analise._duasContribution, 0),
    grupo: courses.reduce((s, c) => s + c.analise._grupoContribution, 0),
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
    metas_nao_atingidas_arredondadas: [
      ...(Math.round(projected.negra) !== TARGETS.ethnicity.negra ? ["negra"] : []),
      ...(Math.round(projected.branca) !== TARGETS.ethnicity.branca ? ["branca"] : []),
      ...(Math.round(projected.parda) !== TARGETS.ethnicity.parda ? ["parda"] : []),
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
    console.log(`  ${k}: ${v.toFixed(1)}`);
  }
  console.log("\nDistribuição projetada:");
  for (const [k, v] of Object.entries(projected)) {
    const target =
      TARGETS.gender[k] || TARGETS.ethnicity[k] || TARGETS.peopleCount[k];
    console.log(`  ${k}: ${v.toFixed(1)}${target !== undefined ? ` / ${target}` : ""}`);
  }
}

main();
