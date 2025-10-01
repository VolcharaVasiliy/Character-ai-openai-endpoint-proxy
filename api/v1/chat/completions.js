import { Redis } from '@upstash/redis';
import CharacterAI from 'node_characterai';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { model: characterExternalId, messages, stream = false } = body;
  if (!characterExternalId || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing model or messages' });
  }

  if (typeof characterExternalId !== 'string' || characterExternalId.length < 20) {
    return res.status(400).json({ error: 'Invalid model (must be character external ID)' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  const token = authHeader.slice(7);

  try {
    const client = new CharacterAI();
    await client.authenticateWithToken(token); // Авто-login, handles CSRF/cookies

    const kvKey = `cai:chat:${token}:${characterExternalId}`;
    let chatId = await redis.get(kvKey);

    let chat;
    if (!chatId) {
      chat = await client.createOrContinueChat(characterExternalId); // Новый чат с историей
      chatId = chat.externalId; // chat_id для sync
      await redis.set(kvKey, chatId, { ex: 86400 * 7 }); // Неделя
    } else {
      chat = await client.continueChat(characterExternalId, chatId); // Продолжаем с историей
    }

    const userMessage = messages[messages.length - 1].content;
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ error: 'Invalid user message' });
    }

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const messageStream = await chat.sendMessageStream(userMessage); // Stream чанки
      let chunkCount = 0;
      messageStream.on('data', (chunk) => {
        const textDelta = chunk.text || ''; // Delta из стрима
        if (textDelta) {
          chunkCount++;
          const sseData = {
            id: Date.now().toString(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: characterExternalId,
            choices: [{ index: 0, delta: { content: textDelta }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(sseData)}\n\n`);
        }
      });
      messageStream.on('end', () => {
        console.log('Stream ended, chunks:', chunkCount);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    } else {
      const response = await chat.sendMessage(userMessage); // Full ответ
      const assistantText = response.candidates?.[0]?.text || 'No response';
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

    // Update кэш
    await redis.set(kvKey, chatId, { ex: 86400 * 7 });
  } catch (error) {
    console.error('node_characterai error:', error.message);
    res.status(500).json({ error: error.message });
  }
}
