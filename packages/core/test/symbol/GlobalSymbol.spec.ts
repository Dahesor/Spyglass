import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type { AstNode } from '../../lib/index.js'
import { GlobalSymbol, LocalSymbol, Range, SymbolUtil } from '../../lib/index.js'

describe('GlobalSymbol', () => {
	it('separates global-only queries from combined queries and completion', t => {
		const util = new SymbolUtil({})
		const doc = TextDocument.create('file:///test.mcfunction', 'mcfunction', 0, '')
		const node: AstNode = {
			type: 'file',
			range: Range.create(0),
			locals: LocalSymbol.createTable(),
		}
		GlobalSymbol.query(util, doc, 'test', 'name').enter({
			data: { desc: 'global' },
			usage: { type: 'definition' },
		})
		LocalSymbol.queryForScope(util, { doc, node }, 1, 'test', 'name').enter({
			data: { desc: 'local' },
			usage: { type: 'definition' },
		})
		t.assert.equal(GlobalSymbol.query(util, doc, 'test', 'name').symbol?.desc, 'global')
		t.assert.equal(util.query({ doc, node }, 'test', 'name').symbol?.desc, 'local')
		t.assert.equal(
			GlobalSymbol.getVisibleSymbols(util, 'test', doc.uri)['name'],
			util.global['test']!['name'],
		)
		t.assert.equal(
			util.getScopedSymbols('test', { doc, node })['name'],
			node.locals!['test']!['name'],
		)
	})
	it('applies delayed global cleanup without clearing same-named local symbols', t => {
		const util = new SymbolUtil({})
		const doc = TextDocument.create('file:///test.mcfunction', 'mcfunction', 0, '')
		const node: AstNode = {
			type: 'file',
			range: Range.create(0),
			locals: LocalSymbol.createTable(),
		}
		GlobalSymbol.query(util, doc, 'test', 'name').enter({ usage: { type: 'definition' } })
		LocalSymbol.queryForScope(util, { doc, node }, 1, 'test', 'name').enter({
			usage: { type: 'definition' },
		})
		const delayed = util.clone()
		GlobalSymbol.buildCache(delayed)
		GlobalSymbol.clear(delayed, { uri: doc.uri })
		t.assert.notEqual(GlobalSymbol.lookup(util, 'test', ['name']).symbol, undefined)
		delayed.applyDelayedEdits()
		t.assert.equal(GlobalSymbol.lookup(util, 'test', ['name']).symbol, undefined)
		t.assert.notEqual(LocalSymbol.lookup(node, 'test', ['name'])?.symbol, undefined)
	})
})
