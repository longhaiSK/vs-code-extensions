import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

let isSyncing = false; 

export function activate(context: vscode.ExtensionContext) {

    const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const config = vscode.workspace.getConfiguration('qmd2typ');
        if (config.get('renderOnSave') && doc.languageId === 'quarto') {
            const editor = vscode.window.activeTextEditor;
            const line = (editor && editor.document === doc) ? editor.selection.active.line : 0;
            await runQuartoRender(doc, true, line, editor?.viewColumn); 
        }
    });

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

    let autoSync = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (isSyncing) return; 

        if (editor && editor.document.fileName.endsWith('.typ')) {
            setTimeout(async () => {
                if (!isSyncing) await jumpToQmd(editor);
            }, 50);
        }
    });

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

async function runQuartoRender(doc: vscode.TextDocument, jumpAfter: boolean, lineIdx: number = 0, viewCol?: vscode.ViewColumn) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
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
                resolve(true); // Close notification instantly

                if (error) {
                    vscode.window.showErrorMessage(`Quarto Error: ${stderr || error.message}`);
                    return;
                }

                if (jumpAfter) {
                    isSyncing = true; 
                    try {
                        await syncQmdToTyp(doc.uri, lineIdx, viewCol);
                    } catch (err) {
                        console.error("Sync error:", err);
                    } finally {
                        isSyncing = false;
                    }
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
        
        // 1. Open .typ file in the same pane
        const typDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(typPath));
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

        // 3. Trigger Preview. Because the file is completely normal and active, 
        // Tinymist will respond instantly.
        try {
            await vscode.commands.executeCommand('tinymist.showPreview');
        } catch (e) {
            console.warn("Tinymist command failed.", e);
        }

        // 4. Bounce back to Quarto
        return new Promise<void>((resolveBounce) => {
            setTimeout(async () => {
                try {
                    await vscode.window.showTextDocument(qmdDoc, { 
                        viewColumn: targetColumn,
                        preserveFocus: false 
                    });
                } catch (e) {
                    console.error("Bounce failed", e);
                }
                resolveBounce();
            }, 500); 
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
