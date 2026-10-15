# Security

Keep workplace credentials, server details and reports out of public issues. Report reproducible problems with synthetic inputs. Avoid posting real authentication captures or SOAP bodies.

The extension requires a trusted workspace and sends RDL content and chosen parameter values to the selected report server. SSRS performs database access and rendering. Connection passwords use VS Code SecretStorage; execution-scoped database credentials and parameter values are held in memory. Data-source connection overrides are applied only to the submitted copy.

This is an initial testing release; use a development report server while evaluating it. HTTPS verification remains enabled, Basic over HTTP is prohibited, redirects are rejected and no telemetry or cloud AI calls are added. Inline PDF preview uses bundled PDF.js assets under a restrictive webview CSP.
