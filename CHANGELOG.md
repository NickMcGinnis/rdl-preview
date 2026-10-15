# Changelog

## Unreleased

- Windows NTLM connections only offer the password to NTLM/Negotiate challenges, so a server can no longer request it over Basic.
- Windows transport no longer pins TLS 1.2; it adds TLS 1.2 to the system defaults instead.
- Activate only in workspaces containing `.rdl` files instead of on every startup.
- The test API is only exposed when running under the extension test host.

## 0.1.1 — 2026-10-15

- Allow Basic authentication with HTTP-only SSRS servers after explicit per-connection opt-in.
- Explain unencrypted credential transmission in the connection warning and settings.
- Preserve the opt-in when editing the same connection; keep HTTPS certificate checks and redirect rejection.
- Add HTTP Basic SOAP regression tests.

## 0.1.0 — 2026-10-15

Initial testing release:

- Temporary SSRS report execution from the current RDL document.
- Typed parameter entry, defaults, available values, multiple values, nullable/blank values and dependent-choice refresh.
- Saved machine-local environment profiles and encrypted connection passwords.
- Environment switching and preview-only shared/embedded data-source overrides.
- Execution-scoped database credential prompts.
- Local PDF.js viewer with page navigation, zoom and save.
- Offline demo mode and a synthetic sample report.
