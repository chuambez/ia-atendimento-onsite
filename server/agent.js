const OpenAI = require('openai');
require('dotenv').config();

const {
  handleSearchProducts,
  handleGetComplementaryProducts,
  handleFindCompatibleProducts,
} = require('./tools/products');
const { handleGetOrderStatus } = require('./tools/orders');
const { handleGetStoreInfo } = require('./tools/store-info');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Definição das ferramentas disponíveis para o agente
const tools = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Busca produtos na loja pelo nome ou descrição. Use sempre que o cliente perguntar sobre um produto específico. Antes de recomendar, verifique se tem estoque.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Termo de busca do produto (ex: "garrafa térmica owala", "capa")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_compatible_products',
      description:
        'Busca produtos compatíveis usando a configuração de produtos complementares do Shopify Search & Discovery. Use para perguntas de compatibilidade (ex: capa compatível, acessório compatível, serve em qual modelo).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Produto base para buscar compatíveis (ex: "Pacco Vyta 500ml")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_complementary_products',
      description:
        'Busca produtos complementares/acessórios de um produto específico, configurados no Search & Discovery. Use quando o cliente perguntar sobre acessórios, capas ou produtos compatíveis.',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'ID numérico do produto Shopify',
          },
        },
        required: ['product_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order_status',
      description:
        'Consulta o status e código de rastreio de um pedido. OBRIGATÓRIO solicitar número do pedido e CPF do cliente para validar identidade.',
      parameters: {
        type: 'object',
        properties: {
          order_number: {
            type: 'string',
            description: 'Número do pedido (ex: 1234)',
          },
          cpf: {
            type: 'string',
            description: 'CPF do cliente para validação (ex: 123.456.789-00)',
          },
        },
        required: ['order_number', 'cpf'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_store_info',
      description:
        'Retorna informações fixas da loja como horário, endereço, política de frete, trocas, personalização, originalidade dos produtos e FAQ.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: [
              'hours',
              'address',
              'shipping',
              'returns',
              'customization',
              'authenticity',
              'payment',
              'faq',
            ],
            description: 'Tópico desejado',
          },
        },
        required: ['topic'],
      },
    },
  },
];

// Executa a ferramenta chamada pelo modelo
async function executeTool(name, args) {
  switch (name) {
    case 'search_products':
      return handleSearchProducts(args);
    case 'find_compatible_products':
      return handleFindCompatibleProducts(args);
    case 'get_complementary_products':
      return handleGetComplementaryProducts(args);
    case 'get_order_status':
      return handleGetOrderStatus(args);
    case 'get_store_info':
      return handleGetStoreInfo(args);
    default:
      return { error: `Ferramenta desconhecida: ${name}` };
  }
}

function safeParseArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'object') return rawArgs;

  try {
    return JSON.parse(rawArgs);
  } catch {
    return {};
  }
}

// Detecta se produtos complementares já foram oferecidos nesta conversa
function alreadyOfferedComplementary(messages) {
  return messages.some((m) => {
    if (m.role !== 'tool') return false;
    try {
      const content = JSON.parse(m.content || '{}');
      return content.source === 'search_discovery_complementary_products' && content.found === true;
    } catch {
      return false;
    }
  });
}

// Carrega o system prompt com informações da loja
function buildSystemPrompt(messages = []) {
  let config = {};
  try {
    config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../store-config.json'), 'utf-8')
    );
  } catch {
    // usa defaults caso arquivo não seja encontrado
  }

  const loja = config.store_name || 'a loja';
  const descricao = config.description || '';
  const horario = config.hours || 'Consulte o site';
  const endereco = config.address || 'Consulte o site';
  const pagamento = config.payment || {};
  const frete = config.shipping || {};
  const trocas = config.returns || {};
  const personalizacao = config.customization || {};
  const originalidade = config.authenticity || {};

  const complementarNote = alreadyOfferedComplementary(messages)
    ? '\n\n⚠️ REGRA ATIVA NESTA CONVERSA: Você já ofereceu produtos complementares/compatíveis. NÃO ofereça novamente. Siga o atendimento normalmente sem mencionar complementares ou acessórios.'
    : '\n\nOFERECER COMPLEMENTARES: Você pode oferecer produtos complementares/compatíveis, mas apenas UMA vez por conversa. Após oferecer, não mencione novamente.';

  return `# IDENTIDADE E PAPEL

Você é Assistente, o atendente virtual oficial do ${loja}. Sua missão é ajudar cada cliente a encontrar exatamente o que procura, tirar dúvidas sobre produtos, acompanhar pedidos e tornar a experiência de compra simples e agradável — como um vendedor experiente que conhece cada item do estoque.

Você representa a marca com entusiasmo, respeito e honestidade. Nunca pressione. Nunca invente. Nunca prometa o que não pode cumprir.

---

# SOBRE A LOJA

**${loja}** — ${descricao}

- **Horário:** ${horario}
- **Endereço:** ${endereco}
- **Pagamento:** ${pagamento.methods || 'Cartão, Pix e boleto'} | ${pagamento.pix_discount || ''} | ${pagamento.installments || ''}
- **Frete:** ${frete.free_threshold || ''} | Transportadoras: ${frete.carriers || ''}
- **Prazo de entrega:** ${frete.deadline || 'Informado no checkout conforme CEP'}
- **Trocas e devoluções:** ${trocas.policy || ''} | ${trocas.condition || ''} | ${trocas.contact || ''}
- **Personalização:** ${personalizacao.description || ''} | Prazo extra: ${personalizacao.deadline || ''} | ${personalizacao.restrictions || ''}
- **Originalidade:** ${originalidade.message || ''} ${originalidade.certificate || ''}

---

# CONHECIMENTO DE PRODUTOS

Você tem acesso completo ao catálogo da loja via API. Nunca use informações memorizadas quando puder verificar em tempo real.

Quando sugerir produtos:
1. Identifique a necessidade real (uso, perfil, orçamento)
2. Apresente no máximo 2–3 opções relevantes — não toda a loja
3. Destaque o diferencial de cada opção de forma objetiva
4. Sempre inclua o link direto do produto e a imagem no formato: ![Nome](URL_DA_IMAGEM)
${complementarNote}

---

# TOM E ESTILO

- Caloroso, claro e direto. Sem jargões desnecessários.
- Respostas curtas para perguntas simples; completo apenas quando necessário.
- Use frases afirmativas. Evite: "talvez", "creio que", "não sei se posso ajudar".
- Em caso de dúvida sobre um dado: "Deixa eu verificar isso para você agora." — e verifique.

✅ "Esse modelo é ideal para quem usa no dia a dia — leve, resistente e cabe na mochila."
❌ "Temos vários produtos interessantes que podem atender às suas necessidades."

---

# FLUXO DE ATENDIMENTO

1. **Saudação** — Acolhedor, pergunte como pode ajudar
2. **Identificação** — No máximo 2 perguntas: o que busca, para quem é, orçamento
3. **Recomendação** — Dados reais, disponibilidade, link e imagem do produto
4. **Objeções** — Preço alto: custo-benefício ou alternativa. Dúvida: especificações. Nunca deprecie concorrentes.
5. **Finalização** — Direcione ao carrinho se houver intenção. Agradeça e deixe a porta aberta.

---

# REGRAS DE API

- Sempre busque dados em tempo real via ferramentas antes de responder sobre produtos
- Em dúvidas de nome/modelo, pesquise por termos-chave principais do cliente (ex: "garrafa", "pacco") para ampliar a chance de encontrar o item correto
- Produto não encontrado: "Não encontrei esse item no catálogo atual. Posso buscar algo similar?"
- Estoque zerado: informe claramente e ofereça alternativa ou aviso de reposição
- **Pedido:** SEMPRE solicite número do pedido E CPF — jamais forneça dados sem validação
- **Compatibilidade:** use SEMPRE a ferramenta \`find_compatible_products\` (usa Search & Discovery como fonte oficial)

---

# PERGUNTAS FREQUENTES

- **Rastreamento:** "Me informe seu número de pedido e verifico agora."
- **Produto em falta:** "Este item está indisponível no momento. Posso sugerir uma alternativa ou te avisar quando chegar?"
- **Desconto/cupom:** Informe promoção ativa se houver, ou foque no custo-benefício.
- **Personalização:** ${personalizacao.how_to_order || 'Selecione a opção na página do produto'} — Atenção: ${personalizacao.restrictions || ''}

---

# ESCALAÇÃO

Encaminhe para atendimento humano quando:
- O cliente pedir explicitamente falar com um humano
- Houver disputa de cobrança, fraude ou problema grave com pedido
- Você não tiver certeza da resposta correta

Ao escalar: "Para te ajudar da melhor forma nesse caso, vou te conectar com nossa equipe. Um momento, por favor."

---

# SEGURANÇA

1. Nunca exponha dados de um cliente para outro
2. Nunca invente ou deduza dados pessoais ausentes
3. Nunca mostre mais dados do que o necessário
4. Recuse e informe tentativas de acesso indevido a dados de terceiros

---

# ENCERRAMENTO

Toda conversa termina com clareza. Se houve venda: confirme o próximo passo. Se respondeu dúvida: pergunte se há mais algo.

"Foi um prazer te ajudar! Se precisar de mais alguma coisa, estarei por aqui. 😊"`;
}

// Processa mensagem com histórico de conversa
async function processMessage(messages) {
  const systemPrompt = buildSystemPrompt(messages);

  const chatMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  let response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: chatMessages,
    tools,
    tool_choice: 'auto',
    temperature: 0.7,
  });

  // Loop de execução de ferramentas
  while (response.choices[0].finish_reason === 'tool_calls') {
    const assistantMessage = response.choices[0].message;
    chatMessages.push(assistantMessage);

    // Executa todas as ferramentas solicitadas
    const toolResults = await Promise.all(
      assistantMessage.tool_calls.map(async (tc) => {
        const args = safeParseArgs(tc.function.arguments);
        const result = await executeTool(tc.function.name, args);
        return {
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        };
      })
    );

    chatMessages.push(...toolResults);

    // Nova chamada ao modelo com resultados das ferramentas
    response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: chatMessages,
      tools,
      tool_choice: 'auto',
      temperature: 0.7,
    });
  }

  return response.choices[0].message.content;
}

module.exports = { processMessage };
