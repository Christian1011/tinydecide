# Changelog

## 0.1.2 (2026-10-26)

0.1.1 was staged but never published. Its fix is included here.

- In Node, `shadow('name', api)` no longer throws at startup when `.tinydecide/` can't be written. Answers stay in memory and one line is logged.
- A lock file keeps each decision folder to one process, so extra copies under `pm2 -i` or Node cluster keep their answers in memory instead of losing them.
- The answer log is trimmed as it grows, also with `autoCompile: false`, and a failed trim no longer leaves it closed. Its files are readable only by their owner.
- `compile()` rejects a `target` or `delta` outside 0 to 1 and an unknown `guarantee`. Before, `--target 98%` certified every cutoff.
- Local answers match your API's response in more cases: index labels come back as numbers, and probability arrays without `labels` stay with your API.
- A compile that gets no answers waits for more instead of retrying without end.
- Options inside `compile` no longer override the top-level `target`, `delta`, `audit` and `labels`.
- A label the model already knows no longer trips the guard when it is missing from the latest window.
- `guarantee: 'local'` no longer fails when one of the most confident calibration answers is mislabelled.
- A custom `choice` can return just the label, `stats().logged` counts the answers in the store, and `tinydecide -h` prints help.

## 0.1.0 (2026-10-24)

First release.

- `shadow(name, api)` wraps a decision API: it learns from the API's answers, certifies a cutoff, and answers confident calls locally. Agreement with your API is certified at the target you set (98% by default, 95% confidence).
- Live checks send every call back to your API when its answers change: a CUSUM test on a random audit sample, and checks on the calls your API answers anyway, overall and per label.
- In Node and Bun, named decisions persist in `.tinydecide/<name>/` and compile in a worker thread. Browsers, workers and edge runtimes get the same API with in-memory storage.
- `tinydecide` CLI: `try`, `status`, `compile`, `inspect`, `decide`.
- TypeScript types included.
