# Design

The visual authority is VS Code's existing workbench. This is a narrowly scoped companion panel, not a new visual identity.

Use native QuickPick/InputBox flows for connection management and switching. Use VS Code theme tokens, the workbench font, normal form controls and explicit focus rings in the preview webview. The panel presents a parameter column and a larger document area, stacking in narrow editor groups. Keep the active environment, report filename, parameter validation and render state visible. The PDF area uses local PDF.js assets, with page and zoom controls. Demo mode is labeled beside the environment and in every generated page. Parameter metadata determines form fields; null and blank remain distinct.
