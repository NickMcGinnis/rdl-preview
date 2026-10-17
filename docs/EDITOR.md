# RDL editing

This plan covers adding editing support to RDL Preview in two levels. Both run entirely inside VS Code on every platform: they don't use the authentication helpers or contact a report server.

| Level | What it adds | Status |
| --- | --- | --- |
| 0 | RDL language support in the normal text editor | Implemented |
| 1 | A tree-and-properties designer that writes back to the text | Planned |
| 2 | A visual layout surface with drag/resize and Tablix editing | Not planned |

In every level, the `.rdl` text is the only source of truth. Nothing keeps a separate model that can drift from the file, and saving, undo, hot exit, git and **Preview Report** keep working without special handling.

## Level 0 — language support

### Language

- The `rdl` language is registered for `.rdl` and `.rdlc`. Before this, `.rdl` opened as XML only when it started with `<?xml`, and as plain text otherwise.
- The grammar (`language/rdl.tmLanguage.json`) includes VS Code's built-in `text.xml` grammar. On top of that, it highlights element text that starts with `=` as an expression: VB string literals, comments, keywords, function calls, numbers, operators (including `&amp;` concatenation) and `Parameters!`/`Fields!`/`ReportItems!`/`Globals!`/`User!`/`Variables!`/`DataSets!`/`DataSources!` references.
- The language configuration copies the XML one, so comments, brackets and auto-closing behave the same.
- `xmlLanguageParticipants` keeps Red Hat's XML extension (schema validation, tag completion, formatting) working on the `rdl` language. Without it, users who already map `.rdl` to that extension would lose its features.
- Language features also work on `.rdl`/`.rdlc` files that a user has mapped to the `xml` language through `files.associations`.

### Features

| Feature | Behavior |
| --- | --- |
| Outline / breadcrumbs / Go to Symbol | Data Sources, Datasets (with fields), Parameters, Variables, Embedded Images, then Page Header / Body / Page Footer for each section, with report items nested as they are in the layout. Data regions show their dataset. |
| Diagnostics | Malformed XML (with the parser's position). Duplicate names among parameters, data sources, datasets, report items, groups and embedded images, and duplicate field names within a dataset. References in expressions to parameters, fields, report items, datasets, data sources or variables that don't exist, with a hint when only the letter case differs. `DataSetName`, `DataSourceName`, `ToggleItem` and `ParameterName` values that point at nothing. `ValueField`/`LabelField` values missing from the referenced dataset. Parameters that have no cell in a `ReportParametersLayout`. |
| Completion | After `Parameters!`, `Fields!`, `ReportItems!`, `DataSets!`, `DataSources!`, `Variables!`, `Globals!` or `User!`. Fields from the dataset of the enclosing data region are listed first. |
| Go to Definition | From an expression reference, `DataSetName`, `DataSourceName`, `ToggleItem`, `ParameterName`, `ValueField` or `LabelField` to the declaring element. |
| Folding | Every element that spans more than one line, so long RDL files can be folded even when they aren't indented consistently. |
| Snippets | `rdl-parameter`, `rdl-datasource`, `rdl-datasource-shared`, `rdl-dataset`, `rdl-field`, `rdl-query-parameter`, `rdl-textbox`. |

### Rules for analysis

- Only elements in the report's own namespace are analyzed. Designer metadata (`rd:*`) and anything that redeclares the default namespace, such as the query designer state inside `rd:DesignerState`, are skipped.
- Name lookups are case-sensitive, as SSRS's are. Collection names (`parameters!`) are matched case-insensitively, as VB matches them.
- Expression scanning skips VB string literals and `'` comments, so text such as `="Parameters!X"` is not treated as a reference.
- A reference to `Fields!X` only checks that some dataset declares `X`. Scope rules (data region, aggregate scope arguments) aren't modeled, so they can't produce false errors.
- Semantic diagnostics are only reported when the XML is well formed. The outline is built from a tolerant tokenizer, so it stays useful while the user is typing.
- Diagnostics are recomputed 300 ms after the user stops typing. Results are cached per document version and shared by every provider.

### Code

| File | Responsibility |
| --- | --- |
| `src/rdl-model.ts` | Tolerant XML tokenizer with exact source ranges, attribute and text helpers. It is shared with `rdl.ts`. |
| `src/rdl-analysis.ts` | Pure analysis (no `vscode` import): declarations, references, issues, outline, completion and definition lookups. |
| `src/language.ts` | Registers VS Code providers and the diagnostic collection over `rdl-analysis.ts`. |
| `language/` | Grammar, language configuration and snippets. |

### Not in level 0

- XSD validation inside the extension. Red Hat's XML extension can do this with Microsoft's published schemas; bundling them depends on their redistribution terms.
- Hover, Find All References and Rename. Rename belongs with level 1 because it edits the document.
- Scope-aware field checks and checks of aggregate scope arguments.
- Language features in untrusted workspaces. The extension declares `untrustedWorkspaces.supported: false`, so it is disabled entirely there. Level 1 should revisit this, because editing runs nothing and could be supported as `"limited"`.

## Level 1 — designer (plan)

### Shape

A `CustomTextEditorProvider` registered as `rdlPreview.designer` with `"priority": "option"`. The XML text editor stays the default. The designer opens from **Open With…**, an editor-title button, and a command. It is a webview with three panes:

1. **Report tree:** the level 0 outline. Selecting an item in the designer reveals it in the text editor, and the other way round.
2. **Property form:** fields for the selected node (see Scope).
3. **Page wireframe:** a read-only scaled drawing of the body, header and footer using `Top`/`Left`/`Width`/`Height`. Clicking an item selects it. Data regions, charts, maps and gauges are drawn as labeled boxes.

Because the provider is a *text* editor provider, the `TextDocument` stays authoritative. VS Code supplies dirty state, save, revert, undo/redo, hot exit and diffs, and the existing preview reads the same document.

### Document model

Extend `src/rdl-model.ts` from a tokenizer into an editable source tree:

- Record ranges for attributes and text nodes as well as elements, and detect the indentation and newline style each parent uses.
- Identify nodes by **path + Name**, for example `DataSets/DataSet[Name=Sales]/Fields/Field[Name=Amount]`, not by character position. The user may type in the text editor while the designer is open.
- Re-parse after every document change (`onDidChangeTextDocument`), re-resolve the selected path, and post the new state to the webview. If the selected node disappears, select its nearest surviving ancestor.

### Edits

Each designer action becomes a small operation that produces a `WorkspaceEdit` covering the fewest characters possible:

| Operation | Notes |
| --- | --- |
| `setText(path, value)` | Escapes XML. Turns a self-closing element into an open/close pair when needed. |
| `setChild(path, name, value)` | Creates the child if missing, uses the parent's namespace prefix, and inserts it in schema order with matching indentation. |
| `removeChild(path, name)` | Removes the element and the whitespace it owned. |
| `insertElement(path, xml, position)` / `removeElement(path)` | Adding and deleting parameters, datasets, fields and so on. |
| `rename(collection, old, new)` | Changes the `Name` attribute, then every reference that level 0 analysis found (`Parameters!X`, `Fields!X`, `DataSetName`, `ParameterName`…), as one edit. |

Rules every operation must follow:

- **Only touch the target range.** Comments, `rd:*` metadata, unknown elements, namespace declarations, entity spelling, BOM and line endings elsewhere stay byte-for-byte the same.
- **Respect the schema version.** Read the namespace (2008/01, 2010/01, 2016/01) and only insert elements that version allows. For example, `ReportSections` and `ReportParametersLayout` don't exist in 2008.
- **Keep linked structures in sync.** Adding or removing a parameter in a 2016 report also adds or removes its `CellDefinition` in `ReportParametersLayout` and updates `NumberOfRows`/`NumberOfColumns` if needed. Removing a dataset warns about data regions and references that still use it.
- **Escape every webview value** before it enters XML. The webview is untrusted, as the preview's is today: validate message shape, length and the target path.
- **Edit expressions as text.** Never evaluate them. Values that start with `=` get a monospace field with level 0 expression completion.
- **Keep size units.** Sizes (`in`, `cm`, `mm`, `pt`, `pc`) are edited in the unit they're stored in, and converted only for the wireframe.

### Scope

| Area | Editable |
| --- | --- |
| Report | Description, author, page size, margins, columns, body height and width, report width, language, `AutoRefresh` |
| Parameters | Add, delete, reorder, rename (with references); data type, prompt, hidden/internal, nullable, allow blank, multi-value; static defaults; static available values; query-based defaults and available values (dataset, value field, label field) |
| Data sources | Add, delete, rename; shared reference or embedded provider + connection string (no credentials); integrated security |
| Datasets | Add, delete, rename; data source; command type; query text (monospace, with a **Open in text editor** link for long queries); query parameters; timeout; **fields list edited by hand** |
| Report items | Name (with references), `Top`/`Left`/`Width`/`Height`, `Hidden`, `ToolTip`. Textbox: value (plain or expression), `CanGrow`/`CanShrink`, and font family, size, weight, style, color, alignment and format string on the first run/paragraph |
| Data regions | Name, dataset, `NoRowsMessage`, `PageBreak`. The cells inside a Tablix are edited with the text editor. |

Fields can't be discovered automatically. Report Builder gets them by running the query against the database, and the SSRS execution API has no equivalent. Field editing is manual, with a **Paste field names** helper that accepts a column list.

### Webview

- Add a second esbuild entry for `media/designer.ts`. The scripts copy the preview's CSP, nonce and `vscode-*` theme variable patterns.
- Use plain DOM code, or Preact if the tree and form grow too large for that. Don't use `@vscode/webview-ui-toolkit`, which is deprecated.
- The panel is keyboard navigable: a tree with `role="tree"` and arrow keys, labeled form controls, and errors announced through `aria-live`.
- The wireframe is a drawing aid only. Everything it shows is also in the tree.

### Preview integration

- Add a **Preview** button in the designer that opens or refreshes the existing preview beside it.
- Add an optional `rdlPreview.refreshOnSave` setting that re-renders an open preview with its current parameters when the document is saved. Each refresh is a new `LoadReportDefinition` execution, so this happens only on save, not on every keystroke.
- Add a **Validate on server** command that runs `LoadReportDefinition` for the active connection and shows the server's error as a diagnostic, without rendering.

### Trust

Switch `capabilities.untrustedWorkspaces` to `"limited"`. Language features and the designer work in untrusted workspaces; preview, connection and server-validation commands keep refusing there, as `preview` already does. Review every command entry point for an `isTrusted` check before making the switch.

### Tests

- **Round trip:** a corpus of synthetic and MIT-licensed sample reports (Microsoft's `sql-server-samples` reports) covering the 2008, 2010 and 2016 schemas. Parsing and serializing with no edits must give byte-identical output. Each edit operation must produce well-formed XML that changes only the expected range. Each operation's output should match a stored expected result.
- **Schema:** where Microsoft's XSDs can be used in CI, every edit result validates against the schema for its namespace.
- **Extension host:** open the designer on the example report, change a parameter prompt through the test API, and check that the document is dirty, undo restores it byte-for-byte, and the preview still renders in demo mode.
- **Browser harness:** extend `scripts/ui-harness.mts` to load the designer webview with fixture state.

### Order of work

1. Editable document model and edit operations, with round-trip tests. No UI.
2. Rename across references, also available as a text-editor **Rename Symbol** (`F2`) provider.
3. Designer shell: tree, selection sync, and report and page properties.
4. Parameters, then data sources and datasets, then report items.
5. Wireframe.
6. Preview integration, server validation and limited trust.

### Risks and open questions

- **Parameter layout.** The exact server rules for `ReportParametersLayout` (hidden parameters, gaps in the grid) need checking against SSRS 2016+ and Power BI Report Server.
- **Element order.** Most RDL content models are unordered choices, but some aren't. Insertion order should come from the XSD, not guesswork.
- **Large reports.** Reports with big `EmbeddedImages` need incremental re-parsing, or at least skipping image data during analysis, so the designer stays responsive.
- **Concurrent edits.** If the user types in the text editor during a designer edit, the `WorkspaceEdit` must be based on the current document version, or retried after re-parsing.
