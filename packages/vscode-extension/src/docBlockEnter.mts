import * as vsc from 'vscode'

/** Handles the behavior of pressing Enter inside a doc block
 * This routes the Enter key action through this function
 */
export function registerDocBlockEnter(): vsc.Disposable {
	// Since it triggers ever time enter is pressed, performance is critical here
	// With some benchmarking, this re-route increases delay by a magnitude of ~0.1ms
	return vsc.commands.registerCommand('spyglassmc.docBlockEnter', async () => {
		const editor = vsc.window.activeTextEditor
		if (editor?.document.languageId === 'mcfunction' && editor.selections.length === 1) {
			const selection = editor.selection
			const line = selection.active.line
			const edit = selection.isEmpty
				? docBlockEnter(i => editor.document.lineAt(i).text, line, selection.active.character)
				: undefined
			if (edit) {
				const range = new vsc.Range(line, edit.start, line, selection.active.character)
				if (await editor.edit(builder => builder.replace(range, edit.text))) {
					const position = edit.text.startsWith('\n')
						? new vsc.Position(line + 1, edit.text.length - 1)
						: new vsc.Position(line, edit.start + edit.text.length)
					editor.selection = new vsc.Selection(position, position)
				}
				return
			}
		}
		await vsc.commands.executeCommand('default:type', { text: '\n' })
	})
}

function docBlockEnter(lineAt: (line: number) => string, line: number, character: number) {
	const current = lineAt(line)
	const before = current.slice(0, character)
	const match = /^([\t ]*)#(>?)([\t ]*)/.exec(before)
	// immediately stops if the current line does not start with `#`
	if (!match) {
		return undefined
	}
	let inDocBlock = false
	// Look upwards to find a `#>`
	for (let i = line; i >= 0; i--) {
		const text = i === line ? current : lineAt(i)
		if (/^[\t ]*#>/.test(text)) {
			inDocBlock = true
			break
		}
		if (!/^[\t ]*#/.test(text)) {
			break
		}
	}
	if (!inDocBlock) {
		return undefined
	}
	const [, leading, marker, spacing] = match
	if (!marker && /^[\t ]*#[\t ]*$/.test(current) && character === current.length) {
		return {
			start: leading.length,
			text: spacing.length > 1 || spacing.includes('\t') ? '# ' : '',
		}
	}
	return { start: character, text: `\n${leading}#${marker ? ' ' : spacing || ' '}` }
}
