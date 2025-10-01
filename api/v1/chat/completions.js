import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BASE_URL = 'https://beta.character.ai';
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { model: characterExternalId, messages, stream = false } = req.body;
  if (!characterExternalId || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing model or messages' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const token = authHeader.slice(7);

  try {
    const kvKey = `cai:history:${token}:${characterExternalId}`;
    let historyExternalId = await redis.get(kvKey);

    // Шаг 1: Получи tgt (identifier) из char info, если нет в Redis
    const tgtKey = `cai:tgt:${token}:${characterExternalId}`;
    let tgt = await redis.get(tgtKey);
    if (!tgt) {
      const infoRes = await fetch(`${BASE_URL}/chat/character/info/`, {
        method: 'POST',
        headers: { ...HEADERS, Authorization: `Token ${token}` },
        body: JSON.stringify({ external_id: characterExternalId }),
      });
      if (!infoRes.ok) throw new Error('Failed to get char info');
      const infoData = await infoRes.json();
      tgt = infoData.identifier;
      await redis.set(tgtKey, tgt, { ex: 3600 }); // Кэш на час
    }

    // Шаг 2: Создай/возобнови историю чата, если нет
    if (!historyExternalId) {
      const createRes = await fetch(`${BASE_URL}/chat/history/create/`, {
        method: 'POST',
        headers: { ...HEADERS, Authorization: `Token ${token}` },
        body: JSON.stringify({ external_id: characterExternalId }),
      });
      if (!createRes.ok) throw new Error('Failed to create history');
      const createData = await createRes.json();
      historyExternalId = createData.external_id;
      await redis.set(kvKey, historyExternalId, { ex: 86400 * 7 }); // Кэш на неделю
    }

    // Шаг 3: Отправь сообщение (последнее из messages — user input)
    const userMessage = messages[messages.length - 1].content;
    const payload = {
      history_external_id: historyExternalId,
      character_external_id: characterExternalId,
      text: userMessage,
      tgt,
      ranking_method: 'random',
      staging: false,
      override_prefix: null,
      override_rank: null,
      stream_every_n_steps: stream ? 1 : 16, // Для стрима — чаще
      is_proactive: false,
      num_candidates: 1,
      seen_msg_uuids: [],
    };

    const referer = `https://beta.character.ai/chat?char=${characterExternalId}`;
    const sendRes = await fetch(`${BASE_URL}/chat/streaming/`, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: `Token ${token}`, Referer: referer },
      body: JSON.stringify(payload),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      throw new Error(`API error: ${err}`);
    }

    if (stream) {
      // Стрим: Парсим чанки как SSE (Character.AI шлёт JSON-строки с delta)
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const reader = sendRes.body.getReader();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Последняя строка — неполная

        for (const line of lines) {
          if (line.trim()) {
            try {
              const chunk = JSON.parse(line);
              const textDelta = chunk.candidates?.[0]?.text || ''; // Из стрима — текст чанка
              const sseData = {
                id: Date.now().toString(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: characterExternalId,
                choices: [{ index: 0, delta: { content: textDelta }, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(sseData)}\n\n`);
            } catch (e) {
              // Игнор мусора
            }
          }
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // Non-stream: Ждём полный ответ
      const data = await sendRes.json();
      const assistantText = data.candidates?.[0]?.text || 'No response';
      res.status(200).json({
        id: Date.now().toString(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: characterExternalId,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: assistantText },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, // Заглушка
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
