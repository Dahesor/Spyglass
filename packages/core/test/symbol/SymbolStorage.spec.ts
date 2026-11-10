import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
	BinderContext,
	LocalSymbol,
	Range,
	SymbolIsotopeProvider,
	SymbolIsotopeScope,
	SymbolService,
	SymbolStorage,
	UriBinderContext,
} from '../../lib/index.js'
import { mockProjectData } from '../utils.ts'

const doc = TextDocument.create('file:///test.mcfunction', 'mcfunction', 0, '')

describe('SymbolStorage ownership', () => {
	it('resolves delayed isotope writes after a parent is created', t => {
		const service = new SymbolService(new SymbolStorage())
		const branch = service.cloneDelayed()
		branch.query(doc, 'test', 'parent').enter({ usage: { type: 'definition' } })
		branch.query(doc, 'test', 'parent', 'child').enterIsotope('doc', {
			data: { scope: SymbolIsotopeScope.Public, source: SymbolIsotopeProvider.DocBlock },
			usage: { type: 'declaration' },
		})
		branch.applyDelayedEdits()
		t.assert.equal(
			service.query(doc, 'test', 'parent', 'child').symbolView?.declaration?.length,
			1,
		)
	})

	it('preserves a local write target when resolveAlias has no alias to follow', t => {
		const service = new SymbolService(new SymbolStorage())
		const table = LocalSymbol.createTable()
		service.queryInTable(table, doc, 'test', 'local').enter({ usage: { type: 'definition' } })
		service.queryInTable(table, doc, 'test', 'local').resolveAlias().enter({
			usage: { type: 'reference' },
		})
		t.assert.equal(
			service.queryInTable(table, doc, 'test', 'local').symbolView?.reference?.length,
			1,
		)
		t.assert.equal(service.lookup('test', ['local']).symbol, undefined)
	})

	it('refreshes a resolved local alias in the global destination category', t => {
		const service = new SymbolService(new SymbolStorage())
		service.query(doc, 'target', 'value').enter({ usage: { type: 'definition' } })
		const table = LocalSymbol.createTable()
		service.queryInTable(table, doc, 'alias', 'local').enter({
			data: { relations: { aliasOf: { category: 'target', path: ['value'] } } },
			usage: { type: 'definition' },
		})
		const handle = service.queryInTable(table, doc, 'alias', 'local').resolveAlias()
		handle.enter({ usage: { type: 'reference' } })
		t.assert.equal(handle.category, 'target')
		t.assert.equal(service.query(doc, 'target', 'value').symbolView?.reference?.length, 1)
		t.assert.equal(table['target'], undefined)
	})

	it('commits delayed members into the current parent after clearing and rebuilding it', t => {
		const service = new SymbolService(new SymbolStorage())
		service.query(doc, 'test', 'parent').enter({ usage: { type: 'definition' } })
		const oldParent = service.lookup('test', ['parent']).symbol!
		const branch = service.cloneDelayed()
		branch.clear({ uri: doc.uri })
		branch.query(doc, 'test', 'parent').enter({ usage: { type: 'definition' } })
		branch.query(doc, 'test', 'parent', 'child').enter({ usage: { type: 'definition' } })
		branch.applyDelayedEdits()
		const parent = service.lookup('test', ['parent']).symbol!
		const child = service.lookup('test', ['parent', 'child']).symbol
		t.assert.notEqual(parent, oldParent)
		t.assert.notEqual(child, undefined)
		t.assert.equal(child?.parentSymbol, parent)
		t.assert.equal(service.storage.getPaths(doc.uri).size, 2)
		service.clear({ uri: doc.uri })
		t.assert.equal(service.storage.getPaths().size, 0)
	})

	it('trims unused ancestors while preserving parents with live members', t => {
		const storage = new SymbolStorage()
		const service = new SymbolService(storage)
		service.query(doc, 'test', 'parent').enter({})
		service.query(doc, 'test', 'parent', 'unused').enter({})
		service.query(doc, 'test', 'parent', 'live').enter({ usage: { type: 'definition' } })
		storage.trim()
		t.assert.equal(service.lookup('test', ['parent', 'unused']).symbol, undefined)
		t.assert.notEqual(service.lookup('test', ['parent', 'live']).symbol, undefined)
		t.assert.equal(storage.getPaths(doc.uri).size, 1)
		service.clear({ uri: doc.uri })
		t.assert.equal(service.lookup('test', ['parent']).symbol, undefined)
		t.assert.equal(storage.getPaths().size, 0)
	})

	it('prunes historical paths while retaining other locations and contributors', t => {
		const storage = new SymbolStorage()
		const service = new SymbolService(storage)
		for (const contributor of ['binder', 'checker']) {
			service.contributeAs(contributor, () => {
				service.query(doc, 'test', 'shared').enter({ usage: { type: 'definition' } })
				service.query(doc, 'test', 'shared').enter({ usage: { type: 'reference' } })
			})
		}
		storage.rebuildIndex()
		service.clear({
			uri: doc.uri,
			contributor: 'binder',
			predicate: data => data.type === 'reference',
		})
		t.assert.equal(storage.getPaths(doc.uri, 'binder').size, 1)
		service.clear({ uri: doc.uri, contributor: 'binder' })
		t.assert.equal(storage.getPaths(doc.uri, 'binder').size, 0)
		t.assert.equal(storage.getPaths(doc.uri, 'checker').size, 1)
		service.clear({ contributor: 'checker' })
		t.assert.equal(storage.getPaths().size, 0)
		for (let i = 0; i < 100; i++) {
			service.query(doc, 'test', `old${i}`).enter({ usage: { type: 'reference' } })
			service.clear({ uri: doc.uri })
		}
		t.assert.equal(storage.getPaths().size, 0)
	})

	it('does not conflate an absent contributor with the string undefined', t => {
		const storage = new SymbolStorage()
		const service = new SymbolService(storage)
		service.query(doc, 'test', 'implicit').enter({ usage: { type: 'reference' } })
		service.contributeAs('undefined', () => {
			service.query(doc, 'test', 'explicit').enter({ usage: { type: 'reference' } })
		})
		t.assert.equal(storage.getPaths(doc.uri, 'undefined').size, 1)
		service.clear({ contributor: 'undefined' })
		t.assert.equal(storage.getPaths(doc.uri, 'undefined').size, 0)
		t.assert.equal(storage.getPaths(doc.uri).size, 1)
	})

	it('restores delay mode after a commit throws', t => {
		const branch = new SymbolService(new SymbolStorage()).cloneDelayed()
		branch.runOrDefer(() => {
			throw new Error('Commit failed')
		})
		t.assert.throws(() => branch.applyDelayedEdits(), /Commit failed/)
		branch.query(doc, 'test', 'next').enter({ usage: { type: 'definition' } })
		t.assert.equal(branch.lookup('test', ['next']).symbol, undefined)
		branch.applyDelayedEdits()
		t.assert.notEqual(branch.lookup('test', ['next']).symbol, undefined)
		branch.query(doc, 'test', 'later').enter({ usage: { type: 'definition' } })
		t.assert.equal(branch.lookup('test', ['later']).symbol, undefined)
	})

	it('looks up an empty URI exactly without returning symbols from other files', t => {
		const service = new SymbolService(new SymbolStorage())
		service.query('', 'test', 'empty').enter({ usage: { type: 'definition' } })
		service.query(doc, 'test', 'file').enter({ usage: { type: 'definition' } })
		t.assert.deepEqual(
			service.getSymbolsInFile('').map(symbol => symbol.identifier),
			['empty'],
		)
	})

	it('shares committed changes and indexes across independent contexts and branches', t => {
		const project = mockProjectData()
		const first = BinderContext.create(project, { doc })
		const second = BinderContext.create(project, { doc })
		t.assert.notEqual(first.symbols, second.symbols)
		t.assert.equal(first.symbols.storage, project.symbolStorage)
		t.assert.equal(second.symbols.storage, project.symbolStorage)
		const branch = first.symbols.cloneDelayed()
		branch.contributeAs('binder', () => {
			branch.query(doc, 'test', 'accepted').enter({ usage: { type: 'definition' } })
		})
		t.assert.deepEqual(second.symbols.getSymbolsInFile(doc.uri), [])
		branch.applyDelayedEdits()
		branch.applyDelayedEdits()
		const symbol = second.symbols.lookup('test', ['accepted']).symbol!
		t.assert.deepEqual(second.symbols.getSymbolsInFile(doc.uri), [symbol])
		t.assert.equal(symbol.scopes?.public?.[0]?.usages.definition?.length, 1)
		t.assert.equal(project.symbolStorage.getPaths(doc.uri, 'binder').size, 1)
		second.symbols.clear({ uri: doc.uri, contributor: 'binder' })
		t.assert.equal(first.symbols.query(doc, 'test', 'accepted').symbolView, undefined)
		t.assert.equal(project.symbolStorage.getPaths().size, 0)
	})

	it('discards speculative writes without changing the shared table or indexes', t => {
		const storage = new SymbolStorage()
		const service = new SymbolService(storage)
		const branch = service.cloneDelayed()
		branch.query(doc, 'test', 'discarded').enter({ usage: { type: 'definition' } })
		t.assert.deepEqual(storage.global, {})
		t.assert.deepEqual([...storage.getPaths()], [])
		storage.trim()
		t.assert.deepEqual(storage.global, {})
	})

	it('clears preexisting global symbols through a branch without rebuilding its index', t => {
		const storage = new SymbolStorage()
		const service = new SymbolService(storage)
		const local = { type: 'file', range: Range.create(0), locals: LocalSymbol.createTable() }
		service.query(doc, 'test', 'same').enter({ usage: { type: 'definition' } })
		LocalSymbol.queryInsideScope(service, { doc, node: local }, 1, 'test', 'same').enter({
			usage: { type: 'definition' },
		})
		const branch = service.cloneDelayed()
		branch.clear({ uri: doc.uri })
		t.assert.equal(service.getSymbolsInFile(doc.uri).length, 1)
		branch.applyDelayedEdits()
		t.assert.deepEqual(service.getSymbolsInFile(doc.uri), [])
		t.assert.notEqual(local.locals['test']!['same'], undefined)
	})

	it('does not enumerate symbols or rebuild indexes when creating contexts and clones', t => {
		let scans = 0
		const table = new Proxy({}, {
			ownKeys(target) {
				scans++
				return Reflect.ownKeys(target)
			},
		})
		const storage = new SymbolStorage(table)
		const initialScans = scans
		const project = mockProjectData({ symbolStorage: storage })
		for (let i = 0; i < 100; i++) {
			const ctx = BinderContext.create(project, { doc })
			t.assert.equal(ctx.symbols.cloneDelayed().storage, storage)
			t.assert.equal(UriBinderContext.create(project).symbols.storage, storage)
		}
		t.assert.equal(scans, initialScans)
	})

	it('isolates contributors during overlapping asynchronous context work', async t => {
		const project = mockProjectData()
		const first = BinderContext.create(project, { doc }).symbols
		const second = BinderContext.create(project, { doc }).symbols
		let release!: () => void
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		const pending = first.contributeAsAsync('first', async () => {
			await gate
			first.query(doc, 'test', 'first').enter({ usage: { type: 'definition' } })
		})
		await second.contributeAsAsync('second', async () => {
			second.query(doc, 'test', 'second').enter({ usage: { type: 'definition' } })
			release()
			await pending
		})
		first.query(doc, 'test', 'outside').enter({ usage: { type: 'definition' } })
		t.assert.equal(
			first.query(doc, 'test', 'first').symbolView?.definition?.[0].contributor,
			'first',
		)
		t.assert.equal(
			first.query(doc, 'test', 'second').symbolView?.definition?.[0].contributor,
			'second',
		)
		t.assert.equal(
			first.query(doc, 'test', 'outside').symbolView?.definition?.[0].contributor,
			undefined,
		)
	})
})
