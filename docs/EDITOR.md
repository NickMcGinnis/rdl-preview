# RDL editing

RDL Preview supports editing at two levels. Both run entirely inside VS Code on every platform: they don't use the authentication helpers or contact a report server.

| Level | What it adds | Status |
| --- | --- | --- |
| 0 | RDL language support in the normal text editor | Implemented |
| 1 | A tree-and-properties designer that writes back to the text | Implemented |
| 2 | A visual layout surface with drag/resize and Tablix editing | Not planned |

In every level, the `.rdl` text is the only source of truth. Nothing keeps a separate model that can drift from the file, and saving, undo, hot exit, git and **Preview Report** keep working without special handling.

## Level 0 — language support

### Language

- The `rdl` language is registered for `.rdl` and `.rdlc`. Before this, `.rdl` opened as XML only when it started with `<?xml`, and as plain text otherwise.
- The grammar (`language/rdl.tmLanguage.json`) includes VS Code's built-in `text.xml` grammar. On top of that, it highlights element text that starts with `=` as an expression: VB string literals, comments, keywords, function calls, numbers, operators (including `&amp;` concatenation) and `Parameters!`/`Fields!`/`ReportItems!`/`Globals!`/`User!`/`Variables!`/`DataSets!`/`DataSources!` references.
- The language configuration copies the XML one, so comments, brackets and auto-closing behave the same.
- `xmlLanguageParticipants` keeps Red Hat's XML extension (schema validation, tag completion, formatting) working on the `rdl` language.
- Language features also work on `.rdl`/`.rdlc` files that a user has mapped to the `xml` language through `files.associations`.

### Features

| Feature | Behavior |
| --- | --- |
| Outline / breadcrumbs / Go to Symbol | Data Sources, Datasets (with fields), Parameters, Variables, Embedded Images, then Page Header / Body / Page Footer for each section, with report items nested as they are in the layout. Data regions show their dataset. |
| Diagnostics | Malformed XML (with the parser's position). Duplicate names among parameters, data sources, datasets, report items, groups and embedded images, and duplicate field names within a dataset. References in expressions to parameters, fields, report items, datasets, data sources or variables that don't exist, with a hint when only the letter case differs. `DataSetName`, `DataSourceName`, `ToggleItem` and `ParameterName` values that point at nothing. `ValueField`/`LabelField` values missing from the referenced dataset. Scope strings in aggregates and lookups (`Sum(…, "Sales")`) that don't name a dataset, group or data region (warning). Parameter layout grids that break the [RDL 2016 rules](https://learn.microsoft.com/en-us/openspecs/sql_server_protocols/MS-RDL/234a2684-75dc-4caf-913c-65e6547cb764): a parameter without exactly one cell, two cells at the same position, or a cell outside the grid. |
| Completion | After `Parameters!`, `Fields!`, `ReportItems!`, `DataSets!`, `DataSources!`, `Variables!`, `Globals!` or `User!`. Fields from the dataset of the enclosing data region are listed first. |
| Go to Definition | From an expression reference, scope string, `DataSetName`, `DataSourceName`, `ToggleItem`, `ParameterName`, `ValueField` or `LabelField` to the declaring element. |
| Rename Symbol (F2) | From a declaration's name, a reference or a scope string. Renames the declaration and every reference to it, including layout cells and aggregate scope strings. A `Fields!X` reference whose dataset can't be determined, when several datasets declare `X`, is left alone and reported. |
| Folding | Every element that spans more than one line, so long RDL files can be folded even when they aren't indented consistently. |
| Snippets | `rdl-parameter`, `rdl-datasource`, `rdl-datasource-shared`, `rdl-dataset`, `rdl-field`, `rdl-query-parameter`, `rdl-textbox`. |

### Rules for analysis

- Only elements in the report's own namespace are analyzed. Designer metadata (`rd:*`) and anything that redeclares the default namespace, such as the query designer state inside `rd:DesignerState`, are skipped.
- Name lookups are case-sensitive, as SSRS's are. Collection names (`parameters!`) are matched case-insensitively, as VB matches them.
- Expression scanning skips VB string literals and `'` comments, so text such as `="Parameters!X"` is not treated as a reference. Scope strings are only recognized as whole arguments of aggregate, lookup and scope functions (`Sum`, `CountRows`, `Lookup`, `RunningValue`, `InScope`, …), so `Format(x, "N2")` isn't one.
- A reference to `Fields!X` only checks that some dataset declares `X`. Scope rules (data region, aggregate scope arguments) aren't modeled, so they can't produce false errors.
- Semantic diagnostics are only reported when the XML is well formed. The outline is built from a tolerant tokenizer, so it stays useful while the user is typing.
- Diagnostics are recomputed 300 ms after the user stops typing. Results are cached per document version and shared by every provider and the designer.

## Level 1 — designer

### Opening it

The designer is a `CustomTextEditorProvider` (`rdlPreview.designer`) with `"priority": "option"`, so the XML editor stays the default. Open it with **Open Designer** in the editor title bar, the Explorer context menu, the Command Palette or **Open With…**. From the text editor it opens beside the text, which keeps both in view. **Open XML** in the designer's title bar goes the other way.

Because it is a *text* editor provider, the `TextDocument` stays authoritative. VS Code supplies dirty state, save, revert, undo/redo, hot exit and diffs, and the existing preview reads the same document.

### Layout

- **Outline tree:** the level 0 outline, with the report at the root and Data Sources, Datasets, Parameters and Embedded Images always present so items can be added to an empty list. It is an ARIA tree with arrow-key navigation.
- **Properties:** a form for the selected node, grouped into sections. Text fields apply on blur or Enter; code fields also on Ctrl/Cmd+Enter. Invalid values (a size like `abc`, a duplicate name) are shown under the field and nothing is written.
- **Actions:** buttons for the node, such as **Add parameter**, **Move up**, **Add fields…** or **Delete**. Delete asks first and says how many expressions still use the item.
- **Layout drawing:** a to-scale, read-only drawing of the body, header or footer containing the selection. Clicking an item selects it. Rectangles show their contents; data regions, charts and other items are labeled boxes. Everything in it is also in the tree, so it is hidden from screen readers.
- Selecting a node reveals it in any visible text editor for the same file, and moving the cursor in the text editor selects the matching node.

### Editable properties

| Node | Properties | Actions |
| --- | --- | --- |
| Report | Description, author, language, auto refresh; for single-section reports, report width, page size and margins | Add parameter, data source, dataset, page header/footer |
| Section (multi-section reports) | Report width, page size and margins | Add page header/footer |
| Body / Page header / footer | Height; print on first/last page | Add text box; delete header/footer |
| Parameter | Name, data type, prompt, hidden, multi-value, nullable, allow blank; available values (any / static list / query with dataset, value and label field); default values (none / static list / query) | Move up/down, delete |
| Data source | Name; embedded (provider, connection string, integrated security) or shared reference. Warns when the connection string seems to contain a password. | Delete |
| Dataset | Name; data source, command type, query text, timeout and query parameters, or the shared dataset reference | Add field, add fields from a column list, delete |
| Field | Name; query column or calculated expression | Delete |
| Text box | Name, value (single text run), can grow/shrink, font family, size, weight, style, color, format, alignment, vertical alignment | Delete |
| Image | Name, source, embedded image or value, MIME type, sizing | Delete |
| Table / matrix / list | Name, dataset, no-rows message, page break | Delete |
| Chart, gauge, custom item | Name, dataset (when it has one) | Delete |
| Rectangle | Name, page break | Add text box, delete |
| Subreport | Name, report | Delete |
| Every positioned item | Top, left, width, height, hidden, tooltip, background color | |
| Embedded image | Name, preview | Add from a PNG/JPEG/GIF/BMP file (up to 10 MB), delete |
| Variable | Name, value | Delete |

Font settings apply to every text run (alignment to every paragraph) in the text box, so mixed formatting can be made uniform; the form says when runs differ. Text boxes with several runs show their values read-only. Text boxes inside table cells have no position and can't be deleted, because a cell must have content. Everything else, including Tablix rows, columns and groups, is edited in the text editor.

Fields can't be discovered automatically. Report Builder gets them by running the query against the database, and the SSRS execution API has no equivalent. **Add fields…** takes the column names the query returns and creates a field for each, turning names such as `Customer Name` into valid field names (`Customer_Name`).

### How edits are made

`src/rdl-edit.ts` turns each change into the smallest text edits it can:

- Only the target range changes. Comments, `rd:*` metadata, unknown elements, namespace declarations, entity spelling, BOM and line endings elsewhere stay byte-for-byte the same.
- New elements copy the surrounding style: indentation unit, line endings, the parent's namespace prefix, and whether siblings keep their children on one line.
- Nodes are found by **path + Name** (`Report/DataSets/DataSet[Sales]/Fields/Field[Amount]`), not by position, so typing elsewhere in the file doesn't break a selection.
- Each message from the webview carries the document version it was based on. If the user has typed in the text editor since, the edit is rejected and the form refreshes.
- Removing the last item of a list (fields, parameters, query parameters…) removes the list too, because RDL doesn't allow empty lists.
- New children are placed in the order Report Builder writes them. The 2010 schema has no ordered sequence with more than one element (every content model is an unordered choice), so this is cosmetic and never affects validity.
- Parameter changes keep an RDL 2016 `ReportParametersLayout` valid: a new parameter takes the first free cell (adding a row when the grid is full), a deleted parameter's cell is removed (and the layout itself when no parameters remain), and moving a parameter swaps the two cells so the prompt order follows.
- Renames go through the same code as F2, so references, layout cells and scope strings follow.
- Values that start with `=` are expressions: they are edited as text and never evaluated. A checkbox or list property whose value is an expression is shown as an expression field instead.
- Sizes keep the unit they were typed in (`in`, `cm`, `mm`, `pt`, `pc`); the layout drawing converts them to inches.
- Webview messages are untrusted: types, lengths, paths and property keys are validated, and every value is escaped before it enters XML.

The designer is read-only, with an explanation, when the file isn't an RDL report, when the XML is malformed (edits would be guesses), and for RDL 2003/2005 reports. RDL 2008 and later are editable: 2008 keeps `Body`, `Width` and `Page` directly under `Report`, and 2010+ wraps them in `ReportSections/ReportSection`; the designer handles both.

### Preview integration

- The designer's **Preview** button opens the preview beside it.
- `rdlPreview.refreshOnSave` (off by default) re-runs an open preview with its current parameter values whenever its report is saved. Each refresh is a new `LoadReportDefinition` execution, so it happens on save rather than on every change.
- **Validate on Server** runs `LoadReportDefinition` for the active connection without rendering. A rejection is shown as a Problem, placed on the first item the server message names (or the report element), and cleared when the file changes.

### Trust

`capabilities.untrustedWorkspaces` is `"limited"`. Language features and the designer work in untrusted workspaces. **Preview Report**, **Open Demo Report** and **Validate on Server** refuse to run there, because they send the report to a server or execute it. Connection commands only use machine-level settings and SecretStorage, which a workspace can't change.

### Code

| File | Responsibility |
| --- | --- |
| `src/rdl-model.ts` | Tolerant XML tokenizer with exact source ranges, path addressing, and attribute and text helpers. Shared with `rdl.ts`. |
| `src/rdl-analysis.ts` | Declarations, references, scope strings, issues, outline, completion and definitions (no `vscode` import). |
| `src/rdl-rename.ts` | Finding the declaration at an offset and renaming it with its references. |
| `src/rdl-edit.ts` | `Draft`: a working copy that builds minimal, style-preserving edits. |
| `src/rdl-designer.ts` | Designer view model: tree, property descriptions, property and action edits, and the layout drawing (no `vscode` import). |
| `src/language.ts` | VS Code language providers and diagnostics, and the shared analysis cache. |
| `src/designer.ts` | The custom editor: webview messages, applying edits, prompts and text-editor selection sync. |
| `media/designer.js`, `media/designer.css` | The designer webview. |
| `language/` | Grammar, language configuration and snippets. |

### Tests

- `test/language.test.ts` covers analysis, diagnostics, completion, definitions and scope strings.
- `test/designer.test.ts` covers the edit engine (indentation, line endings, prefixes, inline documents, list removal, escaping) and every designer operation against `test/fixtures/sales.rdl`, a synthetic Report Builder–style 2016 report. Most tests assert the exact text produced and that the result has no diagnostics.
- The extension-host test opens the designer on a copy of the fixture, edits a property through the webview message path, checks that only the target text changed, that stale edits are rejected, that adding a parameter updates the layout, that Revert restores the file byte-for-byte, and that F2 rename produces the expected edits. The test window has no focus, so the Undo command itself can't be exercised there; designer changes are ordinary `WorkspaceEdit`s.
- `node --import tsx scripts/ui-harness.mts` serves the designer at `/designer`, backed by the real view model over an in-memory copy of the fixture.

### Not done

- Hover, Find All References and XSD validation inside the extension.
- Editing Tablix structure (rows, columns, groups, cell spans), charts, maps and gauges, beyond the properties listed above.
- Drag and resize in the layout drawing (level 2).
- Incremental parsing. Each change re-parses the whole document; this is fast for typical reports, but very large reports with many embedded images may feel slower.
- The exact server rules for parameter layouts with hidden parameters or empty grid rows haven't been checked against a live SSRS 2016+ or Power BI Report Server.
