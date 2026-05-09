import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process'; 

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let isSyncing = false; 
let isWebviewActive = false; 

const outputChannel = vscode.window.createOutputChannel("Quarto -> Typst");

/**
 * Sets file permissions to read-only (444) or read-write (666).
 * Only executes if the file exists.
 */
function setFileLock(filePath: string, isLocked: boolean) {
    if (!fs.existsSync(filePath)) return;
    try {
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

        const fileName = editor.document.fileName;

        if (fileName.endsWith('.typ')) {
            const qmdPath = fileName.replace('.typ', '.qmd');
            // ONLY lock and jump if this .typ file belongs to a .qmd project
            if (fs.existsSync(qmdPath)) {
                if (isWebviewActive) {
                    isWebviewActive = false;
                    isSyncing = true;
                    setTimeout(async () => {
                        try {
                            await jumpToQmd(editor);
                            setFileLock(fileName, true);
                        } finally { isSyncing = false; }
                    }, 50);
                }
            }
        } else if (editor.document.languageId === 'quarto') {
            const typPath = fileName.replace('.qmd', '.typ');
            if (fs.existsSync(typPath)) {
                setFileLock(typPath, true);
            }
        }
    });

    context.subscriptions.push(previewCommand, forwardSync, autoSync);
}

// --- RENDER ENGINE ---

async function startQuartoRender(doc: vscode.TextDocument, jumpAfter: boolean) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');

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
    outputChannel.appendLine(`[Updating Typst File] Rendering ${path.basename(qmdPath)}...\n`);

    const quartoProcess = spawn('quarto', args, { cwd: workspaceFolder });
    let hasError = false;

    const filterAndLog = (data: Buffer) => {
        const lines = data.toString().split(/\r?\n/);
        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;

            const isError = /error|failed|exception/i.test(trimmed);
            const isWarning = /warning/i.test(trimmed);
            
            if (isError || isWarning) {
                if (isError) hasError = true;
                outputChannel.appendLine(trimmed);
            }
            
            if (trimmed.startsWith('processing file:') || trimmed.includes('output file:')) {
                outputChannel.appendLine(trimmed);
            }
        });
    };

    quartoProcess.stdout?.on('data', filterAndLog);
    quartoProcess.stderr?.on('data', filterAndLog);

    quartoProcess.on('close', async (code) => {
        setFileLock(typPath, true);

        if (code === 0 && !hasError) {
            outputChannel.appendLine(`\n[Success] .typ file updated and locked.`);
            outputChannel.appendLine(`- Browse/Click .typ to sync preview.`);
            outputChannel.appendLine(`- Double-click preview to jump to source.`);
            
            if (jumpAfter) {
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
            const finalCode = code !== 0 ? code : 'Caught by log parser';
            outputChannel.appendLine(`\n[Error] Render failed (Exit Code: ${finalCode}). Check logs above.`);
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
        const typDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(typPath));
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
    } catch (e) { console.error(e); }
}

async function jumpToQmd(typEditor: vscode.TextEditor) {
    const typDoc = typEditor.document;
    const mainQmdPath = typDoc.fileName.replace('.typ', '.qmd');
    if (!fs.existsSync(mainQmdPath)) return;

    const lineText = typDoc.lineAt(typEditor.selection.active.line).text.trim();
    if (!lineText) return;

    const searchWords = new Set(lineText.toLowerCase().match(/\b\w{4,}\b/g) || []);
    if (searchWords.size === 0) return;

    const qmdFilesToSearch = getAllRelatedQmdFiles(mainQmdPath);
    let globalBestFile = '';
    let globalBestLine = -1;
    let globalHighScore = 0;

    for (const filePath of qmdFilesToSearch) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);

        lines.forEach((line, idx) => {
            const words = new Set(line.toLowerCase().match(/\b\w{4,}\b/g) || []);
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
        const targetUri = vscode.Uri.file(globalBestFile);
        
        // Find if any existing editor already has this file open to avoid duplicate tabs
        let targetEditor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.fsPath === targetUri.fsPath
        );

        if (targetEditor) {
            await vscode.window.showTextDocument(targetEditor.document, {
                viewColumn: targetEditor.viewColumn,
                preserveFocus: false,
                preview: false 
            });
        } else {
            const qmdDoc = await vscode.workspace.openTextDocument(targetUri);
            targetEditor = await vscode.window.showTextDocument(qmdDoc, { 
                viewColumn: typEditor.viewColumn, 
                preserveFocus: false,
                preview: false 
            });
        }
        
        const pos = new vscode.Position(globalBestLine, 0);
        targetEditor.selection = new vscode.Selection(pos, pos);
        targetEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
}
