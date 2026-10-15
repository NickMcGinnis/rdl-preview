# Manual testing against a live server

Automated tests use local SOAP fixtures only. Use this checklist against a development SSRS/PBIRS server before relying on a release. Keep real server names, credentials, reports and PDFs out of issues.

1. Install the release VSIX through Extensions → … → Install from VSIX.
2. Run **RDL Preview: Open Demo Report**. Change Department, select multiple Regions, choose null for Notes and render. Render again with different values. This checks the extension and viewer, not SSRS.
3. Run **Manage Connections** → Add connection. Enter the report-server URL (usually `/reportserver`), authentication method and catalog folder.
4. Run **Test Connection**. On Windows, try current identity first if your server uses Windows authentication. A 401 means sign-in failed, a 403 means access is denied, and a redirect or portal page means the URL is wrong.
5. Copy `examples/parameter-demo.rdl` into a local folder, switch to the live connection and preview it. It has parameters but no data source, so it isolates execution permissions from database access. The PDF should show the report title and the chosen values. If `LoadReportDefinition` is denied, the account needs the **ExecuteReportDefinition** system permission.
6. Open a real parameterized RDL. Add any data-source overrides to the profile and set `catalogFolder` to the folder holding the deployed report's shared resources.
7. Check parameter names, defaults, labels, available values and types. Test dates, false booleans, multiple selections, blank vs null and cascading parameters. Change an upstream value and confirm dependent values are cleared and refreshed.
8. Render and compare values, layout, page count and totals with the same report run from the web portal. Test page navigation, zoom and Save PDF on a multipage report.
9. Edit the RDL without saving and run **Preview Report** again. Confirm the preview reflects the edit and keeps parameter values for the current environment.
10. Add a second environment and switch from the status bar. Confirm the old execution is invalidated, the panel names the new environment, overrides point at the intended database, and parameter values don't carry across environments.
11. Restart VS Code. Connections and passwords should persist; parameter values should be cleared. Edit a connection and replace a password through Manage Connections.

When reporting a failure, include the extension version, VS Code version, OS, SSRS/PBIRS version, authentication method, the step that failed and a sanitized error message.
