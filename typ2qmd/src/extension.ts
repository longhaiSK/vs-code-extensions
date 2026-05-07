import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let isSyncing = false; 
let isRenderSetupMode = false; // NEW: The "Safe Harbor" flag

export function activate(context: vscode.ExtensionContext) {

    const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const config = vscode.workspace.getConfiguration('qmd2typ');
        if (config.get('renderOnSave') && doc.languageId === 'quarto') {
            const editor = vscode.window.activeTextEditor;
            const line = (editor && editor.document === doc) ? editor.selection.active.line : 0;
            await runQuartoRender(doc, false, line, editor?.viewColumn); 
        }
    });

    // --- FORWARD SYNC (Right Arrow) ---
    let forwardSync = vscode.commands.registerCommand('qmd2typ.forwardSync', async () => {
        if (isSyncing) return;
        
        const qmdEditor = vscode.window.activeTextEditor;
        if (!qmdEditor || qmdEditor.document.languageId !== 'quarto') return;

        isSyncing = true; 
        try {
            await syncQmdToTyp(qmdEditor.document.uri, qmdEditor.selection.active.line, qmdEditor.viewColumn);
        } finally {
            isSyncing = false;
        }
    });

    // --- REVERSE SYNC OBSERVER ---
    let autoSync = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (isSyncing) return; 

        // 1. RE-ARM THE TRAP: If you switch back to your Quarto file, turn off Setup Mode.
        if (editor && editor.document.languageId === 'quarto') {
            isRenderSetupMode = false;
            return;
        }

        // 2. THE BOUNCE: If a Typst file becomes active...
        if (editor && editor.document.fileName.endsWith('.typ')) {
            // ...but we just rendered, DO NOTHING! Let the user stay and click the Preview button.
            if (isRenderSetupMode) {
                return; 
            }

            // ...otherwise, this was triggered by clicking the PDF! Bounce to QMD immediately!
            setTimeout(async () => {
                if (!isSyncing) await jumpToQmd(editor);
            }, 50);
        }
    });

    // --- RENDER COMMAND (Eye Icon) ---
    let previewCommand = vscode.commands.registerCommand('qmd2typ.preview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'quarto') {
            await editor.document.save(); 
            await runQuartoRender(editor.document, true, editor.selection.active.line, editor.viewColumn);
        }
    });

    context.subscriptions.push(onSave, forwardSync, autoSync, previewCommand);
}

// --- CORE FUNCTIONS ---

async function runQuartoRender(doc: vscode.TextDocument, openTypAfter: boolean, lineIdx: number = 0, viewCol?: vscode.ViewColumn) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');
    const cmd = `quarto render "${qmdPath}" --to typst`;

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Quarto: Rendering Typst...",
        cancellable: false
    }, () => {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                vscode.window.showErrorMessage("Render timed out.");
                resolve(false);
            }, 30000);

            exec(cmd, { cwd: workspaceFolder }, async (error, stdout, stderr) => {
                clearTimeout(timeout);
                resolve(true); 

                if (error) {
                    vscode.window.showErrorMessage(`Quarto Error: ${stderr || error.message}`);
                    return;
                }

                if (openTypAfter && fs.existsSync(typPath)) {
                    // ENTER SAFE HARBOR: Tell the observer not to bounce us back
                    isRenderSetupMode = true; 
                    
                    const targetColumn = viewCol || vscode.ViewColumn.One;
                    const typUri = vscode.Uri.file(typPath);
                    const typDoc = await vscode.workspace.openTextDocument(typUri);
                    
                    // Open the Typst file and leave it there forever so you can click Preview
                    await vscode.window.showTextDocument(typDoc, { 
                        viewColumn: targetColumn, 
                        preserveFocus: false 
                    });
                }
            });
        });
    });
}

async function syncQmdToTyp(qmdUri: vscode.Uri, lineIdx: number, viewCol?: vscode.ViewColumn) {
    const qmdPath = qmdUri.fsPath;
    const typPath = qmdPath.replace('.qmd', '.typ');
    if (!fs.existsSync(typPath)) return;

    try {
        const targetColumn = viewCol || vscode.ViewColumn.One;
        const typUri = vscode.Uri.file(typPath);
        
        // 1. Open .typ file in the same pane
        const typDoc = await vscode.workspace.openTextDocument(typUri);
        const typEditor = await vscode.window.showTextDocument(typDoc, { 
            viewColumn: targetColumn, 
            preserveFocus: false 
        });

        const qmdDoc = await vscode.workspace.openTextDocument(qmdUri);
        const qmdLineText = qmdDoc.lineAt(lineIdx).text.trim();
        
        // 2. Move Cursor for Sync
        if (qmdLineText.length > 0) {
            const searchWords = new Set(qmdLineText.toLowerCase().match(/\b\w{4,}\b/g) || []);
            if (searchWords.size > 0) {
                const typLines = typDoc.getText().split(/\r?\n/);
                let bestMatch = -1;
                let highStore = 0;

                typLines.forEach((line, idx) => {
                    const words = new Set(line.toLowerCase().match(/\b\w{4,}\b/g) || []);
                    let score = 0;
                    searchWords.forEach(w => { if (words.has(w)) score++; });
                    if (score > highStore) { highStore = score; bestMatch = idx; }
                });

                if (bestMatch !== -1) {
                    const pos = new vscode.Position(bestMatch, 0);
                    typEditor.selection = new vscode.Selection(pos, pos);
                    typEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            }
        }

        // 3. EXPLICIT WAKE-UP PING
        // We ping the command again with the URI. If the preview is already open, 
        // this forces Tinymist to re-check the cursor position and scroll.
        try {
            await vscode.commands.executeCommand('tinymist.showPreview', typUri);
        } catch (e) {
            // Ignore if it fails
        }

        // 4. THE LONG BREATH
        // We increase the wait time to 1.5 seconds (1500ms). 
        // This gives Tinymist plenty of time to process the scroll command on larger documents.
        // The visible flash of the .typ file will act as a "Syncing..." loading state for you!
        await sleep(1500); 

        // 5. THE BOUNCE
        await vscode.window.showTextDocument(qmdDoc, { 
            viewColumn: targetColumn,
            preserveFocus: false 
        });
        
    } catch (globalErr) {
        console.error("syncQmdToTyp failed:", globalErr);
    }
}

async function jumpToQmd(typEditor: vscode.TextEditor) {
    const typDoc = typEditor.document;
    const qmdPath = typDoc.fileName.replace('.typ', '.qmd');
    if (!fs.existsSync(qmdPath)) return;

    const lineText = typDoc.lineAt(typEditor.selection.active.line).text.trim();
    if (!lineText) return;

    const qmdDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(qmdPath));
    const qmdLines = qmdDoc.getText().split(/\r?\n/);

    const searchWords = new Set(lineText.toLowerCase().match(/\b\w{4,}\b/g) || []);
    let bestMatch = -1;
    let highStore = 0;

    qmdLines.forEach((line, idx) => {
        const words = new Set(line.toLowerCase().match(/\b\w{4,}\b/g) || []);
        let score = 0;
        searchWords.forEach(w => { if (words.has(w)) score++; });
        if (score > highStore) { highStore = score; bestMatch = idx; }
    });

    if (bestMatch !== -1) {
        const qmdEditor = await vscode.window.showTextDocument(qmdDoc, { 
            viewColumn: typEditor.viewColumn, 
            preserveFocus: false 
        });
        const pos = new vscode.Position(bestMatch, 0);
        qmdEditor.selection = new vscode.Selection(pos, pos);
        qmdEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
}