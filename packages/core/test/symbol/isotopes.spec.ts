import {
	Isotope,
	SymbolIsotopeProvider as Provider,
	SymbolIsotopeScope as Scope,
	SymbolService,
	SymbolStorage,
	SymbolUsageTypes,
	SymbolUtil,
} from '@spyglassmc/core'
import type { IsotopeScope, IsotopeVisibility, SymbolLocation } from '@spyglassmc/core'
import { describe, it } from 'node:test'
import { mockResourceLocation } from '../utils.ts'

const uri = 'file:///pack/data/demo/function/test.mcfunction'
const outside = 'file:///pack/data/other/function/test.mcfunction'
function add(service: SymbolService, identifier: string, scope: IsotopeScope, overrideLevel = 0) {
	service.query(uri, 'tag', 'test').enterIsotope(identifier, {
		data: {
			source: Provider.Regular,
			scope,
			desc: identifier,
			overrideLevel,
			...(scope < Scope.Internal ? { visibleWithin: [{ glob: '**/demo/**' }] } : {}),
		},
		usage: { type: 'declaration' },
	})
	return service.storage.global.tag!['test']
}

describe('symbol scopes', () => {
	it('stops cleanup after finding surviving usages for the affected metadata', t => {
		const util = new SymbolService(new SymbolStorage({}))
		const symbol = add(util, 'global', Scope.Public)
		add(util, 'internal', Scope.Internal)
		const facet = symbol.scopes!.public!
		let visited = 0
		facet[0].usages.reference = [{
			uri,
			get isotopeIdentifier() {
				visited++
				return 'global'
			},
		}]
		// The declaration already proves that each isotope survives. Neither the
		// remaining references nor unaffected scopes need a scan.
		Isotope.cleanupAfterLocationRemoval(util, symbol, new Set(['global', 'internal']), false)
		t.assert.equal(visited, 0)
		t.assert.deepEqual(facet.map(isotope => isotope.identifier), ['global'])
		t.assert.deepEqual(symbol.scopes!.internal?.map(isotope => isotope.identifier), [
			'internal',
		])
		facet[0].usages.declaration = []
		Isotope.cleanupAfterLocationRemoval(util, symbol, new Set(['internal']), false)
		t.assert.equal(visited, 0)
		Isotope.cleanupAfterLocationRemoval(util, symbol, new Set(['global']), false)
		t.assert.equal(visited > 0, true)
		t.assert.equal(facet.length, 1)
	})
	it('removes only affected metadata without surviving usages across shared scopes', t => {
		const util = new SymbolService(new SymbolStorage({}))
		const symbol = add(util, 'surviving', Scope.Public)
		add(util, 'removed', Scope.Public)
		add(util, 'internal', Scope.Internal)
		add(util, 'untouched', Scope.Internal)
		symbol.scopes!.public![0].usages.declaration = symbol.scopes!.public![0].usages.declaration!
			.filter(location => location.isotopeIdentifier === 'surviving')
		symbol.scopes!.internal![0].usages.declaration = []
		Isotope.cleanupAfterLocationRemoval(
			util,
			symbol,
			new Set(['surviving', 'removed', 'internal']),
			false,
		)
		t.assert.deepEqual(symbol.scopes!.public?.map(isotope => isotope.identifier), [
			'surviving',
		])
		t.assert.deepEqual(symbol.scopes!.internal?.map(isotope => isotope.identifier), [
			'untouched',
		])
	})
	it('only sorts metadata when its priority changes, not when adding usages', t => {
		const util = new SymbolService(new SymbolStorage({}))
		const symbol = add(util, 'first', Scope.Public, 1)
		add(util, 'second', Scope.Public, 2)
		const isotopes = symbol.scopes!.public!
		const sort = isotopes.sort.bind(isotopes)
		let sorts = 0
		isotopes.sort = compare => {
			sorts++
			return sort(compare)
		}
		util.query(uri, 'tag', 'test').enterIsotope('first', { usage: { type: 'reference' } })
		util.query(uri, 'tag', 'test').enterIsotope('first', { data: { desc: 'updated' } })
		t.assert.equal(sorts, 0)
		util.query(uri, 'tag', 'test').enterIsotope('first', { data: { overrideLevel: 3 } })
		t.assert.equal(sorts, 1)
		t.assert.equal(isotopes[0].identifier, 'first')
	})
	it('reuses the first matching file location and removes only duplicates during reconciliation', t => {
		const util = new SymbolService(new SymbolStorage({}))
		const symbol = add(util, 'doc', Scope.Public)
		const facet = symbol.scopes!.public!
		facet[0].source = Provider.DocBlock
		facet[0].usages.declaration![0].fromDocDeclaration = true
		const first: SymbolLocation = { uri, fromFile: true, isotopeIdentifier: 'doc' }
		const duplicate = { ...first }
		const imported: SymbolLocation = { uri, fromFile: true, importedFrom: outside }
		facet[0].usages.implementation = [first, duplicate, imported]
		util.storage.rebuildIndex()
		Isotope.reconcileDocUsages(util, symbol)
		t.assert.deepEqual(facet[0].usages.implementation, [imported, first])
		t.assert.equal(facet[0].usages.implementation?.[1], first)
		t.assert.equal(facet[0].usages.implementation?.includes(duplicate), false)
		Isotope.reconcileDocUsages(util, symbol)
		t.assert.equal(facet[0].usages.implementation?.[1], first)
		util.clear({ uri })
		t.assert.equal(util.storage.getPaths().size, 0)
	})
	it('deduplicates file definitions without losing command implementations in the shared facet', t => {
		const util = new SymbolService(new SymbolStorage({}))
		const symbol = add(util, 'doc', Scope.Public)
		const facet = symbol.scopes!.public!
		facet[0].source = Provider.DocBlock
		facet[0].usages.declaration![0].fromDocDeclaration = true
		const command: SymbolLocation = {
			uri,
			followDocScope: true,
			isotopeIdentifier: 'doc',
		}
		const file: SymbolLocation = { uri, isotopeIdentifier: 'doc', fromFile: true }
		facet[0].usages.definition = [file, { ...file }]
		facet[0].usages.implementation = [command]
		util.storage.rebuildIndex()
		Isotope.reconcileDocUsages(util, symbol)
		t.assert.deepEqual(facet[0].usages.definition, [file])
		t.assert.equal(facet[0].usages.definition?.[0], file)
		t.assert.deepEqual(facet[0].usages.implementation, [command])
		t.assert.equal(facet[0].usages.implementation?.[0], command)
	})
	it('refreshes selection after creating a Regular fallback during reconciliation', t => {
		const util = new SymbolService(new SymbolStorage({}))
		const symbol = add(util, 'stale-doc', Scope.Public)
		let facet = symbol.scopes!.public!
		facet[0].source = Provider.DocBlock
		facet[0].usages.declaration = []
		facet[0].usages.reference = [
			{ uri, followDocScope: true, isotopeIdentifier: 'stale-doc' },
			{ uri: outside, followDocScope: true, isotopeIdentifier: 'stale-doc' },
		]
		util.storage.rebuildIndex()
		Isotope.reconcileDocUsages(util, symbol)
		facet = symbol.scopes!.public!
		t.assert.equal(facet.length, 1)
		t.assert.equal(facet[0].source, Provider.Regular)
		t.assert.deepEqual(facet[0].usages.reference?.map(value => value.isotopeIdentifier), [
			facet[0].identifier,
			facet[0].identifier,
		])
	})
	it('preserves location indexes when references move to a doc isotope', t => {
		const util = new SymbolService(new SymbolStorage({}))
		const symbol = add(util, 'doc', Scope.Private)
		const doc = symbol.scopes!.restricted![0]
		doc.source = Provider.DocBlock
		doc.usages.declaration![0].fromDocDeclaration = true
		add(util, 'regular', Scope.Public)
		const facet = symbol.scopes!.public!
		facet[0].usages.declaration = []
		facet[0].usages.reference = [
			{ uri, followDocScope: true, isotopeIdentifier: 'regular' },
			{ uri: outside, followDocScope: true, isotopeIdentifier: 'regular' },
		]
		util.storage.rebuildIndex()
		Isotope.reconcileDocUsages(util, symbol)
		t.assert.equal(doc.usages.reference?.length, 2)
		t.assert.deepEqual(facet[0].usages.reference, [])
		t.assert.equal(util.storage.getPaths(uri).size, 1)
		t.assert.equal(util.storage.getPaths(outside).size, 1)
		util.clear({ uri })
		util.clear({ uri: outside })
		t.assert.equal(util.storage.getPaths().size, 0)
	})
	it('stores every usage in Global and keeps the base free of descriptions and locations', t => {
		const util = new SymbolService(new SymbolStorage({}))
		for (const type of SymbolUsageTypes) {
			util.query(uri, 'tag', 'test').enter({
				data: { desc: 'description' },
				usage: { type },
			})
		}
		const symbol = util.storage.global.tag!['test']
		for (
			const key of [
				'desc',
				'visibility',
				'visibilityRestriction',
				'isotopes',
				...SymbolUsageTypes,
			]
		) {
			t.assert.equal(key in symbol, false)
		}
		for (const type of SymbolUsageTypes) {
			t.assert.equal(symbol.scopes?.public?.[0]?.usages[type]?.length, 1)
		}
		t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'description')
	})
	for (const scope of [Scope.Public, Scope.Internal]) {
		it(`shares usages across metadata overrides and restores the remaining description (scope ${scope})`, t => {
			const service = new SymbolService(new SymbolStorage({}))
			add(service, 'first', scope, 1)
			const symbol = add(service, 'second', scope, 7)
			const facet = scope === Scope.Public ? symbol.scopes!.public! : symbol.scopes!.internal!
			t.assert.deepEqual(facet.map(value => value.identifier), ['second', 'first'])
			t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.declaration?.length, 2)
			t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'second')
			service.clear({
				predicate: ({ location }) => location.isotopeIdentifier === 'second',
			})
			t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'first')
			t.assert.equal(facet[0].usages.declaration?.length, 1)
		})
	}
	it('prefers Internal over Public regardless of their override levels', t => {
		const service = new SymbolService(new SymbolStorage({}))
		add(service, 'public', Scope.Public, 100)
		const symbol = add(service, 'internal', Scope.Internal, -1)
		t.assert.equal(SymbolUtil.viewFromContext(symbol, outside)?.desc, 'internal')
		service.clear({
			predicate: ({ location }) => location.isotopeIdentifier === 'internal',
		})
		t.assert.equal(SymbolUtil.viewFromContext(symbol, outside)?.desc, 'public')
	})
	it('prefers scope before override level, and keeps the first equal scoped priority', t => {
		const service = new SymbolService(new SymbolStorage({}))
		add(service, 'namespace', Scope.Protected, 100)
		add(service, 'private', Scope.Private, 1)
		const symbol = add(service, 'tie', Scope.Private, 1)
		t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'private')
		symbol.scopes!.restricted![2].overrideLevel = 2
		t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'tie')
		t.assert.equal(SymbolUtil.viewFromContext(symbol, outside), undefined)
	})
	it('refreshes glob matching after replacement and in-place edits', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const symbol = add(service, 'private', Scope.Private)
		const isotope = symbol.scopes!.restricted![0]
		t.assert.equal(Isotope.selectIsotope(symbol, uri), isotope)
		isotope.visibleWithin = [{ glob: '**/other/**' }]
		t.assert.equal(Isotope.selectIsotope(symbol, uri), undefined)
		isotope.visibleWithin[0].glob = '**/demo/**'
		t.assert.equal(Isotope.selectIsotope(symbol, uri), isotope)
		isotope.visibleWithin.length = 0
		t.assert.equal(Isotope.selectIsotope(symbol, uri), undefined)
	})
	it('checks namespace in addition to matching globs', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const symbol = add(service, 'namespace', Scope.Protected)
		symbol.scopes!.restricted![0].visibleWithin![0].namespace = 'other'
		t.assert.equal(Isotope.selectIsotope(symbol, uri, mockResourceLocation), undefined)
		symbol.scopes!.restricted![0].visibleWithin![0].namespace = 'demo'
		t.assert.notEqual(Isotope.selectIsotope(symbol, uri, mockResourceLocation), undefined)
	})
	it('records inaccessible references without creating a public facet', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const symbol = add(service, 'private', Scope.Private)
		service.query(outside, 'tag', 'test').enter({
			usage: { type: 'reference', followDocScope: true },
		})
		t.assert.equal(symbol.scopes?.restricted?.[0].usages.reference?.length, 1)
		t.assert.equal(symbol.scopes?.public, undefined)
		t.assert.equal(SymbolUtil.viewFromContext(symbol, outside), undefined)
	})
	it('rejects undefined scope or source before mutating metadata or locations', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const symbol = add(service, 'private', Scope.Private)
		for (const data of [{ scope: undefined }, { source: undefined }]) {
			t.assert.throws(
				() =>
					service.query(uri, 'tag', 'test').enterIsotope('private', {
						data: { ...data, desc: 'invalid' },
						usage: { type: 'reference' },
					}),
				/cannot be undefined/,
			)
		}
		t.assert.equal(symbol.scopes?.restricted?.[0].desc, 'private')
		t.assert.equal(symbol.scopes?.restricted?.[0].usages.reference, undefined)
	})
	it('defers isotope creation and chained updates until delayed edits commit', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const delayed = service.cloneDelayed()
		delayed.query(uri, 'tag', 'test').enterIsotope('doc', {
			data: { source: Provider.Regular, scope: Scope.Public, desc: 'first' },
			usage: { type: 'declaration' },
		}).enterIsotope('doc', { data: { desc: 'updated' }, usage: { type: 'reference' } })
		t.assert.equal(service.storage.global.tag, undefined)
		delayed.applyDelayedEdits()
		t.assert.equal(
			SymbolUtil.viewFromContext(service.storage.global.tag!['test'], uri)?.desc,
			'updated',
		)
		t.assert.equal(
			service.storage.global.tag!['test'].scopes?.public?.[0]?.usages.reference?.length,
			1,
		)
		delayed.applyDelayedEdits()
		t.assert.equal(
			service.storage.global.tag!['test'].scopes?.public?.[0]?.usages.reference?.length,
			1,
		)
	})
	it('does not leak abandoned delayed updates', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const symbol = add(service, 'first', Scope.Public)
		service.cloneDelayed().query(uri, 'tag', 'test').enterIsotope('first', {
			data: { desc: 'abandoned' },
			usage: { type: 'reference' },
		})
		t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'first')
		t.assert.equal(symbol.scopes?.public?.[0]?.usages.reference, undefined)
	})
	it('uses contextual data in queries and keeps visible collections linked to raw symbols', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const symbol = add(service, 'private', Scope.Private)
		symbol.data = 'base data'
		symbol.scopes!.restricted![0].data = 'private data'
		const query = service.query(uri, 'tag', 'test')
		t.assert.equal(
			query.getData((value): value is string => typeof value === 'string'),
			'private data',
		)
		query.ifDeclared(view => t.assert.equal(view.desc, 'private'))
		t.assert.equal(service.getVisibleSymbols('tag', uri)['test'], symbol)
		t.assert.equal(service.query(outside, 'tag', 'test').symbolView, undefined)
	})
	it('writes mcdoc to one Global isotope and reads it without a URI', t => {
		const service = new SymbolService(new SymbolStorage({}))
		service.query(uri, 'mcdoc', 'module::Type').enter({
			data: { desc: 'type' },
			usage: { type: 'definition' },
		})
		service.query(outside, 'mcdoc', 'module::Type').enter({ usage: { type: 'reference' } })
		const symbol = service.storage.global.mcdoc!['module::Type']
		t.assert.equal(symbol.scopes?.public?.length, 1)
		t.assert.equal(symbol.scopes?.public?.[0]?.usages.reference?.length, 1)
		t.assert.equal(SymbolUtil.viewFromContext(symbol, undefined)?.desc, 'type')
	})
	it('uses Builtin for registered resources and Regular for ordinary contributions', t => {
		const service = new SymbolService(new SymbolStorage({}))
		service.contributeAs(
			'symbol_registrar/resources',
			() =>
				service.query('spyglass://builtin', 'item', 'builtin').enter({
					usage: { type: 'definition' },
				}),
		)
		service.query(uri, 'item', 'regular').enter({ usage: { type: 'definition' } })
		t.assert.equal(
			service.storage.global.item!['builtin'].scopes?.public?.[0].source,
			Provider.Builtin,
		)
		t.assert.equal(
			service.storage.global.item!['regular'].scopes?.public?.[0].source,
			Provider.Regular,
		)
	})
})

describe('file symbol access checks', () => {
	it('matches isotope selection across scopes, URI rules and contextual views', t => {
		for (const scope of [Scope.Private, Scope.Protected, Scope.Internal, Scope.Public]) {
			const service = new SymbolService(new SymbolStorage({}))
			const symbol = add(service, 'test', scope)
			for (
				const rules of [[], [{ glob: '' }], [{ glob: '**/demo/**' }], [{ namespace: 'demo' }]]
			) {
				if (symbol.scopes?.restricted?.[0]) {
					symbol.scopes.restricted[0].visibleWithin = rules
				}
				for (const contextUri of [undefined, '', uri, outside]) {
					t.assert.equal(
						Isotope.isVisible(symbol, contextUri, mockResourceLocation),
						!!Isotope.selectIsotope(symbol, contextUri, mockResourceLocation),
					)
					const view = SymbolUtil.viewFromContext(symbol, uri, mockResourceLocation)
					if (view) {
						t.assert.equal(
							Isotope.isVisible(view, contextUri, mockResourceLocation),
							Isotope.isVisible(symbol, contextUri, mockResourceLocation),
						)
					}
				}
			}
			for (const category of ['mcdoc', 'mcdoc/dispatcher']) {
				symbol.category = category
				t.assert.equal(Isotope.isVisible(symbol, uri), scope === Scope.Public)
			}
		}
	})
	it('skips restricted rules for public symbols and stops at the first restricted match', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const symbol = add(service, 'private', Scope.Private)
		const first = symbol.scopes!.restricted![0]!
		first.visibleWithin = [{ namespace: 'demo' }]
		let calls = 0
		const resolve = (value: string) => {
			calls++
			return mockResourceLocation(value)
		}
		add(service, 'public', Scope.Public)
		t.assert.equal(Isotope.isVisible(symbol, uri, resolve), true)
		t.assert.equal(calls, 0)
		delete symbol.scopes!.public
		symbol.scopes!.restricted!.push({
			identifier: 'later',
			usages: {},
			source: Provider.Regular,
			scope: Scope.Private,
			get visibleWithin(): IsotopeVisibility[] {
				throw new Error('Later rules should not be inspected')
			},
		})
		t.assert.equal(Isotope.isVisible(symbol, uri, resolve), true)
		t.assert.equal(calls, 1)
	})

	it('does not scan usages of a visible symbol with many command definitions', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const symbol = add(service, 'public', Scope.Public)
		let reads = 0
		symbol.scopes!.public![0].usages.definition = Array.from({ length: 10000 }, () => ({
			uri,
			get fromFile() {
				reads++
				return false
			},
		}))
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(symbol, uri), false)
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(symbol, outside), false)
		t.assert.equal(reads, 0)
	})
	it('still reports inaccessible file symbols but allows non-file symbols', t => {
		const service = new SymbolService(new SymbolStorage({}))
		const symbol = add(service, 'private', Scope.Private)
		const isotope = symbol.scopes!.restricted![0]!
		isotope.usages.definition = [{ uri, fromFile: true }]
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(symbol, uri), false)
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(symbol, outside), true)
		isotope.usages.definition = [{ uri }]
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(symbol, outside), false)
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(undefined, outside), false)
	})
})
