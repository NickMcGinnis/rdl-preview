# RDL Preview

Edit SSRS reports with Copilot in VS Code, enter parameters, and preview a server-rendered PDF beside the RDL.

RDL Preview is an MIT-licensed VS Code desktop extension. It submits the local report definition to the SSRS execution service, runs a temporary execution, and displays the returned PDF. It does not publish a permanent report or modify your source file.

**v0.1.1 is a testing release.** Local SOAP fixture tests, a VS Code extension-host smoke test and the PDF viewer are verified. Authentication and rendering against a live SSRS/PBIRS installation still require workplace acceptance testing. Demo mode generates an explicitly simulated PDF and does not render RDL.

## Install

1. Download `rdl-preview-0.1.1.vsix` from [GitHub Releases](https://github.com/NickMcGinnis/rdl-preview/releases).
2. In VS Code, open Extensions → **… → Install from VSIX…** and select the file.
3. Run **RDL Preview: Open Demo Report** from the Command Palette to try parameter entry and PDF display without a server.

Alternatively:

```sh
code --install-extension rdl-preview-0.1.1.vsix
```

VS Code 1.96 or later is required. Installation from GitHub does not require a Marketplace account. Follow your organization's software installation rules on managed laptops.

## Preview a report

1. Open an `.rdl` file in a trusted workspace.
2. Run **RDL Preview: Manage Connections**, add an environment, and configure its report-server URL and authentication.
3. Select **RDL Preview: Test Connection** to check that the execution endpoint responds.
4. Run **RDL Preview: Preview Report**, or use the editor title / file context-menu command.
5. Supply report parameters and click **Render preview**.
6. Change values and render again. After editing the RDL, run **Preview Report** again to submit its latest in-memory contents, including unsaved edits.

The panel supports String, Integer, Float, Boolean and DateTime parameters, available-value lists, defaults, multiple values, nulls and blank strings. Use ISO dates such as `2026-10-15` or `2026-10-15T09:30:00`. Free-form multi-value inputs use one value per line; listed multi-value inputs support the platform's usual Ctrl/Cmd-click and keyboard selection. Changing an upstream parameter refreshes dependent choices; **Refresh choices** is also available. Hidden/internal parameters use server metadata and defaults rather than appearing as editable fields.

PDF controls include page navigation, zoom and **Save PDF**. The inline preview is a visual canvas; save the PDF and use an accessible PDF reader for text search, selection and screen-reader navigation.

## Saved environments

The status-bar item **RDL: Development** shows the selected environment. Click it or run **Switch Environment** to choose another connection. A change invalidates the previous execution; run **Preview Report** again. Existing PDFs remain labeled with the environment that produced them.

Use **Manage Connections** to add, edit or delete connections and replace saved passwords. **Edit advanced settings** opens the machine-specific `rdlPreview.profiles` setting. These settings are excluded from VS Code Settings Sync. Passwords are encrypted using VS Code SecretStorage and are not synced. Parameter values stay in session memory, separately for each report and environment, and are cleared when connection settings change or VS Code restarts.

Example user settings (illustrative hosts and paths):

```json
{
  "rdlPreview.profiles": [
    {
      "id": "development",
      "name": "Development",
      "serverUrl": "https://reports-dev.example.com/reportserver",
      "auth": "windows",
      "catalogFolder": "/Finance/Reports",
      "parameterLanguage": "en-US",
      "timeoutSeconds": 120,
      "dataSources": {
        "Main": { "reference": "/Data Sources/Development" }
      }
    },
    {
      "id": "qa",
      "name": "QA",
      "serverUrl": "https://reports-qa.example.com/reportserver",
      "auth": "ntlm",
      "username": "DOMAIN\\reportdeveloper",
      "catalogFolder": "/Finance/Reports",
      "dataSources": {
        "Main": { "reference": "/Data Sources/QA" }
      }
    }
  ]
}
```

### Authentication

| Method | Windows | macOS / Linux |
| --- | --- | --- |
| `windows` | Current Windows identity through the bundled PowerShell HTTP helper | System `/usr/bin/curl` with SPNEGO and an existing, valid Kerberos ticket |
| `ntlm` | Explicit credentials through the Windows helper | System `/usr/bin/curl` with NTLM support |
| `basic` | Node HTTP(S); HTTP requires per-connection opt-in | Node HTTP(S); HTTP requires per-connection opt-in |
| `demo` | Simulated local output | Simulated local output |

Windows requires Windows PowerShell 5.1 and permission to run the bundled `media/request.ps1`. The extension does not bypass PowerShell execution policy. macOS includes curl; Linux needs a compatible curl at `/usr/bin/curl`. The extension does not acquire Kerberos tickets, change domain settings or configure delegation. Basic authentication must already be enabled on SSRS. Corporate proxy / authentication combinations may need additional work; report reproducible failures using sanitized details.

Use the service URL, normally `/reportserver`, not the `/reports` web portal. HTTPS certificates must be trusted; certificate verification remains enabled. HTTP is supported for all authentication methods after an explicit per-connection opt-in. For Basic authentication, the warning also explains that the username and password travel without encryption. To use a legacy HTTP-only SSRS server, choose Basic, enter its `http://host/reportserver` URL, and select **Allow HTTP for this connection** when prompted. This saves `allowHttp: true` for that profile. Report definitions, parameters and PDF data also travel without TLS. Redirects are rejected rather than forwarding credentials to a different endpoint.

### Database connections and shared resources

The extension connects to SSRS; SSRS connects to the report database. Prefer existing server-side shared data sources with their configured credentials. When the execution service requests data-source credentials, the extension prompts for each username and password and submits all of them together. Those database credentials are used for that execution only and are not saved.

The `dataSources` object is keyed by the RDL's **DataSource Name**, not its SQL database name. An override can use a shared `reference` **or** an embedded `connectionString`, with an optional `dataProvider`:

```json
"dataSources": {
  "Main": {
    "connectionString": "Data Source=sql-dev.example.com;Initial Catalog=ReportingDev",
    "dataProvider": "SQL"
  }
}
```

Connection strings in settings must not contain user IDs, passwords or access tokens. Existing embedded connection properties, including integrated security, are preserved when changing the connection string. Switching an embedded source to a shared source, or vice versa, replaces that source's connection definition only in the submitted copy. Other report XML is preserved.

Relative shared data-source, shared dataset and subreport paths are resolved against `catalogFolder`, because temporary SSRS executions require absolute catalog references. Provide explicit source mappings when your Visual Studio project paths differ from deployed paths. Changing the SSRS URL alone does not change an embedded database connection.

## Server requirements and limitations

- The account must be allowed to use `LoadReportDefinition`: SSRS requires the system-level **ExecuteReportDefinition** permission and appropriate access to referenced resources. A working **Test Connection** is not proof of these permissions.
- Referenced data sources, shared datasets, subreports and custom assemblies must already exist on the selected report server. The extension does not deploy dependencies or load project-local `.rds`/`.rsd` files.
- This release uses the `ReportExecution2005.asmx` SOAP execution API. SSRS/PBIRS configurations, versions, authentication and report compatibility require real-server testing. Power BI Service cloud endpoints and `.pbix` reports are outside scope.
- PDF output comes from the server's fonts, renderer, data providers and database access. There is no local SSRS renderer or visual RDL designer.
- Requests default to a 120-second timeout (configurable 10–600 seconds). The transport response limit is 100 MB, including base64/XML overhead; very large reports need a smaller test input.
- Closing a panel or switching environments cancels the client request. Server-side processing may continue until SSRS ends the request/session.
- Demo mode reads basic, static RDL parameter definitions and produces a labeled fixture PDF. It does not evaluate report expressions, query-backed choices or SQL.

## Development

Use Node.js 24 LTS and npm. No SSRS instance is needed for local tests.

```sh
npm ci
npm run verify
npm run test:extension
npm run package
```

Press **F5** in VS Code to launch an Extension Development Host. The extension-host test downloads an official VS Code build and uses an isolated temporary user profile; Linux needs a graphical session, or `xvfb-run -a npm run test:extension`. Set `VSCODE_EXECUTABLE_PATH` to reuse an existing VS Code executable. To inspect the exact webview in a local browser, run `node --import tsx scripts/ui-harness.mts` after building.

See [work-laptop acceptance testing](docs/WORK-LAPTOP-TESTING.md), [architecture](docs/ARCHITECTURE.md), and [validation](docs/VALIDATION.md). CI runs checks on macOS, Windows and Linux and creates a VSIX artifact. A downloaded package contains compiled code and local PDF.js assets; Node.js is not required to install or use it.

## Privacy and license

The extension adds no telemetry, AI calls, cloud storage or external assets. Live requests go to the configured SSRS server; the PDF viewer's scripts, fonts and worker ship in the package. Demo mode makes no network requests. No report XML, parameter values or credentials are logged by the extension. Server errors are shown in the local panel and can contain database or report details; sanitize them before posting an issue. Work reports and credentials should stay on the work machine.

MIT for this repository's code. PDF.js is Apache-2.0; bundled XML dependencies retain their licenses. Packaged third-party notices are included in `dist/THIRD_PARTY_NOTICES.txt` and `media/pdfjs/LICENSE`.

Protocol references: [temporary report execution](https://learn.microsoft.com/en-us/dotnet/api/reportexecution2005.reportexecutionservice.loadreportdefinition?view=sqlserver-2016), [parameter validation](https://learn.microsoft.com/en-us/dotnet/api/reportexecution2005.reportexecutionservice.setexecutionparameters?view=sqlserver-2016), [execution credentials](https://learn.microsoft.com/en-us/dotnet/api/reportexecution2005.reportexecutionservice.setexecutioncredentials?view=sqlserver-2016), [rendering](https://learn.microsoft.com/en-us/dotnet/api/reportexecution2005.reportexecutionservice.render?view=sqlserver-2016).
