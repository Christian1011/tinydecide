# Changelog

## 0.1.1 — 2026-10-25

- `guarantee: 'local'` no longer fails to certify when one of the few most confident calibration answers is mislabelled. Testing now starts at the first cutoff with enough local answers that an error rate of half the target would still certify (`localStart`), so one bad label among the top answers can't end the test sequence. The guarantee itself is unchanged.

## 0.1.0 — 2026-10-24

First release.

- `shadow(name, api)` wraps a decision API: it learns from the API's answers, certifies a cutoff, and answers confident calls locally. Agreement with your API is certified at the target you set (98% by default, 95% confidence).
- Live checks send every call back to your API when its answers change: a CUSUM test on a random audit sample, and checks on the calls your API answers anyway, overall and per label.
- In Node and Bun, named decisions persist in `.tinydecide/<name>/` and compile in a worker thread. Browsers, workers and edge runtimes get the same API with in-memory storage.
- `tinydecide` CLI: `try`, `status`, `compile`, `inspect`, `decide`.
- TypeScript types included.
