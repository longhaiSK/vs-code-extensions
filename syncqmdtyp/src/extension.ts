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
        
        try {
            const typUri = vscode.Uri.file(typPath);
            const typDoc = await vscode.workspace.openTextDocument(typUri);
            
            // 1. Show the document (or ensure it's loaded)
            const typEditor = await vscode.window.showTextDocument(typDoc, { preserveFocus: true, preview: false });

            // 2. FORCE REFRESH FROM DISK
            // This command clears the "newer file exists" conflict by reloading from disk
            await vscode.commands.executeCommand('workbench.action.files.revert', typUri);

            // 3. Trigger Tinymist refresh (The "Fake Edit")
            // We do this AFTER the revert to ensure Tinymist sees the fresh Quarto output
            const edit = new vscode.WorkspaceEdit();
            const lastLine = typDoc.lineCount - 1;
            const position = typDoc.lineAt(lastLine).range.end;
            
            edit.insert(typUri, position, ' ');
            await vscode.workspace.applyEdit(edit);
            
            const editUndo = new vscode.WorkspaceEdit();
            editUndo.delete(typUri, new vscode.Range(position, position.translate(0, 1)));
            await vscode.workspace.applyEdit(editUndo);
            
            // Save immediately so the file is no longer "dirty"
            await typDoc.save(); 

        } catch (e) {
            console.warn("Could not refresh .typ file:", e);
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
    }
}

// async function jumpToQmd(typEditor: vscode.TextEditor) {
//     const typDoc = typEditor.document;
//     const mainQmdPath = typDoc.fileName.replace('.typ', '.qmd');
//     if (!fs.existsSync(mainQmdPath)) return;

//     // 1. Get the specific word under the cursor to use as the "exact anchor"
//     const cursorPosition = typEditor.selection.active;
//     const wordRange = typDoc.getWordRangeAtPosition(cursorPosition);
//     const anchorWord = wordRange ? typDoc.getText(wordRange) : "";

//     // 2. Get context for both exact matching and tie-breaking
//     const cursorOffset = typDoc.offsetAt(cursorPosition);
    
//     // Grab a larger chunk of text (about 300 chars either way)
//     const textAround = typDoc.getText(new vscode.Range(
//         typDoc.positionAt(Math.max(0, cursorOffset - 300)),
//         typDoc.positionAt(cursorOffset + 300)
//     ));

//     const allWords = textAround.match(/\b\w{3,}\b/g) || [];
//     if (allWords.length === 0) return;

//     const midIndex = Math.floor(allWords.length / 2);
    
//     // Primary Zone: ~12 words right around the cursor for the exact line match
//     const searchWords = allWords.slice(Math.max(0, midIndex - 6), midIndex + 6)
//                                 .map(w => w.toLowerCase());
                                
//     // Context Zone: ~30 words total to act as our tie-breaker
//     const contextWords = allWords.slice(Math.max(0, midIndex - 15), midIndex + 15)
//                                  .map(w => w.toLowerCase());

//     const qmdFilesToSearch = getAllRelatedQmdFiles(mainQmdPath);
//     let globalBestFile = '';
//     let globalBestLine = -1;
//     let globalHighScore = 0;

//     for (const filePath of qmdFilesToSearch) {
//         if (!fs.existsSync(filePath)) continue;
//         const content = fs.readFileSync(filePath, 'utf8');
//         const lines = content.split(/\r?\n/);

//         lines.forEach((line, idx) => {
//             if (line.trim().length < 3) return;
            
//             const lineLower = line.toLowerCase();
//             let score = 0;
            
//             // --- Phase 1: Primary Exact Match ---
//             // 1 full point for every exact word matched on this specific line
//             searchWords.forEach(word => {
//                 if (lineLower.includes(word)) score += 1;
//             });

//             // --- Phase 2: Contextual Tie-Breaker ---
//             // If the base score implies a decent match (e.g., >40% of words found), 
//             // we check the surrounding lines to break potential duplicates
//             if (score > (searchWords.length * 0.4)) { 
                
//                 // Peek at up to 2 lines above and 2 lines below in the .qmd file
//                 let surroundingQmd = "";
//                 for (let offset = -2; offset <= 2; offset++) {
//                     const targetIdx = idx + offset;
//                     if (offset !== 0 && targetIdx >= 0 && targetIdx < lines.length) {
//                         surroundingQmd += lines[targetIdx] + " ";
//                     }
//                 }
//                 const surroundingLower = surroundingQmd.toLowerCase();

//                 // Award fractional bonus points for broader context matches
//                 contextWords.forEach(word => {
//                     // Only score context words that weren't already part of the primary search
//                     if (!searchWords.includes(word) && surroundingLower.includes(word)) {
//                         score += 0.2; 
//                     }
//                 });
//             }

//             // Update the global high score
//             if (score > globalHighScore) { 
//                 globalHighScore = score; 
//                 globalBestLine = idx; 
//                 globalBestFile = filePath;
//             }
//         });
//     }

//     // 3. Navigation with Column Precision
//     if (globalBestFile !== '' && globalHighScore > 1) {
//         const targetUri = vscode.Uri.file(globalBestFile);
//         const qmdDoc = await vscode.workspace.openTextDocument(targetUri);
        
//         let targetEditor = vscode.window.visibleTextEditors.find(
//             e => e.document.uri.fsPath === targetUri.fsPath
//         );

//         targetEditor = await vscode.window.showTextDocument(qmdDoc, {
//             viewColumn: targetEditor ? targetEditor.viewColumn : vscode.ViewColumn.One,
//             preserveFocus: false,
//             preview: false 
//         });

//         // Calculate the best column position
//         const targetLineText = qmdDoc.lineAt(globalBestLine).text;
//         let targetCol = 0;

//         if (anchorWord) {
//             // Try to find the exact word within the matched line
//             const wordIdx = targetLineText.toLowerCase().indexOf(anchorWord.toLowerCase());
//             if (wordIdx !== -1) {
//                 targetCol = wordIdx;
//             }
//         }

//         const pos = new vscode.Position(globalBestLine, targetCol);
//         const anchorRange = qmdDoc.getWordRangeAtPosition(pos) || new vscode.Range(pos, pos.translate(0, Math.max(1, anchorWord.length)));
        
//         // Move selection to the exact word
//         targetEditor.selection = new vscode.Selection(pos, pos);
//         targetEditor.revealRange(
//             new vscode.Range(pos, pos), 
//             vscode.TextEditorRevealType.InCenter
//         );
        
//         // --- VISUAL FEEDBACK: RED "CURSOR" PULSE ---
//         const cursorDecoration = vscode.window.createTextEditorDecorationType({
//             backgroundColor: 'rgba(255, 0, 0, 0.2)',
//             border: '1px solid rgba(255, 0, 0, 0.8)',
//             borderRadius: '2px',
//             overviewRulerColor: 'red',
//             overviewRulerLane: vscode.OverviewRulerLane.Full,
//             fontWeight: 'bold'
//         });

//         // Apply decoration to the specific word/range
//         targetEditor.setDecorations(cursorDecoration, [anchorRange]);

//         // Remove the highlight after 1.2 seconds so it doesn't stay red forever
//         setTimeout(() => cursorDecoration.dispose(), 1200);
//     }
// }

// async function jumpToQmd(typEditor: vscode.TextEditor) {
//     const typDoc = typEditor.document;
//     const mainQmdPath = typDoc.fileName.replace('.typ', '.qmd');
//     if (!fs.existsSync(mainQmdPath)) return;

//     // 1. Get the specific word under the cursor to use as the "exact anchor"
//     const cursorPosition = typEditor.selection.active;
//     const wordRange = typDoc.getWordRangeAtPosition(cursorPosition);
//     const anchorWord = wordRange ? typDoc.getText(wordRange) : "";

//     // 2. Get the 10-word context for unique line identification
//     const cursorOffset = typDoc.offsetAt(cursorPosition);
//     const textAround = typDoc.getText(new vscode.Range(
//         typDoc.positionAt(Math.max(0, cursorOffset - 150)),
//         typDoc.positionAt(cursorOffset + 150)
//     ));

//     const words = textAround.match(/\b\w{3,}\b/g) || [];
//     if (words.length === 0) return;

//     const midIndex = Math.floor(words.length / 2);
//     const searchWords = words.slice(Math.max(0, midIndex - 5), midIndex + 5)
//                              .map(w => w.toLowerCase());

//     const qmdFilesToSearch = getAllRelatedQmdFiles(mainQmdPath);
//     let globalBestFile = '';
//     let globalBestLine = -1;
//     let globalHighScore = 0;

//     for (const filePath of qmdFilesToSearch) {
//         if (!fs.existsSync(filePath)) continue;
//         const content = fs.readFileSync(filePath, 'utf8');
//         const lines = content.split(/\r?\n/);

//         lines.forEach((line, idx) => {
//             if (line.trim().length < 3) return;
            
//             const lineLower = line.toLowerCase();
//             let score = 0;
//             searchWords.forEach(word => {
//                 if (lineLower.includes(word)) score++;
//             });

//             if (score > globalHighScore) { 
//                 globalHighScore = score; 
//                 globalBestLine = idx; 
//                 globalBestFile = filePath;
//             }
//         });
//     }

//     // 3. Navigation with Column Precision
//     if (globalBestFile !== '' && globalHighScore > 1) {
//         const targetUri = vscode.Uri.file(globalBestFile);
//         const qmdDoc = await vscode.workspace.openTextDocument(targetUri);
        
//         let targetEditor = vscode.window.visibleTextEditors.find(
//             e => e.document.uri.fsPath === targetUri.fsPath
//         );

//         targetEditor = await vscode.window.showTextDocument(qmdDoc, {
//             viewColumn: targetEditor ? targetEditor.viewColumn : vscode.ViewColumn.One,
//             preserveFocus: false,
//             preview: false 
//         });

//         // Calculate the best column position
//         const targetLineText = qmdDoc.lineAt(globalBestLine).text;
//         let targetCol = 0;

//         if (anchorWord) {
//             // Try to find the exact word within the matched line
//             const wordIdx = targetLineText.toLowerCase().indexOf(anchorWord.toLowerCase());
//             if (wordIdx !== -1) {
//                 targetCol = wordIdx;
//             }
//         }

//         // ... (previous logic to find globalBestLine and targetCol)

//         const pos = new vscode.Position(globalBestLine, targetCol);
//         const anchorRange = qmdDoc.getWordRangeAtPosition(pos) || new vscode.Range(pos, pos.translate(0, 5));
        
//         // Move selection to the exact word
//         targetEditor.selection = new vscode.Selection(pos, pos);
//         targetEditor.revealRange(
//             new vscode.Range(pos, pos), 
//             vscode.TextEditorRevealType.InCenter
//         );
        
//         // --- VISUAL FEEDBACK: RED "CURSOR" PULSE ---
//         const cursorDecoration = vscode.window.createTextEditorDecorationType({
//             backgroundColor: 'rgba(255, 0, 0, 0.2)',
//             border: '1px solid rgba(255, 0, 0, 0.8)',
//             borderRadius: '2px',
//             overviewRulerColor: 'red',
//             overviewRulerLane: vscode.OverviewRulerLane.Full,
//             fontWeight: 'bold'
//         });

//         // Apply decoration to the specific word/range
//         targetEditor.setDecorations(cursorDecoration, [anchorRange]);

//         // Remove the highlight after 1.2 seconds so it doesn't stay red forever
//         setTimeout(() => cursorDecoration.dispose(), 1200);
//     }
// }

