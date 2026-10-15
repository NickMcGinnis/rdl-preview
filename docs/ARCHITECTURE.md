# Architecture

`extension.ts` registers commands and owns one preview. `connections.ts` manages machine settings, encrypted connection passwords and the workspace's selected profile. `preview.ts` owns the execution, parameter state and webview messages. `ssrs.ts` implements SOAP envelopes and SSRS execution metadata. `transport.ts` sends authenticated requests. `rdl.ts` selectively edits the preview copy. `parameters.ts` validates values and invalidates dependencies. `demo.ts` supplies an explicitly simulated local workflow.

Live execution:

1. Read the open document's current text; validate well-formed XML and reject DTD/entity declarations.
2. Resolve shared resource paths and apply profile data-source overrides to a copy.
3. Call `LoadReportDefinition`; retain the ExecutionID for this panel only.
4. If required, collect all execution-scoped database credentials and call `SetExecutionCredentials`.
5. Read parameter metadata, apply defaults or remembered values and refresh server metadata via `SetExecutionParameters`.
6. Accept edits, invalidate dependent values, refresh metadata, validate and render with `Render` in PDF format.
7. Transfer PDF bytes to a CSP-restricted webview using local PDF.js resources. Save only when explicitly requested.

Only SSRS execution APIs are implemented; no report catalog writes, permanent publishing or database client is involved. Server execution sessions expire according to SSRS policy. The extension does not issue any administrative cleanup request.

Windows authentication uses the bundled fixed PowerShell script and .NET's default or explicit credentials. Inputs travel through stdin as JSON. Other desktop platforms use system curl for NTLM/SPNEGO; its config, credentials and request body also travel through stdin, with no shell evaluation and no curl startup config. Basic uses Node HTTPS. Redirects are not followed, TLS validation remains enabled, and Basic over HTTP is rejected. HTTPS proxy handling is transport-specific and is an acceptance-testing consideration.

Passwords use VS Code SecretStorage, scoped to the connection identity. Data-source passwords are execution-only. Parameters and PDFs are memory-only until the user saves a PDF. Settings are user/machine scoped, not workspace configuration. Profile changes cancel/invalidate the current client execution and clear remembered parameters. Webview messages are treated as untrusted and are validated against the current parameter list; report strings are inserted using textContent. Workspace Trust is required before previewing.
