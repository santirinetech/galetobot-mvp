
import dotenv from 'dotenv';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

import QRCode from 'qrcode-terminal';
import pino from 'pino';

dotenv.config({
  path: new URL('../../../../.env', import.meta.url)
});

const logger = pino({ level: 'silent' });

const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.N8N_WEBHOOK_TOKEN;

if (!WEBHOOK_URL || !WEBHOOK_TOKEN) {
  throw new Error(
    'Configure N8N_WEBHOOK_URL e N8N_WEBHOOK_TOKEN no .env'
  );
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

  const { version } = await fetchLatestBaileysVersion();

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
    lastDisconnect
  }) => {
    if (qr) {
      console.log('\n📱 Escaneie o QR Code:\n');
      QRCode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconectando = false;
      console.log('✅ WhatsApp conectado!');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;

      console.log('⚠️ Conexão encerrada. Código:', code);

      if (code === DisconnectReason.loggedOut) {
        console.log(
          '❌ Sessão desconectada. Novo pareamento necessário.'
        );
        return;
      }

      if (!reconectando && !encerrando) {
        reconectando = true;

        setTimeout(() => {
          reconectando = false;
          iniciarWhatsApp().catch(console.error);
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
        tipoJid: jid.split('@')[1],
        texto
      });

      try {
        const respostaN8n = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GaletoBot-Token': WEBHOOK_TOKEN
          },
          body: JSON.stringify({
            session_id: jid,
            mensagem: texto,
            message_id: msg.key?.id
          }),
          signal: AbortSignal.timeout(15000)
        });

        if (!respostaN8n.ok) {
          throw new Error(
            `n8n respondeu HTTP ${respostaN8n.status}`
          );
        }

        const dados = await respostaN8n.json();

        if (
          typeof dados.resposta !== 'string' ||
          !dados.resposta.trim()
        ) {
          throw new Error(
            'n8n não retornou o campo resposta corretamente'
          );
        }

        console.log('🤖 Resposta recebida do n8n.');

        await sock.sendMessage(jid, {
          text: dados.resposta
        });

        console.log('✅ Resposta enviada ao WhatsApp!');
      } catch (erro) {
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

iniciarWhatsApp().catch(console.error);
