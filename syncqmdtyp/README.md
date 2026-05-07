# typ2qmd

A smart, "zero-dependency" cross-file jumper designed for Positron and VS Code. This extension allows you to instantly sync your cursor position between technical documents (like **Typst**, **Quarto**, **TeX**, and **Markdown**) based on content similarity.

## Features

*   **Smart Syncing:** Uses a word-overlap fuzzy matching algorithm to find the corresponding line in a partner file, even if the formatting or syntax differs.
*   **Side-by-Side Workflow:** Automatically opens the target file in a new editor column to the right, keeping your source and draft in view.
*   **Format Agnostic:** Works across `.typ`, `.qmd`, `.tex`, and `.md` files out of the box.
*   **Customizable:** Priority extensions can be configured directly in your `settings.json`.

## Keybindings

| Shortcut | Action |
| :--- | :--- |
| `Cmd + Shift + J` | Jump to the most relevant line in the partner file |

## Configuration

You can customize the search priority by adding the following to your `settings.json`:

```json
{
  "typ2qmd.targetExtensions": [".qmd", ".md", ".tex", ".typ"]
}
```

The extension will look for a file with the same name as your active file, checking these extensions in the order they are listed.

## Why use this?

When working on complex projects, manually scrolling through a long `.qmd` file to find a specific equation you just spotted in your `.typ` output is tedious. **typ2qmd** automates that "search and jump" process so you can stay in your creative flow.
