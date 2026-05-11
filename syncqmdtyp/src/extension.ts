import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process'; 

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let isSyncing = false; 
let isWebviewActive = false; 

const outputChannel = vscode.window.createOutputChannel("Quarto -> Typst");

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
        
        // If focus shifts to a Webview (like the Tinymist Preview)
        if (!editor) { 
            isWebviewActive = true; 
            return; 
        }

        const fileName = editor.document.fileName;

        if (fileName.endsWith('.typ')) {
            const qmdPath = fileName.replace('.typ', '.qmd');
            // ONLY jump if this .typ file belongs to a .qmd project
            if (fs.existsSync(qmdPath)) {
                if (isWebviewActive) {
                    isWebviewActive = false;
                    isSyncing = true;
                    setTimeout(async () => {
                        try {
                            await jumpToQmd(editor);
                        } finally { isSyncing = false; }
                    }, 50);
                }
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
    let isCapturingErrorBlock = false;

    // Enhanced Multiline Error Capture
    const processOutput = (data: Buffer, isStderr: boolean) => {
        const text = data.toString();
        const lines = text.split(/\r?\n/);
        
        lines.forEach(line => {
            const trimmed = line.trim();
            
            // Preserve empty lines if we are inside an error block
            if (!trimmed) {
                if (isCapturingErrorBlock) outputChannel.appendLine(""); 
                return;
            }

            const isError = /error|failed|exception/i.test(trimmed);
            const isWarning = /warning/i.test(trimmed);
            
            if (isError || isWarning) {
                if (isError) hasError = true;
                isCapturingErrorBlock = true; // Begin capturing the multiline stack trace
                // Print the raw line (not trimmed) to keep indentation for visual code pointers
                outputChannel.appendLine(line); 
            } 
            else if (trimmed.startsWith('processing file:') || trimmed.includes('output file:')) {
                isCapturingErrorBlock = false; // Reset error block when normal progress resumes
                outputChannel.appendLine(trimmed);
            } 
            else if (isCapturingErrorBlock || isStderr) {
                // If we are tracing an error, OR if Quarto pushed this to standard error, print it
                outputChannel.appendLine(line); 
            }
        });
    };

    quartoProcess.stdout?.on('data', (data) => processOutput(data, false));
    quartoProcess.stderr?.on('data', (data) => processOutput(data, true));

    quartoProcess.on('close', async (code) => {
        if (code === 0 && !hasError) {
            outputChannel.appendLine(`\n[Success] .typ file updated.`);
            outputChannel.appendLine(`- Browse/Click .typ to sync preview.`);
            outputChannel.appendLine(`- Double-click preview to jump to source.`);
            
            try {
                const typUri = vscode.Uri.file(typPath);
                const typDoc = await vscode.workspace.openTextDocument(typUri);
                
                // Keep the document open in the background without stealing focus
                await vscode.window.showTextDocument(typDoc, { preserveFocus: true, preview: false });
                
                // Fake edit: Add a space and delete it to force the LSP to refresh the preview
                const edit = new vscode.WorkspaceEdit();
                const position = typDoc.lineAt(typDoc.lineCount - 1).range.end;
                
                edit.insert(typUri, position, ' ');
                await vscode.workspace.applyEdit(edit);
                
                const editUndo = new vscode.WorkspaceEdit();
                editUndo.delete(typUri, new vscode.Range(position, position.translate(0, 1)));
                await vscode.workspace.applyEdit(editUndo);
                
                await typDoc.save(); 

            } catch (e) {
                console.warn("Could not execute Tinymist background update:", e);
            }

            if (jumpAfter) {
                isSyncing = true;
                try {
                    await syncQmdToTyp(doc.uri, 0, vscode.window.activeTextEditor?.viewColumn);
                } finally {
                    isSyncing = false;
                }
            }
        } else {
            const finalCode = code !== 0 ? code : 'Caught by log parser';
            outputChannel.appendLine(`\n[Error] Render failed (Exit Code: ${finalCode}). Check the detailed trace above.`);
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

    // --- UPGRADED CONTEXT SELECTION ---
    // Grab roughly 10 words around the cursor for a unique "fingerprint"
    const cursorOffset = typDoc.offsetAt(typEditor.selection.active);
    const textAround = typDoc.getText(new vscode.Range(
        typDoc.positionAt(Math.max(0, cursorOffset - 100)),
        typDoc.positionAt(cursorOffset + 100)
    ));

    const words = textAround.match(/\b\w{3,}\b/g) || [];
    if (words.length === 0) return;

    // Pivot around the cursor: find the 10 words closest to the middle of our sample
    const midIndex = Math.floor(words.length / 2);
    const searchWords = words.slice(Math.max(0, midIndex - 5), midIndex + 5)
                             .map(w => w.toLowerCase());

    const qmdFilesToSearch = getAllRelatedQmdFiles(mainQmdPath);
    let globalBestFile = '';
    let globalBestLine = -1;
    let globalHighScore = 0;

    for (const filePath of qmdFilesToSearch) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);

        lines.forEach((line, idx) => {
            if (line.trim().length < 3) return; // Skip empty/trivial lines
            
            const lineLower = line.toLowerCase();
            let score = 0;
            
            // Score based on word frequency in this line
            searchWords.forEach(word => {
                if (lineLower.includes(word)) score++;
            });

            if (score > globalHighScore) { 
                globalHighScore = score; 
                globalBestLine = idx; 
                globalBestFile = filePath;
            }
        });
    }

    // --- NAVIGATION ---
    if (globalBestFile !== '' && globalHighScore > 1) { // Require at least 2 word match
        const targetUri = vscode.Uri.file(globalBestFile);
        
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
                viewColumn: vscode.ViewColumn.One, 
                preserveFocus: false,
                preview: false 
            });
        }
        
        const pos = new vscode.Position(globalBestLine, 0);
        targetEditor.selection = new vscode.Selection(pos, pos);
        targetEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        
        // Brief highlight effect to show the user where they landed
        const decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 255, 0, 0.3)',
            isWholeLine: true
        });
        targetEditor.setDecorations(decoration, [new vscode.Range(pos, pos)]);
        setTimeout(() => decoration.dispose(), 800);
    }
}
