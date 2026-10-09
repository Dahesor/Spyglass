import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
	BinderContext,
	LocalSymbol,
	Range,
	SymbolService,
	SymbolStorage,
	UriBinderContext,
} from '../../lib/index.js'
import { mockProjectData } from '../utils.ts'

const doc = TextDocument.create('file:///test.mcfunction', 'mcfunction', 0, '')

describe('SymbolStorage ownership', () => {
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

	it('shares committed changes, indexes and events across independent contexts and branches', t => {
		const project = mockProjectData()
		const first = BinderContext.create(project, { doc })
		const second = BinderContext.create(project, { doc })
		t.assert.notEqual(first.symbols, second.symbols)
		t.assert.equal(first.symbols.storage, project.symbolStorage)
		t.assert.equal(second.symbols.storage, project.symbolStorage)
		const events: string[] = []
		const indexedDuringEvents: string[][] = []
		project.symbolStorage.on('symbolLocationCreated', ({ location }) => {
			events.push(`created:${location.contributor}`)
			indexedDuringEvents.push(
				second.symbols.getSymbolsInFile(location.uri)
					.map(symbol => symbol.identifier),
			)
		}).on('symbolLocationRemoved', ({ location }) => {
			events.push(`removed:${location.contributor}`)
		})
		const branch = first.symbols.cloneDelayed()
		branch.contributeAs('binder', () => {
			branch.query(doc, 'test', 'accepted').enter({ usage: { type: 'definition' } })
		})
		t.assert.deepEqual(second.symbols.getSymbolsInFile(doc.uri), [])
		t.assert.deepEqual(events, [])
		branch.applyDelayedEdits()
		branch.applyDelayedEdits()
		const symbol = second.symbols.lookup('test', ['accepted']).symbol!
		t.assert.deepEqual(second.symbols.getSymbolsInFile(doc.uri), [symbol])
		t.assert.deepEqual(events, ['created:binder'])
		t.assert.deepEqual(indexedDuringEvents, [['accepted']])
		second.symbols.clear({ uri: doc.uri, contributor: 'binder' })
		t.assert.equal(first.symbols.query(doc, 'test', 'accepted').symbolView, undefined)
		t.assert.deepEqual(events, ['created:binder', 'removed:binder'])
	})

	it('discards speculative writes without changing the shared table or indexes', t => {
		const storage = new SymbolStorage()
		const service = new SymbolService(storage)
		const branch = service.cloneDelayed()
		let events = 0
		storage.on('symbolCreated', () => events++)
		branch.query(doc, 'test', 'discarded').enter({ usage: { type: 'definition' } })
		t.assert.deepEqual(storage.global, {})
		t.assert.deepEqual([...storage.getPaths()], [])
		storage.trim()
		t.assert.equal(events, 0)
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
