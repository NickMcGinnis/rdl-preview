# Security

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub security advisories](https://github.com/NickMcGinnis/rdl-preview/security/advisories/new) rather than a public issue. Use synthetic reports and fictional hosts in reproductions; don't include real credentials, authentication captures or SOAP bodies.

## Security model

- Previewing requires a trusted workspace. The RDL text and chosen parameter values are sent to the selected report server, which performs database access and rendering.
- Connection settings are machine-scoped, so a workspace cannot redirect saved credentials to another server.
- Connection passwords are stored in VS Code SecretStorage, keyed to the connection's server URL, authentication method and username. Database credentials requested by SSRS are used for one execution and never saved.
- TLS certificate verification is always on and redirects are never followed. HTTP requires an explicit per-connection opt-in; with it, report data (and Basic credentials) travel unencrypted.
- NTLM passwords are only offered to NTLM/Negotiate challenges, never Basic.
- Credentials never appear in process arguments or generated scripts; the curl and PowerShell transports read them from stdin.
- The PDF viewer uses bundled PDF.js under a restrictive webview CSP. The extension makes no telemetry or other network calls.
