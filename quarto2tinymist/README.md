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
*   **📋 Smart Output Logging:** A dedicated output channel captures detailed multi-line Typst/Pandoc error traces, making debugging math and syntax errors a breeze.

## How to Use

### 1. Build the Bridge (Render)
Click the **Play icon** in your editor title bar or use the command `Render Quarto to Typst`. This saves your file and runs a background render. Your Tinymist preview will update automatically.

### 2. Inverse Search (Preview → Source)
Double-click a line in your **PDF Preview**. Tinymist will jump to the `.typ` file; Quarto Typst Sync will instantly "hop" you over to the correct `.qmd` file and highlight the paragraph in **red**.

### 3. Forward Sync (Source → Preview)
With your cursor in a `.qmd` file, use the shortcut or the **Arrow icon** in the title bar to find that same location in the Typst source.

## Recommended Keybindings

To make the workflow feel native, add these to your `keybindings.json`:

| Command | Shortcut (Mac) | Shortcut (Windows) | Action |
| :--- | :--- | :--- | :--- |
| `qmd2typ.preview` | `Cmd + Shift + T` | `Ctrl + Shift + T` | Render `.qmd` to `.typ` |
| `qmd2typ.forwardSync` | `Cmd + Shift + F` | `Ctrl + Shift + F` | Jump from `.qmd` to `.typ` |

## Requirements

*   **[Quarto CLI](https://quarto.org/docs/get-started/)**: Must be installed and available in your system PATH.
*   **[Tinymist Typst Extension](https://marketplace.visualstudio.com/items?itemName=myriad-dreamin.tinymist)**: Required for the PDF preview and LSP support.

## Why this exists?

When writing academic papers or technical books, Quarto is the best tool for data and math, but the "edit-render-wait" cycle can be slow. By using Typst as a bridge, you get instant feedback. This extension removes the friction of managing two different file types, allowing you to treat your `.qmd` as the source of truth while using `.typ` as a high-speed viewing engine.

---
Developed by **[Longhai Li] (https://longhaisk.github.io/)**