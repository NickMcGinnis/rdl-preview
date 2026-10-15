# Contributing

Use Node.js 24, run `npm ci`, and make sure `npm run verify` and `npm run test:extension` pass before opening a pull request.

Use synthetic RDL files and fictional hosts in tests, issues and screenshots. Don't commit credentials, internal URLs, real reports or PDFs.

The fixture tests can't prove compatibility with a real report server. For changes to authentication or server behavior, say which SSRS/PBIRS versions, operating systems and auth methods you tested against.

Please don't add automatic publishing, TLS bypasses, logging of requests or credentials, or persistence of report data. New authentication methods must keep secrets out of settings, process arguments and generated scripts.
