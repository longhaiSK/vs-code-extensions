import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process'; 

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let isSyncing = false; 
let isWebviewActive = false; 

// Track the last active QMD file so we can redirect template .typ files back to the project root
let lastActiveQmd: string | undefined;

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
        // Keep track of the most recent .qmd file
        if (editor && editor.document.languageId === 'quarto') {
            lastActiveQmd = editor.document.fileName;
        }

        if (isSyncing) return; 
        
        // If focus shifts to a Webview (like the Tinymist Preview)
        if (!editor) { 
            isWebviewActive = true; 
            return; 
        }

        const fileName = editor.document.fileName;

        if (fileName.endsWith('.typ')) {
            // --- FIX 1: Restrict opening system/external Typst files ---
            if (lastActiveQmd) {
                const qmdDir = path.dirname(lastActiveQmd) + path.sep;
                const typDir = path.dirname(fileName) + path.sep;
                
                // If the opened .typ file is outside the QMD project directory, close it immediately.
                if (!typDir.startsWith(qmdDir)) {
                    isSyncing = true;
                    try {
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        const doc = await vscode.workspace.openTextDocument(lastActiveQmd);
                        await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
                    } finally {
                        isSyncing = false;
                    }
                    return;
                }
            }

            const exactQmdPath = fileName.replace('.typ', '.qmd');
            let targetQmdPath = exactQmdPath;

            // If Tinymist jumps to a secondary local style/template file (e.g. _extensions/.../core.typ)
            if (!fs.existsSync(exactQmdPath) && lastActiveQmd) {
                targetQmdPath = lastActiveQmd;
            }

            if (fs.existsSync(targetQmdPath)) {
                if (isWebviewActive) {
                    isWebviewActive = false;
                    isSyncing = true;
                    setTimeout(async () => {
                        try {
                            await jumpToQmd(editor, targetQmdPath);
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
    outputChannel.appendLine(`🚀 [Starting] Rendering ${path.basename(qmdPath)} to Typst...\n`);
    outputChannel.appendLine(`--------------------------------------------------`);

    const quartoProcess = spawn('quarto', args, { cwd: workspaceFolder });
    
    let hasError = false;
    let isCapturingErrorBlock = false;

    // --- FIX 2: Enhanced Multiline Error Capture & Debug Logging ---
    const processOutput = (data: Buffer, isStderr: boolean) => {
        const text = data.toString();
        const lines = text.split(/\r?\n/);
        
        lines.forEach(line => {
            const trimmed = line.trim();
            
            // Preserve empty lines only if we are inside a multiline error block
            if (!trimmed) {
                if (isCapturingErrorBlock) outputChannel.appendLine(""); 
                return;
            }

            const isError = /error:|failed|exception/i.test(trimmed);
            const isWarning = /warning:/i.test(trimmed);
            
            if (isError) {
                hasError = true;
                isCapturingErrorBlock = true;
                outputChannel.appendLine(`❌ ERROR: ${trimmed}`);
            } 
            else if (isWarning) {
                outputChannel.appendLine(`⚠️ WARNING: ${trimmed}`);
            } 
            else if (trimmed.startsWith('processing file:') || trimmed.includes('output file:')) {
                isCapturingErrorBlock = false; // Reset error block on successful progress
                outputChannel.appendLine(`✅ PROGRESS: ${trimmed}`);
            } 
            else {
                if (isCapturingErrorBlock) {
                    // Indent stack traces/error continuations for readability
                    outputChannel.appendLine(`       ${line}`);
                } else {
                    // Log everything else so no debugging context is lost!
                    outputChannel.appendLine(`📝 ${line}`);
                }
            }
        });
    };

    quartoProcess.stdout?.on('data', (data) => processOutput(data, false));
    quartoProcess.stderr?.on('data', (data) => processOutput(data, true));

    quartoProcess.on('close', async (code) => {
        outputChannel.appendLine(`--------------------------------------------------`);
        if (code === 0 && !hasError) {
            outputChannel.appendLine(`🎉 [Success] .typ file successfully updated.`);
            
            try {
                const typUri = vscode.Uri.file(typPath);
                const typDoc = await vscode.workspace.openTextDocument(typUri);
                
                // 1. Show the document (or ensure it's loaded)
                const typEditor = await vscode.window.showTextDocument(typDoc, { preserveFocus: true, preview: false });

                // 2. FORCE REFRESH FROM DISK
                await vscode.commands.executeCommand('workbench.action.files.revert', typUri);

                // 3. Trigger Tinymist refresh (The "Fake Edit")
                const edit = new vscode.WorkspaceEdit();
                const lastLine = typDoc.lineCount - 1;
                const position = typDoc.lineAt(lastLine).range.end;
                
                edit.insert(typUri, position, ' ');
                await vscode.workspace.applyEdit(edit);
                
                const editUndo = new vscode.WorkspaceEdit();
                editUndo.delete(typUri, new vscode.Range(position, position.translate(0, 1)));
                await vscode.workspace.applyEdit(editUndo);
                
                await typDoc.save(); 

            } catch (e) {
                outputChannel.appendLine(`⚠️ [Warning] Could not refresh .typ file: ${e}`);
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
            outputChannel.appendLine(`🔥 [Error] Render failed (Exit Code: ${finalCode}). Check the trace above for details.`);
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

async function jumpToQmd(typEditor: vscode.TextEditor, mainQmdPath: string) {
    const typDoc = typEditor.document;
    if (!fs.existsSync(mainQmdPath)) return;

    // 1. Get the specific word under the cursor to use as the "exact anchor"
    const cursorPosition = typEditor.selection.active;
    const wordRange = typDoc.getWordRangeAtPosition(cursorPosition);
    const anchorWord = wordRange ? typDoc.getText(wordRange) : "";

    // 2. Get context for both exact matching and tie-breaking
    const cursorOffset = typDoc.offsetAt(cursorPosition);
    
    // Grab a larger chunk of text (about 300 chars either way)
    const textAround = typDoc.getText(new vscode.Range(
        typDoc.positionAt(Math.max(0, cursorOffset - 300)),
        typDoc.positionAt(cursorOffset + 300)
    ));

    const allWords = textAround.match(/\b\w{3,}\b/g) || [];
    if (allWords.length === 0) return;

    const midIndex = Math.floor(allWords.length / 2);
    
    // Primary Zone: ~12 words right around the cursor for the exact line match
    const searchWords = allWords.slice(Math.max(0, midIndex - 6), midIndex + 6)
                                .map(w => w.toLowerCase());
                                
    // Context Zone: ~30 words total to act as our tie-breaker
    const contextWords = allWords.slice(Math.max(0, midIndex - 15), midIndex + 15)
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
            if (line.trim().length < 3) return;
            
            const lineLower = line.toLowerCase();
            let score = 0;
            
            // --- Phase 1: Primary Exact Match ---
            searchWords.forEach(word => {
                if (lineLower.includes(word)) score += 1;
            });

            // --- Phase 2: Contextual Tie-Breaker ---
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
                    if (!searchWords.includes(word) && surroundingLower.includes(word)) {
                        score += 0.2; 
                    }
                });
            }

            // Update the global high score
            if (score > globalHighScore) { 
                globalHighScore = score; 
                globalBestLine = idx; 
                globalBestFile = filePath;
            }
        });
    }

    // 3. Navigation with Column Precision
    if (globalBestFile !== '' && globalHighScore > 1) {
        // Clean up: If Tinymist opened a secondary style file, close it securely
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

        // Calculate the best column position
        const targetLineText = qmdDoc.lineAt(globalBestLine).text;
        let startCol = 0;
        let endCol = 0;

        if (anchorWord) {
            // Try to find the exact word within the matched line
            const wordIdx = targetLineText.toLowerCase().indexOf(anchorWord.toLowerCase());
            if (wordIdx !== -1) {
                startCol = wordIdx;
                // Calculate the exact character index right after the word
                endCol = wordIdx + anchorWord.length; 
            }
        }

        const startPos = new vscode.Position(globalBestLine, startCol);
        const cursorPos = new vscode.Position(globalBestLine, endCol > 0 ? endCol : startCol);
        
        // Define the range for the red visual pulse (highlights the whole word)
        const anchorRange = qmdDoc.getWordRangeAtPosition(startPos) || 
                            new vscode.Range(startPos, new vscode.Position(globalBestLine, startCol + Math.max(1, anchorWord.length)));
        
        // Move selection (cursor) to the EXACT END of the word
        targetEditor.selection = new vscode.Selection(cursorPos, cursorPos);
        targetEditor.revealRange(
            new vscode.Range(cursorPos, cursorPos), 
            vscode.TextEditorRevealType.InCenter
        );
        
        // --- VISUAL FEEDBACK: RED "CURSOR" PULSE ---
        const cursorDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.2)',
            border: '1px solid rgba(255, 0, 0, 0.8)',
            borderRadius: '2px',
            overviewRulerColor: 'red',
            overviewRulerLane: vscode.OverviewRulerLane.Full,
            fontWeight: 'bold'
        });

        // Apply decoration to the specific word/range
        targetEditor.setDecorations(cursorDecoration, [anchorRange]);

        // Remove the highlight after 1.2 seconds
        setTimeout(() => cursorDecoration.dispose(), 1200);
    } else {
        // No match found. Clean up secondary .typ files safely.
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
