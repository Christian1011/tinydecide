# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. You will get a reply within a few days.

Two things worth knowing when you deploy TinyDecide:

1. The answer log (`.tinydecide/<name>/answers.jsonl`, or your own `store`) holds the raw inputs your API saw. Keep it as private as those inputs.
2. `.tdm` model files are parsed with bounds checks, but load models only from sources you trust, as with any file your app executes decisions from.
