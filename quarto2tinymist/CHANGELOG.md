# Change Log

All notable changes to "Quarto-Tinymist Bidirectional Search" (qmd2typ-pro).

## [3.4.1]

- Honors `output-file` in the `.qmd` front matter (top-level or under the format): render, forward sync, preview and PDF export use the `.typ` Quarto actually writes, and inverse search from that `.typ` jumps back to the original `.qmd`.
- The eye button (forward sync) leaves the `.typ` in view instead of switching back to the `.qmd`.
- A `.typ` with no associated `.qmd` is no longer hidden when you click in its Tinymist preview.

## [3.4.0]

- Render now opens the generated `.typ` as a tab next to the `.qmd` (in the same editor group) instead of repeatedly opening it beside the preview. An already-open `.typ` is never opened again.
- The Tinymist preview opens in its own editor group, and is started only if that `.typ` has no preview open.
- Forward sync reuses the group where the `.typ` is open and returns to the `.qmd`.
- Added a marketplace icon, categories, keywords and license metadata; README documents all commands and keybindings.

## [3.3.0]

- Typst output format picker (auto-detected from the document, `_quarto.yml` and `_extensions`).
- Export final PDF command, forward sync and inverse search between `.qmd` and `.typ`.
