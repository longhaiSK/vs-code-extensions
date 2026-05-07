import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

// Module-level lock to prevent infinite sync loops
let isSyncing = false; 

export function activate(context: vscode.ExtensionContext) {

    // --- 1. RENDER ON SAVE ---
    const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const config = vscode.workspace.getConfiguration('qmd2typ');
        if (config.get('renderOnSave') && doc.languageId === 'quarto') {
            const editor = vscode.window.activeTextEditor;
            const line = (editor && editor.document === doc) ? editor.selection.active.line : 0;
            await runQuartoRender(doc, true, line, editor?.viewColumn); 
        }
    });

    // --- 2. FORWARD SYNC (QMD -> Typst/Preview) ---
    let forwardSync = vscode.commands.registerCommand('qmd2typ.forwardSync', async () => {
        if (isSyncing) return;
        
        const qmdEditor = vscode.window.activeTextEditor;
        if (!qmdEditor || qmdEditor.document.languageId !== 'quarto') return;

        isSyncing = true; 
        await syncQmdToTyp(qmdEditor.document, qmdEditor.selection.active.line, qmdEditor.viewColumn);
        isSyncing = false;
    });

    // --- 3. REVERSE SYNC (Preview/Typst -> QMD) ---
    let autoSync = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (isSyncing) return; 

        if (editor && editor.document.fileName.endsWith('.typ')) {
            setTimeout(async () => {
                if (!isSyncing) await jumpToQmd(editor);
            }, 50);
        }
    });

    // --- 4. PREVIEW BUTTON COMMAND ---
    let previewCommand = vscode.commands.registerCommand('qmd2typ.preview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'quarto') {
            await editor.document.save(); 
            // Pass the current cursor line so we know where to sync after rendering
            await runQuartoRender(editor.document, true, editor.selection.active.line, editor.viewColumn);
        }
    });

    context.subscriptions.push(onSave, forwardSync, autoSync, previewCommand);
}

// --- CORE FUNCTIONS ---

async function runQuartoRender(doc: vscode.TextDocument, jumpAfter: boolean, lineIdx: number = 0, viewCol?: vscode.ViewColumn) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');
    const cmd = `quarto render "${qmdPath}" --to typst`;
    
    // 1. UNLOCK file before rendering
    if (fs.existsSync(typPath)) {
        try { fs.chmodSync(typPath, 0o666); } catch (e) { /* ignore */ }
    }

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Quarto: Rendering Typst bridge...",
        cancellable: false
    }, () => {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                vscode.window.showErrorMessage("Render timed out after 30 seconds.");
                resolve(false);
            }, 30000);

            exec(cmd, { cwd: workspaceFolder }, async (error, stdout, stderr) => {
                clearTimeout(timeout);

                // 2. LOCK file immediately after rendering finishes
                if (fs.existsSync(typPath)) {
                    try { fs.chmodSync(typPath, 0o444); } catch (e) { /* ignore */ }
                }

                if (error) {
                    vscode.window.showErrorMessage(`Quarto Error: ${stderr || error.message}`);
                    resolve(false);
                    return;
                }

                // 3. ALWAYS trigger the preview step if requested
                if (jumpAfter) {
                    isSyncing = true; // Lock before initiating the jump
                    await syncQmdToTyp(doc, lineIdx, viewCol);
                    isSyncing = false;
                }
                
                resolve(true);
            });
        });
    });
}

async function syncQmdToTyp(qmdDoc: vscode.TextDocument, lineIdx: number, viewCol?: vscode.ViewColumn) {
    const typPath = qmdDoc.fileName.replace('.qmd', '.typ');
    if (!fs.existsSync(typPath)) return;

    // 1. ALWAYS open the .typ document (even if the cursor is on a blank line)
    const typDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(typPath));
    const typEditor = await vscode.window.showTextDocument(typDoc, { 
        viewColumn: vscode.ViewColumn.Beside, 
        preserveFocus: false // Force active to trigger Tinymist
    });

    // 2. ATTEMPT fuzzy matching
    const qmdLineText = qmdDoc.lineAt(lineIdx).text.trim();
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

            // If a match is found, move the Typst cursor
            if (bestMatch !== -1) {
                const pos = new vscode.Position(bestMatch, 0);
                typEditor.selection = new vscode.Selection(pos, pos);
                typEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        }
    }

    // 3. ALWAYS tell Tinymist to show/update the preview
    await vscode.commands.executeCommand('tinymist.showPreview');

    // 4. BOUNCE back to QMD
    return new Promise((resolve) => {
        setTimeout(async () => {
            await vscode.window.showTextDocument(qmdDoc, { 
                viewColumn: viewCol || vscode.ViewColumn.One,
                preserveFocus: false 
            });
            resolve(true);
        }, 250); // Small delay guarantees Tinymist has time to read the new active tab
    });
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
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false 
        });
        const pos = new vscode.Position(bestMatch, 0);
        qmdEditor.selection = new vscode.Selection(pos, pos);
        qmdEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
}