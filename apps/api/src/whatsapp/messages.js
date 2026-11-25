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

export function createMessageHandler(requestReply) {
    const pending = new Set();
    const handled = new Set();

    return async (socket, messages, { active, signal, emit }) => {
        for (const msg of messages) {
            if (!active()) return;
            const { remoteJid: jid, remoteJidAlt, id, fromMe } = msg.key ?? {};
            if (fromMe || !jid || /@(?:g\.us|broadcast|newsletter)$/.test(jid)) continue;
            const text = extrairTexto(msg.message);
            if (!text) {
                emit('message_ignored', { reason: 'no_text' });
                continue;
            }
            const ids = id ? [jid, remoteJidAlt].filter(Boolean).map(address => JSON.stringify([address, id])) : [];
            if (ids.some(key => pending.has(key) || handled.has(key))) {
                emit('message_ignored', { reason: 'duplicate' });
                continue;
            }

            for (const key of ids) pending.add(key);
            let sending = false;
            try {
                const reply = await requestReply({ jid, id, text, signal, emit });
                if (!active()) continue;
                if (reply !== null) {
                    sending = true;
                    await socket.sendMessage(jid, { text: reply });
                    if (active()) emit('reply_sent');
                }
                for (const key of ids) handled.add(key);
            } catch {
                // The remote outcome is ambiguous once sendMessage has started.
                if (sending) for (const key of ids) handled.add(key);
                if (active()) emit('message_failed', { stage: sending ? 'send_outcome_unknown' : 'webhook' });
            } finally {
                for (const key of ids) pending.delete(key);
                while (handled.size > 2000) handled.delete(handled.values().next().value);
            }
        }
    };
}
