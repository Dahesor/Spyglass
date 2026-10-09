import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
	LocalSymbol,
	Range,
	StateProxy,
	SymbolEnterType,
	SymbolImport,
	SymbolService,
	SymbolStorage,
	SymbolTable,
	SymbolUtil,
} from '../../lib/index.js'
import type { AstNode } from '../../lib/index.js'

describe('GlobalSymbol', () => {
	it('recognizes local tables and newly created maps through different state proxies', t => {
		const util = new SymbolService(new SymbolStorage({}))
		const doc = TextDocument.create('file:///test.mcfunction', 'mcfunction', 0, '')
		const node: AstNode = { type: 'file', range: Range.create(0) }
		node.locals = LocalSymbol.createTable()
		const proxy = StateProxy.create(node)
		LocalSymbol.queryInsideScope(util, { doc, node: proxy }, 1, 'function', 'demo:test').enter({
			data: { data: { target: 'demo:target' } },
			usage: { type: 'declaration' },
		})
		const secondProxy = StateProxy.create(node)
		t.assert.equal(LocalSymbol.isTable(secondProxy.locals!), true)
		t.assert.equal(LocalSymbol.isMap(secondProxy.locals!.function), true)
		util.query({ doc, node: secondProxy }, 'function', 'demo:test').enter({
			usage: { type: 'reference' },
		}, SymbolEnterType.InFileSymbol)
		const symbol = node.locals!.function!['demo:test']
		t.assert.equal(LocalSymbol.is(symbol), true)
		t.assert.equal(symbol.facets, undefined)
		t.assert.deepEqual(symbol.data, { target: 'demo:target' })
		t.assert.equal(SymbolUtil.viewFromContext(symbol, doc.uri)?.reference?.length, 1)
		t.assert.equal(util.storage.global.function, undefined)
	})
	it('visits each location once when clearing a symbol shared across files and contributors', t => {
		const service = new SymbolService(new SymbolStorage({}))
		for (const contributor of ['binder', 'checker']) {
			service.contributeAs(contributor, () => {
				for (const uri of ['file:///first', 'file:///second']) {
					service.query(uri, 'test', 'shared').enter({ usage: { type: 'reference' } })
				}
			})
		}
		let visits = 0
		service.clear({
			predicate: () => {
				visits++
				return false
			},
		})
		t.assert.equal(visits, 4)
		t.assert.equal(service.storage.global['test']!['shared'].facets!.global!.reference!.length, 4)
	})
	it('preserves unrelated usage arrays when removing a dependency', t => {
		const util = new SymbolService(new SymbolStorage(SymbolTable.link({ test: { empty: {} } })))
		util.query('file:///local', 'test', 'local').enter({ usage: { type: 'definition' } })
		const facet = util.storage.global['test']!['local'].facets!.global!
		const definitions = facet.definition
		SymbolImport.removeDependencySymbols(util, 'other-package')
		t.assert.equal(facet.definition, definitions)
		t.assert.equal(util.storage.global['test']!['empty'], undefined)
	})
	it('does not revisit live trim candidates on subsequent unrelated clears', t => {
		const service = new SymbolService(new SymbolStorage({}))
		service.contributeAs('binder', () => {
			service.query('file:///first', 'test', 'shared').enter({ usage: { type: 'definition' } })
			service.query('file:///second', 'test', 'shared').enter({ usage: { type: 'definition' } })
		})
		service.clear({ uri: 'file:///first' })
		const symbol = service.storage.global['test']!['shared']
		let checks = 0
		Object.defineProperty(symbol, 'members', {
			get() {
				checks++
				return undefined
			},
		})
		service.clear({ uri: 'file:///unrelated' })
		t.assert.equal(checks, 0)
		service.clear({ uri: 'file:///second' })
		t.assert.equal(service.storage.global['test']!['shared'], undefined)
	})
	it('does not reconcile unaffected usages when a shared isotope survives cleanup', t => {
		const service = new SymbolService(new SymbolStorage({}))
		service.contributeAs('binder', () => {
			service.query('file:///first', 'test', 'shared').enter({ usage: { type: 'definition' } })
			service.query('file:///second', 'test', 'shared').enter({
				usage: { type: 'reference', originalUsageType: 'reference' },
			})
		})
		const facet = service.storage.global['test']!['shared'].facets!.global!
		const reference = facet.reference![0]
		const removed: unknown[] = []
		service.storage.on('symbolLocationRemoved', ({ location }) => removed.push(location))
		service.clear({ uri: 'file:///second' })
		t.assert.deepEqual(removed, [reference])
		const definitions = facet.definition
		service.clear({ uri: 'file:///second' })
		t.assert.equal(facet.definition, definitions)
	})
})
