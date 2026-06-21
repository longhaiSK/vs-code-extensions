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
let awaitingTinymistJump = false;
let selectionTimeout: NodeJS.Timeout | undefined;

// --- CONFIGURATION ---
// Adjust these values to tune the sync behavior on your specific machine
const SETTLE_DELAY_MS = 200;     // Time to wait for Tinymist to finish moving the cursor
const WEBVIEW_FALLBACK_MS = 1000; // Safety net timer if Tinymist doesn't trigger a cursor event
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
            await syncQmdToTyp(qmdEditor.document.uri, qmdEditor.selection.active, qmdEditor.viewColumn, false);
        } finally {
            isSyncing = false;
        }
    });

    // COMMAND: Export Typst to PDF
    let exportPdfCommand = vscode.commands.registerCommand('qmd2typ.exportPdf', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName.endsWith('.typ')) {
            await editor.document.save();
            await executeTypstToPdf(editor.document);
        } else if (editor && editor.document.languageId === 'quarto') {
            // Optional: If triggered from a .qmd, automatically try to compile its target .typ
            const typPath = editor.document.fileName.replace('.qmd', '.typ');
            if (fs.existsSync(typPath)) {
                const typDoc = await vscode.workspace.openTextDocument(typPath);
                await executeTypstToPdf(typDoc);
            } else {
                vscode.window.showErrorMessage("No compiled .typ file found for this .qmd yet. Preview it first.");
            }
        }
    });

    // HELPER: Extracted jump logic to keep things clean
    async function executeJumpLogic(typEditor: vscode.TextEditor) {
        isSyncing = true;
        const fileName = typEditor.document.fileName;
        const exactQmdPath = fileName.replace('.typ', '.qmd');
        let targetQmdPath = exactQmdPath;

        if (!fs.existsSync(exactQmdPath) && lastActiveQmd) {
            if (path.dirname(fileName) === path.dirname(lastActiveQmd)) {
                targetQmdPath = lastActiveQmd;
            } else {
                targetQmdPath = "";
            }
        }

        if (targetQmdPath !== "" && fs.existsSync(targetQmdPath)) {
            try {
                await jumpToQmd(typEditor, targetQmdPath);
            } finally { isSyncing = false; }
        } else {
            isSyncing = false;
        }
    }

    // 1. AUTO-SYNC (Handles Tab Changes & The Framework Assassin)
    let autoSync = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor && editor.document.languageId === 'quarto') {
            lastActiveQmd = editor.document.fileName;
        }

        if (isSyncing) return; 
        
        if (!editor) { 
            isWebviewActive = true; 
            return; 
        }

        const fileName = editor.document.fileName;

        if (fileName.endsWith('.typ')) {
            const normalizedPath = fileName.replace(/\\/g, '/').toLowerCase();
            const isFrameworkFile = [
                '/_extensions/', '/typst/packages/', '/.local/share/typst/',
                '/.cache/typst/', '/library/application support/typst/',
                '/appdata/local/typst/', '/appdata/roaming/typst/'
            ].some(p => normalizedPath.includes(p));

            // CRITICAL UX: The Framework Assassin
            if (isFrameworkFile) {
                if (isWebviewActive) {
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    if (lastActiveQmd) {
                        const qmdDoc = await vscode.workspace.openTextDocument(lastActiveQmd);
                        await vscode.window.showTextDocument(qmdDoc, { preserveFocus: false });
                    }
                }
                isWebviewActive = false; 
                awaitingTinymistJump = false;
                return; 
            }

            // Arm the listener to wait for Tinymist's cursor movement.
            if (isWebviewActive) {
                isWebviewActive = false;
                awaitingTinymistJump = true;

                // Fallback: If Tinymist opens the .typ file but the cursor was ALREADY
                // in the exact right spot, a selection change event will never fire. 
                // Bumped to 500ms to ensure it doesn't race the debounce.
                setTimeout(() => {
                    if (awaitingTinymistJump) {
                        awaitingTinymistJump = false;
                        executeJumpLogic(editor);
                    }
                }, WEBVIEW_FALLBACK_MS); 
            }
        } else {
            isWebviewActive = false; 
            awaitingTinymistJump = false;
        }
    });

    // 2. Wait for Tinymist to actually move the cursor (DEBOUNCED)
    let selectionSync = vscode.window.onDidChangeTextEditorSelection(async (event) => {
        if (!awaitingTinymistJump || isSyncing) return;

        const editor = event.textEditor;
        if (editor.document.fileName.endsWith('.typ')) {
            
            // Clear the previous timer if Tinymist is still actively moving the cursor
            if (selectionTimeout) clearTimeout(selectionTimeout);
            
            // Set a 150ms timer to wait for the cursor to "settle" on its final destination
            selectionTimeout = setTimeout(() => {
                awaitingTinymistJump = false;
                executeJumpLogic(editor);
            }, SETTLE_DELAY_MS);
        }
    });

    context.subscriptions.push(previewCommand, forwardSync, exportPdfCommand, autoSync, selectionSync);
}

// --- PURE MANUAL RENDER ENGINE ---

async function executeQuartoRender(doc: vscode.TextDocument) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');
    const typFileName = path.basename(typPath);

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
            emitter.fire(`\x1b[1;32m🎉 [Success] ${typFileName} successfully updated.\x1b[0m\r\n`);
            
            emitter.fire(`\x1b[1;36m💡 [Tip] Check the "Problems" panel for any Typst Complilation errors.\x1b[0m\r\n`);
            
            try {
                const typUri = vscode.Uri.file(typPath);
                await vscode.commands.executeCommand('workbench.action.files.revert', typUri);
            } catch (e) {
                emitter.fire(`\x1b[1;33m⚠️ [Warning] Could not refresh ${typFileName}: ${e}\x1b[0m\r\n`);
            }

            isSyncing = true;
            try {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.fileName === qmdPath) {
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

// --- PDF COMPILATION ENGINE ---
// --- PDF COMPILATION ENGINE ---

async function executeTypstToPdf(doc: vscode.TextDocument) {
    const typPath = doc.fileName;
    if (!typPath.endsWith('.typ')) return;

    const workspaceFolder = path.dirname(typPath);
    const pdfFileName = path.basename(typPath).replace('.typ', '.pdf');

    // FIX 1: Use Quarto's bundled typst compiler instead of a standalone typst installation
    const args = ['typst', 'compile', typPath];

    const { terminal, emitter } = getRenderTerminal();
    terminal.show(true);
    emitter.fire('\x1b[2J\x1b[3J\x1b[H');
    emitter.fire(`\x1b[1;34m📄 [Compiling PDF] ${path.basename(typPath)}...\x1b[0m\r\n\r\n`);

    // Spawn 'quarto' instead of 'typst'
    const typstProcess = spawn('quarto', args, { cwd: workspaceFolder });
    let hasError = false;

    const processOutput = (data: Buffer) => {
        const rawText = data.toString();
        const cleanText = rawText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        if (/error:|failed|exception/i.test(cleanText)) hasError = true;
        emitter.fire(rawText.replace(/\r?\n/g, '\r\n'));
    };

    typstProcess.stdout?.on('data', processOutput);
    typstProcess.stderr?.on('data', processOutput);

    // FIX 2: Catch process launch errors so it never hangs silently again
    typstProcess.on('error', (err) => {
        emitter.fire('\r\n--------------------------------------------------\r\n');
        emitter.fire(`\x1b[1;31m🔥 [System Error] Could not start compiler: ${err.message}\x1b[0m\r\n`);
    });

    typstProcess.on('close', (code) => {
        emitter.fire('\r\n--------------------------------------------------\r\n');
        if (code === 0 && !hasError) {
            emitter.fire(`\x1b[1;32m🎉 [Success] ${pdfFileName} successfully generated.\x1b[0m\r\n`);
        } else {
            const finalCode = code !== 0 ? code : 'Caught by log parser';
            emitter.fire(`\x1b[1;31m🔥 [Error] PDF Compilation failed (Exit Code: ${finalCode}).\x1b[0m\r\n`);
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

async function syncQmdToTyp(qmdUri: vscode.Uri, cursor: vscode.Position, viewCol?: vscode.ViewColumn, returnFocus: boolean = true) {
    const qmdPath = qmdUri.fsPath;
    const typPath = qmdPath.replace('.qmd', '.typ');
    const typUri = vscode.Uri.file(typPath);
    if (!fs.existsSync(typPath)) return;

    try {
        const qmdDoc = await vscode.workspace.openTextDocument(qmdUri);
        
        let wordRange = qmdDoc.getWordRangeAtPosition(cursor);
        let anchorWord = wordRange ? qmdDoc.getText(wordRange) : "";

        if (!anchorWord) {
            const lineText = qmdDoc.lineAt(cursor.line).text;
            const textAfterCursor = lineText.substring(cursor.character);
            const match = textAfterCursor.match(/\b\w{2,}\b/);
            if (match) {
                anchorWord = match[0];
            }
        }

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

            setTimeout(async () => {
                await vscode.commands.executeCommand('cursorMove', { to: 'right', by: 'character', value: 1 });
                await vscode.commands.executeCommand('cursorMove', { to: 'left', by: 'character', value: 1 });
                
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