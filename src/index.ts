import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import cron from 'node-cron';

dotenv.config();

const app = express();
app.use(express.json());

// ==========================================
// 1. CONFIGURAÇÕES
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL as string;
const supabaseKey = process.env.SUPABASE_KEY as string;
const supabase = createClient(supabaseUrl, supabaseKey);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

// ==========================================
// 2. O MOLDE DA IA (Atualizado com novas intenções)
// ==========================================
const vendaSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    intencao: { 
        type: SchemaType.STRING, 
        description: "Classifique como: registrar_venda, consultar_estoque, resumo_vendas, consultar_fiados, consultar_clientes, ou outro" 
    },
    cliente_nome: { type: SchemaType.STRING, description: "Nome do cliente (ou 'N/A' se for consulta)" },
    itens: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          produto_nome: { type: SchemaType.STRING },
          quantidade: { type: SchemaType.INTEGER },
          preco_unitario: { type: SchemaType.NUMBER }
        },
        required: ["produto_nome", "quantidade", "preco_unitario"]
      }
    },
    pagamentos: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          valor: { type: SchemaType.NUMBER },
          metodo: { type: SchemaType.STRING },
          status: { type: SchemaType.STRING },
          data_vencimento: { type: SchemaType.STRING }
        },
        required: ["valor", "metodo", "status", "data_vencimento"]
      }
    }
  },
  required: ["intencao", "cliente_nome", "itens", "pagamentos"]
};

// ==========================================
// 3. ROTA WEB PARA TESTE
// ==========================================
app.get('/', (req, res) => res.send('API do Revenda Fácil rodando! 🚀'));

// ==========================================
// 4. O ROBÔ DO WHATSAPP (Agora com Consultas!)
// ==========================================
console.log('🤖 Iniciando o robô do WhatsApp...');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('📱 Leia o QR Code abaixo com o WhatsApp do seu celular de testes:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Bot do WhatsApp conectado e pronto para receber mensagens!');

    // ========================================================
    // O ROBÔ COBRADOR (Cron Job)
    // ========================================================
    
    // O padrão '0 9 * * *' significa: Rodar todo dia às 09:00 da manhã.
    // DICA PARA TESTE: Para testar agora, troque por '* * * * *' (vai rodar a cada 1 minuto)
    cron.schedule('0 9 * *', async () => {
        console.log('⏰ Rodando a verificação diária de fiados...');

        try {
            // 1. Pega a data de hoje no formato YYYY-MM-DD
            const hojeLocal = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

            // 2. Busca no Supabase parcelas que vencem HOJE e estão pendentes
            const { data: cobrancas } = await supabase
                .from('financeiro_parcelas')
                .select('valor_parcela, vendas(clientes(nome))')
                .eq('status_pagamento', 'pendente')
                .eq('data_vencimento', hojeLocal);

            // 3. Se achou alguém devendo hoje, manda mensagem pro Admin!
            if (cobrancas && cobrancas.length > 0) {
                let msgTexto = '⏰ *BOM DIA! Dia de receber dindin!*\n\n🚨 Os seguintes clientes têm fiado vencendo *HOJE*:\n\n';
                
                cobrancas.forEach((c: any) => {
                    const nome = c.vendas?.clientes?.nome || 'Cliente';
                    msgTexto += `- *${nome}*: R$ ${c.valor_parcela}\n`;
                });

                msgTexto += '\n_Dica: Se já recebeu, me avise para eu dar baixa!_';

                // Formata o número do admin para o padrão do whatsapp-web.js
                const numeroAdmin = `${process.env.NUMERO_ADMIN}@c.us`;
                
                // Dispara a mensagem proativamente!
                await client.sendMessage(numeroAdmin, msgTexto);
                console.log('✅ Notificação de cobrança enviada com sucesso!');
            } else {
                console.log('Nenhum fiado vencendo hoje.');
            }

        } catch (error) {
            console.error('Erro na rotina de cobrança:', error);
        }
    });
});

client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast' || msg.author) return;

    // Pega o texto e tira espaços extras no começo e no fim
    const textoDaRevendedora = msg.body.trim().toLowerCase();
    console.log(`\n💬 Nova mensagem: "${textoDaRevendedora}"`);

    try {
        // ========================================================
        // CAMADA 1: O MENU FIXO (Custo ZERO, não usa IA)
        // ========================================================

        // Se a pessoa digitar 'menu', 'oi', 'olá', 'opcoes' ou '0'
        if (['menu', 'oi', 'olá', 'ola', 'opções', 'opcoes', '0'].includes(textoDaRevendedora)) {
            const menuResumo = `👋 Olá! Como posso ajudar nas suas vendas hoje?\n\n` +
                               `*1* 📊 Resumo do Mês\n` +
                               `*2* 📦 Consultar Estoque\n` +
                               `*3* 🚨 Consultar Fiados\n` +
                               `*4* 👥 Quantidade de Clientes\n\n` +
                               `✍️ _Ou simplesmente digite a sua venda (Ex: Vendi um Kaiak pro João por 150...)_`;
            await msg.reply(menuResumo);
            return; // Mata a execução aqui! Não chama a IA.
        }

        if (textoDaRevendedora === '1') {
            const date = new Date();
            const primeiroDia = new Date(date.getFullYear(), date.getMonth(), 1).toISOString();
            const { data: vendas } = await supabase.from('vendas').select('valor_total').gte('data_venda', primeiroDia);
            const totalMes = vendas?.reduce((acc, v) => acc + Number(v.valor_total), 0) || 0;
            await msg.reply(`📊 *Resumo do Mês:*\nVocê tem *${vendas?.length || 0} vendas*.\nTotal faturado: *R$ ${totalMes.toFixed(2)}*`);
            return;
        }

        if (textoDaRevendedora === '2') {
            const { data: produtos } = await supabase.from('produtos').select('nome, estoque').neq('estoque', 0);
            if (!produtos || produtos.length === 0) {
                await msg.reply('📦 Seu estoque está vazio.');
            } else {
                let resposta = '📦 *Seu Estoque:*\n';
                produtos.forEach(p => resposta += `- ${p.nome}: *${p.estoque}* un\n`);
                await msg.reply(resposta);
            }
            return;
        }

        if (textoDaRevendedora === '3') {
            const { data: fiados } = await supabase.from('financeiro_parcelas').select(`valor_parcela, data_vencimento, vendas(clientes(nome))`).eq('status_pagamento', 'pendente');
            if (!fiados || fiados.length === 0) {
                await msg.reply('🎉 Ninguém está te devendo!');
            } else {
                let totalPendente = 0;
                let resposta = '🚨 *Fiados pendentes:*\n\n';
                fiados.forEach((f: any) => {
                    totalPendente += Number(f.valor_parcela);
                    const nome = f.vendas?.clientes?.nome || 'Desconhecido';
                    const data = f.data_vencimento.split('-').reverse().join('/');
                    resposta += `- *${nome}*: R$ ${f.valor_parcela} (Vence: ${data})\n`;
                });
                resposta += `\n💰 *Total na rua:* R$ ${totalPendente}`;
                await msg.reply(resposta);
            }
            return;
        }

        if (textoDaRevendedora === '4') {
            const { count } = await supabase.from('clientes').select('*', { count: 'exact', head: true });
            await msg.reply(`👥 Você tem *${count} clientes* cadastrados.`);
            return;
        }

        // ========================================================
        // CAMADA 2: A INTELIGÊNCIA ARTIFICIAL (Para as Vendas)
        // ========================================================
        
        // Se o código chegou até aqui, é porque a mensagem não foi "1", "2", "3" ou "menu".
        // Então assumimos que é uma frase natural e mandamos para o Gemini analisar.
        
        console.log("🧠 Enviando texto para a IA interpretar...");

        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: vendaSchema,
            }
        });

        const prompt = `
            Você é um assistente de extração de dados. A data de hoje é 2026-04-02.
            A mensagem abaixo é o relato de uma VENDA. Extraia os itens, cliente e valores.
            Mensagem: "${msg.body}"
        `;

        const result = await model.generateContent(prompt);
        const dadosEstruturados = JSON.parse(result.response.text());

        // LÓGICA DE SALVAR A VENDA NO BANCO...
        if (dadosEstruturados.intencao === "registrar_venda") {
            let { data: cliente } = await supabase.from('clientes').select('id').ilike('nome', `%${dadosEstruturados.cliente_nome}%`).limit(1).single();
            if (!cliente) {
                const { data: novoCliente } = await supabase.from('clientes').insert([{ nome: dadosEstruturados.cliente_nome }]).select('id').single();
                cliente = novoCliente;
            }

            const valorTotal = dadosEstruturados.pagamentos.reduce((acc: number, pag: any) => acc + pag.valor, 0);
            const { data: venda } = await supabase.from('vendas').insert([{ cliente_id: cliente?.id, valor_total: valorTotal }]).select('id').single();

            const parcelas = dadosEstruturados.pagamentos.map((pag: any) => ({
                venda_id: venda?.id, valor_parcela: pag.valor, data_vencimento: pag.data_vencimento, status_pagamento: pag.status, metodo_pagamento: pag.metodo
            }));
            await supabase.from('financeiro_parcelas').insert(parcelas);

            let produtosRegistrados = [];
            for (const item of dadosEstruturados.itens) {
                let { data: produto } = await supabase.from('produtos').select('id, estoque').ilike('nome', `%${item.produto_nome}%`).limit(1).single();
                if (!produto) {
                    const { data: novoProduto } = await supabase.from('produtos').insert([{ nome: item.produto_nome, preco_venda: item.preco_unitario, estoque: 0 }]).select('id, estoque').single();
                    produto = novoProduto;
                }
                await supabase.from('itens_venda').insert([{ venda_id: venda?.id, produto_id: produto?.id, quantidade: item.quantidade, preco_unitario: item.preco_unitario }]);
                await supabase.from('produtos').update({ estoque: (produto?.estoque || 0) - item.quantidade }).eq('id', produto?.id);
                produtosRegistrados.push(`${item.quantidade}x ${item.produto_nome}`);
            }

            const temFiado = dadosEstruturados.pagamentos.some((p: any) => p.metodo === 'fiado');
            await msg.reply(`✅ Anotado!\n\nVenda de *R$ ${valorTotal}* para *${dadosEstruturados.cliente_nome}*.\n📦 Abatidos: ${produtosRegistrados.join(', ')}.${temFiado ? '\n🚨 Fiado anotado!' : ''}`);
        } else {
             // Caso a IA receba uma frase complexa que não seja uma venda
             await msg.reply('Não entendi essa. Digite *Menu* para ver as opções ou me mande os dados de uma venda.');
        }

    } catch (error) {
        console.error("Erro no fluxo:", error);
        await msg.reply("Deu um erro técnico aqui. Tenta mandar de novo?");
    }
});

client.initialize();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});