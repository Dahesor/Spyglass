import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type { AstNode } from '../../lib/index.js'
import {
	GlobalSymbol,
	LocalSymbol,
	Range,
	StateProxy,
	SymbolTable,
	SymbolUtil,
} from '../../lib/index.js'

describe('GlobalSymbol', () => {
	it('recognizes local tables and newly created maps through different state proxies', t => {
		const util = new SymbolUtil({})
		const doc = TextDocument.create('file:///test.mcfunction', 'mcfunction', 0, '')
		const node: AstNode = { type: 'file', range: Range.create(0) }
		LocalSymbol.initialize(node)
		const proxy = StateProxy.create(node)
		LocalSymbol.queryForScope(util, { doc, node: proxy }, 1, 'function', 'demo:test').enter({
			data: { data: { target: 'demo:target' } },
			usage: { type: 'declaration' },
		})
		const secondProxy = StateProxy.create(node)
		t.assert.equal(LocalSymbol.isTable(secondProxy.locals!), true)
		t.assert.equal(LocalSymbol.isMap(secondProxy.locals!.function), true)
		util.query({ doc, node: secondProxy }, 'function', 'demo:test').enterCommand({
			usage: { type: 'reference' },
		})
		const symbol = node.locals!.function!['demo:test']
		t.assert.equal(LocalSymbol.is(symbol), true)
		t.assert.equal(symbol.facets, undefined)
		t.assert.deepEqual(symbol.data, { target: 'demo:target' })
		t.assert.equal(SymbolUtil.viewFromContext(symbol, doc.uri)?.reference?.length, 1)
		t.assert.equal(util.global.function, undefined)
	})
	it('visits each location once when clearing a symbol shared across files and contributors', t => {
		const util = new SymbolUtil({})
		for (const contributor of ['binder', 'checker']) {
			util.contributeAs(contributor, () => {
				for (const uri of ['file:///first', 'file:///second']) {
					util.query(uri, 'test', 'shared').enter({ usage: { type: 'reference' } })
				}
			})
		}
		let visits = 0
		GlobalSymbol.clear(util, {
			predicate: () => {
				visits++
				return false
			},
		})
		t.assert.equal(visits, 4)
		t.assert.equal(util.global['test']!['shared'].facets!.global!.reference!.length, 4)
	})
	it('preserves unrelated usage arrays when removing a dependency', t => {
		const util = new SymbolUtil(SymbolTable.link({ test: { empty: {} } }))
		util.query('file:///local', 'test', 'local').enter({ usage: { type: 'definition' } })
		const facet = util.global['test']!['local'].facets!.global!
		const definitions = facet.definition
		GlobalSymbol.removeDependencySymbols(util, 'other-package')
		t.assert.equal(facet.definition, definitions)
		t.assert.equal(util.global['test']!['empty'], undefined)
	})
	it('does not revisit live trim candidates on subsequent unrelated clears', t => {
		const util = new SymbolUtil({})
		util.contributeAs('binder', () => {
			util.query('file:///first', 'test', 'shared').enter({ usage: { type: 'definition' } })
			util.query('file:///second', 'test', 'shared').enter({ usage: { type: 'definition' } })
		})
		GlobalSymbol.clear(util, { uri: 'file:///first' })
		const symbol = util.global['test']!['shared']
		let checks = 0
		Object.defineProperty(symbol, 'members', {
			get() {
				checks++
				return undefined
			},
		})
		GlobalSymbol.clear(util, { uri: 'file:///unrelated' })
		t.assert.equal(checks, 0)
		GlobalSymbol.clear(util, { uri: 'file:///second' })
		t.assert.equal(util.global['test']!['shared'], undefined)
	})
	it('does not reconcile unaffected usages when a shared isotope survives cleanup', t => {
		const util = new SymbolUtil({})
		util.contributeAs('binder', () => {
			util.query('file:///first', 'test', 'shared').enter({ usage: { type: 'definition' } })
			util.query('file:///second', 'test', 'shared').enter({
				usage: { type: 'reference', originalUsageType: 'reference' },
			})
		})
		const facet = util.global['test']!['shared'].facets!.global!
		const reference = facet.reference![0]
		const removed: unknown[] = []
		util.on('symbolLocationRemoved', ({ location }) => removed.push(location))
		GlobalSymbol.clear(util, { uri: 'file:///second' })
		t.assert.deepEqual(removed, [reference])
		const definitions = facet.definition
		GlobalSymbol.clear(util, { uri: 'file:///second' })
		t.assert.equal(facet.definition, definitions)
	})
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
