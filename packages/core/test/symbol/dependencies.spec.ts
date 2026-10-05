import { SymbolTable, SymbolUtil } from '@spyglassmc/core'
import { describe, it } from 'node:test'

const namespace = {
	identifier: 'namespace', source: 0 as const, scope: 1 as const, namespace: ['demo'], visibleWithin: ['**/data/demo/**'],
	desc: 'namespace documentation', data: 'namespace data',
	declaration: [{ uri: 'file:///dependency/doc.mcfunction', fromDocDeclaration: true }],
	implementation: [{ uri: 'file:///dependency/source.json', fromFile: true }],
}
const privateIsotope = { identifier: 'private', source: 0 as const, scope: 0 as const, visibleWithin: ['**/private/**'] }

describe('dependency symbol exports', () => {
	for (const importFirst of [true, false]) {
		it(`keeps foreign file definitions independent of local private docs (import first: ${importFirst})`, t => {
			const symbols = new SymbolUtil({})
			const source = SymbolTable.link({ function: { shared: {
				definition: [{ uri: 'file:///dependency/shared.mcfunction', fromFile: true, originalUsageType: 'definition' }],
			} } })
			const imported = SymbolTable.getDependencyExports(source, 'package-checksum')
			const declare = () => symbols.query('file:///project/private/doc.mcfunction', 'function', 'shared')
				.enterIsotope('private-doc', {
					data: { source: 0, scope: 0, visibleWithin: ['file:///project/private/**'], desc: 'local private' },
					usage: { type: 'declaration', fromDocDeclaration: true },
				})
			if (importFirst) {
				symbols.importDependencySymbols(imported)
				declare()
			} else {
				declare()
				symbols.importDependencySymbols(imported)
			}
			const raw = symbols.global.function!['shared']
			const inside = 'file:///project/private/use.mcfunction'
			const outside = 'file:///project/use.mcfunction'
			t.assert.equal(SymbolUtil.viewFromContext(raw, inside)?.desc, 'local private')
			t.assert.equal(SymbolUtil.viewFromContext(raw, inside)?.implementation, undefined)
			t.assert.equal(SymbolUtil.viewFromContext(raw, outside)?.definition?.[0].uri, 'file:///dependency/shared.mcfunction')
			symbols.removeDependencySymbols('package-checksum')
			t.assert.equal(symbols.global.function!['shared'], raw)
			t.assert.equal(SymbolUtil.viewFromContext(raw, inside)?.desc, 'local private')
			t.assert.equal(SymbolUtil.viewFromContext(raw, outside), undefined)
			symbols.importDependencySymbols(SymbolTable.getDependencyExports(source, 'package-checksum'))
			symbols.clear({ uri: 'file:///project/private/doc.mcfunction' })
			t.assert.equal(SymbolUtil.viewFromContext(raw, inside)?.definition?.[0].uri, 'file:///dependency/shared.mcfunction')
		})
	}
	it('namespaces isotope identifiers by checksum and removes metadata-only imports', t => {
		const symbols = new SymbolUtil({})
		const source = SymbolTable.link({ function: { shared: { visibility: 3, isotopes: [namespace] }, metadata: { data: 'value' } } })
		symbols.importDependencySymbols(SymbolTable.getDependencyExports(source, 'first'))
		symbols.importDependencySymbols(SymbolTable.getDependencyExports(source, 'second'))
		const isotopes = symbols.global.function!['shared'].isotopes!
		t.assert.equal(new Set(isotopes.map(value => value.identifier)).size, 2)
		t.assert.deepEqual(isotopes.map(value => value.providerName), ['first', 'second'])
		t.assert.equal(isotopes.every(value => value.source === 1), true)
		symbols.removeDependencySymbols('first')
		t.assert.equal(symbols.global.function!['shared'].isotopes?.[0].providerName, 'second')
		symbols.removeDependencySymbols('second')
		t.assert.equal(symbols.global.function!['metadata'], undefined)
	})
	for (const visibility of [2, 3] as const) {
		it(`exports only namespace isotopes and removes base metadata and usages (visibility: ${visibility})`, t => {
			const source = SymbolTable.link({
				function: {
					scoped: {
						visibility, desc: 'base documentation', data: 'base data',
						definition: [{ uri: 'file:///dependency/base.mcfunction' }],
						isotopes: [privateIsotope, namespace, { identifier: 'local', source: 0, scope: -1 }],
					},
					hidden: { visibility, isotopes: [privateIsotope] },
				},
			})
			const before = SymbolTable.serialize(source)
			const exported = SymbolTable.getDependencyExports(source, 'checksum')
			const symbol = exported.function!['scoped']
			t.assert.equal(symbol.visibility, 2)
			t.assert.equal(symbol.desc, undefined)
			t.assert.equal(symbol.data, undefined)
			t.assert.equal(symbol.definition, undefined)
			t.assert.deepEqual(symbol.isotopes, [{ ...namespace, identifier: JSON.stringify(['checksum', 'isotope', namespace.identifier]), source: 1, providerName: 'checksum' }])
			t.assert.equal(exported.function!['hidden'], undefined)
			t.assert.equal(SymbolTable.serialize(source), before)
			t.assert.equal(SymbolUtil.viewFromContext(symbol, 'file:///consumer/data/demo/function/use.mcfunction')?.data,
				'namespace data')
			t.assert.equal(SymbolUtil.viewFromContext(symbol, 'file:///consumer/data/other/function/use.mcfunction'), undefined)
		})
	}
	it('imports public and implicit-public bases and filters members recursively', t => {
		const exported = SymbolTable.getDependencyExports(SymbolTable.link({
			test: {
				explicit: { visibility: 4, data: 'public' },
				implicit: { data: 'default public', members: {
					public: { visibility: 4 }, internal: { visibility: 3 },
					file: { visibility: 1 }, block: { visibility: 0 },
					scoped: { visibility: 3, isotopes: [namespace] },
				} },
				internalParent: { visibility: 3, members: { public: { visibility: 4 } } },
			},
		}), 'checksum')
		t.assert.equal(SymbolUtil.viewFromContext(exported['test']!['explicit'], 'file:///consumer/a')?.data, 'public')
		t.assert.equal(SymbolUtil.viewFromContext(exported['test']!['implicit'], 'file:///consumer/a')?.data, 'default public')
		t.assert.deepEqual(Object.keys(exported['test']!['implicit'].members!), ['public', 'scoped'])
		t.assert.equal(exported['test']!['implicit'].members!['scoped'].parentSymbol, exported['test']!['implicit'])
		t.assert.equal(exported['test']!['internalParent'], undefined)
	})
	it('keeps local internal declarations when a dependency exports the same public symbol', t => {
		const symbols = new SymbolUtil({})
		symbols.query('file:///project/source.mcfunction', 'function', 'shared').enter({
			data: { visibility: 3, desc: 'local', data: 'local data' }, usage: { type: 'declaration' },
		})
		const dependency = SymbolTable.link({ function: {
			shared: { visibility: 4, desc: 'external', data: 'external data',
				definition: [{ uri: 'file:///dependency/shared.mcfunction' }], isotopes: [namespace] },
		} })
		symbols.importDependencySymbols(SymbolTable.getDependencyExports(dependency, 'checksum'))
		symbols.importDependencySymbols(SymbolTable.getDependencyExports(dependency, 'checksum'))
		const symbol = symbols.global.function!['shared']
		t.assert.equal(symbol.visibility, 3)
		t.assert.equal(symbol.desc, 'local')
		t.assert.equal(symbol.data, 'local data')
		t.assert.equal(symbol.definition, undefined)
		t.assert.equal(symbol.isotopes?.length, 2)
		t.assert.equal(symbol.isotopes?.[0].declaration?.length, 1)
		symbols.clear({ uri: 'file:///dependency/shared.mcfunction' })
		t.assert.equal(symbol.definition, undefined)
		t.assert.equal(symbol.declaration?.length, 1)
		t.assert.equal(symbol.visibility, 3)
	})
})
