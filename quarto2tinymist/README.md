# Quarto Typst Sync 🚀

**The missing bridge for professional Quarto-Typst workflows in VS Code and Positron.**

Quarto Typst Sync provides high-performance, bidirectional navigation between your Quarto (`.qmd`) source files and Typst (`.typ`) outputs. It allows you to leverage Quarto's powerful statistical engine and modular includes while enjoying the lightning-fast, real-time visual typesetting of the Tinymist (Typst) previewer.

## 💎 The Core Feature: Precise Inverse Search

**Tired of hunting for typos in massive documents?** 
Double-click anywhere in your Tinymist PDF preview, and this extension will instantly teleport you back to the exact word in your Quarto source.

Unlike standard text jumpers, **Quarto Typst Sync** is built for complex projects:
*   **Word-Level Precision:** Lands your cursor on the specific word you clicked, not just the general line.
*   **The "Red Pulse":** A temporary visual highlight ensures you never lose track of your cursor after a jump.
*   **Modular Aware:** Automatically scans your project tree to find matches inside nested `{{< include chapter.qmd >}}` files.

## Core Features

*   **⚡ High-Speed Render:** Triggers a cached Quarto render that updates your `.typ` file in the background, forcing an instant PDF refresh.
*   **🔍 Precision Inverse-Sync:** Move from PDF → Typst → Quarto in milliseconds.
*   **🎯 Forward-Sync:** Jump from your `.qmd` draft to the corresponding location in the `.typ` file.
*   **📋 Smart Output Logging:** A dedicated "Quarto -> Typst" terminal shows the render log, including multi-line Typst/Pandoc error traces, making debugging math and syntax errors a breeze.
*   **🗂️ Tidy Layout:** The generated `.typ` opens as a tab next to your `.qmd` (never twice), and the Tinymist preview gets its own editor group.

## How to Use

### 1. Build the Bridge (Render)
Click the **Play icon** in your editor title bar or use the command `Render Quarto to Typst`. This saves your file and runs a background render. The first time, the generated `.typ` opens as a tab next to your `.qmd` and the Tinymist preview opens in a separate editor group; later renders just refresh them, and nothing is opened twice. Use the **format picker** (chevron icon) to choose the Typst output format; it is detected from your document, `_quarto.yml` and `_extensions`.

### 2. Inverse Search (Preview → Source)
Double-click a line in your **PDF Preview**. Tinymist will jump to the `.typ` file; Quarto Typst Sync will instantly "hop" you over to the correct `.qmd` file and highlight the paragraph in **red**.

### 3. Forward Sync (Source → Preview)
With your cursor in a `.qmd` file, use the shortcut or the **Arrow icon** in the title bar to find that same location in the Typst source.

## Commands and Keybindings

All commands are in the editor title bar for `.qmd` files and have default keybindings (which you can change in `keybindings.json`):

| Command | Shortcut (Mac) | Shortcut (Windows/Linux) | Action |
| :--- | :--- | :--- | :--- |
| `qmd2typ.preview` | `Cmd + Shift + R` | `Ctrl + Shift + R` | Render `.qmd` to `.typ` and open the preview |
| `qmd2typ.forwardSync` | `Cmd + Shift + J` | `Ctrl + Shift + J` | Jump from `.qmd` to the matching place in the `.typ` and preview |
| `qmd2typ.exportPdf` | `Cmd + Shift + V` | `Ctrl + Shift + V` | Compile the `.typ` to a final PDF |
| `qmd2typ.selectFormat` | (title bar) | (title bar) | Choose the Typst output format passed to `quarto render --to` |

## Requirements

*   **[Quarto CLI](https://quarto.org/docs/get-started/)**: Must be installed and available in your system PATH.
*   **[Tinymist Typst Extension](https://marketplace.visualstudio.com/items?itemName=myriad-dreamin.tinymist)**: Required for the PDF preview and LSP support.
*   **[Quarto extension](https://marketplace.visualstudio.com/items?itemName=quarto.quarto)**: Provides `.qmd` language support.

Both extensions are installed automatically as dependencies. The extension runs in VS Code and Positron.

## Why this exists?

When writing academic papers or technical books, Quarto is the best tool for data and math, but the "edit-render-wait" cycle can be slow. By using Typst as a bridge, you get instant feedback. This extension removes the friction of managing two different file types, allowing you to treat your `.qmd` as the source of truth while using `.typ` as a high-speed viewing engine.

---
Developed by **[Longhai Li] (https://longhaisk.github.io/)**