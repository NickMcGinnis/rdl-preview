# Changelog

## 0.1.1 — 2026-10-15

- Allow Basic authentication with HTTP-only SSRS servers after explicit per-connection opt-in.
- Explain unencrypted credential transmission in the connection warning and settings.
- Preserve the opt-in when editing the same connection; keep HTTPS certificate checks and redirect rejection.
- Add real HTTP Basic SOAP regression coverage for parameterized preview.

## 0.1.0 — 2026-10-15

Initial testing release:

- Temporary SSRS report execution from the current RDL document.
- Typed parameter entry, defaults, available values, multiple values, nullable/blank values and dependent-choice refresh.
- Saved machine-local environment profiles and encrypted connection passwords.
- Environment switching and preview-only shared/embedded data-source overrides.
- Execution-scoped database credential prompts.
- Local PDF.js viewer with page navigation, zoom and save.
- Clearly labeled offline demo, synthetic RDL sample and workplace acceptance guide.

Live SSRS/PBIRS authentication, rendering and report compatibility require workplace acceptance testing.
