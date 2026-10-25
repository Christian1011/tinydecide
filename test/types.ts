// Compile-time checks for the public types: `npm run typecheck`.
import { compile, fileStore, memoryStore, Model, shadow, type Decide, type Report } from 'tinydecide';

declare function classify(text: string): Promise<{ label: 'billing' | 'bug'; probs: Record<string, number> }>;

const support = shadow('support', (text: string) => classify(text), { target: 0.99, group: (t) => t.length });
const answer: { label: 'billing' | 'bug' } = await support('my card was charged twice');
const d = await support.detailed('hi');
const source: 'local' | 'api' | 'fallback' = d.source;
const mode: 'learning' | 'local' | 'guarded' = support.mode;
const r: Report | null = await support.compile();
await support.close();

const plain: Decide<string, string> = shadow(async (text: string) => (text.length > 3 ? 'long' : 'short'), { store: memoryStore(), log: false });
const store = fileStore('.tinydecide/x');
const { model, report } = await compile([{ input: 'a', choice: 'x' }], { target: 0.95 });
const m: Model = Model.fromBytes(model.toBytes());
const verdict: 'ship' | 'marginal' | 'not-worth-it' | 'need-more-data' = report.verdict;

// @ts-expect-error unknown options are rejected
shadow('x', async () => 'a', { autocompile: false });
// @ts-expect-error target is a number
shadow('x', async () => 'a', { target: '98%' });

export { answer, source, mode, r, plain, store, m, verdict };
