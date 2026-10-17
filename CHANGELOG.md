# Changelog

## Unreleased

- **RDL Designer**: open an RDL file with **Open Designer** to edit it through an outline tree and property forms beside the XML. Edits report and page settings, parameters with available and default values, data sources, datasets, query parameters, fields, and common text box, image, rectangle, table and subreport properties. Adds and deletes report objects, keeps RDL 2016 parameter layouts valid, and shows a to-scale drawing of the page. Changes are ordinary text edits, so Undo, Save and source control work as usual.
- **Rename Symbol** (F2) for parameters, fields, datasets, data sources, report items, groups, variables and embedded images, including references in expressions, layout cells and aggregate scope strings.
- **Validate on Server** checks a report definition with the active connection without rendering it.
- New `rdlPreview.refreshOnSave` setting re-runs an open preview when its report is saved.
- Editing, the designer and language features now work in untrusted workspaces. Previewing and server validation still require trust.
- Diagnostics follow the RDL 2016 parameter layout rules (one cell per parameter, unique positions inside the grid) and check aggregate and lookup scope strings.
- `.rdl` and `.rdlc` files open as the new **RDL** language. It adds expression highlighting, an Outline, diagnostics for malformed XML, duplicate names and undefined references, completion after `Parameters!`/`Fields!`/`ReportItems!` and similar, Go to Definition, folding and snippets. Red Hat XML extension features keep working through `xmlLanguageParticipants`.

## 0.1.3 — 2026-10-15

- The editor title bar shows a report icon instead of the **Preview Report** label.
- Switch, add and manage environments from a dropdown in the preview header. Switching starts a new execution in the same panel instead of requiring **Preview Report** again.
- Remove the environment status bar item.
- Fix **Use null** on non-string parameters. A null value is now sent without a `Value` element, as Visual Studio sends it, instead of with `xsi:nil`, which SSRS read as a blank value. Integer, date and other typed parameters were rejected as "not valid for its type".

## 0.1.2 — 2026-10-15

- Windows NTLM connections only offer the password to NTLM/Negotiate challenges, so a server can no longer request it over Basic.
- Windows transport no longer pins TLS 1.2; it adds TLS 1.2 to the system defaults instead.
- Activate only in workspaces containing `.rdl` files instead of on every startup.
- The test API is only exposed when running under the extension test host.

## 0.1.1 — 2026-10-15

- Allow Basic authentication with HTTP-only SSRS servers after explicit per-connection opt-in.
- Explain unencrypted credential transmission in the connection warning and settings.
- Preserve the opt-in when editing the same connection; keep HTTPS certificate checks and redirect rejection.
- Add HTTP Basic SOAP regression tests.

## 0.1.0 — 2026-10-15

Initial testing release:

- Temporary SSRS report execution from the current RDL document.
- Typed parameter entry, defaults, available values, multiple values, nullable/blank values and dependent-choice refresh.
- Saved machine-local environment profiles and encrypted connection passwords.
- Environment switching and preview-only shared/embedded data-source overrides.
- Execution-scoped database credential prompts.
- Local PDF.js viewer with page navigation, zoom and save.
- Offline demo mode and a synthetic sample report.
