import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
	LocalSymbol,
	Range,
	SymbolIsotopeScope,
	SymbolService,
	SymbolStorage,
	SymbolUtil,
} from '../../lib/index.js'
import type { AstNode, LookupResult } from '../../lib/index.js'

function setup() {
	const service = new SymbolService(new SymbolStorage({}))
	const doc = TextDocument.create('file:///test.mcfunction', 'mcfunction', 0, '')
	const file: AstNode = { type: 'file', range: Range.create(0), locals: LocalSymbol.createTable() }
	const block: AstNode = {
		type: 'block',
		range: Range.create(0),
		parent: file,
		locals: LocalSymbol.createTable(),
	}
	const child: AstNode = { type: 'symbol', range: Range.create(0), parent: block }
	file.children = [block]
	block.children = [child]
	return { util: service, doc, file, block, child }
}

describe('LocalSymbol', () => {
	it('keeps same-named global, file and block symbols independent', t => {
		const { util: service, doc, file, block, child } = setup()
		service.query(doc, 'test', 'name').enter({
			data: { desc: 'global' },
			usage: { type: 'definition' },
		})
		LocalSymbol.queryInsideScope(service, { doc, node: child }, 1, 'test', 'name')
			.enter({ data: { desc: 'file' }, usage: { type: 'definition' } })
		LocalSymbol.queryInsideScope(service, { doc, node: child }, 0, 'test', 'name')
			.enter({ data: { desc: 'block' }, usage: { type: 'definition' } })
		t.assert.equal(service.query(doc, 'test', 'name').symbolView?.desc, 'global')
		t.assert.equal(
			service.query({ doc, node: file }, 'test', 'name').symbolView?.desc,
			'file',
		)
		t.assert.equal(
			service.query({ doc, node: child }, 'test', 'name').symbolView?.desc,
			'block',
		)
		t.assert.notEqual(file.locals!['test']!['name'], block.locals!['test']!['name'])
		t.assert.equal(
			service.getScopedSymbols('test', { doc, node: child })['name'],
			block.locals!['test']!['name'],
		)
	})
	it('falls back to global lookup and does not expose locals from another file', t => {
		const { util: service, doc, child } = setup()
		service.query(doc, 'test', 'global').enter({ usage: { type: 'definition' } })
		LocalSymbol.queryInsideScope(service, { doc, node: child }, 1, 'test', 'local')
			.enter({ usage: { type: 'definition' } })
		t.assert.equal(
			service.query({ doc, node: child }, 'test', 'global').heyGimmeDaSymbol(),
			service.storage.global['test']!['global'],
		)
		t.assert.equal(service.lookup('test', ['local']).symbol, undefined)
		t.assert.equal(
			service.query({ doc, node: setup().child }, 'test', 'local').symbolView,
			undefined,
		)
	})
	it('clears local contributions separately from global contributions', t => {
		const { util: service, doc, file, child } = setup()
		service.query(doc, 'test', 'name').enter({ usage: { type: 'definition' } })
		LocalSymbol.queryInsideScope(service, { doc, node: child }, 1, 'test', 'name')
			.enter({ usage: { type: 'definition' } })
		service.clear({ uri: doc.uri })
		t.assert.equal(service.lookup('test', ['name']).symbol, undefined)
		t.assert.notEqual(lookup(child, 'test', ['name'])?.symbol, undefined)
		service.query(doc, 'test', 'name').enter({ usage: { type: 'definition' } })
		LocalSymbol.clear(service, file, { uri: doc.uri })
		t.assert.equal(lookup(child, 'test', ['name']), undefined)
		t.assert.notEqual(service.lookup('test', ['name']).symbol, undefined)
	})
	it('keeps delayed local and member writes in the selected local table', t => {
		const { util, doc, file, child } = setup()
		const delayed = util.cloneDelayed()
		LocalSymbol.queryInsideScope(delayed, { doc, node: child }, 1, 'mcdoc', 'Type')
			.enter({
				data: { desc: 'local type' },
				usage: { type: 'definition' },
			})
		t.assert.equal(file.locals!.mcdoc?.['Type'], undefined)
		delayed.applyDelayedEdits()
		util.query({ doc, node: child }, 'mcdoc', 'Type').member(
			'member',
			query =>
				query.enter({
					data: { desc: 'local member' },
					usage: { type: 'definition' },
				}),
		)
		t.assert.notEqual(file.locals!.mcdoc!['Type'].members?.['member'], undefined)
		const symbol = file.locals!.mcdoc!['Type']
		t.assert.equal(LocalSymbol.is(symbol), true)
		if (!LocalSymbol.is(symbol)) {
			throw new Error('Expected local symbol')
		}
		t.assert.equal(symbol.facets, undefined)
		t.assert.equal(symbol.desc, 'local type')
		t.assert.equal(symbol.definition?.length, 1)
		t.assert.equal(symbol.definition?.[0].isotopeIdentifier, undefined)
		t.assert.equal(util.storage.global.mcdoc, undefined)
	})
	it('rejects isotope writes to a local table', t => {
		const { util, doc, file, child } = setup()
		t.assert.throws(() =>
			LocalSymbol.queryInsideScope(util, { doc, node: child }, 1, 'test', 'name')
				.enterIsotope('regular', { data: { scope: SymbolIsotopeScope.Global, source: 3 } })
		)
		t.assert.equal(file.locals!['test']?.['name'], undefined)
	})
	it('delays local clearing without losing queued cleanup', t => {
		const { util, doc, file, child } = setup()
		LocalSymbol.queryInsideScope(util, { doc, node: child }, 1, 'test', 'name')
			.enter({ usage: { type: 'definition' } })
		const delayed = util.cloneDelayed()
		LocalSymbol.clear(delayed, file, { uri: doc.uri })
		t.assert.notEqual(lookup(child, 'test', ['name']), undefined)
		delayed.applyDelayedEdits()
		t.assert.equal(lookup(child, 'test', ['name']), undefined)
	})
	it('walks local tables to the root and through child scopes', t => {
		const { file, block, child } = setup()
		t.assert.deepEqual([...LocalSymbol.getLocalsToRoot(child)], [block.locals, file.locals])
		t.assert.deepEqual([...LocalSymbol.getLocalsToLeaves(file)], [file.locals, block.locals])
		t.assert.throws(() => LocalSymbol.findTable({ type: 'symbol', range: Range.create(0) }, 1))
	})
})

function lookup(
	node: AstNode,
	category: string,
	path: readonly string[],
): LookupResult | undefined {
	for (const table of LocalSymbol.getLocalsToRoot(node)) {
		const result = SymbolUtil.lookupInTable(table, category, path)
		if (result.symbol) {
			return result
		}
	}
	return undefined
}
