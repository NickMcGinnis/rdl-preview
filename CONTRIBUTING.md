# Contributing

Use Node.js 24 LTS, run `npm ci`, then `npm run verify` and `npm run test:extension` before opening a pull request. Use synthetic RDL files and fictional hosts in tests, issues and screenshots. Keep domain credentials, internal URLs, business reports and PDFs out of the repository.

The extension has no local SSRS engine. Protocol fixtures and demo output cannot establish compatibility with a live report server. Describe the exact evidence for server or authentication changes, including a sanitized version/OS/authentication matrix.

Keep edits to the original RDL separate from preview preparation. Do not introduce automatic publishing, TLS bypasses, request/credential logging or persistence of report data. Any new authentication method must keep secrets out of settings, process arguments and generated scripts.
