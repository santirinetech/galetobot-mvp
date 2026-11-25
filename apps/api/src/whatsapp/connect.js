
import dotenv from 'dotenv';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

import QRCode from 'qrcode-terminal';
import pino from 'pino';

const chavesWebhook = ['N8N_WEBHOOK_URL', 'N8N_WEBHOOK_TOKEN'];
const ambienteInicial = Object.fromEntries(chavesWebhook.map(chave => [chave, process.env[chave]]));
const { parsed: ambienteArquivo } = dotenv.config({
  path: new URL('../../../../.env', import.meta.url)
});

const logger = pino({ level: 'silent' });

const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.N8N_WEBHOOK_TOKEN;
const CABECALHO_WEBHOOK = 'X-GaletoBot-Token';

if (!WEBHOOK_URL || !WEBHOOK_TOKEN) {
  throw new Error(
    'Configure N8N_WEBHOOK_URL e N8N_WEBHOOK_TOKEN no .env'
  );
}
if (new URL(WEBHOOK_URL).pathname.includes('/webhook-test/')) {
  throw new Error('Use a Production URL do workflow em N8N_WEBHOOK_URL.');
}

console.log('Origem da configuração do webhook:', Object.fromEntries(chavesWebhook.map(chave => [
  chave,
  ambienteInicial[chave] === undefined ? '.env' :
    ambienteArquivo?.[chave] === undefined ? 'ambiente do processo' :
      ambienteInicial[chave] === ambienteArquivo[chave] ? 'ambiente do processo (igual ao .env)' :
        'ambiente do processo (diverge do .env)'
])));

function urlParaLog(valor) {
  try {
    const url = new URL(valor, WEBHOOK_URL);
    if (!['http:', 'https:'].includes(url.protocol)) return '[protocolo omitido]';
    return `${url.origin}${url.pathname}`
      .replaceAll(WEBHOOK_TOKEN, '[oculto]')
      .replaceAll(encodeURIComponent(WEBHOOK_TOKEN), '[oculto]');
  } catch {
    return '[URL inválida]';
  }
}

function resumirCorpoErro(corpo) {
  // A resposta pode refletir dados do cliente ou credenciais. Registre apenas marcadores conhecidos.
  let json;
  try {
    json = JSON.parse(corpo);
  } catch {
    // Proxies também podem responder com HTML ou texto.
  }
  const marcadores = corpo.slice(0, 16384).match(/request failed with status code \d{3}|error (?:1010|1015|1020)|cloudflare|attention required|access denied|request blocked|authorization data is wrong|header auth credentials are not set|invalid (?:token|credentials)|unauthorized|forbidden|webhook is not registered|webhook não registrado|não autorizado|integração não configurada|erro interno/gi);
  return {
    formato: json !== undefined ? 'JSON' : /<html[\s>]|<!doctype html/i.test(corpo) ? 'HTML' : 'texto',
    marcadores: [...new Set(marcadores?.map(item => item.toLowerCase()))].slice(0, 10),
    codigo: Number.isInteger(json?.code) && json.code >= 100 && json.code <= 599 ? json.code : undefined,
    etapa: ['contexto', 'conversa'].includes(json?.etapa) ? json.etapa : undefined
  };
}

let reconectando = false;
let encerrando = false;

const mensagensProcessadas = new Set();

function extrairTexto(message) {
  let conteudo = message;

  // Desembrulha mensagens encapsuladas.
  for (let i = 0; i < 5 && conteudo; i++) {
    if (conteudo.ephemeralMessage?.message) {
      conteudo = conteudo.ephemeralMessage.message;
    } else if (conteudo.viewOnceMessage?.message) {
      conteudo = conteudo.viewOnceMessage.message;
    } else if (conteudo.viewOnceMessageV2?.message) {
      conteudo = conteudo.viewOnceMessageV2.message;
    } else if (conteudo.documentWithCaptionMessage?.message) {
      conteudo = conteudo.documentWithCaptionMessage.message;
    } else {
      break;
    }
  }

  return (
    conteudo?.conversation ||
    conteudo?.extendedTextMessage?.text ||
    conteudo?.imageMessage?.caption ||
    conteudo?.videoMessage?.caption ||
    ''
  ).trim();
}

async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(
    './whatsapp-session'
  );

  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log('Versão do protocolo WhatsApp:', version.join('.'),
    isLatest ? '(consultada)' : '(fallback do Baileys)');

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({
    connection,
    qr,
    lastDisconnect,
    receivedPendingNotifications
  }) => {
    if (connection === 'connecting') {
      console.log('WhatsApp: abrindo conexão...');
    }

    if (receivedPendingNotifications === true) {
      console.log('WhatsApp: recebimento das notificações pendentes concluído.');
    }

    if (qr) {
      if (process.env.WHATSAPP_ALLOW_QR === '0') {
        encerrando = true;
        process.exitCode = 1;
        console.error('A sessão precisa de pareamento. O modo hospedado bloqueou a exibição do QR.');
        sock.end(new Error('Pareamento indisponível neste processo'));
        return;
      }
      console.log('\n📱 Escaneie o QR Code:\n');
      QRCode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconectando = false;
      console.log('✅ WhatsApp conectado!');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;

      console.log('⚠️ Conexão encerrada. Código:', code);

      if (code === DisconnectReason.loggedOut) {
        encerrando = true;
        process.exitCode = 1;
        console.log(
          '❌ Sessão desconectada. Novo pareamento necessário.'
        );
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        encerrando = true;
        process.exitCode = 1;
        console.error('Sessão assumida por outra conexão. Reconexão interrompida.');
        return;
      }

      if (!reconectando && !encerrando) {
        reconectando = true;
        console.log('WhatsApp: nova tentativa de conexão em 3 segundos.');

        setTimeout(() => {
          reconectando = false;
          if (encerrando) return;
          iniciarWhatsApp().catch(registrarFalhaDeInicializacao);
        }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log('🔎 Evento WhatsApp:', {
      type,
      quantidade: messages.length,
      tipos: messages.map(msg => ({
        fromMe: Boolean(msg.key?.fromMe),
        jid: msg.key?.remoteJid?.split('@')[1] || 'desconhecido',
        conteudo: Object.keys(msg.message || {})
      }))
    });

    // Não responder mensagens antigas sincronizadas.
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key?.remoteJid;

      if (msg.key?.fromMe) continue;
      if (!jid) continue;
      if (jid.endsWith('@g.us')) continue;
      if (jid === 'status@broadcast') continue;
      if (jid.endsWith('@newsletter')) continue;
      if (jid.endsWith('@broadcast')) continue;

      const texto = extrairTexto(msg.message);

      if (!texto) {
        console.log('⚠️ Mensagem ignorada: texto não identificado.', {
          tipoJid: jid.split('@')[1],
          tipos: Object.keys(msg.message || {})
        });
        continue;
      }

      const identificador = `${jid}:${msg.key?.id || ''}`;

      if (msg.key?.id && mensagensProcessadas.has(identificador)) {
        continue;
      }

      if (msg.key?.id) {
        mensagensProcessadas.add(identificador);

        // Evita crescimento ilimitado da memória.
        if (mensagensProcessadas.size > 1000) {
          const primeiro = mensagensProcessadas.values().next().value;
          mensagensProcessadas.delete(primeiro);
        }
      }

      console.log('📩 Mensagem recebida:', {
        tipoJid: jid.split('@')[1]
      });

      let envioIniciado = false;
      try {
        console.log('Webhook n8n — requisição:', {
          url: urlParaLog(WEBHOOK_URL),
          metodo: 'POST',
          cabecalhoAutenticacao: CABECALHO_WEBHOOK
        });
        const respostaN8n = await fetch(WEBHOOK_URL, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/json',
            [CABECALHO_WEBHOOK]: WEBHOOK_TOKEN
          },
          body: JSON.stringify({
            session_id: jid,
            mensagem: texto,
            message_id: msg.key?.id
          }),
          signal: AbortSignal.timeout(15000)
        });

        const location = respostaN8n.headers.get('location');
        const redirecionamento = [301, 302, 303, 307, 308].includes(respostaN8n.status);
        const contentType = respostaN8n.headers.get('content-type')?.split(';')[0].trim();
        console.log('Webhook n8n — resposta:', {
          url: urlParaLog(respostaN8n.url || WEBHOOK_URL),
          status: respostaN8n.status,
          contentType: /^[\w.+-]+\/[\w.+-]+$/.test(contentType ?? '') ? contentType : null,
          serverPresente: respostaN8n.headers.has('server'),
          serverIndicaCloudflare: /^cloudflare$/i.test(respostaN8n.headers.get('server') ?? ''),
          cfRayPresente: respostaN8n.headers.has('cf-ray'),
          redirecionamento: redirecionamento ? {
            destino: location ? urlParaLog(location) : null,
            seguido: false
          } : null
        });

        if (!respostaN8n.ok) {
          const corpo = await respostaN8n.text().catch(() => null);
          const resumo = corpo ? resumirCorpoErro(corpo) : null;
          console.error('Webhook n8n — corpo de erro sanitizado:', resumo ??
            (corpo === '' ? '[vazio]' : '[indisponível]'));
          const etapa = resumo?.etapa ? ` (API, etapa ${resumo.etapa})` : '';
          throw new Error(
            `n8n respondeu HTTP ${respostaN8n.status}${etapa}`
          );
        }

        const dados = await respostaN8n.json();

        if (dados?.suprimir_resposta === true && dados.resposta === '') {
          continue;
        }

        if (
          typeof dados?.resposta !== 'string' ||
          !dados.resposta.trim()
        ) {
          throw new Error(
            'n8n não retornou o campo resposta corretamente'
          );
        }

        console.log('🤖 Resposta recebida do n8n.');

        envioIniciado = true;
        await sock.sendMessage(jid, {
          text: dados.resposta
        });

        console.log('✅ Resposta enviada ao WhatsApp!');
      } catch (erro) {
        if (!envioIniciado) mensagensProcessadas.delete(identificador);
        console.error(
          '❌ Erro ao processar mensagem:',
          erro.message
        );
      }
    }
  });

  sock.ev.on('messages.update', updates => {
    console.log('🔎 Atualizações de mensagens:', updates.length);
  });
}

process.on('SIGINT', () => {
  encerrando = true;
  console.log('\n🛑 Encerrando GaletoBot...');
  process.exit(0);
});

function registrarFalhaDeInicializacao(erro) {
  process.exitCode = 1;
  console.error('Falha ao iniciar o adaptador WhatsApp:', erro.message);
}

iniciarWhatsApp().catch(registrarFalhaDeInicializacao);
