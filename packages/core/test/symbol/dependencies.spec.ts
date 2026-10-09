import {
	SymbolEnterType,
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
			usage: {},
		}, SymbolEnterType.File)
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
	it('deeply isolates exported metadata, members and locations from the source', t => {
		const source = new SymbolService(new SymbolStorage({}))
		const query = source.query('file:///dependency/doc', 'function', 'parent')
		query.enter({ data: { data: { nested: ['original'] } }, usage: { type: 'definition' } })
		query.member('child', member => member.enter({ usage: { type: 'definition' } }))
		const before = SymbolTable.serialize(source.storage.global)
		const exported = SymbolTable.getDependencyExports(source.storage.global, 'package')
		const parent = exported.function!['parent']
		const facet = parent.facets!.global!
		;(facet.isotopes[0].data as { nested: string[] }).nested.push('changed')
		facet.definition![0].uri = 'file:///changed'
		parent.members!['child'].facets!.global!.definition![0].uri = 'file:///changed-child'
		t.assert.equal(parent.members!['child'].parentSymbol, parent)
		t.assert.equal(SymbolTable.serialize(source.storage.global), before)
	})
	it('does not relocate imported command definitions into a local private doc', t => {
		const source = new SymbolService(new SymbolStorage({}))
		source.query('file:///dependency/command.mcfunction', 'function', 'shared').enter(
			{
				usage: { type: 'definition' },
			},
			SymbolEnterType.InFileSymbol,
		)
		const symbols = new SymbolService(new SymbolStorage({}))
		SymbolImport.importDependencySymbols(
			symbols,
			SymbolTable.getDependencyExports(source.storage.global, 'package'),
		)
		declarePrivate(symbols)
		const raw = symbols.storage.global.function!['shared']
		t.assert.equal(SymbolUtil.viewFromContext(raw, inside)?.implementation, undefined)
		t.assert.equal(
			SymbolUtil.viewFromContext(raw, outside)?.definition?.[0].uri,
			'file:///dependency/command.mcfunction',
		)
	})
	for (const importFirst of [true, false]) {
		it(`keeps foreign file definitions independent of local private docs (import first: ${importFirst})`, t => {
			const symbols = new SymbolService(new SymbolStorage({}))
			const exported = SymbolTable.getDependencyExports(dependency(), 'package')
			if (importFirst) {
				SymbolImport.importDependencySymbols(symbols, exported)
				declarePrivate(symbols)
			} else {
				declarePrivate(symbols)
				SymbolImport.importDependencySymbols(symbols, exported)
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
			SymbolImport.importDependencySymbols(symbols, exported)
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
		SymbolImport.importDependencySymbols(
			symbols,
			SymbolTable.getDependencyExports(source, 'first'),
		)
		SymbolImport.importDependencySymbols(
			symbols,
			SymbolTable.getDependencyExports(source, 'second'),
		)
		const raw = symbols.storage.global.function!['shared']
		t.assert.equal(raw.facets?.global?.isotopes.length, 2)
		t.assert.equal(raw.facets?.global?.definition?.length, 2)
		t.assert.equal(raw.facets?.internal, undefined)
		SymbolImport.removeDependencySymbols(symbols, 'first')
		t.assert.equal(raw.facets?.global?.isotopes[0].providerName, 'second')
		t.assert.equal(raw.facets?.global?.definition?.length, 1)
		SymbolImport.removeDependencySymbols(symbols, 'second')
		t.assert.equal(symbols.storage.global.function!['shared'], undefined)
	})
	it('exports Global and Protected facets, excluding Project, Private, Local and Imported', t => {
		const source = new SymbolService(new SymbolStorage({}))
		for (
			const [name, scope] of [
				['public', Scope.Global],
				['internal', Scope.Project],
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
		SymbolImport.importDependencySymbols(
			source,
			SymbolTable.getDependencyExports(dependency(), 'foreign'),
		)
		const before = SymbolTable.serialize(source.storage.global)
		const exported = SymbolTable.getDependencyExports(source.storage.global, 'package')
		t.assert.deepEqual(Object.keys(exported.function!), ['public', 'namespace'])
		t.assert.equal(
			exported.function!['public'].facets?.global?.isotopes[0].source,
			Provider.Imported,
		)
		t.assert.equal(exported.function!['namespace'].facets?.isotopes?.[0].scope, Scope.Protected)
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
			data: { scope: Scope.Project, desc: 'local', data: 'local data' },
			usage: { type: 'declaration' },
		})
		const exported = SymbolTable.getDependencyExports(dependency(), 'package')
		SymbolImport.importDependencySymbols(symbols, exported)
		SymbolImport.importDependencySymbols(symbols, exported)
		const raw = symbols.storage.global.function!['shared']
		t.assert.equal(SymbolUtil.viewFromContext(raw, outside)?.desc, 'local')
		t.assert.equal(SymbolUtil.viewFromContext(raw, outside)?.data, 'local data')
		t.assert.equal(raw.facets?.global?.definition?.length, 1)
		t.assert.equal(raw.facets?.internal?.declaration?.length, 1)
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
			SymbolImport.importDependencySymbols(
				symbols,
				SymbolTable.getDependencyExports(source.storage.global, checksum),
			)
		}
		SymbolImport.removeDependencySymbols(symbols, 'first')
		t.assert.equal(symbols.storage.global.item!['metadata'].facets?.global?.isotopes.length, 1)
		SymbolImport.removeDependencySymbols(symbols, 'second')
		t.assert.equal(symbols.storage.global.item!['metadata'], undefined)
	})
	it('filters members recursively and restores parent links after exporting', t => {
		const source = new SymbolService(new SymbolStorage({}))
		source.query(inside, 'test', 'parent').enter({ data: { desc: 'parent' } })
			.member('public', query => query.enter({ data: { scope: Scope.Global } }))
			.member('internal', query => query.enter({ data: { scope: Scope.Project } }))
		const exported = SymbolTable.getDependencyExports(source.storage.global, 'package')
		const parent = exported['test']!['parent']
		t.assert.deepEqual(Object.keys(parent.members!), ['public'])
		t.assert.equal(parent.members!['public'].parentSymbol, parent)
	})
})
