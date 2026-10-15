# Contributing

Use Node.js 24, run `npm ci`, and make sure `npm run verify` and `npm run test:extension` pass before opening a pull request.

Use synthetic RDL files and fictional hosts in tests, issues and screenshots. Don't commit credentials, internal URLs, real reports or PDFs.

The fixture tests can't prove compatibility with a real report server. For changes to authentication or server behavior, say which SSRS/PBIRS versions, operating systems and auth methods you tested against.

Please don't add automatic report publishing, TLS bypasses, logging of requests or credentials, or persistence of report data. New authentication methods must keep secrets out of settings, process arguments and generated scripts.

## Releasing

1. Bump `version` with `npm version <x.y.z> --no-git-tag-version`.
2. Add a `## <x.y.z> — <date>` section to `CHANGELOG.md`; it becomes the release notes.
3. Commit, then push a matching tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.

The Release workflow checks that the tag matches `package.json`, runs the tests, and publishes a GitHub release with the VSIX attached. 0.x versions are marked as pre-releases.
