import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process'; // CHANGED: We now use spawn for real-time streaming

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let isSyncing = false; 
let isWebviewActive = false; 

// Create a dedicated Output Panel for the user to see compilation errors
const outputChannel = vscode.window.createOutputChannel("Quarto -> Typst");

function setFileLock(filePath: string, isLocked: boolean) {
    if (!fs.existsSync(filePath)) return;
    try {
        fs.chmodSync(filePath, isLocked ? 0o444 : 0o666);
    } catch (e) {
        console.warn(`Could not set lock state on ${filePath}`);
    }
}

export function activate(context: vscode.ExtensionContext) {

    const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const config = vscode.workspace.getConfiguration('qmd2typ');
        if (config.get('renderOnSave') && doc.languageId === 'quarto') {
            const editor = vscode.window.activeTextEditor;
            const line = (editor && editor.document === doc) ? editor.selection.active.line : 0;
            await runQuartoRender(doc, false, line, editor?.viewColumn); 
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

        if (!editor) {
            isWebviewActive = true;
            return;
        }

        if (editor.document.fileName.endsWith('.typ')) {
            if (isWebviewActive) {
                isWebviewActive = false;
                isSyncing = true;
                
                setTimeout(async () => {
                    try {
                        await jumpToQmd(editor);
                        setFileLock(editor.document.fileName, true);
                    } finally {
                        isSyncing = false;
                    }
                }, 50);
            }
        } else {
            isWebviewActive = false;
            if (editor.document.languageId === 'quarto') {
                const typPath = editor.document.fileName.replace('.qmd', '.typ');
                setFileLock(typPath, true);
            }
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

async function runQuartoRender(doc: vscode.TextDocument, openTypAfter: boolean, lineIdx: number = 0, viewCol?: vscode.ViewColumn) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');
    
    // Explicitly enforce keeping the .typ file and extension
    // Enforce all speed and bridge-protection flags
    // Corrected flags for speed and bridge protection
    const args = [
        'render', 
        qmdPath, 
        '--to', 'typst', 
        '--cache',              // Uses cached results for code chunks
        '--quiet',              // Reduces CLI overhead (optional, keeps logs cleaner)
        '-M', 'output-ext:typ', // Ensures .typ extension
        '-M', 'keep-typ:true'   // Prevents Quarto from deleting the file
    ];

    setFileLock(typPath, false);

    // THE FIX: Remove the popup notification entirely!
    // Instead, immediately clear and open our Terminal-like Output Channel.
    // 'true' preserves your cursor focus in the editor so you don't stop typing.
    outputChannel.clear();
    outputChannel.show(true); 
    outputChannel.appendLine(`[Running] quarto ${args.join(' ')}\n`);

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            outputChannel.appendLine(`\n[Error] Render timed out after 30 seconds.`);
            vscode.window.showErrorMessage("Render timed out.");
            setFileLock(typPath, true);
            resolve(false);
        }, 30000);

        // Use spawn to stream output in real-time
        const quartoProcess = spawn('quarto', args, { cwd: workspaceFolder });

        quartoProcess.stdout.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        quartoProcess.stderr.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        quartoProcess.on('close', async (code) => {
            clearTimeout(timeout);
            
            if (code !== 0) {
                // IF ERROR: The panel is already open, so you immediately see why it failed.
                outputChannel.appendLine(`\n[Failed] Quarto exited with code ${code}.`);
                setFileLock(typPath, true); 
                resolve(false);
                return;
            }

            outputChannel.appendLine("\n[Success] Render completed.");

            if (openTypAfter) {
                isSyncing = true; 
                try {
                    await syncQmdToTyp(doc.uri, lineIdx, viewCol);
                } catch (err) {
                    console.error("Sync error:", err);
                } finally {
                    isSyncing = false;
                }
            } else {
                setFileLock(typPath, true); 
            }
            resolve(true);
        });
    });
}

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