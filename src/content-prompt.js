/**
 * Contexto editorial e visual usado para orientar o preenchimento dos cursos.
 *
 * Este arquivo centraliza as instruções que serão incluídas no arquivo Markdown
 * enviado junto com cada lote de cursos.
 */

const { OUTPUT_FIELDS, VALIDATION } = require("./content-schema");

function generateBatchInstructions(batchNumber, courses) {
  const courseList = courses
    .map((c) => `- **${c.course_id}**: ${c.Curso}`)
    .join("\n");

  return `# Instruções de preenchimento do lote ${String(batchNumber).padStart(
    3,
    "0"
  )}

## Cursos deste lote

${courseList}

## Público-alvo das futuras imagens

- Público brasileiro prioritário entre 20 e 35 anos.
- Maioria feminina, aproximadamente 60% dos personagens principais no conjunto completo dos cursos, sem aplicação rígida em cada imagem.
- Predominância de pessoas de classe C, representadas de forma natural.
- Ambientes brasileiros contemporâneos, reais e acessíveis.
- Evitar tanto aparência de luxo quanto estereótipos de pobreza.
- Roupas comuns, profissionais ou casuais, coerentes com a atividade.
- Diversidade deve parecer natural, não publicitária ou artificial.
- Sem sexualização, infantilização ou estereótipos ligados a gênero, classe social, etnia, corpo ou profissão.

## Distribuição demográfica global desejada

A distribuição deve ser avaliada no catálogo completo de 128 cursos, e não isoladamente em cada lote.

### Gênero dos personagens principais

- Aproximadamente 60% mulheres.
- Aproximadamente 40% homens.

### Características étnico-raciais declaradas

Use termos respeitosos:

- pessoa parda;
- pessoa negra;
- pessoa branca;
- pessoa de traços indígenas;
- pessoa de ascendência asiática.

Distribuição alvo:

- Aproximadamente 45% pessoas pardas.
- Aproximadamente 25% pessoas negras.
- Aproximadamente 25% pessoas brancas.
- Aproximadamente 5% pessoas indígenas, asiáticas ou outras representações brasileiras.

Não utilize o termo "mulato" nos prompts ou em qualquer campo.

### Quantidade de pessoas nas cenas

- Aproximadamente 70% das cenas com uma pessoa.
- Aproximadamente 25% das cenas com duas pessoas.
- Aproximadamente 5% das cenas com pequenos grupos.

Em cenas com duas ou mais pessoas, priorizar combinações naturais de diferentes gêneros, tons de pele e características físicas.

## Regras demográficas e de representação

- Não associe curso, profissão, comportamento, condição econômica ou capacidade intelectual a gênero, cor ou etnia.
- A escolha demográfica não pode alterar a atividade central do curso nem prejudicar a composição.
- A região inferior esquerda do card deve continuar livre para logo, nome do curso e informações acadêmicas.
- Descreva características visuais concretas quando necessário, mas não presuma identidade étnica a partir da aparência.
- A representação deve refletir o Brasil real: diverso, sem exotização nem uniformização.

## Campos de origem fornecidos no JSON

Utilize apenas estes campos para compreender o curso:

- \`course_id\`
- \`Curso\`
- \`Formação\`
- \`Modalidade\`
- \`Duração\`
- \`Classificação\`
- \`Descrição\`
- \`Mercado de Trabalho\`
- \`area de atuação\`

Não use META TITLE, META DESCRIPTION, IMG ALT, observações internas, URLs, imagens, grade ou textos promocionais anteriores como fonte.

## Campos a serem produzidos

${OUTPUT_FIELDS.filter((f) => f !== "course_id")
  .map((field) => {
    const rules = VALIDATION[field];
    let line = `### ${field}`;
    if (rules && rules.minLength && rules.maxLength) {
      line += ` (${rules.minLength} a ${rules.maxLength} caracteres)`;
    } else if (rules && rules.maxLength) {
      line += ` (máx. ${rules.maxLength} caracteres)`;
    }
    return line;
  })
  .join("\n\n")}

### descricao_curta

- Entre 100 e 160 caracteres.
- Explique concretamente o que o aluno aprenderá ou desenvolverá.
- Use português brasileiro natural.
- Varie naturalmente a frase inicial, preferencialmente no imperativo, como “Aprenda”, “Desenvolva”, “Prepare-se” e “Aprofunde”.
- Não inicie todos os cursos com “Você”.
- Não crie frases com sujeito omitido, como “Capacita a...” ou “Prepara para...”.
- Dentro de cada lote, no máximo duas descrições podem usar a mesma construção inicial.
- Não repita o nome do curso.
- Não mencione modalidade, formação, duração ou preço.
- Não prometa emprego, salário, sucesso, reconhecimento oficial ou garantias profissionais.
- Não invente empregabilidade nem informações ausentes dos campos de origem.
- Evite frases genéricas como "prepare-se para o futuro" ou "transforme sua carreira".

### visual_tema

Frase curta que representa o principal conhecimento ou atividade do curso. Deve ser escolhido com base na descrição, mercado de trabalho e áreas de atuação.

### visual_personagem

Descrição do personagem principal, contendo:

- papel profissional ou acadêmico;
- idade aparente entre 20 e 35 anos;
- gênero (mulher ou homem, respeitando a distribuição global de 60/40);
- características visuais concretas, como tom de pele e cabelo;
- identificação étnico-racial respeitosa quando pertinente;
- representação brasileira diversa.

Use os termos definidos na seção de distribuição demográfica. Não presuma identidade étnica a partir da aparência e nunca use o termo "mulato".

Quando uma pessoa não for necessária para representar corretamente o curso, use: \`sem personagem principal\`.

Em cenas com duas ou mais pessoas, descreva brevemente cada uma e indique a combinação natural de diversidade.

### visual_ambiente

Ambiente real e reconhecível onde a atividade poderia acontecer. Deve ser coerente com o curso, contemporâneo, organizado, realista, compatível com o contexto brasileiro, sem luxo exagerado e sem precariedade artificial.

### visual_objetos

Entre três e cinco objetos físicos relevantes para a área, separados por vírgula. Não inclua palavras, marcas, logotipos, diplomas legíveis, interfaces flutuantes ou objetos sem relação com o curso.

### visual_atividade

Ação observável e específica relacionada ao curso. O personagem deve estar realizando uma atividade real, não apenas olhando para a câmera ou posando.

### visual_composicao

Deve sempre orientar:

- formato quadrado 1:1;
- enquadramento médio ou aberto;
- personagem ou assunto principal à direita ou na região superior;
- região inferior esquerda livre;
- nenhum rosto, mão ou objeto importante na região inferior esquerda;
- iluminação publicitária natural;
- separação clara entre assunto e fundo.

A região inferior esquerda será usada posteriormente para logo, nome do curso e informações acadêmicas.

### visual_evitar

Inclua erros específicos do curso e também:

- palavras, textos, logotipos, marcas ou marca-d'água;
- mãos incorretas ou objetos deformados;
- interfaces flutuantes;
- estereótipos profissionais;
- atividade tecnicamente incorreta;
- ambiente luxuoso ou precário.

### prompt_imagem

Prompt completo em português para gerar somente o fundo fotográfico. Deve combinar tema, personagem, ambiente, objetos, atividade, composição e elementos a evitar.

Deve solicitar:

- fotografia publicitária realista;
- cenário brasileiro contemporâneo;
- iluminação natural profissional;
- composição quadrada;
- assunto principal à direita ou na região superior;
- região inferior esquerda livre de rostos, mãos e objetos importantes;
- a instrução “sem marca-d'água” (não use “sem filigrana”).

Não deve solicitar:

- logo;
- moldura;
- gradiente;
- nome do curso;
- textos;
- preço;
- identidade visual;
- card completo.

### conteudo_status

Deve ser preenchido obrigatoriamente como: \`rascunho\`.

## Formato obrigatório da resposta

Salve o resultado no arquivo:

\`\`\`text
output/content/batch-${String(batchNumber).padStart(3, "0")}-output.json
\`\`\`

O arquivo deve conter um array JSON com objetos no seguinte formato:

\`\`\`json
{
  "course_id": "",
  "descricao_curta": "",
  "visual_tema": "",
  "visual_personagem": "",
  "visual_ambiente": "",
  "visual_objetos": "",
  "visual_atividade": "",
  "visual_composicao": "",
  "visual_evitar": "",
  "prompt_imagem": "",
  "conteudo_status": "rascunho"
}
\`\`\`

## Regras editoriais gerais

- Não invente informações que não estejam nos campos de origem.
- Não invente empregabilidade, salário, reconhecimento oficial ou garantias profissionais.
- Priorize linguagem clara, específica e natural.
- Cada campo deve ser útil para a produção futura de imagens.
- O conjunto dos 128 cursos deve respeitar a distribuição de diversidade e gênero descrita, sem aplicar regras idênticas a cada curso individualmente.
- Varie as aberturas das descrições curtas com construções naturais, preferencialmente no imperativo. Dentro de cada lote, no máximo duas podem usar a mesma construção inicial.
- Não inclua dados acadêmicos (modalidade, formação, duração) dentro dos campos visuais.
- A cena deve girar em torno da atividade central do curso. Evite representar como principal uma tarefa periférica, burocrática ou genérica que possa ser confundida com qualquer outra formação.
- Evite estereótipos visuais ligados a gênero, idade, classe social, etnia, corpo ou profissão.
- Não associe curso, profissão, comportamento, condição econômica ou capacidade intelectual a gênero, cor ou etnia.
- Quando houver cursos semelhantes na grade, enfatize no tema, ambiente, objetos e atividade o elemento que diferencia um do outro.
- Antes de finalizar, verifique se a cena proposta poderia ser confundida com a de outro curso. Se sim, ajuste o tema, ambiente, objetos ou atividade para torná-la específica.
- Não faça promessas médicas, terapêuticas, clínicas ou de resultado de tratamento, especialmente em cursos de saúde e bem-estar. Evite termos como "cura", "tratar", "diagnosticar" ou "resolver" no sentido médico.
- Mantenha a representação dentro do contexto de classe C brasileira, evitando aparência de luxo ou estereótipos de pobreza.
- A distribuição demográfica deve ser considerada no catálogo completo, e não imposta de forma idêntica em cada curso.
- Nunca use o termo "mulato" nos prompts ou campos visuais.
`;

}

module.exports = {
  generateBatchInstructions,
};
