import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    let disposable = vscode.commands.registerCommand('typ2qmd.syncLine', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const currentFilePath = document.fileName;
        const currentDir = path.dirname(currentFilePath);
        const currentBaseName = path.basename(currentFilePath, path.extname(currentFilePath));

        // 1. Fetch settings
        const config = vscode.workspace.getConfiguration('typ2qmd');
        const targetExtensions = config.get<string[]>('targetExtensions') || [".qmd", ".md", ".tex", ".typ"];

        // 2. Identify the text on the current line
        const position = editor.selection.active;
        const lineText = document.lineAt(position.line).text.trim();
        
        if (lineText.length === 0) {
            vscode.window.showWarningMessage('Current line is empty.');
            return;
        }

        // 3. Find the partner file
        let targetPath = '';
        for (const ext of targetExtensions) {
            if (ext === path.extname(currentFilePath)) continue;
            const potentialPath = path.join(currentDir, currentBaseName + ext);
            if (fs.existsSync(potentialPath)) {
                targetPath = potentialPath;
                break;
            }
        } // end for loop

        if (!targetPath) {
            vscode.window.showErrorMessage(`No partner file found for ${currentBaseName}`);
            return;
        }

        try {
            // 4. Read file and find match
            const targetContent = fs.readFileSync(targetPath, 'utf-8');
            const targetLines = targetContent.split(/\r?\n/);
            const searchWords = new Set(lineText.toLowerCase().match(/\b\w{4,}\b/g) || []);
            
            let bestMatchIndex = -1;
            let highestScore = 0;

            targetLines.forEach((tLine, index) => {
                const tWords = new Set(tLine.toLowerCase().match(/\b\w{4,}\b/g) || []);
                let score = 0;
                searchWords.forEach(word => { if (tWords.has(word)) score++; });

                if (score > highestScore) {
                    highestScore = score;
                    bestMatchIndex = index;
                }
            }); // end forEach

            // 5. Navigate without opening duplicates
            if (bestMatchIndex !== -1 && highestScore > 0) {
                const targetUri = vscode.Uri.file(targetPath);
                
                // Check for an already visible editor containing this file
                let targetEditor = vscode.window.visibleTextEditors.find(
                    e => e.document.uri.fsPath === targetUri.fsPath
                );

                if (targetEditor) {
                    // Switch focus to the existing tab
                    await vscode.window.showTextDocument(targetEditor.document, targetEditor.viewColumn);
                } else {
                    // Open new tab beside the current one
                    const targetDoc = await vscode.workspace.openTextDocument(targetUri);
                    targetEditor = await vscode.window.showTextDocument(targetDoc, vscode.ViewColumn.Beside);
                }

                // Move cursor and center the screen
                const targetPosition = new vscode.Position(bestMatchIndex, 0);
                targetEditor.selection = new vscode.Selection(targetPosition, targetPosition);
                targetEditor.revealRange(
                    new vscode.Range(targetPosition, targetPosition), 
                    vscode.TextEditorRevealType.InCenter
                );
            } else {
                vscode.window.showWarningMessage('No confident match found.');
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Error: ${err}`);
        }
    }); // end registerCommand

    context.subscriptions.push(disposable);
} // end activate

export function deactivate() {}
