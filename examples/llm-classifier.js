// Wrap an LLM classifier. Any OpenAI-compatible endpoint works: an open-weights model on a hosted
// API, vLLM, Ollama, or a commercial model. TinyDecide learns from the labels it returns.
//
//   LLM_API_KEY=… node examples/llm-classifier.js "my card was charged twice" "the app crashes when i log in"
//
// Defaults to Mistral Nemo on OpenRouter. With Ollama: LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=llama3.2

import { shadow } from 'tinydecide';

const LABELS = ['billing', 'login', 'bug', 'cancel', 'other'];
const BASE_URL = process.env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1';
const MODEL = process.env.LLM_MODEL ?? 'mistralai/mistral-nemo';

/** Your existing call: one support message in, one label out. */
async function classify(text) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.LLM_API_KEY && { authorization: `Bearer ${process.env.LLM_API_KEY}` }),
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 4,
      messages: [
        { role: 'system', content: `Label the customer's support message. Reply with one word: ${LABELS.join(', ')}.` },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${MODEL} returned HTTP ${res.status}`);
  const reply = (await res.json()).choices[0].message.content.trim().toLowerCase();
  return LABELS.find((label) => reply.startsWith(label)) ?? 'other';
}

// The one line. Every call reaches the LLM until a local model certifies; then the calls it is sure
// about are answered locally. Answers and the model live in .tinydecide/support-route/.
const route = shadow('support-route', classify, { labels: LABELS });

for (const text of process.argv.slice(2)) {
  const { value, source, ms } = await route.detailed(text);
  console.log(`${value.padEnd(8)} ${source.padEnd(6)} ${ms.toFixed(1).padStart(7)} ms   ${text}`);
}
await route.close();
