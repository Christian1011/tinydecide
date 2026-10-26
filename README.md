# TinyDecide

[![npm](https://img.shields.io/npm/v/tinydecide)](https://www.npmjs.com/package/tinydecide) [![test](https://github.com/Christian1011/tinydecide/actions/workflows/test.yml/badge.svg)](https://github.com/Christian1011/tinydecide/actions/workflows/test.yml) [![bundle size](https://img.shields.io/badge/browser-12%20KB%20gzipped-blue)](#how-it-works) [![license](https://img.shields.io/npm/l/tinydecide)](LICENSE)

Wrap your decision API. TinyDecide learns from its answers and takes over the calls it can answer locally, in microseconds, with agreement certified.

```sh
npm install tinydecide      # or: bun add tinydecide
```

```js
import { shadow } from 'tinydecide';

const classify = shadow('support', (text) => api.classify(text));

await classify('my card was charged twice'); // the same answer your API gives
```

On day one every call still goes to your API. After 2,000 answers TinyDecide compiles a small local model and certifies how far to trust it. From then on, calls it is sure about are answered in about 10 µs, and the rest still go to your API.

```sh
npx tinydecide try    # 15 seconds, no API key: TinyDecide learns a simulated API, which then changes
```

Wrapping an LLM classifier is the common case. [`examples/llm-classifier.js`](examples/llm-classifier.js) does it for any OpenAI-compatible endpoint, defaulting to an open-weights model.

## What you can count on

1. **Your API stays the reference.** Across all calls, the answers you get agree with your API at least 98% of the time, counting your API's own answers as agreeing. This is certified at 95% confidence on traffic like the traffic it learned from. You set the target. With `compile: { guarantee: 'local' }`, the local answers alone meet it too.
2. **A call never fails because of TinyDecide.** If anything inside it throws (the model, the disk, your custom hooks), the call goes to your API.
3. **API changes are caught.** A small random sample of local answers is re-checked against your API, and calls your API answers anyway are checked for free. When your API's answers move, every call goes back to it until a model trained on the new answers certifies. Replaying 221,636 real recorded calls produced no false alarms.
4. **Restarts resume.** In Node, a named decision keeps its answers, model and state in `.tinydecide/<name>/`.
5. **Training runs off the main thread.** Compiles train in a worker thread. Two steps still pause the main thread: reading the answer log at the start of each compile, and trimming the log once every 25,000 answers. On an M3 Pro each takes about 45 ms with 100,000 short answers, and about 0.6 s when inputs are 2,000 characters long.
6. **It says when it is not worth it.** Some decisions are beyond a word-level model. TinyDecide tells you and keeps calling your API.

No dependencies. Node 22+, Bun, browsers, workers and edge runtimes; 12 KB gzipped in a browser bundle.

## How a decision graduates

| Mode | Who answers | Until |
|---|---|---|
| **learning** | Your API, every call | 2,000 answers are logged and a compile certifies |
| **local** | The model when its margin clears the certified cutoff; your API otherwise | A live check fails, or your API returns a label the model has never seen |
| **guarded** | Your API, every call | A compile on answers given after the change certifies |

It recompiles each time the answers double, and at least every 20,000 answers. It logs one line when something changes, never per call:

```
[tinydecide] support: learning from your API. First compile after 2,000 answers.
[tinydecide] support: compiled from 2,000 answers: answers 60% of calls locally, with ≥ 98% agreement with your API certified at 95% confidence. 0.16 MB, 8.1 µs per call.
[tinydecide] support: your API's answers changed for "billing": on calls the model leaned toward "billing" but left to your API, they now agree 9% of the time where the model expected 47%. Every call goes to your API until a model trained on its new answers certifies.
```

`npx tinydecide status` shows every decision in `.tinydecide/` at a glance.

## Your API's responses

`shadow(name, api)` takes any function of one input. It reads the label from:

- a string: `'billing'`
- an object with `label`, `choice`, `decision` or `answer`, plus optional `probs` (a label → probability map, or an array in `labels` order). Probabilities help: the model learns from how sure your API was.

Local answers come back in the same shape: a string for a string, or an object with the label under the same key, plus `probs` and `confidence` if your API returns them. Other fields of your API's response are not reproduced. For anything else, pass `choice: (response) => label` (or `{ choice, probs }`) to read it and `respond: (decision) => …` to build local answers.

The input can be a string, `{ a, b }` for a pair, or an object with a string `state`, `text`, `input`, `content` or `message`. The model reads the first of those it finds, or every field when there is none. The whole input is logged with the answer.

## Options

```js
shadow('support', api, {
  target: 0.98,         // agreement with your API to certify, overall across all calls
  group: (input) => input.conversationId, // keep a conversation's calls together when certifying
  fallback: true,       // answer locally if your API throws and a model exists
  log: false,           // or (line, event) => logger.info(line)
});
```

| Option | Default | |
|---|---|---|
| `target` | `0.98` | Agreement to certify. Overall: your API's own answers count as agreeing |
| `delta` | `0.05` | 1 − confidence of the certificate |
| `audit` | `0.02` | Share of calls your API also answers in the background, to check agreement live |
| `group` | none | Keeps related calls in one split, so the certificate covers new conversations, not just new messages |
| `labels` | inferred | Fixes the label set and order. Needed when your API returns probability arrays; also names index labels |
| `fallback` | `false` | Answer locally when your API throws |
| `log` | `true` | One line per lifecycle event. `false`, or a function to route it |
| `onEvent` | none | Every event as an object: `start`, `compile:start`, `compile`, `install`, `guard`, `discard`, `audit`, `unreadable`, `error` |
| `dir` | `.tinydecide` | Node: where named decisions live. Also `$TINYDECIDE_DIR` |
| `store` | file in Node, memory elsewhere | Where answers, the model and its state live (see below) |
| `model` | none | Start from a compiled model |
| `autoCompile` | `{ min: 2000, growth: 2, maxEvery: 20000, window: 50000 }` | `false` compiles only on `decide.compile()` |
| `choice`, `respond` | built in | Read custom responses, build custom local answers |

Misspelled options, and out-of-range `target`, `delta` or `audit`, throw at startup with a message that says what to write instead.

The function you get back also has:

- `decide.detailed(input)` returns `{ value, source, choice, confidence, ms }`; `source` is `'local'`, `'api'` or `'fallback'`.
- `decide.stats()` returns the mode, counts, calls saved, and live agreement with its interval.
- `decide.ready` resolves once a saved model is loaded. Calls before that go to your API.
- `decide.compile()` compiles now. `decide.close()` stops compiling and closes the store.
- `decide.mode` and `decide.model` are read-only.

## Where things live

In Node, `shadow('support', api)` keeps one folder:

```
.tinydecide/
  .gitignore        written once: the folder holds raw inputs, so git ignores it
  support/
    answers.jsonl   your API's recent answers, trimmed to the newest 100,000
    model.tdm       the installed model, and report.json, its compile report
    state.json      only while guarded, so a restart stays guarded
    lock            the pid of the process using the folder
```

Model and state writes are atomic, and a line cut off by a crash is skipped. The lock keeps each folder to one process. If the folder can't be opened (it is read-only, or another process holds it), answers stay in memory and one line is logged.

To keep answers elsewhere, pass a `store`: an object with `append(record)` and `load()`, plus optional `size`, `loadModel`, `saveModel`, `loadState`, `saveState` and `close` (any of them may be async). `memoryStore()` and `fileStore(dir)` are the built-in ones.

## Deploying

**One long-running server process.** Nothing to do. Answers and models persist in `.tinydecide/`. If a process manager runs several copies (`pm2 -i`, Node cluster), the first one keeps the folder and the others keep their answers in memory.

**Several instances, or serverless.** Each instance can learn on its own, but they learn faster together. Send answers to one place with a custom `store`, compile on a schedule, and ship the model:

```sh
npx tinydecide compile answers.jsonl --out support.tdm
```

```js
import { loadModel, shadow } from 'tinydecide';

const classify = shadow('support', api, { model: loadModel('support.tdm'), autoCompile: false, store });
```

The live checks still run on every instance and fall back to your API on their own.

**Browsers, workers and edge.** The same import works; answers stay in memory. Load a compiled model with `Model.fromBytes(await (await fetch('/support.tdm')).arrayBuffer())` and pass it as `model`.

## The guarantee

Each compile splits the logged answers into train, calibration and test, by `group` or else by normalized text so repeats never leak. It trains, quantizes to int8, and then runs Learn-Then-Test with fixed-sequence binomial testing over a margin grid fixed in advance. It picks the loosest cutoff for which

> with probability at least 1 − `delta` over the calibration draw, agreement with your API on traffic like the calibration rows is at least `target`.

Only the uniform random sample calibrates. Calls logged because the model deferred them are biased toward hard cases, so they train but never certify. Every number in a report is measured on the int8 model that ships. Pass `compile: { guarantee: 'local' }` to certify agreement on local answers alone; it answers fewer calls.

The certificate covers traffic like the calibration sample. The live checks cover change:

| Check | Watches | Trips when |
|---|---|---|
| Audit | The random sample of local answers, re-asked of your API | A CUSUM test finds overall agreement below target. About 2% false alarms over a model's life when agreement sits exactly at target, fewer above it |
| Deferred | Calls your API answers anyway, against the model's guess | Agreement falls far below calibration overall, or for one label far below what the model's own calibrated confidence predicts |
| Schema | Your API's labels | A label appears that the model has never seen |

A compile that is running when a check trips is cancelled and never installed, because its answers straddle the change.

## Results

### Replay on real decision-API traffic

Fifteen decisions, with answers recorded from a production decision model. For each one: compile on the first N calls, then answer later calls the model never saw. Target 98%, delta 5%.

| Decision | Calls compiled | Answered locally | Agreement [95% CI] | Verdict |
|---|---:|---:|---|---|
| Toxic chat prompts | 2,000 | 87.2% | 98.3% [97.1–99.1] | ship |
| Support intents (CLINC, 151 labels) | 10,000 | 73.1% | 98.6% [98.0–98.9] | ship |
| PubMed sentence role † | 50,000 | 67.6% | 98.3% [97.7–98.7] | ship |
| Economic news relevance | 2,000 | 67.1% | 99.2% [98.5–99.6] | ship |
| Dialog emotion † | 20,000 | 62.4% | 98.2% [97.7–98.6] | ship |
| Voice-assistant intents (SLURP, 60 labels) | 5,000 | 44.1% | 99.1% [98.6–99.4] | ship |
| Adverse drug events | 10,000 | 38.1% | 98.3% [97.7–98.7] | ship |
| Airline sentiment | 5,000 | 36.7% | 99.0% [98.4–99.3] | ship |
| Hate / offensive speech | 10,000 | 31.6% | 98.5% [98.0–98.9] | ship |
| Sarcastic headlines | 20,000 | 19.8% | 98.6% [98.1–99.0] | marginal |
| Relation types (SemEval, 19 labels) | 5,000 | 19.5% | 98.5% [97.7–99.0] | marginal |
| Sexism detection (EDOS) | 5,000 | 11.9% | 98.6% [98.0–99.0] | marginal |
| Adversarial hate (DynaHate) | 5,000 | 7.5% | 99.4% [98.8–99.7] | marginal |
| Scientific inference pairs (SciNLI) † | 20,000 | 4.1% | 99.1% [98.7–99.4] | not worth it |
| Paraphrase pairs (PAWS) | 10,000 | 3.6% | 98.4% [97.8–98.8] | not worth it |

† The recorded answers mix the decision model with other labellers.

Across all 56 (decision, N) cells from 1,000 to 50,000 calls, 3 measured below 98%, close to the 5% that `delta` allows; 1 was clearly below. Pooled agreement was 98.8%. On a deliberately shifted future set built from clusters the compile never saw, 9 of 56 measured below and 2 clearly. The recorded traffic is research data and is not distributed.

### Live, against a real API

TinyDecide wrapped an open-weights model on OpenRouter (Mistral Nemo) labelling 3,000 public airline tweets. Total cost $0.0034. After the first compile at 2,000 answers, the next 1,000 calls were 24% local with overall agreement 98.9% [98.0–99.4]. API p50 541 ms; local 16.8 µs.

### The guard

- **False alarms:** none in 221,636 recorded calls across all 15 decisions, replayed with no API change.
- **Detection:** when a simulated 10-label API starts filing one label under another, the guard trips after a median of 1,226 calls (754–3,657 over 10 runs), with 25–309 wrong local answers in the meantime.

Both are in [`bench/results/guard-2026-10-24.md`](bench/results/guard-2026-10-24.md); `npm run bench:guard` reruns the detection runs.

## Command line

```
tinydecide try                  a 15 s simulation: learn a simulated API, which then changes
tinydecide status [dir]         what each decision is doing
tinydecide compile <answers>    compile from a .jsonl log or a decision folder
tinydecide inspect <model.tdm>  labels and certificate
tinydecide decide <model.tdm>   answer inputs from arguments or stdin
```

`compile` prints the verdict, a held-out check and what other targets would allow:

```
  tinydecide compile  traffic.jsonl → traffic.tdm

  10,000 calls · 151 labels · target 98.0% overall agreement (95% confidence)

  ✓ ship   Answers 69.1% of calls locally while keeping overall agreement with your API ≥ 98% (95% confidence).

  held-out check   1,015 calls   69.0% local   98.4% agreement [97.5%–99.0%]
  local answers    97.7% agree with your API
  what if          90% → 96%   95% → 83%   97% → 76%   98% → 69%   99.0% → 56%   99.5% → 36%
  model            0.66 MB · 15,948 features · 11.1 µs per call · trained in 3.5 s
```

Answer logs are one JSON object per line: `{"input": "…", "choice": "billing"}`, optionally with `probs` and `group`. The label may also be under `label`, `decision` or `answer`.

## How it works

- **Features.** Text is normalized (NFKC, lowercase). Features are word unigrams and bigrams, number shapes, and character 2–4 grams within words, hashed to 32 bits. Han and kana characters are their own tokens. Pairs get side-aware and overlap features.
- **Model.** Words and characters are pooled separately and summed into a linear head, fastText-style, trained with SGD on your API's soft labels and stored as int8 with one scale per row.
- **Cutoff.** The score is the margin between the top two logits. A fitted temperature makes the reported confidence match how often your API agrees. It does not change the cutoff.
- **Size and speed.** 0.2–6 MB per decision, most under 3 MB. On an M3 Pro, a call takes 8–30 µs for short texts, 45–70 µs for pairs, and about 200 µs for news articles a few thousand characters long.

## Limits

1. **Word-level models.** Decisions that turn on meaning across a pair, or on world knowledge, mostly stay with your API. The verdict tells you which.
2. **Detection takes calls.** A change confined to one label of ten was caught after a median of about 1,200 calls. A higher `audit` rate catches changes sooner and saves less.
3. **The answer log holds raw inputs.** Keep `.tinydecide/` private, redact inputs before they reach `shadow`, or use your own `store`.
4. **One input, one label.** Multi-label and free-text outputs are out of scope.
5. **Long inputs need memory to compile.** Features take about 22 KB per training row at 2,000 characters, about 0.7 GB at the default 50,000-answer window. Lower `autoCompile.window` for long texts on small machines.

## Development

```sh
npm test               # 49 tests, about 15 s
npm run test:bun       # the same tests under Bun
npm run typecheck      # the public types, with tsc
npm run bench:guard    # how fast the guard catches an API change, over 10 runs
```

Issues and pull requests are welcome; please run the tests first. Security reports go through [SECURITY.md](SECURITY.md).

To release: bump `version` in package.json, add a CHANGELOG entry, and push a `vX.Y.Z` tag. CI runs the tests and stages the version on npm, and it goes public once a maintainer approves it with 2FA.

## License

MIT
