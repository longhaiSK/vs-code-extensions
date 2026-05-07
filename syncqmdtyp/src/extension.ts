import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process'; 

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let isSyncing = false; 
let isWebviewActive = false; 
let activePreviewProcess: ChildProcess | null = null; // Track the hanging process

const outputChannel = vscode.window.createOutputChannel("Quarto -> Typst");

function setFileLock(filePath: string, isLocked: boolean) {
    if (!fs.existsSync(filePath)) return;
    try {
        // Only lock if we aren't currently in the middle of a preview write
        fs.chmodSync(filePath, isLocked ? 0o444 : 0o666);
    } catch (e) {
        console.warn(`Could not set lock state on ${filePath}`);
    }
}

export function activate(context: vscode.ExtensionContext) {

    // COMMAND: Render / Start Preview
    let previewCommand = vscode.commands.registerCommand('qmd2typ.preview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'quarto') {
            await editor.document.save(); 
            await startQuartoPreview(editor.document, true);
        }
    });

    // COMMAND: Forward Sync
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

    // AUTO-SYNC / JUMP BACK logic remains the same
    let autoSync = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (isSyncing) return; 
        if (!editor) { isWebviewActive = true; return; }

        if (editor.document.fileName.endsWith('.typ')) {
            if (isWebviewActive) {
                isWebviewActive = false;
                isSyncing = true;
                setTimeout(async () => {
                    try {
                        await jumpToQmd(editor);
                        setFileLock(editor.document.fileName, true);
                    } finally { isSyncing = false; }
                }, 50);
            }
        } else if (editor.document.languageId === 'quarto') {
            const typPath = editor.document.fileName.replace('.qmd', '.typ');
            setFileLock(typPath, true);
        }
    });

    context.subscriptions.push(previewCommand, forwardSync, autoSync);
}

// --- NEW RESIDENT PREVIEW ENGINE ---

async function startQuartoPreview(doc: vscode.TextDocument, jumpToTyp: boolean) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');

    // If a process is already hanging, we don't need to start a new one
    // Quarto Preview will detect the file save automatically.
    if (activePreviewProcess) {
        outputChannel.appendLine(`[Info] Quarto Preview is already resident. Updating bridge...`);
        if (jumpToTyp) await syncQmdToTyp(doc.uri, 0); 
        return;
    }

    // Unlock bridge for the resident process
    setFileLock(typPath, false);

    const args = [
        'preview', qmdPath, 
        '--to', 'typst', 
        '--no-browser',           // Don't open a browser
        '--no-watch-inputs',      // Only render on Save, not every keystroke
        '-M', 'output-ext:typ', 
        '-M', 'keep-typ:true'
    ];

    outputChannel.clear();
    outputChannel.show(true); 
    outputChannel.appendLine(`[Starting Resident Bridge] quarto ${args.join(' ')}\n`);

    activePreviewProcess = spawn('quarto', args, { cwd: workspaceFolder });

    activePreviewProcess.stdout?.on('data', (data) => {
        const out = data.toString();
        outputChannel.append(out);
        
        // When Quarto says it's watching, we know the first render is done
        if (out.includes("Watching files for changes") && jumpToTyp) {
            syncQmdToTyp(doc.uri, 0);
        }
    });

    activePreviewProcess.stderr?.on('data', (data) => {
        outputChannel.append(data.toString());
    });

    activePreviewProcess.on('close', (code) => {
        outputChannel.appendLine(`\n[Stopped] Quarto process exited (Code ${code}).`);
        activePreviewProcess = null;
        setFileLock(typPath, true);
    });
}

// ... syncQmdToTyp and jumpToQmd functions remain unchanged from previous version ...

async function syncQmdToTyp(qmdUri: vscode.Uri, lineIdx: number, viewCol?: vscode.ViewColumn) {
    const qmdPath = qmdUri.fsPath;
    const typPath = qmdPath.replace('.qmd', '.typ');
    if (!fs.existsSync(typPath)) return;

    try {
        setFileLock(typPath, false);

        const targetColumn = viewCol || vscode.ViewColumn.One;
        const typUri = vscode.Uri.file(typPath);
        
        const typDoc = await vscode.workspace.openTextDocument(typUri);
        const typEditor = await vscode.window.showTextDocument(typDoc, { 
            viewColumn: targetColumn, 
            preserveFocus: false 
        });

        const qmdDoc = await vscode.workspace.openTextDocument(qmdUri);
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

                if (bestMatch !== -1) {
                    const pos = new vscode.Position(bestMatch, 0);
                    typEditor.selection = new vscode.Selection(pos, pos);
                    typEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            }
        }
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
        const words = new paddingSet(line.toLowerCase().match(/\b\w{4,}\b/g) || []);
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

class paddingSet extends Set<string> {
    // Just an alias to maintain your existing fuzzy matching logic perfectly
}