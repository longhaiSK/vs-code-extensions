import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process'; 

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let isSyncing = false; 
let isWebviewActive = false; 

const outputChannel = vscode.window.createOutputChannel("Quarto -> Typst");

function setFileLock(filePath: string, isLocked: boolean) {
    if (!fs.existsSync(filePath)) return;
    try {
        // Only lock if we aren't currently in the middle of a render write
        fs.chmodSync(filePath, isLocked ? 0o444 : 0o666);
    } catch (e) {
        console.warn(`Could not set lock state on ${filePath}`);
    }
}

export function activate(context: vscode.ExtensionContext) {

    // COMMAND: Render
    let previewCommand = vscode.commands.registerCommand('qmd2typ.preview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'quarto') {
            await editor.document.save(); 
            await startQuartoRender(editor.document, true);
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

    // AUTO-SYNC / JUMP BACK
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

// --- RENDER ENGINE ---

async function startQuartoRender(doc: vscode.TextDocument, jumpAfter: boolean) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');

    // Unlock so Quarto can write the bridge file to the physical disk
    setFileLock(typPath, false);

    const args = [
        'render', qmdPath, 
        '--to', 'typst', 
        '--cache', 
        '-M', 'output-ext:typ', 
        '-M', 'keep-typ:true'
    ];

    outputChannel.clear();
    outputChannel.show(true); 
    outputChannel.appendLine(`[Updating Bridge] quarto ${args.join(' ')}\n`);

    const quartoProcess = spawn('quarto', args, { cwd: workspaceFolder });

    // Track errors manually in case Quarto returns code 0 improperly
    let hasError = false;

    quartoProcess.stdout?.on('data', (data) => {
        const out = data.toString();
        outputChannel.append(out);
        if (out.includes('Error') || out.includes('Failed') || out.includes('failed')) {
            hasError = true;
        }
    });

    quartoProcess.stderr?.on('data', (data) => {
        const err = data.toString();
        outputChannel.append(err);
        if (err.includes('Error') || err.includes('Failed') || err.includes('failed')) {
            hasError = true;
        }
    });

    quartoProcess.on('close', async (code) => {
        // Re-lock the file to protect it immediately after writing finishes
        setFileLock(typPath, true);

        // Strictly evaluate both the exit code AND our scraped error flag
        if (code === 0 && !hasError) {
            outputChannel.appendLine(`\n[Success] .Typ File is updated on disk.`);
            outputChannel.appendLine(` Browse and Click the .Typ File to Sync Preview.`);
            outputChannel.appendLine(` Click Preview to Jump Back to .qmd File.`);
            
            if (jumpAfter) {
                // Briefly unlock for the sync navigation logic to function
                setFileLock(typPath, false);
                isSyncing = true;
                try {
                    await syncQmdToTyp(doc.uri, 0);
                } finally {
                    isSyncing = false;
                    setFileLock(typPath, true);
                }
            }
        } else {
            // Give a clean error message if it fails
            const finalCode = code !== 0 ? code : 'Unknown (Caught by log parser)';
            outputChannel.appendLine(`\n[Error] Render failed with exit code ${finalCode}. Check output logs above.`);
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
    const mainQmdPath = typDoc.fileName.replace('.typ', '.qmd');
    if (!fs.existsSync(mainQmdPath)) return;

    const lineText = typDoc.lineAt(typEditor.selection.active.line).text.trim();
    if (!lineText) return;

    const searchWords = new Set(lineText.toLowerCase().match(/\b\w{4,}\b/g) || []);
    if (searchWords.size === 0) return;

    // Utilize the helper to get the main file AND all included chapters
    const qmdFilesToSearch = getAllRelatedQmdFiles(mainQmdPath);

    let globalBestFile = '';
    let globalBestLine = -1;
    let globalHighScore = 0;

    for (const filePath of qmdFilesToSearch) {
        if (!fs.existsSync(filePath)) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);

        lines.forEach((line, idx) => {
            const words = new paddingSet(line.toLowerCase().match(/\b\w{4,}\b/g) || []);
            let score = 0;
            searchWords.forEach(w => { if (words.has(w)) score++; });
            
            if (score > globalHighScore) { 
                globalHighScore = score; 
                globalBestLine = idx; 
                globalBestFile = filePath;
            }
        });
    }

    if (globalBestFile !== '' && globalBestLine !== -1) {
        const qmdDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(globalBestFile));
        const qmdEditor = await vscode.window.showTextDocument(qmdDoc, { 
            viewColumn: typEditor.viewColumn, 
            preserveFocus: false 
        });
        
        const pos = new vscode.Position(globalBestLine, 0);
        qmdEditor.selection = new vscode.Selection(pos, pos);
        qmdEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
}

class paddingSet extends Set<string> {
    // Just an alias to maintain your existing fuzzy matching logic perfectly
}