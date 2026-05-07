import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
    
    // 1. THE "RENDER TYPST" BUTTON
    let previewCommand = vscode.commands.registerCommand('qmd2typ.preview', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith('.qmd')) return;

        const qmdDoc = editor.document;
        const qmdPath = qmdDoc.fileName;
        const typPath = qmdPath.replace('.qmd', '.typ');

        await qmdDoc.save();

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Quarto: Generating Typst bridge...",
            cancellable: false
        }, (progress) => {
            return new Promise((resolve) => {
                // Simplified command execution
                const cmd = `quarto render "${qmdPath}" --to typst`;
                
                exec(cmd, { cwd: path.dirname(qmdPath) }, async (error, stdout, stderr) => {
                    if (error) {
                        vscode.window.showErrorMessage(`Quarto Error: ${stderr}`);
                        resolve(false);
                        return;
                    }

                    // Open the .typ file normally so you can see any issues
                    const typDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(typPath));
                    await vscode.window.showTextDocument(typDoc, {
                        viewColumn: vscode.ViewColumn.One,
                        preview: false
                    });

                    // Inform the user it's ready for the Tinymist preview
                    vscode.window.setStatusBarMessage("Typst bridge updated.", 3000);
                    resolve(true);
                });
            });
        });
    });

    // 2. THE INVERSE JUMP (Clicking in Preview -> .typ -> .qmd)
    let autoSync = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (!editor) return;

        const doc = editor.document;
        if (doc.fileName.endsWith('.typ')) {
            // Tiny delay to let Tinymist finish its cursor placement
            setTimeout(async () => {
                await jumpToQmdSource(editor);
            }, 50);
        }
    });

    context.subscriptions.push(previewCommand, autoSync);
}

async function jumpToQmdSource(typEditor: vscode.TextEditor) {
    const typDoc = typEditor.document;
    const qmdPath = typDoc.fileName.replace('.typ', '.qmd');
    
    if (!fs.existsSync(qmdPath)) return;

    // Grab the line content from the .typ file
    const lineText = typDoc.lineAt(typEditor.selection.active.line).text.trim();
    if (lineText.length === 0) return;

    try {
        const qmdDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(qmdPath));
        const qmdLines = qmdDoc.getText().split(/\r?\n/);

        // Fuzzy Matching Logic
        const searchWords = new Set(lineText.toLowerCase().match(/\b\w{4,}\b/g) || []);
        let bestMatchIndex = -1;
        let highestScore = 0;

        qmdLines.forEach((line, index) => {
            const qmdWords = new Set(line.toLowerCase().match(/\b\w{4,}\b/g) || []);
            let score = 0;
            searchWords.forEach(w => { if (qmdWords.has(w)) score++; });
            
            if (score > highestScore) {
                highestScore = score;
                bestMatchIndex = index;
            }
        });

        if (bestMatchIndex !== -1 && highestScore > 0) {
            // Jump to QMD but KEEP the .typ file open in the background/tab
            const qmdEditor = await vscode.window.showTextDocument(qmdDoc, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: false
            });

            const pos = new vscode.Position(bestMatchIndex, 0);
            qmdEditor.selection = new vscode.Selection(pos, pos);
            qmdEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
    } catch (err) {
        console.error("Inverse sync failed:", err);
    }
}
