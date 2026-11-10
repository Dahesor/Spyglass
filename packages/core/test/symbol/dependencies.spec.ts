import {
	SymbolImport,
	SymbolIsotopeProvider as Provider,
	SymbolIsotopeScope as Scope,
	SymbolService,
	SymbolStorage,
	SymbolTable,
	SymbolUtil,
} from '@spyglassmc/core'
import { describe, it } from 'node:test'
import { mockResourceLocation } from '../utils.ts'

const inside = 'file:///project/private/use.mcfunction'
const outside = 'file:///project/use.mcfunction'
function dependency() {
	const symbols = new SymbolService(new SymbolStorage({}))
	symbols.query('file:///dependency/shared.mcfunction', 'function', 'shared')
		.enter({
			usage: { type: 'definition', fromFile: true },
		})
	return symbols.storage.global
}
function declarePrivate(symbols: SymbolService) {
	symbols.query('file:///project/private/doc.mcfunction', 'function', 'shared').enterIsotope(
		'private-doc',
		{
			data: {
				source: Provider.DocBlock,
				scope: Scope.Private,
				visibleWithin: [{ glob: 'file:///project/private/**' }],
				desc: 'local private',
			},
			usage: { type: 'declaration', fromDocDeclaration: true },
		},
	)
}

describe('dependency symbol exports', () => {
	it('queues dependency imports and removals in order without publishing speculative writes', t => {
		const symbols = new SymbolService(new SymbolStorage({}))
		const branch = symbols.cloneDelayed()
		SymbolImport.mergeDependencySymbols(
			branch,
			SymbolTable.getDependencyExports(dependency(), 'first'),
		)
		SymbolImport.removeDependencySymbols(branch, 'first', false)
		SymbolImport.mergeDependencySymbols(
			branch,
			SymbolTable.getDependencyExports(dependency(), 'second'),
		)
		t.assert.deepEqual(symbols.storage.global, {})
		t.assert.equal(symbols.storage.getPaths().size, 0)
		branch.applyDelayedEdits()
		branch.applyDelayedEdits()
		const symbol = symbols.lookup('function', ['shared']).symbol!
		t.assert.equal(symbol.scopes?.public?.length, 1)
		t.assert.equal(symbol.scopes?.public?.[0].providerName, 'second')
		t.assert.equal(symbol.scopes?.public?.[0].usages.definition?.length, 1)
		SymbolImport.removeDependencySymbols(symbols, 'second')
		t.assert.equal(symbols.lookup('function', ['shared']).symbol, undefined)
		t.assert.equal(symbols.storage.getPaths().size, 0)
	})
	for (const shouldTrim of [false, true]) {
		it(`defers dependency removal and index updates together (trim: ${shouldTrim})`, t => {
			const symbols = new SymbolService(new SymbolStorage({}))
			SymbolImport.mergeDependencySymbols(
				symbols,
				SymbolTable.getDependencyExports(dependency(), 'package'),
			)
			const before = SymbolTable.serialize(symbols.storage.global)
			const paths = symbols.storage.getPaths()
			const branch = symbols.cloneDelayed()
			SymbolImport.removeDependencySymbols(branch, 'package', shouldTrim)
			t.assert.equal(SymbolTable.serialize(symbols.storage.global), before)
			t.assert.deepEqual(symbols.storage.getPaths(), paths)
			branch.applyDelayedEdits()
			t.assert.equal(symbols.storage.getPaths().size, 0)
			t.assert.equal(
				symbols.lookup('function', ['shared']).symbol === undefined,
				shouldTrim,
			)
			symbols.storage.trim()
			t.assert.equal(symbols.lookup('function', ['shared']).symbol, undefined)
		})
	}
	it('defers file replacement, provider migration and trimming until commit', t => {
		const symbols = new SymbolService(new SymbolStorage({}))
		const uri = 'file:///dependency/shared.mcfunction'
		SymbolImport.mergeDependencySymbols(
			symbols,
			SymbolTable.getDependencyExports(dependency(), 'before'),
		)
		symbols.query(outside, 'function', 'shared').enter({ usage: { type: 'reference' } })
		const before = SymbolTable.serialize(symbols.storage.global)
		const paths = symbols.storage.getPaths()
		const branch = symbols.cloneDelayed()
		SymbolImport.replaceDependencyFile(
			branch,
			'before',
			'after',
			uri,
			SymbolTable.getDependencyExports(dependency(), 'after'),
		)
		SymbolImport.replaceDependencyFile(branch, 'after', 'removed', uri, {})
		t.assert.equal(SymbolTable.serialize(symbols.storage.global), before)
		t.assert.deepEqual(symbols.storage.getPaths(), paths)
		branch.applyDelayedEdits()
		t.assert.equal(symbols.lookup('function', ['shared']).symbol, undefined)
		t.assert.equal(symbols.storage.getPaths().size, 0)
	})

	it('replaces only one file while preserving sibling declarations and consumer usages', t => {
		const uri = 'file:///dependency/doc.mcfunction'
		const sibling = 'file:///dependency/sibling.mcfunction'
		const source = new SymbolService(new SymbolStorage({}))
		const declare = (symbols: SymbolService, text: string) =>
			symbols.query(uri, 'test', 'shared').enter({
				data: { desc: text },
				usage: { type: 'declaration' },
			})
		declare(source, 'before')
		source.query(sibling, 'test', 'shared').enter({ usage: { type: 'reference' } })
		source.query(sibling, 'test', 'untouched').enter({ usage: { type: 'definition' } })
		const symbols = new SymbolService(new SymbolStorage({}))
		SymbolImport.mergeDependencySymbols(
			symbols,
			SymbolTable.getDependencyExports(source.storage.global, 'before'),
		)
		symbols.query(outside, 'test', 'shared').enter({ usage: { type: 'reference' } })
		const shared = symbols.lookup('test', ['shared']).symbol!
		const untouched = symbols.lookup('test', ['untouched']).symbol!
		const edited = new SymbolService(new SymbolStorage({}))
		declare(edited, 'after')
		SymbolImport.replaceDependencyFile(
			symbols,
			'before',
			'after',
			uri,
			SymbolTable.getDependencyExports(edited.storage.global, 'after'),
		)
		t.assert.equal(symbols.lookup('test', ['shared']).symbol, shared)
		t.assert.equal(symbols.lookup('test', ['untouched']).symbol, untouched)
		t.assert.equal(SymbolUtil.viewFromContext(shared, outside)?.desc, 'after')
		t.assert.equal(shared.scopes?.public?.[0]?.usages.declaration?.length, 1)
		t.assert.deepEqual(
			shared.scopes?.public?.[0]?.usages.reference?.map(location => location.uri).sort(),
			[sibling, outside].sort(),
		)
		t.assert.equal(untouched.scopes?.public?.[0]?.usages.definition?.[0].uri, sibling)
		t.assert.equal(untouched.scopes?.public?.[0].providerName, 'after')
		SymbolImport.replaceDependencyFile(symbols, 'after', 'removed', uri, {})
		t.assert.equal(symbols.lookup('test', ['shared']).symbol, undefined)
		t.assert.equal(symbols.storage.getPaths(outside).size, 0)
		t.assert.equal(symbols.storage.getPaths(sibling).size, 1)
		t.assert.equal(untouched.scopes?.public?.[0]?.usages.definition?.[0].uri, sibling)
	})
	it('deeply isolates exported metadata, members and locations from the source', t => {
		const source = new SymbolService(new SymbolStorage({}))
		const query = source.query('file:///dependency/doc', 'function', 'parent')
		query.enter({ data: { data: { nested: ['original'] } }, usage: { type: 'definition' } })
		query.member('child', member => member.enter({ usage: { type: 'definition' } }))
		const before = SymbolTable.serialize(source.storage.global)
		const exported = SymbolTable.getDependencyExports(source.storage.global, 'package')
		const parent = exported.function!['parent']
		const facet = parent.scopes!.public!
		;(facet[0].data as { nested: string[] }).nested.push('changed')
		facet[0].usages.definition![0].uri = 'file:///changed'
		parent.members!['child'].scopes!.public![0].usages.definition![0].uri =
			'file:///changed-child'
		t.assert.equal(parent.members!['child'].parentSymbol, parent)
		t.assert.equal(SymbolTable.serialize(source.storage.global), before)
	})
	it('does not relocate imported command implementations into a local private doc', t => {
		const source = new SymbolService(new SymbolStorage({}))
		source.query('file:///dependency/command.mcfunction', 'function', 'shared').enter({
			usage: { type: 'implementation', followDocScope: true },
		})
		const symbols = new SymbolService(new SymbolStorage({}))
		SymbolImport.mergeDependencySymbols(
			symbols,
			SymbolTable.getDependencyExports(source.storage.global, 'package'),
		)
		declarePrivate(symbols)
		const raw = symbols.storage.global.function!['shared']
		t.assert.equal(SymbolUtil.viewFromContext(raw, inside)?.implementation, undefined)
		t.assert.equal(
			SymbolUtil.viewFromContext(raw, outside)?.implementation?.[0].uri,
			'file:///dependency/command.mcfunction',
		)
	})
	for (const importFirst of [true, false]) {
		it(`keeps foreign file definitions independent of local private docs (import first: ${importFirst})`, t => {
			const symbols = new SymbolService(new SymbolStorage({}))
			const exported = SymbolTable.getDependencyExports(dependency(), 'package')
			if (importFirst) {
				SymbolImport.mergeDependencySymbols(symbols, exported)
				declarePrivate(symbols)
			} else {
				declarePrivate(symbols)
				SymbolImport.mergeDependencySymbols(symbols, exported)
			}
			const raw = symbols.storage.global.function!['shared']
			t.assert.equal(SymbolUtil.viewFromContext(raw, inside)?.desc, 'local private')
			t.assert.equal(SymbolUtil.viewFromContext(raw, inside)?.implementation, undefined)
			t.assert.equal(
				SymbolUtil.viewFromContext(raw, outside)?.definition?.[0].uri,
				'file:///dependency/shared.mcfunction',
			)
			SymbolImport.removeDependencySymbols(symbols, 'package')
			t.assert.equal(SymbolUtil.viewFromContext(raw, inside)?.desc, 'local private')
			t.assert.equal(SymbolUtil.viewFromContext(raw, outside), undefined)
			SymbolImport.mergeDependencySymbols(symbols, exported)
			symbols.clear({ uri: 'file:///project/private/doc.mcfunction' })
			t.assert.equal(
				SymbolUtil.viewFromContext(raw, inside)?.definition?.[0].uri,
				'file:///dependency/shared.mcfunction',
			)
		})
	}
	it('namespaces imported Global metadata by package and removes only that package usages', t => {
		const symbols = new SymbolService(new SymbolStorage({}))
		const source = dependency()
		SymbolImport.mergeDependencySymbols(
			symbols,
			SymbolTable.getDependencyExports(source, 'first'),
		)
		SymbolImport.mergeDependencySymbols(
			symbols,
			SymbolTable.getDependencyExports(source, 'second'),
		)
		const raw = symbols.storage.global.function!['shared']
		t.assert.equal(raw.scopes?.public?.length, 2)
		t.assert.equal(raw.scopes?.public?.[0]?.usages.definition?.length, 2)
		t.assert.equal(raw.scopes?.internal, undefined)
		SymbolImport.removeDependencySymbols(symbols, 'first')
		t.assert.equal(raw.scopes?.public?.[0].providerName, 'second')
		t.assert.equal(raw.scopes?.public?.[0]?.usages.definition?.length, 1)
		SymbolImport.removeDependencySymbols(symbols, 'second')
		t.assert.equal(symbols.storage.global.function!['shared'], undefined)
	})
	it('exports Global and Protected scopes, excluding Project, Private, Local and Imported', t => {
		const source = new SymbolService(new SymbolStorage({}))
		for (
			const [name, scope] of [
				['public', Scope.Public],
				['internal', Scope.Internal],
				['private', Scope.Private],
				['namespace', Scope.Protected],
				['local', Scope.Local],
			] as const
		) {
			source.query('file:///dependency/doc', 'function', name).enterIsotope(name, {
				data: {
					source: Provider.Regular,
					scope,
					visibleWithin: [{
						glob: '**/data/demo/**',
						namespace: scope === Scope.Protected ? 'demo' : undefined,
					}],
				},
				usage: { type: 'declaration' },
			})
		}
		SymbolImport.mergeDependencySymbols(
			source,
			SymbolTable.getDependencyExports(dependency(), 'foreign'),
		)
		const before = SymbolTable.serialize(source.storage.global)
		const exported = SymbolTable.getDependencyExports(source.storage.global, 'package')
		t.assert.deepEqual(Object.keys(exported.function!), ['public', 'namespace'])
		t.assert.equal(
			exported.function!['public'].scopes?.public?.[0].source,
			Provider.Imported,
		)
		t.assert.equal(exported.function!['namespace'].scopes?.restricted?.[0].scope, Scope.Protected)
		t.assert.notEqual(
			SymbolUtil.viewFromContext(
				exported.function!['namespace'],
				'file:///consumer/data/demo/function/use',
				mockResourceLocation,
			),
			undefined,
		)
		t.assert.equal(
			SymbolUtil.viewFromContext(
				exported.function!['namespace'],
				'file:///consumer/data/other/function/use',
				mockResourceLocation,
			),
			undefined,
		)
		t.assert.equal(SymbolTable.serialize(source.storage.global), before)
	})
	it('keeps Internal ahead of imported Public and does not duplicate usages on reimport', t => {
		const symbols = new SymbolService(new SymbolStorage({}))
		symbols.query(inside, 'function', 'shared').enter({
			data: { scope: Scope.Internal, desc: 'local', data: 'local data' },
			usage: { type: 'declaration' },
		})
		const exported = SymbolTable.getDependencyExports(dependency(), 'package')
		SymbolImport.mergeDependencySymbols(symbols, exported)
		SymbolImport.mergeDependencySymbols(symbols, exported)
		const raw = symbols.storage.global.function!['shared']
		t.assert.equal(SymbolUtil.viewFromContext(raw, outside)?.desc, 'local')
		t.assert.equal(SymbolUtil.viewFromContext(raw, outside)?.data, 'local data')
		t.assert.equal(raw.scopes?.public?.[0]?.usages.definition?.length, 1)
		t.assert.equal(raw.scopes?.internal?.[0]?.usages.declaration?.length, 1)
		SymbolImport.removeDependencySymbols(symbols, 'package')
		t.assert.equal(SymbolUtil.viewFromContext(raw, outside)?.desc, 'local')
	})
	it('removes metadata-only imports and preserves the remaining package', t => {
		const source = new SymbolService(new SymbolStorage({}))
		source.query('file:///dependency/doc', 'item', 'metadata').enter({
			data: { desc: 'documentation' },
		})
		const symbols = new SymbolService(new SymbolStorage({}))
		for (const checksum of ['first', 'second']) {
			SymbolImport.mergeDependencySymbols(
				symbols,
				SymbolTable.getDependencyExports(source.storage.global, checksum),
			)
		}
		SymbolImport.removeDependencySymbols(symbols, 'first')
		t.assert.equal(symbols.storage.global.item!['metadata'].scopes?.public?.length, 1)
		SymbolImport.removeDependencySymbols(symbols, 'second')
		t.assert.equal(symbols.storage.global.item!['metadata'], undefined)
	})
	it('filters members recursively and restores parent links after exporting', t => {
		const source = new SymbolService(new SymbolStorage({}))
		source.query(inside, 'test', 'parent').enter({ data: { desc: 'parent' } })
			.member('public', query => query.enter({ data: { scope: Scope.Public } }))
			.member('internal', query => query.enter({ data: { scope: Scope.Internal } }))
		const exported = SymbolTable.getDependencyExports(source.storage.global, 'package')
		const parent = exported['test']!['parent']
		t.assert.deepEqual(Object.keys(parent.members!), ['public'])
		t.assert.equal(parent.members!['public'].parentSymbol, parent)
	})
})
