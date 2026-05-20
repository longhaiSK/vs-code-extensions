import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process'; 

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Global State
let isSyncing = false; 
let isWebviewActive = false; 
let lastActiveQmd: string | undefined;

// --- TERMINAL SETUP ---
let renderTerminal: vscode.Terminal | undefined;
let terminalEmitter: vscode.EventEmitter<string> | undefined;

function getRenderTerminal() {
    if (!renderTerminal || !terminalEmitter) {
        terminalEmitter = new vscode.EventEmitter<string>();
        const pty: vscode.Pseudoterminal = {
            onDidWrite: terminalEmitter.event,
            open: () => {},
            close: () => {
                renderTerminal = undefined;
                terminalEmitter = undefined;
            }
        };
        renderTerminal = vscode.window.createTerminal({ name: "Quarto -> Typst", pty });
    }
    return { terminal: renderTerminal, emitter: terminalEmitter };
}

export function activate(context: vscode.ExtensionContext) {

    // COMMAND: Manual Preview/Play
    let previewCommand = vscode.commands.registerCommand('qmd2typ.preview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'quarto') {
            await editor.document.save(); 
            await executeQuartoRender(editor.document);
        }
    });

    // COMMAND: Forward Sync
    let forwardSync = vscode.commands.registerCommand('qmd2typ.forwardSync', async () => {
        if (isSyncing) return;
        const qmdEditor = vscode.window.activeTextEditor;
        if (!qmdEditor || qmdEditor.document.languageId !== 'quarto') return;

        isSyncing = true; 
        try {
            await syncQmdToTyp(qmdEditor.document.uri, qmdEditor.selection.active, qmdEditor.viewColumn);
        } finally {
            isSyncing = false;
        }
    });

    // AUTO-SYNC / JUMP BACK
    let autoSync = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor && editor.document.languageId === 'quarto') {
            lastActiveQmd = editor.document.fileName;
        }

        if (isSyncing) return; 
        
        if (!editor) { 
            isWebviewActive = true; 
            return; 
        }

        const fileName = editor.document.fileName;

        if (fileName.endsWith('.typ')) {
            if (lastActiveQmd) {
                const qmdDir = path.dirname(lastActiveQmd) + path.sep;
                const typDir = path.dirname(fileName) + path.sep;
                
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

// --- PURE MANUAL RENDER ENGINE ---

async function executeQuartoRender(doc: vscode.TextDocument) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');

    const args = ['render', qmdPath, '--to', 'typst', '--cache', '-M', 'output-ext:typ', '-M', 'keep-typ:true'];

    const { terminal, emitter } = getRenderTerminal();
    terminal.show(true); 
    emitter.fire('\x1b[2J\x1b[3J\x1b[H'); 
    emitter.fire(`\x1b[1;34m🚀 [Rendering] ${path.basename(qmdPath)}...\x1b[0m\r\n\r\n`);

    const quartoProcess = spawn('quarto', args, { cwd: workspaceFolder });
    let hasError = false;

    const processOutput = (data: Buffer) => {
        const rawText = data.toString();
        const cleanText = rawText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        if (/error:|failed|exception/i.test(cleanText)) hasError = true;
        emitter.fire(rawText.replace(/\r?\n/g, '\r\n'));
    };

    quartoProcess.stdout?.on('data', processOutput);
    quartoProcess.stderr?.on('data', processOutput);

    quartoProcess.on('close', async (code) => {
        emitter.fire('\r\n--------------------------------------------------\r\n');
        if (code === 0 && !hasError) {
            emitter.fire(`\x1b[1;32m🎉 [Success] .typ file successfully updated.\x1b[0m\r\n`);
            
            try {
                const typUri = vscode.Uri.file(typPath);
                const typDoc = await vscode.workspace.openTextDocument(typUri);
                await vscode.window.showTextDocument(typDoc, { preserveFocus: true, preview: false });
                await vscode.commands.executeCommand('workbench.action.files.revert', typUri);
                const edit = new vscode.WorkspaceEdit();
                const position = typDoc.lineAt(typDoc.lineCount - 1).range.end;
                edit.insert(typUri, position, ' ');
                await vscode.workspace.applyEdit(edit);
                const editUndo = new vscode.WorkspaceEdit();
                editUndo.delete(typUri, new vscode.Range(position, position.translate(0, 1)));
                await vscode.workspace.applyEdit(editUndo);
                await typDoc.save(); 
            } catch (e) {
                emitter.fire(`\x1b[1;33m⚠️ [Warning] Could not refresh .typ file: ${e}\x1b[0m\r\n`);
            }

            isSyncing = true;
            try {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.fileName === qmdPath) {
                    await syncQmdToTyp(activeEditor.document.uri, activeEditor.selection.active, activeEditor.viewColumn);
                }
            } finally {
                isSyncing = false;
            }
        } else {
            const finalCode = code !== 0 ? code : 'Caught by log parser';
            emitter.fire(`\x1b[1;31m🔥 [Error] Render failed (Exit Code: ${finalCode}).\x1b[0m\r\n`);
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

async function syncQmdToTyp(qmdUri: vscode.Uri, cursor: vscode.Position, viewCol?: vscode.ViewColumn) {
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
        const qmdLineText = qmdDoc.lineAt(cursor.line).text.trim();
        
        const wordRange = qmdDoc.getWordRangeAtPosition(cursor);
        const anchorWord = wordRange ? qmdDoc.getText(wordRange) : "";
        
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
                    const targetLineText = typLines[bestMatch];
                    let endCol = targetLineText.length; 
                    let startCol = 0;

                    if (anchorWord) {
                        const wordIdx = targetLineText.toLowerCase().indexOf(anchorWord.toLowerCase());
                        if (wordIdx !== -1) {
                            startCol = wordIdx;
                            endCol = wordIdx + anchorWord.length;
                        } else {
                            let lastWordIndex = -1;
                            let lastWordLength = 0;
                            searchWords.forEach(w => {
                                const idx = targetLineText.toLowerCase().indexOf(w);
                                if (idx > lastWordIndex) {
                                    lastWordIndex = idx;
                                    lastWordLength = w.length;
                                }
                            });
                            if (lastWordIndex !== -1) {
                                startCol = lastWordIndex;
                                endCol = lastWordIndex + lastWordLength;
                            }
                        }
                    }

                    const cursorPos = new vscode.Position(bestMatch, endCol);
                    const startPos = new vscode.Position(bestMatch, startCol);
                    
                    typEditor.selection = new vscode.Selection(cursorPos, cursorPos);
                    typEditor.revealRange(new vscode.Range(cursorPos, cursorPos), vscode.TextEditorRevealType.InCenter);
                    
                    const anchorRange = new vscode.Range(startPos, cursorPos);
                    const cursorDecoration = vscode.window.createTextEditorDecorationType({
                        backgroundColor: 'rgba(255, 0, 0, 0.2)',
                        border: '1px solid rgba(255, 0, 0, 0.8)',
                        borderRadius: '2px',
                        overviewRulerColor: 'red',
                        overviewRulerLane: vscode.OverviewRulerLane.Full,
                        fontWeight: 'bold'
                    });

                    typEditor.setDecorations(cursorDecoration, [anchorRange]);
                    setTimeout(() => cursorDecoration.dispose(), 1200);
                }
            }
        }
    } catch (e) { console.error(e); }
}

async function jumpToQmd(typEditor: vscode.TextEditor, mainQmdPath: string) {
    const typDoc = typEditor.document;
    if (!fs.existsSync(mainQmdPath)) return;

    const cursorPosition = typEditor.selection.active;
    const wordRange = typDoc.getWordRangeAtPosition(cursorPosition);
    const anchorWord = wordRange ? typDoc.getText(wordRange) : "";

    const cursorOffset = typDoc.offsetAt(cursorPosition);
    
    const textAround = typDoc.getText(new vscode.Range(
        typDoc.positionAt(Math.max(0, cursorOffset - 300)),
        typDoc.positionAt(cursorOffset + 300)
    ));

    const allWords = textAround.match(/\b\w{3,}\b/g) || [];
    if (allWords.length === 0) return;

    const midIndex = Math.floor(allWords.length / 2);
    
    const searchWords = allWords.slice(Math.max(0, midIndex - 6), midIndex + 6)
                                .map(w => w.toLowerCase());
                                
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
            
            searchWords.forEach(word => {
                if (lineLower.includes(word)) score += 1;
            });

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

            if (score > globalHighScore) { 
                globalHighScore = score; 
                globalBestLine = idx; 
                globalBestFile = filePath;
            }
        });
    }

    if (globalBestFile !== '' && globalHighScore > 1) {
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

        const targetLineText = qmdDoc.lineAt(globalBestLine).text;
        let startCol = 0;
        let endCol = targetLineText.length; 

        if (anchorWord) {
            const wordIdx = targetLineText.toLowerCase().indexOf(anchorWord.toLowerCase());
            if (wordIdx !== -1) {
                startCol = wordIdx;
                endCol = wordIdx + anchorWord.length; 
            }
        }

        const startPos = new vscode.Position(globalBestLine, startCol);
        const cursorPos = new vscode.Position(globalBestLine, endCol);
        
        const anchorRange = qmdDoc.getWordRangeAtPosition(startPos) || 
                            new vscode.Range(startPos, new vscode.Position(globalBestLine, startCol + Math.max(1, anchorWord.length)));
        
        targetEditor.selection = new vscode.Selection(cursorPos, cursorPos);
        targetEditor.revealRange(
            new vscode.Range(cursorPos, cursorPos), 
            vscode.TextEditorRevealType.InCenter
        );
        
        const cursorDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.2)',
            border: '1px solid rgba(255, 0, 0, 0.8)',
            borderRadius: '2px',
            overviewRulerColor: 'red',
            overviewRulerLane: vscode.OverviewRulerLane.Full,
            fontWeight: 'bold'
        });

        targetEditor.setDecorations(cursorDecoration, [anchorRange]);
        setTimeout(() => cursorDecoration.dispose(), 1200);
        
    } else {
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

export function deactivate() {}