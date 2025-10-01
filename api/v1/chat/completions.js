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
    const app = new CharacterAI();
    await app.authenticateWithToken(token); // Логин по char_token

    const kvKey = `cai:chat:${token}:${characterExternalId}`;
    let chat = await redis.get(kvKey);

    if (!chat) {
      chat = await app.createOrContinueChat(characterExternalId); // Создаёт/продолжает историю
      await redis.set(kvKey, chat, { ex: 86400 * 7 }); // Кэш на неделю (serialize chat object? Wrapper handles)
      // Note: chat is object, Redis stores JSON.stringify if needed, but for simplicity assume serializable
    } else {
      chat = await app.continueChat(chat); // Возобновить
    }

    const userMessage = messages[messages.length - 1].content;
    if (!userMessage || typeof userMessage !== 'string') {
      return res.status(400).json({ error: 'Invalid user message' });
    }

    if (stream) {
      // Stream support via wrapper's sendMessageStream
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const streamResponse = await chat.sendMessageStream(userMessage);
      for await (const chunk of streamResponse) {
        const textDelta = chunk.text || '';
        if (textDelta) {
          const sseData = {
            id: Date.now().toString(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: characterExternalId,
            choices: [{ index: 0, delta: { content: textDelta }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(sseData)}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const response = await chat.sendAndAwaitResponse(userMessage);
      const assistantText = response.text || 'No response';
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

    // Update KV after response (for next continuity)
    await redis.set(kvKey, chat, { ex: 86400 * 7 });
  } catch (error) {
    console.error('Wrapper error:', error.message);
    res.status(500).json({ error: error.message });
  }
}
