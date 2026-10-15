# Validation for v0.1.0

Initial validation was performed on macOS without a live SSRS server.

- TypeScript checks and production bundle build passed.
- Local tests cover XML preservation and preview-only overrides, relative shared-resource paths, malformed XML / entity rejection, connection validation, parameter types, null vs blank, multi-value serialization, dependency invalidation, metadata decoding, curl config escaping and demo PDF parsing.
- A loopback SOAP fixture exercises the execution sequence over HTTP: temporary definition → execution-scoped database credentials → multiple parameter values → PDF. SOAP faults, HTTP errors and redirects are checked separately.
- A synthetic NTLM challenge fixture exercises the platform's HTTP adapter and Unicode request/response handling. This is not a real SSRS server or domain authentication test.
- An official VS Code 1.142.0 instance, using an isolated temporary profile, activated the extension, opened the demo, loaded the packaged webview assets, rendered PDF.js pages twice in the same panel and invalidated the old execution when connection settings changed.
- Browser inspection exercised listed and multi-value parameters, null selection and the PDF viewer. A webview-specific PDF worker loading problem found by the VS Code test was fixed by loading the bundled worker as a blob. The resulting UI was visually inspected.
- The VSIX is packaged with compiled extension code, the PowerShell helper, synthetic RDL sample, local PDF.js worker/fonts/CMaps/WASM and dependency license notices. No workplace data, connection secrets or local test profiles are included.

CI is configured to repeat checks on macOS, Windows and Linux. Actual CI results are visible in GitHub Actions; this document does not substitute for those results.

Still required at work: installation policy, real SSRS/PBIRS authentication and version compatibility, ExecuteReportDefinition permission, data-source authentication/delegation, actual query-backed and cascading parameters, dependency paths, corporate networking/certificates, multipage report layout and database results. Follow [WORK-LAPTOP-TESTING.md](WORK-LAPTOP-TESTING.md).
