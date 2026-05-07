# Quarto Typst Sync

A high-performance bridge and smart cross-file jumper designed for Positron and VS Code. **Quarto Typst Sync** seamlessly connects your Quarto (`.qmd`) source files with Typst (`.typ`) outputs, giving you the heavy-lifting power of Quarto's statistical caching alongside the lightning-fast, real-time visual typesetting of Tinymist.

## 🔥 The Killer Feature: Multi-File Inverse Search
The most requested workflow for complex academic writing is finally here: **Instant PDF-to-Source routing.**

`Cmd + Click` (or double-click) anywhere in your Tinymist PDF preview, and this extension will instantly route you back to the exact source paragraph in your Quarto draft. 

Unlike standard text jumpers, **Quarto Typst Sync** natively understands Quarto's modular architecture. It automatically scans your main document and recursively searches through all `{{< include chapter.qmd >}}` files to teleport your cursor to the correct line in the correct sub-file, keeping you entirely in your creative flow.

## Core Features

*   **High-Speed Bridge:** Uses a cached, daemon-free `quarto render` to instantly update your Typst output without server conflicts or zombie processes.
*   **Inverse-Sync:** Click anywhere in your PDF, and the extension finds the exact source paragraph, even if it's buried in a nested `{{< include >}}` file.
*   **Forward-Sync:** Instantly teleport from your `.qmd` draft to the exact corresponding line in the `.typ` file to trigger a PDF refresh.
*   **File Protection (Safe Lock):** Automatically locks your `.typ` bridge file (`chmod 444`) to prevent accidental typing and data loss, unlocking it only when safely writing a render or performing a sync.

## How to Use

This extension is built to get out of your way so you can focus on writing complex, math-heavy documents. 

### 1. Build the Bridge (Render)
*   **Action:** Click the **[Typ]** button in your editor menu (or trigger the `preview` command).
*   **What it does:** Saves your `.qmd` document and quietly runs a cached Quarto render in the background. It updates the physical `.typ` file on your disk, which instantly refreshes your Tinymist PDF.

### 2. Inverse Search (Preview to Source)
*   **Action:** Click inside your PDF preview (Triggered via Tinymist).
*   **What it does:** Tinymist routes the click to the `.typ` file. The extension instantly takes over, scans your `.qmd` tree, and teleports your editor to the exact source file and line.

### 3. Forward Sync (Source to Preview)
*   **Action:** Press `Cmd + Shift + L` (or your mapped shortcut for the `forwardSync` command).
*   **What it does:** Teleports your cursor from the `.qmd` file directly to the most relevant line in the `.typ` file.

## Keybindings

You can map these commands in your VS Code / Positron `keybindings.json`:

| Command ID | Recommended Shortcut | Action |
| :--- | :--- | :--- |
| `qmd2typ.preview` | `Cmd + Shift + T` | Update the `.typ` bridge file via Quarto |
| `qmd2typ.forwardSync` | `Cmd + Shift + L` | Jump from `.qmd` to the matching line in `.typ` |

## Why use this?

When authoring complex textbooks or statistical papers, manually scrolling through thousands of lines of Quarto markdown to find a specific LaTeX equation you just spotted in your Typst output is tedious. **Quarto Typst Sync** automates that "search and jump" process, handles your multi-chapter includes, and protects your compiled files so you can write without friction.