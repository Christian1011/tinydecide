# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. You will get a reply within a few days.

When you deploy TinyDecide:

1. The answer log (`.tinydecide/<name>/answers.jsonl`, or your own `store`) holds the raw inputs your API saw. Keep it as private as those inputs.
2. Load `.tdm` files only from sources you trust. A model decides what your app returns.
