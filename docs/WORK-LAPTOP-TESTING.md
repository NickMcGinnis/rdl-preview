# Work-laptop acceptance test

Use an approved development environment. Keep actual server names, credentials, report definitions, parameter values and PDFs on the work machine.

1. Download the release VSIX and install it through Extensions → … → Install from VSIX. No clone, npm or Node.js installation is required.
2. Run **RDL Preview: Open Demo Report**. Change Department, select multiple Regions, choose null for Notes and render. Confirm a clearly labeled DEMO PDF appears. Render a second time with different values. This verifies the extension and viewer, not SSRS.
3. Run **Manage Connections** → Add connection. Enter the real report-server URL (usually `/reportserver`), authentication and report catalog folder. HTTP-only servers can use Basic authentication after selecting **Allow HTTP for this connection** in the warning; that warning states that usernames, passwords and report data travel unencrypted.
4. Run **Test Connection**. On Windows, try current identity first if your organization uses Windows authentication. A 401 means sign-in failed. A 403 means access is denied. A redirect or portal page means the endpoint needs correction.
5. To isolate server execution permissions from database access, copy the bundled `examples/parameter-demo.rdl` into a local work folder, switch to the live connection and preview it. This synthetic report has parameters but needs no database. Unlike demo mode, its PDF should contain the RDL's report title and the parameters you chose. If LoadReportDefinition is denied, ask the SSRS administrator about ExecuteReportDefinition; Test Connection alone does not exercise this permission.
6. Open one real parameterized RDL from the work environment. Add any shared-source mappings or embedded connection overrides under the machine-specific profile setting. Set catalogFolder to the folder containing the deployed report's shared resources.
7. Confirm parameter names, defaults, labels, allowed values and types. Test dates, false booleans, multiple selections, blank vs null and any cascading dependencies used by that report. Change the upstream choice and confirm stale dependent values are cleared and refreshed.
8. Render a PDF. Compare its values, layout, page count and totals with the same report and parameters in your existing tool. Test page navigation, zoom and Save PDF on a multipage report.
9. Ask Copilot to make a small visible change, then run **Preview Report** again. Confirm the new preview uses the edit and preserves parameter values for the current environment.
10. Add a second environment and switch using the status bar. Confirm the previous execution becomes inactive, the new panel names the new environment, data-source mappings select the intended database, and parameter values do not leak between environments.
11. Restart VS Code. Confirm connections remain saved, credentials behave as expected, and parameter values have been cleared. Edit a connection and replace a password through Manage Connections.

Record the extension version, VS Code version, OS, SSRS/PBIRS version, authentication method, sanitized error code, and which step failed. Share a synthetic reproduction rather than an actual company report. An issue report should never include passwords, parameter values, connection strings with secrets or business PDFs.
