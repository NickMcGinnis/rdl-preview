# RDL Preview

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
VS Code desktop extension in TypeScript with a local HTML/CSS/JavaScript webview. This follows the extension workflow accepted in the project brief.

## Users and purpose
Report developers use Copilot to edit RDL files and need to pass parameters and see server-rendered previews without using the Visual Studio designer. Development happens on a personal Mac; initial SSRS acceptance testing happens on a work laptop.

## Capabilities and constraints
First release: parameterized local-RDL preview, editable saved environment profiles, environment switching, encrypted credentials, demo mode, public FOSS source and downloadable VSIX. Use the real SSRS execution service for live previews; local demo output is explicitly simulated. Preserve the original RDL. No live SSRS server is available during initial development.

## Operating context
Copilot supplies existing authoring features. The extension owns connection, parameter entry and preview. Workplace configuration and reports remain on the work machine. SSRS and database credentials are separate.

## Product principles
Keep the edit/preview loop short. Make the active environment visible. Distinguish demo success from live acceptance. Use VS Code conventions.
