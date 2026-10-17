# RDL Preview

Preview SSRS reports in VS Code: enter parameters and see the server-rendered PDF beside the RDL.

RDL Preview submits the open report definition to the SSRS execution service as a temporary execution and displays the returned PDF. Nothing is published to the server and the source file is never modified.

> **Status:** early testing release. The protocol is covered by local fixture tests, but authentication and rendering have not yet been verified against many live SSRS/PBIRS installations. See [manual testing](docs/MANUAL-TESTING.md).

## Install

Download the `.vsix` from the [latest release](https://github.com/NickMcGinnis/rdl-preview/releases), then either use Extensions → **… → Install from VSIX…** or run:

```sh
code --install-extension rdl-preview-<version>.vsix
```

Requires VS Code 1.96 or later. Run **RDL Preview: Open Demo Report** to try the parameter panel and PDF viewer without a server.

## Preview a report

1. Open an `.rdl` file in a trusted workspace.
2. Run **RDL Preview: Manage Connections** and add a connection.
3. Run **RDL Preview: Test Connection** to check the execution endpoint responds.
4. Run **RDL Preview: Preview Report**, or click the report icon in the editor title bar (also in the file context menu).
5. Fill in parameters and click **Render preview**.

Parameters can be changed and re-rendered in place. After editing the RDL, run **Preview Report** again; unsaved edits are included.

Supported parameter types are String, Integer, Float, Boolean and DateTime, including available-value lists, defaults, multiple values, null and blank. Enter dates as `2026-10-15` or `2026-10-15T09:30:00`, and free-form multi-value parameters one value per line. Changing an upstream parameter refreshes dependent choices. Hidden parameters use their server defaults.

The viewer supports page navigation, zoom and **Save PDF**. The inline preview is a canvas, so save the PDF to search or select text or to use a screen reader.

## Edit RDL

`.rdl` and `.rdlc` files open as the **RDL** language, with:

- XML highlighting, plus highlighting of expressions (element text starting with `=`) and their `Parameters!`, `Fields!` and `ReportItems!` references.
- An Outline and breadcrumbs showing data sources, datasets and fields, parameters, and the header, body and footer report items.
- Problems for malformed XML, duplicate names, and references to parameters, fields, report items, datasets, data sources or variables that don't exist. Names are case-sensitive, as in SSRS.
- Completion after `Parameters!`, `Fields!`, `ReportItems!`, `Globals!` and similar, and **Go to Definition** from a reference to its declaration.
- Folding for every multi-line element, and snippets starting with `rdl-` for parameters, data sources, datasets, fields, query parameters and textboxes.

If the Red Hat XML extension is installed, its features (formatting, tag completion, and schema validation once you associate the RDL XSD) still work on RDL files. See [RDL editing](docs/EDITOR.md) for details and the planned designer.

## Connections

The preview header shows the active environment. Pick another from its **Environment** dropdown to start a new execution in the same panel; the dropdown also adds and manages connections. **Switch Environment** in the Command Palette does the same.

**Manage Connections** adds, edits and deletes connections and replaces saved passwords. **Edit advanced settings** opens the `rdlPreview.profiles` setting, which is machine-scoped and not synced. Passwords are stored in VS Code SecretStorage. Parameter values are remembered per report and connection until VS Code restarts or connection settings change.

Example settings:

```json
{
  "rdlPreview.profiles": [
    {
      "id": "development",
      "name": "Development",
      "serverUrl": "https://reports-dev.example.com/reportserver",
      "auth": "windows",
      "catalogFolder": "/Finance/Reports",
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
      "catalogFolder": "/Finance/Reports"
    }
  ]
}
```

Optional fields: `parameterLanguage` (default `en-US`), `timeoutSeconds` (10–600, default 120) and `allowHttp`.

### Authentication

| Method | Windows | macOS / Linux |
| --- | --- | --- |
| `windows` | Current Windows identity via the bundled PowerShell helper | `/usr/bin/curl` with SPNEGO and an existing Kerberos ticket |
| `ntlm` | Explicit credentials via the PowerShell helper | `/usr/bin/curl` with NTLM |
| `basic` | Node HTTP(S) | Node HTTP(S) |
| `demo` | Simulated local output | Simulated local output |

On Windows, the helper needs Windows PowerShell 5.1 and an execution policy that allows the bundled `media/request.ps1`; the extension does not bypass execution policy. The extension does not acquire Kerberos tickets. Basic must already be enabled on the server.

Use the service URL (normally `/reportserver`), not the `/reports` web portal. Certificates must be trusted. Redirects are rejected rather than followed.

HTTP URLs require an explicit opt-in: when you enter an `http://` URL, a warning explains that report data (and, for Basic, the username and password) will travel unencrypted, and choosing **Allow HTTP for this connection** saves `allowHttp: true` on that connection.

### Data sources and shared resources

The extension talks to SSRS; SSRS talks to the database. Server-side shared data sources with stored credentials work best. If SSRS asks for data-source credentials, you are prompted for each one; they are used for that execution only and not saved.

`dataSources` is keyed by the RDL's DataSource `Name`. Each override is either a shared `reference` or a `connectionString`, with an optional `dataProvider`:

```json
"dataSources": {
  "Main": {
    "connectionString": "Data Source=sql-dev.example.com;Initial Catalog=ReportingDev",
    "dataProvider": "SQL"
  }
}
```

Connection strings must not contain user IDs, passwords or access tokens. Overrides apply only to the copy sent to the server; the rest of the report XML is untouched.

Temporary executions need absolute catalog paths, so relative shared data source, shared dataset and subreport references are resolved against `catalogFolder`.

## Limitations

- The account needs the system-level **ExecuteReportDefinition** permission. Test Connection does not check it.
- Shared data sources, shared datasets, subreports and custom assemblies must already be deployed. Project-local `.rds`/`.rsd` files are not used.
- Uses the `ReportExecution2005.asmx` SOAP API. Power BI Service and `.pbix` reports are out of scope.
- Rendering uses the server's fonts and renderer; there is no local renderer or visual designer.
- Field checks only confirm that some dataset declares the field; data-region and aggregate scopes aren't checked locally.
- Responses are limited to 100 MB, including base64/XML overhead.
- Closing the panel cancels the client request, but the server may keep processing until it finishes.
- Demo mode reads static parameter definitions and produces a labeled placeholder PDF. It does not evaluate expressions, run queries or render the report.

## Development

Requires Node.js 24 and npm. Tests don't need an SSRS server.

```sh
npm ci
npm run verify          # type check, unit tests, build
npm run test:extension  # VS Code extension-host test
npm run package
```

Press **F5** to launch an Extension Development Host. The extension-host test downloads VS Code and uses a temporary profile; on Linux run it under `xvfb-run -a`, and set `VSCODE_EXECUTABLE_PATH` to reuse an existing install. To open the webview in a browser, build and then run `node --import tsx scripts/ui-harness.mts`.

See also [architecture](docs/ARCHITECTURE.md), [RDL editing](docs/EDITOR.md) and [manual testing](docs/MANUAL-TESTING.md).

## Privacy

No telemetry. The only network requests go to your configured report server; PDF.js, its fonts and worker ship in the package. Report XML, parameter values and credentials are not logged. Server error messages may include database or report details, so sanitize them before posting an issue.

## License

MIT. PDF.js is Apache-2.0; other bundled dependencies keep their own licenses. Notices ship in `dist/THIRD_PARTY_NOTICES.txt` and `media/pdfjs/LICENSE`.

SSRS API references: [LoadReportDefinition](https://learn.microsoft.com/en-us/dotnet/api/reportexecution2005.reportexecutionservice.loadreportdefinition?view=sqlserver-2016), [SetExecutionParameters](https://learn.microsoft.com/en-us/dotnet/api/reportexecution2005.reportexecutionservice.setexecutionparameters?view=sqlserver-2016), [SetExecutionCredentials](https://learn.microsoft.com/en-us/dotnet/api/reportexecution2005.reportexecutionservice.setexecutioncredentials?view=sqlserver-2016), [Render](https://learn.microsoft.com/en-us/dotnet/api/reportexecution2005.reportexecutionservice.render?view=sqlserver-2016).
