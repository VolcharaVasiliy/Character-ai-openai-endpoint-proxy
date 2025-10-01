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
  console.log('Handler started: Method', req.method, 'URL', req.url);

  if (req.method !== 'POST') {
    console.log('Method not POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body; // Авто-парсинг от bodyParser
  if (!body || typeof body !== 'object') {
    console.log('Body invalid:', typeof body);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.log('Body parsed:', { model: body.model?.slice(0, 20) + '...', messagesCount: body.messages?.length || 0, stream: body.stream });

  const { model: characterExternalId, messages, stream = false } = body;
  if (!characterExternalId || !messages || !Array.isArray(messages)) {
    console.log('Missing params:', { hasModel: !!characterExternalId, hasMessages: !!messages });
    return res.status(400).json({ error: 'Missing model or messages' });
  }

  // Валидация: model должен быть string, ~30 chars (ID)
  if (typeof characterExternalId !== 'string' || characterExternalId.length < 20) {
    console.log('Invalid model:', characterExternalId);
    return res.status(400).json({ error: 'Invalid model (must be character external ID)' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('Invalid auth header');
    return res.status(401).json({ error: 'Invalid token' });
  }
  const token = authHeader.slice(7);
  console.log('Auth token length:', token.length);

  try {
    const kvKey = `cai:history:${token}:${characterExternalId}`;
    console.log('KV key:', kvKey);
    let historyExternalId = await redis.get(kvKey);

    // Шаг 1: Получи tgt
    const tgtKey = `cai:tgt:${token}:${characterExternalId}`;
    let tgt = await redis.get(tgtKey);
    if (!tgt) {
      console.log('Fetching char info...');
      try {
        const infoRes = await fetch(`${BASE_URL}/chat/character/info/`, {
          method: 'POST',
          headers: { ...HEADERS, Authorization: `Token ${token}` },
          body: JSON.stringify({ external_id: characterExternalId }),
        });
        if (!infoRes.ok) {
          const errText = await infoRes.text();
          console.log('Char info error:', infoRes.status, errText.slice(0, 200));
          throw new Error(`Failed to get char info: ${infoRes.status} - ${errText}`);
        }
        const infoData = await infoRes.json();
        tgt = infoData.identifier;
        console.log('TGT fetched:', !!tgt);
        await redis.set(tgtKey, tgt, { ex: 3600 });
      } catch (fetchErr) {
        console.error('Fetch char info error:', fetchErr.message);
        throw fetchErr;
      }
    }

    // Шаг 2: Создай/возобнови историю
    if (!historyExternalId) {
      console.log('Creating history...');
      try {
        const createRes = await fetch(`${BASE_URL}/chat/history/create/`, {
          method: 'POST',
          headers: { ...HEADERS, Authorization: `Token ${token}` },
          body: JSON.stringify({ external_id: characterExternalId }),
        });
        if (!createRes.ok) {
          const errText = await createRes.text();
          console.log('History create error:', createRes.status, errText.slice(0, 200));
          throw new Error(`Failed to create history: ${createRes.status} - ${errText}`);
        }
        const createData = await createRes.json();
        historyExternalId = createData.external_id;
        console.log('History created:', !!historyExternalId);
        await redis.set(kvKey, historyExternalId, { ex: 86400 * 7 });
      } catch (fetchErr) {
        console.error('Fetch history error:', fetchErr.message);
        throw fetchErr;
      }
    }

    // Шаг 3: Отправь сообщение
    const userMessage = messages[messages.length - 1].content;
    if (!userMessage || typeof userMessage !== 'string') {
      console.log('Invalid user message');
      return res.status(400).json({ error: 'Invalid user message' });
    }
    console.log('User message length:', userMessage.length);
    const payload = {
      history_external_id: historyExternalId,
      character_external_id: characterExternalId,
      text: userMessage,
      tgt,
      ranking_method: 'random',
      staging: false,
      override_prefix: null,
      override_rank: null,
      stream_every_n_steps: stream ? 1 : 16,
      is_proactive: false,
      num_candidates: 1,
      seen_msg_uuids: [],
    };
    console.log('Payload ready, sending...');

    const referer = `https://beta.character.ai/chat?char=${characterExternalId}`;
    console.log('Referer:', referer);

    const sendRes = await fetch(`${BASE_URL}/chat/streaming/`, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: `Token ${token}`, Referer: referer },
      body: JSON.stringify(payload),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      console.log('Send error:', sendRes.status, err.slice(0, 200));
      throw new Error(`API error: ${err}`);
    }
    console.log('Send response ok:', sendRes.status);

    if (stream) {
      console.log('Starting stream...');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const reader = sendRes.body.getReader();
      let buffer = '';
      let chunkCount = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const chunk = JSON.parse(line);
              const textDelta = chunk.candidates?.[0]?.text || '';
              if (textDelta) chunkCount++;
              const sseData = {
                id: Date.now().toString(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: characterExternalId,
                choices: [{ index: 0, delta: { content: textDelta }, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(sseData)}\n\n`);
            } catch (parseErr) {
              console.log('Chunk parse error:', parseErr.message, 'Line preview:', line.slice(0, 100));
            }
          }
        }
      }
      console.log('Stream ended, chunks:', chunkCount);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      console.log('Non-stream response...');
      const data = await sendRes.json();
      const assistantText = data.candidates?.[0]?.text || 'No response';
      console.log('Response length:', assistantText.length);
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
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  } catch (error) {
    console.error('Handler error:', error.message, error.stack);
    res.status(500).json({ error: error.message });
  }
}
