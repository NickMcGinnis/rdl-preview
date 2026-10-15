# Architecture

| File | Responsibility |
| --- | --- |
| `extension.ts` | Registers commands and owns the current preview panel. |
| `connections.ts` | Connection settings, saved passwords and the workspace's active connection. |
| `preview.ts` | One execution: parameter state, webview messages and PDF hand-off. |
| `ssrs.ts` | SOAP envelopes and decoding of SSRS execution metadata. |
| `transport.ts` | Authenticated HTTP via Node (Basic), curl (NTLM/SPNEGO) or PowerShell (Windows). |
| `rdl.ts` | Edits to the copy of the RDL sent to the server. |
| `parameters.ts` | Parameter validation and dependency invalidation. |
| `demo.ts` | Offline simulated session. |

## Preview flow

1. Read the open document's text; reject malformed XML and DTD/entity declarations.
2. On a copy, resolve relative catalog paths and apply the connection's data-source overrides. Edits are made by byte range so the rest of the document is unchanged.
3. `LoadReportDefinition`, keeping the ExecutionID for this panel only.
4. If SSRS asks for data-source credentials, prompt for them and call `SetExecutionCredentials`.
5. Apply remembered or default values with `SetExecutionParameters` to resolve query-backed choices.
6. On each edit, clear dependent values, refresh metadata, validate, and `Render` to PDF.
7. Send the PDF to the webview, which draws it with the bundled PDF.js. It is written to disk only through Save PDF.

Only execution APIs are called; nothing is written to the report catalog. Executions expire under the server's session policy.

## Transports

All three transports reject redirects and keep TLS verification on. HTTP is only allowed when the saved connection sets `allowHttp`.

- **Basic:** Node `http`/`https`.
- **Windows (`windows`, `ntlm`):** `media/request.ps1`, a fixed script run with `-File`. URL, body and credentials arrive as JSON on stdin. Explicit credentials are registered for NTLM and Negotiate only.
- **macOS/Linux (`windows`, `ntlm`):** `/usr/bin/curl --disable --config -`. The config, including credentials and body, is written to stdin, so nothing sensitive appears in the process arguments.

## State

Connections live in machine-scoped settings. Passwords live in SecretStorage under a key derived from the server URL, auth method and username, so editing any of those requires the password again. Parameter values, database credentials and PDFs are held in memory. Switching environment, or editing the active connection, replaces the open execution in the same panel; replies from the replaced execution are discarded. Changing connection settings clears remembered values.

Webview messages are treated as untrusted and validated against the current parameter list. Server-supplied strings are inserted with `textContent`.
