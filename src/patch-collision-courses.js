/**
 * Correção pontual dos campos visuais de cursos que geraram colisão real
 * na auditoria de conteúdo. Não altera a planilha, não chama APIs.
 */

const fs = require("fs");
const path = require("path");

const OUTPUT_PATH = path.join(
  __dirname,
  "..",
  "output",
  "ai-pilot",
  "reequilibrio-conteudo-output.json"
);

const PATCHES = {
  "ciencias-economicas-ead-bacharelado": {
    visual_personagem:
      "Economista de cerca de 28 anos, homem de pele parda, cabelo curto moreno escuro, camisa azul-clara e óculos retangulares de aro escuro, aponta com giz colorido uma curva de demanda na lousa, protagonista à direita; ao centro, mulher de pele negra, anota variações de mercado no caderno, colabora na cena. Cena com duas pessoas.",
    visual_atividade:
      "Traça uma curva de oferta e demanda na lousa e compara com a tabela impressa, em pé à direita. Ambas as pessoas participam da atividade com funções reais.",
  },
  "ciencias-contabeis-ead-bacharelado": {
    visual_personagem:
      "Contador de cerca de 32 anos, homem de pele parda, cabelo curto grisalho nas têmporas, camisa branca com suspensórios discretos, segura o carimbo de data sobre a pasta fiscal, protagonista à direita; ao centro, mulher de pele negra, organiza recibos na mesa, colabora na cena. Cena com duas pessoas.",
    visual_atividade:
      "Carimba a pasta fiscal e confere o livro-razão fechado, sentado à direita. Ambas as pessoas participam da atividade com funções reais.",
  },
  "administracao-publica-ead-bacharelado": {
    visual_personagem:
      "Administradora pública de cerca de 32 anos, mulher de pele parda, cabelo ondulado curto preso, blazer grafite sobre blusa branca, aponta para o painel de metas vazio, protagonista à direita; ao centro, homem de pele branca, distribui pastas de áreas na mesa, colabora na cena. Cena com duas pessoas.",
    visual_atividade:
      "Compara tabelas impressas sem números legíveis e anota no caderno orçamentário, sentada à direita. Ambas as pessoas participam da atividade com funções reais.",
  },
  "fisica-licenciatura-semipresencial-licenciatura": {
    visual_personagem:
      "Professora de física de cerca de 25 anos, mulher de pele morena, cabelo cacheado preso, jaleco aberto sobre blusa coral, puxa o carrinho no trilho e observa o cronômetro, protagonista à direita; ao centro, homem de pele parda, segura o quadro de anotações, como segunda pessoa relevante. Cena com duas pessoas.",
    visual_atividade:
      "Solta o carrinho pelo trilho inclinado e verifica o cronômetro, em pé ao lado da bancada de experimentos, painel sem escritos. Ambas em participação real, sem personagens periféricos.",
  },
  "geografia-licenciatura-semipresencial-licenciatura": {
    visual_personagem:
      "Professora de geografia de cerca de 25 anos, mulher de traços indígenas, cabelo em box braids médias, camisa amarela de algodão e calça jeans, percorre o relevo do mapa com a mão e aponta o globo, protagonista à direita; ao centro, homem de pele parda, segura o atlas aberto, como segunda pessoa relevante. Cena com duas pessoas.",
    visual_atividade:
      "Percorre o relevo do mapa com a mão e aponta o globo para a turma, em pé ao lado do mapa, quadro apagado. Ambas em participação real, sem personagens periféricos.",
  },
  "ciencias-biologicas-licenciatura-semipresencial-licenciatura": {
    visual_personagem:
      "Professora de biologia de cerca de 24 anos, mulher de pele morena, cabelo cacheado solto, camisa floral leve e avental branco, segura a folha na lupa e mostra a planta para a turma, protagonista à direita; ao centro, homem de pele branca, anota observações no caderno, como segunda pessoa relevante. Cena com duas pessoas.",
    visual_atividade:
      "Mostra a folha na lupa para a turma e aponta o vaso, em pé à direita da bancada, quadro apagado. Ambas em participação real, sem personagens periféricos.",
  },
};

function rebuildPrompt(record) {
  const avoidList =
    "Elementos a evitar: palavras legíveis, identificações comerciais, emblemas, nomes de empresa, valores monetários, bordas decorativas, transições de cor, cabeçalhos, dados institucionais, marca-d'água, mãos anatomicamente incorretas e objetos deformados.";
  return `Fotografia publicitária realista em cenário brasileiro contemporâneo, iluminação natural profissional. ${record.visual_composicao}. ${record.visual_personagem}. Ambiente: ${record.visual_ambiente}. Objetos: ${record.visual_objetos}. Atividade: ${record.visual_atividade}. ${avoidList}`;
}

function main() {
  const records = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  let changed = 0;

  for (const course_id of Object.keys(PATCHES)) {
    const record = records.find((r) => r.course_id === course_id);
    if (!record) {
      console.warn(`Curso não encontrado: ${course_id}`);
      continue;
    }
    Object.assign(record, PATCHES[course_id]);
    record.prompt_imagem = rebuildPrompt(record);
    changed++;
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(records, null, 2), "utf8");
  console.log(`Cursos ajustados: ${changed}`);
}

main();
