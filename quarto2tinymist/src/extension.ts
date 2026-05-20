// ============================================================================
// FUTURE AI / DEVELOPER WARNING: 
// Do NOT "clean up", refactor, or delete the cursor movement logic, 
// "jiggles", or file-modification hacks in this file. They are critical 
// workarounds for VS Code API limitations and Tinymist PDF sync behaviors.
// ============================================================================

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process'; 

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Global State
let isSyncing = false; 
let isWebviewActive = false; 
let lastActiveQmd: string | undefined;

// --- TERMINAL SETUP ---
let renderTerminal: vscode.Terminal | undefined;
let terminalEmitter: vscode.EventEmitter<string> | undefined;

function getRenderTerminal() {
    if (!renderTerminal || !terminalEmitter) {
        terminalEmitter = new vscode.EventEmitter<string>();
        const pty: vscode.Pseudoterminal = {
            onDidWrite: terminalEmitter.event,
            open: () => {},
            close: () => {
                renderTerminal = undefined;
                terminalEmitter = undefined;
            }
        };
        renderTerminal = vscode.window.createTerminal({ name: "Quarto -> Typst", pty });
    }
    return { terminal: renderTerminal, emitter: terminalEmitter };
}

export function activate(context: vscode.ExtensionContext) {

    // COMMAND: Manual Preview/Play
    let previewCommand = vscode.commands.registerCommand('qmd2typ.preview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'quarto') {
            await editor.document.save(); 
            await executeQuartoRender(editor.document);
        }
    });

    // COMMAND: Forward Sync
    let forwardSync = vscode.commands.registerCommand('qmd2typ.forwardSync', async () => {
        if (isSyncing) return;
        const qmdEditor = vscode.window.activeTextEditor;
        if (!qmdEditor || qmdEditor.document.languageId !== 'quarto') return;

        isSyncing = true; 
        try {
            // CRITICAL UX: Pass "false" for returnFocus. 
            // The Eye button should intentionally leave the user in the .typ file!
            await syncQmdToTyp(qmdEditor.document.uri, qmdEditor.selection.active, qmdEditor.viewColumn, false);
        } finally {
            isSyncing = false;
        }
    });

    // AUTO-SYNC / JUMP BACK
    let autoSync = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor && editor.document.languageId === 'quarto') {
            lastActiveQmd = editor.document.fileName;
        }

        if (isSyncing) return; 
        
        // CRITICAL: We track if the user clicked into the Tinymist PDF Webview.
        // If they click the PDF, editor becomes undefined. We flag it so we know 
        // to intercept the subsequent .typ file opening.
        if (!editor) { 
            isWebviewActive = true; 
            return; 
        }

        const fileName = editor.document.fileName;

        if (fileName.endsWith('.typ')) {
            const exactQmdPath = fileName.replace('.typ', '.qmd');
            let targetQmdPath = exactQmdPath;

            if (!fs.existsSync(exactQmdPath) && lastActiveQmd) {
                targetQmdPath = lastActiveQmd;
            }

            // CRITICAL UX: Only jump back to QMD if the TYP file was triggered 
            // by clicking the PDF (isWebviewActive). If the user manually clicked 
            // the .typ file in their file explorer, we leave them alone so they can edit it!
            if (fs.existsSync(targetQmdPath) && isWebviewActive) {
                isWebviewActive = false;
                isSyncing = true;
                setTimeout(async () => {
                    try {
                        await jumpToQmd(editor, targetQmdPath);
                    } finally { isSyncing = false; }
                }, 50);
            }
        } else {
            // Reset flag if they clicked on something else
            isWebviewActive = false; 
        }
    });

    context.subscriptions.push(previewCommand, forwardSync, autoSync);
}

// --- PURE MANUAL RENDER ENGINE ---

async function executeQuartoRender(doc: vscode.TextDocument) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');

    const args = ['render', qmdPath, '--to', 'typst', '--cache', '-M', 'output-ext:typ', '-M', 'keep-typ:true'];

    const { terminal, emitter } = getRenderTerminal();
    terminal.show(true); 
    emitter.fire('\x1b[2J\x1b[3J\x1b[H'); 
    emitter.fire(`\x1b[1;34m🚀 [Rendering] ${path.basename(qmdPath)}...\x1b[0m\r\n\r\n`);

    const quartoProcess = spawn('quarto', args, { cwd: workspaceFolder });
    let hasError = false;

    const processOutput = (data: Buffer) => {
        const rawText = data.toString();
        const cleanText = rawText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        if (/error:|failed|exception/i.test(cleanText)) hasError = true;
        emitter.fire(rawText.replace(/\r?\n/g, '\r\n'));
    };

    quartoProcess.stdout?.on('data', processOutput);
    quartoProcess.stderr?.on('data', processOutput);

    quartoProcess.on('close', async (code) => {
        emitter.fire('\r\n--------------------------------------------------\r\n');
        if (code === 0 && !hasError) {
            emitter.fire(`\x1b[1;32m🎉 [Success] .typ file successfully updated.\x1b[0m\r\n`);
            
            try {
                const typUri = vscode.Uri.file(typPath);
                await vscode.commands.executeCommand('workbench.action.files.revert', typUri);
            } catch (e) {
                emitter.fire(`\x1b[1;33m⚠️ [Warning] Could not refresh .typ file: ${e}\x1b[0m\r\n`);
            }

            isSyncing = true;
            try {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.fileName === qmdPath) {
                    // CRITICAL UX: Pass "true" for returnFocus.
                    // After a render finishes, the user wants to keep typing in their .qmd file.
                    await syncQmdToTyp(activeEditor.document.uri, activeEditor.selection.active, activeEditor.viewColumn, true);
                }
            } finally {
                isSyncing = false;
            }
        } else {
            const finalCode = code !== 0 ? code : 'Caught by log parser';
            emitter.fire(`\x1b[1;31m🔥 [Error] Render failed (Exit Code: ${finalCode}).\x1b[0m\r\n`);
        }
    });
}

// --- HELPER: Find all included .qmd files recursively ---

function getAllRelatedQmdFiles(mainQmdPath: string): string[] {
    const files = new Set<string>();
    files.add(mainQmdPath);
    const queue = [mainQmdPath];

    while (queue.length > 0) {
        const currentPath = queue.shift()!;
        if (!fs.existsSync(currentPath)) continue;

        const content = fs.readFileSync(currentPath, 'utf8');
        const regex = /\{\{<\s*include\s+([^\s>]+)\s*>\}\}/g;
        let match;

        while ((match = regex.exec(content)) !== null) {
            const includePath = path.resolve(path.dirname(currentPath), match[1]);
            if (!files.has(includePath)) {
                files.add(includePath);
                queue.push(includePath);
            }
        }
    }
    return Array.from(files);
}

// --- SYNC & JUMP FUNCTIONS ---

// Added `returnFocus` parameter with a default of true
async function syncQmdToTyp(qmdUri: vscode.Uri, cursor: vscode.Position, viewCol?: vscode.ViewColumn, returnFocus: boolean = true) {
    const qmdPath = qmdUri.fsPath;
    const typPath = qmdPath.replace('.qmd', '.typ');
    const typUri = vscode.Uri.file(typPath);
    if (!fs.existsSync(typPath)) return;

    try {
        const qmdDoc = await vscode.workspace.openTextDocument(qmdUri);
        
        let wordRange = qmdDoc.getWordRangeAtPosition(cursor);
        let anchorWord = wordRange ? qmdDoc.getText(wordRange) : "";

        // CRITICAL UX: The Empty Space Lookahead
        // If the user's cursor is sitting in a blank space right before a word, VS Code
        // returns an empty string. This block scans forward on the same line to find 
        // the very next word so the user doesn't have to highlight text to sync.
        if (!anchorWord) {
            const lineText = qmdDoc.lineAt(cursor.line).text;
            const textAfterCursor = lineText.substring(cursor.character);
            const match = textAfterCursor.match(/\b\w{2,}\b/);
            if (match) {
                anchorWord = match[0];
            }
        }

        // CRITICAL: 300-Character Context Window
        // We do not just match line numbers, because Quarto alters line counts during render.
        // We grab 300 characters around the cursor to create a highly accurate "fingerprint" 
        // to find the exact matching line in the compiled Typst file.
        const cursorOffset = qmdDoc.offsetAt(cursor);
        const textAround = qmdDoc.getText(new vscode.Range(
            qmdDoc.positionAt(Math.max(0, cursorOffset - 300)),
            qmdDoc.positionAt(cursorOffset + 300)
        ));

        const allWords = textAround.match(/\b\w{3,}\b/g) || [];
        if (allWords.length === 0) return;

        const midIndex = Math.floor(allWords.length / 2);
        const searchWords = allWords.slice(Math.max(0, midIndex - 6), midIndex + 6).map(w => w.toLowerCase());
        const contextWords = allWords.slice(Math.max(0, midIndex - 15), midIndex + 15).map(w => w.toLowerCase());

        const typDoc = await vscode.workspace.openTextDocument(typUri);
        const typLines = typDoc.getText().split(/\r?\n/);
        let globalBestLine = -1;
        let globalHighScore = 0;

        typLines.forEach((line, idx) => {
            if (line.trim().length < 3) return;
            const lineLower = line.toLowerCase();
            let score = 0;
            
            searchWords.forEach(word => { if (lineLower.includes(word)) score += 1; });

            if (score > (searchWords.length * 0.4)) { 
                let surroundingTyp = "";
                for (let offset = -2; offset <= 2; offset++) {
                    const targetIdx = idx + offset;
                    if (offset !== 0 && targetIdx >= 0 && targetIdx < typLines.length) {
                        surroundingTyp += typLines[targetIdx] + " ";
                    }
                }
                const surroundingLower = surroundingTyp.toLowerCase();
                contextWords.forEach(word => {
                    if (!searchWords.includes(word) && surroundingLower.includes(word)) { score += 0.2; }
                });
            }

            if (score > globalHighScore) { globalHighScore = score; globalBestLine = idx; }
        });

        if (globalBestLine !== -1 && globalHighScore > 1) {
            const targetLineText = typLines[globalBestLine];
            let startCol = 0;
            let endCol = targetLineText.length; 

            // Place the cursor exactly AFTER the matched word
            if (anchorWord) {
                const wordIdx = targetLineText.toLowerCase().indexOf(anchorWord.toLowerCase());
                if (wordIdx !== -1) {
                    startCol = wordIdx;
                    endCol = wordIdx + anchorWord.length; 
                }
            }

            const startPos = new vscode.Position(globalBestLine, startCol);
            const cursorPos = new vscode.Position(globalBestLine, endCol);
            
            const typEditor = await vscode.window.showTextDocument(typDoc, { preserveFocus: true });

            typEditor.selection = new vscode.Selection(cursorPos, cursorPos);
            typEditor.revealRange(new vscode.Range(cursorPos, cursorPos), vscode.TextEditorRevealType.InCenter);
            
            // CRITICAL WORKAROUND: THE SPACE HACK
            // Tinymist relies on file modifications to trigger the PDF scroll. 
            // By programmatically inserting and immediately deleting a space at the exact coordinate,
            // we force a file-change event that wakes up the Typst compiler and scrolls the preview.
            const insertEdit = new vscode.WorkspaceEdit();
            insertEdit.insert(typUri, cursorPos, ' ');
            await vscode.workspace.applyEdit(insertEdit);
            
            const deleteEdit = new vscode.WorkspaceEdit();
            deleteEdit.delete(typUri, new vscode.Range(cursorPos, cursorPos.translate(0, 1)));
            await vscode.workspace.applyEdit(deleteEdit);
            await typDoc.save();

            const anchorRange = new vscode.Range(startPos, cursorPos);
            const cursorDecoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: 'rgba(255, 0, 0, 0.2)',
                border: '1px solid rgba(255, 0, 0, 0.8)',
                borderRadius: '2px',
                overviewRulerColor: 'red',
                overviewRulerLane: vscode.OverviewRulerLane.Full,
                fontWeight: 'bold'
            });

            typEditor.setDecorations(cursorDecoration, [anchorRange]);
            setTimeout(() => cursorDecoration.dispose(), 1200);

            // CRITICAL WORKAROUND: THE JIGGLE
            // Sometimes VS Code bypasses UI selection events when moving the cursor via API.
            // This jiggle fires a genuine hardware-level event to ensure Tinymist catches it.
            setTimeout(async () => {
                await vscode.commands.executeCommand('cursorMove', { to: 'right', by: 'character', value: 1 });
                await vscode.commands.executeCommand('cursorMove', { to: 'left', by: 'character', value: 1 });
                
                // CONDITIONAL FOCUS RETURN
                // If this was triggered by a Render, steal focus back to QMD. 
                // If triggered by the Eye Button, leave the user in the TYP file!
                if (returnFocus) {
                    await vscode.window.showTextDocument(qmdDoc, {
                        viewColumn: viewCol || vscode.ViewColumn.One,
                        preserveFocus: false
                    });
                }
            }, 50);
        }
    } catch (e) { console.error(e); }
}

async function jumpToQmd(typEditor: vscode.TextEditor, mainQmdPath: string) {
    const typDoc = typEditor.document;
    if (!fs.existsSync(mainQmdPath)) return;

    const cursorPosition = typEditor.selection.active;
    const wordRange = typDoc.getWordRangeAtPosition(cursorPosition);
    const anchorWord = wordRange ? typDoc.getText(wordRange) : "";

    // CRITICAL: 300-Character Context Window (Reverse Direction)
    const cursorOffset = typDoc.offsetAt(cursorPosition);
    const textAround = typDoc.getText(new vscode.Range(
        typDoc.positionAt(Math.max(0, cursorOffset - 300)),
        typDoc.positionAt(cursorOffset + 300)
    ));

    const allWords = textAround.match(/\b\w{3,}\b/g) || [];
    if (allWords.length === 0) return;

    const midIndex = Math.floor(allWords.length / 2);
    const searchWords = allWords.slice(Math.max(0, midIndex - 6), midIndex + 6).map(w => w.toLowerCase());
    const contextWords = allWords.slice(Math.max(0, midIndex - 15), midIndex + 15).map(w => w.toLowerCase());

    const qmdFilesToSearch = getAllRelatedQmdFiles(mainQmdPath);
    let globalBestFile = '';
    let globalBestLine = -1;
    let globalHighScore = 0;

    for (const filePath of qmdFilesToSearch) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);

        lines.forEach((line, idx) => {
            if (line.trim().length < 3) return;
            const lineLower = line.toLowerCase();
            let score = 0;
            
            searchWords.forEach(word => { if (lineLower.includes(word)) score += 1; });

            if (score > (searchWords.length * 0.4)) { 
                let surroundingQmd = "";
                for (let offset = -2; offset <= 2; offset++) {
                    const targetIdx = idx + offset;
                    if (offset !== 0 && targetIdx >= 0 && targetIdx < lines.length) {
                        surroundingQmd += lines[targetIdx] + " ";
                    }
                }
                const surroundingLower = surroundingQmd.toLowerCase();
                contextWords.forEach(word => {
                    if (!searchWords.includes(word) && surroundingLower.includes(word)) { score += 0.2; }
                });
            }

            if (score > globalHighScore) { 
                globalHighScore = score; 
                globalBestLine = idx; 
                globalBestFile = filePath;
            }
        });
    }

    if (globalBestFile !== '' && globalHighScore > 1) {
        if (typDoc.fileName !== mainQmdPath.replace('.qmd', '.typ')) {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        const targetUri = vscode.Uri.file(globalBestFile);
        const qmdDoc = await vscode.workspace.openTextDocument(targetUri);
        
        let targetEditor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.fsPath === targetUri.fsPath
        );

        targetEditor = await vscode.window.showTextDocument(qmdDoc, {
            viewColumn: targetEditor ? targetEditor.viewColumn : vscode.ViewColumn.One,
            preserveFocus: false,
            preview: false 
        });

        const targetLineText = qmdDoc.lineAt(globalBestLine).text;
        let startCol = 0;
        let endCol = targetLineText.length; 

        // CRITICAL UX: End-of-Word Cursor Placement
        // We find the specific word and put the cursor at `endCol` so the user 
        // can immediately start typing after the word without moving their arrow keys.
        if (anchorWord) {
            const wordIdx = targetLineText.toLowerCase().indexOf(anchorWord.toLowerCase());
            if (wordIdx !== -1) {
                startCol = wordIdx;
                endCol = wordIdx + anchorWord.length; 
            }
        }

        const startPos = new vscode.Position(globalBestLine, startCol);
        const cursorPos = new vscode.Position(globalBestLine, endCol);
        
        const anchorRange = qmdDoc.getWordRangeAtPosition(startPos) || 
                            new vscode.Range(startPos, new vscode.Position(globalBestLine, startCol + Math.max(1, anchorWord.length)));
        
        targetEditor.selection = new vscode.Selection(cursorPos, cursorPos);
        targetEditor.revealRange(
            new vscode.Range(cursorPos, cursorPos), 
            vscode.TextEditorRevealType.InCenter
        );
        
        const cursorDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.2)',
            border: '1px solid rgba(255, 0, 0, 0.8)',
            borderRadius: '2px',
            overviewRulerColor: 'red',
            overviewRulerLane: vscode.OverviewRulerLane.Full,
            fontWeight: 'bold'
        });

        targetEditor.setDecorations(cursorDecoration, [anchorRange]);
        setTimeout(() => cursorDecoration.dispose(), 1200);
        
    } else {
        if (typDoc.fileName !== mainQmdPath.replace('.qmd', '.typ')) {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        const fallbackUri = vscode.Uri.file(mainQmdPath);
        const qmdDoc = await vscode.workspace.openTextDocument(fallbackUri);
        await vscode.window.showTextDocument(qmdDoc, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false,
            preview: false 
        });
    }
}

export function deactivate() {}
