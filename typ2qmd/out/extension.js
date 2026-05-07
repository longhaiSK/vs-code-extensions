"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
let isSyncing = false;
let isWebviewActive = false; // Tracks if you are clicking inside the PDF
// --- HELPER: Manage File Lock ---
function setFileLock(filePath, isLocked) {
    if (!fs.existsSync(filePath))
        return;
    try {
        fs.chmodSync(filePath, isLocked ? 0o444 : 0o666);
    }
    catch (e) {
        console.warn(`Could not set lock state on ${filePath}`);
    }
}
function activate(context) {
    const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const config = vscode.workspace.getConfiguration('qmd2typ');
        if (config.get('renderOnSave') && doc.languageId === 'quarto') {
            const editor = vscode.window.activeTextEditor;
            const line = (editor && editor.document === doc) ? editor.selection.active.line : 0;
            await runQuartoRender(doc, true, line, editor?.viewColumn);
        }
    });
    let forwardSync = vscode.commands.registerCommand('qmd2typ.forwardSync', async () => {
        if (isSyncing)
            return;
        const qmdEditor = vscode.window.activeTextEditor;
        if (!qmdEditor || qmdEditor.document.languageId !== 'quarto')
            return;
        isSyncing = true;
        try {
            await syncQmdToTyp(qmdEditor.document.uri, qmdEditor.selection.active.line, qmdEditor.viewColumn);
        }
        finally {
            isSyncing = false;
        }
    });
    // --- THE NEW OBSERVER LOGIC ---
    let autoSync = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (isSyncing)
            return;
        // 1. If editor is undefined, you clicked into the PDF Webview!
        if (!editor) {
            isWebviewActive = true;
            return;
        }
        // 2. If you arrive at a .typ file...
        if (editor.document.fileName.endsWith('.typ')) {
            // ...AND you just came from the PDF Webview
            if (isWebviewActive) {
                isWebviewActive = false; // Reset flag
                isSyncing = true;
                // Tinymist routed your click! Bounce to QMD and lock the file.
                setTimeout(async () => {
                    try {
                        await jumpToQmd(editor);
                        setFileLock(editor.document.fileName, true);
                    }
                    finally {
                        isSyncing = false;
                    }
                }, 50);
            }
        }
        else {
            // 3. If you manually switch to QMD or another tab, reset the webview flag
            isWebviewActive = false;
            // If you went back to QMD manually, ensure the .typ file is locked behind you
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
async function runQuartoRender(doc, openTypAfter, lineIdx = 0, viewCol) {
    const qmdPath = doc.fileName;
    const workspaceFolder = path.dirname(qmdPath);
    const typPath = qmdPath.replace('.qmd', '.typ');
    const cmd = `quarto render "${qmdPath}" --to typst`;
    // UNLOCK for render
    setFileLock(typPath, false);
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
            (0, child_process_1.exec)(cmd, { cwd: workspaceFolder }, async (error, stdout, stderr) => {
                clearTimeout(timeout);
                resolve(true);
                if (error) {
                    vscode.window.showErrorMessage(`Quarto Error: ${stderr || error.message}`);
                    setFileLock(typPath, true); // Lock if failed
                    return;
                }
                if (openTypAfter) {
                    isSyncing = true;
                    try {
                        await syncQmdToTyp(doc.uri, lineIdx, viewCol);
                    }
                    catch (err) {
                        console.error("Sync error:", err);
                    }
                    finally {
                        isSyncing = false;
                    }
                }
                else {
                    setFileLock(typPath, true); // Lock if no jump needed
                }
            });
        });
    });
}
async function syncQmdToTyp(qmdUri, lineIdx, viewCol) {
    const qmdPath = qmdUri.fsPath;
    const typPath = qmdPath.replace('.qmd', '.typ');
    if (!fs.existsSync(typPath))
        return;
    try {
        // 1. UNLOCK so Tinymist can interact with it and you can click the UI
        setFileLock(typPath, false);
        const targetColumn = viewCol || vscode.ViewColumn.One;
        const typUri = vscode.Uri.file(typPath);
        // 2. Open .typ file in the same pane and STOP.
        const typDoc = await vscode.workspace.openTextDocument(typUri);
        const typEditor = await vscode.window.showTextDocument(typDoc, {
            viewColumn: targetColumn,
            preserveFocus: false
        });
        const qmdDoc = await vscode.workspace.openTextDocument(qmdUri);
        const qmdLineText = qmdDoc.lineAt(lineIdx).text.trim();
        // 3. Move Cursor for Sync
        if (qmdLineText.length > 0) {
            const searchWords = new Set(qmdLineText.toLowerCase().match(/\b\w{4,}\b/g) || []);
            if (searchWords.size > 0) {
                const typLines = typDoc.getText().split(/\r?\n/);
                let bestMatch = -1;
                let highStore = 0;
                typLines.forEach((line, idx) => {
                    const words = new Set(line.toLowerCase().match(/\b\w{4,}\b/g) || []);
                    let score = 0;
                    searchWords.forEach(w => { if (words.has(w))
                        score++; });
                    if (score > highStore) {
                        highStore = score;
                        bestMatch = idx;
                    }
                });
                if (bestMatch !== -1) {
                    const pos = new vscode.Position(bestMatch, 0);
                    typEditor.selection = new vscode.Selection(pos, pos);
                    typEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            }
        }
        // DO NOT BOUNCE. You are now safely parked in the .typ file.
        // You have all the time in the world to click "Preview" or view the sync.
    }
    catch (globalErr) {
        console.error("syncQmdToTyp failed:", globalErr);
    }
}
async function jumpToQmd(typEditor) {
    const typDoc = typEditor.document;
    const qmdPath = typDoc.fileName.replace('.typ', '.qmd');
    if (!fs.existsSync(qmdPath))
        return;
    const lineText = typDoc.lineAt(typEditor.selection.active.line).text.trim();
    if (!lineText)
        return;
    const qmdDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(qmdPath));
    const qmdLines = qmdDoc.getText().split(/\r?\n/);
    const searchWords = new Set(lineText.toLowerCase().match(/\b\w{4,}\b/g) || []);
    let bestMatch = -1;
    let highStore = 0;
    qmdLines.forEach((line, idx) => {
        const words = new Set(line.toLowerCase().match(/\b\w{4,}\b/g) || []);
        let score = 0;
        searchWords.forEach(w => { if (words.has(w))
            score++; });
        if (score > highStore) {
            highStore = score;
            bestMatch = idx;
        }
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
//# sourceMappingURL=extension.js.map