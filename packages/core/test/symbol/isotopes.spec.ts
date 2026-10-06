import {
	GlobalSymbol,
	Isotope,
	SymbolIsotopeProvider as Provider,
	SymbolIsotopeScope as Scope,
	SymbolTable,
	SymbolUsageTypes,
	SymbolUtil,
} from '@spyglassmc/core'
import type { IsotopeScope, SymbolLocation } from '@spyglassmc/core'
import { describe, it } from 'node:test'

const uri = 'file:///pack/data/demo/function/test.mcfunction'
const outside = 'file:///pack/data/other/function/test.mcfunction'
function add(util: SymbolUtil, identifier: string, scope: IsotopeScope, overrideLevel = 0) {
	util.query(uri, 'tag', 'test').enterIsotope(identifier, {
		data: {
			source: Provider.Regular,
			scope,
			desc: identifier,
			overrideLevel,
			...(scope < Scope.Project ? { visibleWithin: ['**/demo/**'] } : {}),
		},
		usage: { type: 'declaration' },
	})
	return util.global.tag!['test']
}

describe('symbol facets', () => {
	it('only sorts metadata when its priority changes, not when adding usages', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'first', Scope.Global, 1)
		add(util, 'second', Scope.Global, 2)
		const isotopes = symbol.facets!.global!.isotopes
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
		const util = new SymbolUtil({})
		const symbol = add(util, 'doc', Scope.Global)
		const facet = symbol.facets!.global!
		facet.isotopes[0].source = Provider.DocBlock
		facet.declaration![0].fromDocDeclaration = true
		const first: SymbolLocation = { uri, fromFile: true, isotopeIdentifier: 'doc' }
		const duplicate = { ...first }
		const imported: SymbolLocation = { uri, fromFile: true, importedFrom: outside }
		facet.implementation = [first, duplicate, imported]
		const removed: SymbolLocation[] = []
		const created: SymbolLocation[] = []
		util.on('symbolLocationRemoved', event => removed.push(event.location))
		util.on('symbolLocationCreated', event => created.push(event.location))
		Isotope.reconcileDocUsages(util, symbol)
		t.assert.deepEqual(facet.implementation, [imported, first])
		t.assert.equal(facet.implementation?.[1], first)
		t.assert.deepEqual(removed, [duplicate])
		t.assert.deepEqual(created, [])
		Isotope.reconcileDocUsages(util, symbol)
		t.assert.equal(facet.implementation?.[1], first)
		t.assert.equal(removed.length, 1)
	})
	it('deduplicates file usages against preceding command usages in the shared facet', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'doc', Scope.Global)
		const facet = symbol.facets!.global!
		facet.isotopes[0].source = Provider.DocBlock
		facet.declaration![0].fromDocDeclaration = true
		const command: SymbolLocation = {
			uri,
			originalUsageType: 'definition',
			isotopeIdentifier: 'doc',
		}
		facet.implementation = [command, { ...command, fromFile: true }]
		Isotope.reconcileDocUsages(util, symbol)
		t.assert.deepEqual(facet.implementation, [command])
		t.assert.equal(facet.implementation?.[0], command)
	})
	it('refreshes selection after creating a Regular fallback during reconciliation', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'stale-doc', Scope.Global)
		const facet = symbol.facets!.global!
		facet.isotopes[0].source = Provider.DocBlock
		facet.declaration = []
		facet.reference = [
			{ uri, originalUsageType: 'reference', isotopeIdentifier: 'stale-doc' },
			{ uri: outside, originalUsageType: 'reference', isotopeIdentifier: 'stale-doc' },
		]
		const events: string[] = []
		util.on('symbolLocationRemoved', () => events.push('removed'))
		util.on('symbolLocationCreated', () => events.push('created'))
		Isotope.reconcileDocUsages(util, symbol)
		t.assert.equal(facet.isotopes.length, 1)
		t.assert.equal(facet.isotopes[0].source, Provider.Regular)
		t.assert.deepEqual(facet.reference?.map(value => value.isotopeIdentifier), [
			facet.isotopes[0].identifier,
			facet.isotopes[0].identifier,
		])
		t.assert.deepEqual(events, [])
	})
	it('emits removals before creations when references move to a doc isotope', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'doc', Scope.Private)
		const doc = symbol.facets!.isotopes![0]
		doc.source = Provider.DocBlock
		doc.declaration![0].fromDocDeclaration = true
		add(util, 'regular', Scope.Global)
		const facet = symbol.facets!.global!
		facet.declaration = []
		facet.reference = [
			{ uri, originalUsageType: 'reference', isotopeIdentifier: 'regular' },
			{ uri: outside, originalUsageType: 'reference', isotopeIdentifier: 'regular' },
		]
		const events: string[] = []
		util.on('symbolLocationRemoved', () => events.push('removed'))
		util.on('symbolLocationCreated', () => events.push('created'))
		Isotope.reconcileDocUsages(util, symbol)
		t.assert.equal(doc.reference?.length, 2)
		t.assert.deepEqual(facet.reference, [])
		t.assert.deepEqual(events, ['removed', 'removed', 'created', 'created'])
	})
	it('stores every usage in Global and keeps the base free of descriptions and locations', t => {
		const util = new SymbolUtil({})
		for (const type of SymbolUsageTypes) {
			util.query(uri, 'tag', 'test').enter({ data: { desc: 'description' }, usage: { type } })
		}
		const symbol = util.global.tag!['test']
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
			t.assert.equal(symbol.facets?.global?.[type]?.length, 1)
		}
		t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'description')
	})
	for (const scope of [Scope.Global, Scope.Project]) {
		it(`shares usages across metadata overrides and restores the remaining description (scope ${scope})`, t => {
			const util = new SymbolUtil({})
			add(util, 'first', scope, 1)
			const symbol = add(util, 'second', scope, 7)
			const facet = scope === Scope.Global ? symbol.facets!.global! : symbol.facets!.internal!
			t.assert.deepEqual(facet.isotopes.map(value => value.identifier), ['second', 'first'])
			t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.declaration?.length, 2)
			t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'second')
			GlobalSymbol.clear(util, {
				predicate: ({ location }) => location.isotopeIdentifier === 'second',
			})
			t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'first')
			t.assert.equal(facet.declaration?.length, 1)
		})
	}
	it('prefers Internal over Public regardless of their override levels', t => {
		const util = new SymbolUtil({})
		add(util, 'public', Scope.Global, 100)
		const symbol = add(util, 'internal', Scope.Project, -1)
		t.assert.equal(SymbolUtil.viewFromContext(symbol, outside)?.desc, 'internal')
		GlobalSymbol.clear(util, {
			predicate: ({ location }) => location.isotopeIdentifier === 'internal',
		})
		t.assert.equal(SymbolUtil.viewFromContext(symbol, outside)?.desc, 'public')
	})
	it('prefers scope before override level, and keeps the first equal scoped priority', t => {
		const util = new SymbolUtil({})
		add(util, 'namespace', Scope.Namespace, 100)
		add(util, 'private', Scope.Private, 1)
		const symbol = add(util, 'tie', Scope.Private, 1)
		t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'private')
		symbol.facets!.isotopes![2].overrideLevel = 2
		t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'tie')
		t.assert.equal(SymbolUtil.viewFromContext(symbol, outside), undefined)
	})
	it('refreshes glob matching after replacement and in-place edits', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'private', Scope.Private)
		const isotope = symbol.facets!.isotopes![0]
		t.assert.equal(Isotope.selectIsotope(symbol, uri), isotope)
		isotope.visibleWithin = ['**/other/**']
		t.assert.equal(Isotope.selectIsotope(symbol, uri), undefined)
		isotope.visibleWithin[0] = '**/demo/**'
		t.assert.equal(Isotope.selectIsotope(symbol, uri), isotope)
		isotope.visibleWithin.length = 0
		t.assert.equal(Isotope.selectIsotope(symbol, uri), undefined)
	})
	it('checks namespace in addition to matching globs', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'namespace', Scope.Namespace)
		symbol.facets!.isotopes![0].namespace = ['other']
		t.assert.equal(Isotope.selectIsotope(symbol, uri), undefined)
		symbol.facets!.isotopes![0].namespace = ['demo']
		t.assert.notEqual(Isotope.selectIsotope(symbol, uri), undefined)
	})
	it('records inaccessible references without creating a public facet', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'private', Scope.Private)
		util.query(outside, 'tag', 'test').enterCommand({ usage: { type: 'reference' } })
		t.assert.equal(symbol.facets?.isotopes?.[0].reference?.length, 1)
		t.assert.equal(symbol.facets?.global, undefined)
		t.assert.equal(SymbolUtil.viewFromContext(symbol, outside), undefined)
	})
	it('rejects undefined scope or source before mutating metadata or locations', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'private', Scope.Private)
		for (const data of [{ scope: undefined }, { source: undefined }]) {
			t.assert.throws(
				() =>
					util.query(uri, 'tag', 'test').enterIsotope('private', {
						data: { ...data, desc: 'invalid' },
						usage: { type: 'reference' },
					}),
				/cannot be undefined/,
			)
		}
		t.assert.equal(symbol.facets?.isotopes?.[0].desc, 'private')
		t.assert.equal(symbol.facets?.isotopes?.[0].reference, undefined)
	})
	it('defers isotope creation and chained updates until delayed edits commit', t => {
		const util = new SymbolUtil({})
		const delayed = util.clone()
		delayed.query(uri, 'tag', 'test').enterIsotope('doc', {
			data: { source: Provider.Regular, scope: Scope.Global, desc: 'first' },
			usage: { type: 'declaration' },
		}).enterIsotope('doc', { data: { desc: 'updated' }, usage: { type: 'reference' } })
		t.assert.equal(util.global.tag, undefined)
		delayed.applyDelayedEdits()
		t.assert.equal(SymbolUtil.viewFromContext(util.global.tag!['test'], uri)?.desc, 'updated')
		t.assert.equal(util.global.tag!['test'].facets?.global?.reference?.length, 1)
		delayed.applyDelayedEdits()
		t.assert.equal(util.global.tag!['test'].facets?.global?.reference?.length, 1)
	})
	it('does not leak abandoned delayed updates', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'first', Scope.Global)
		util.clone().query(uri, 'tag', 'test').enterIsotope('first', {
			data: { desc: 'abandoned' },
			usage: { type: 'reference' },
		})
		t.assert.equal(SymbolUtil.viewFromContext(symbol, uri)?.desc, 'first')
		t.assert.equal(symbol.facets?.global?.reference, undefined)
	})
	it('uses contextual data in queries and keeps visible collections linked to raw symbols', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'private', Scope.Private)
		symbol.data = 'base data'
		symbol.facets!.isotopes![0].data = 'private data'
		const query = util.query(uri, 'tag', 'test')
		t.assert.equal(
			query.getData((value): value is string => typeof value === 'string'),
			'private data',
		)
		query.ifDeclared(view => t.assert.equal(view.desc, 'private'))
		t.assert.equal(GlobalSymbol.getVisibleSymbols(util, 'tag', uri)['test'], symbol)
		t.assert.equal(util.query(outside, 'tag', 'test').symbol, undefined)
	})
	it('writes mcdoc to one Global isotope and reads it without a URI', t => {
		const util = new SymbolUtil({})
		util.query(uri, 'mcdoc', 'module::Type').enter({
			data: { desc: 'type' },
			usage: { type: 'definition' },
		})
		util.query(outside, 'mcdoc', 'module::Type').enter({ usage: { type: 'reference' } })
		const symbol = util.global.mcdoc!['module::Type']
		t.assert.equal(symbol.facets?.global?.isotopes.length, 1)
		t.assert.equal(symbol.facets?.global?.reference?.length, 1)
		t.assert.equal(SymbolUtil.viewFromContext(symbol, undefined)?.desc, 'type')
	})
	it('uses Builtin for registered resources and Regular for ordinary contributions', t => {
		const util = new SymbolUtil({})
		util.contributeAs(
			'symbol_registrar/resources',
			() =>
				util.query('spyglass://builtin', 'item', 'builtin').enter({
					usage: { type: 'definition' },
				}),
		)
		util.query(uri, 'item', 'regular').enter({ usage: { type: 'definition' } })
		t.assert.equal(
			util.global.item!['builtin'].facets?.global?.isotopes[0].source,
			Provider.Builtin,
		)
		t.assert.equal(
			util.global.item!['regular'].facets?.global?.isotopes[0].source,
			Provider.Regular,
		)
	})
	it('round-trips shared usages and overrides through serialization and clears them after reload', t => {
		const util = new SymbolUtil({})
		add(util, 'public', Scope.Global)
		add(util, 'internal', Scope.Project)
		const reloaded = new SymbolUtil(SymbolTable.deserialize(SymbolTable.serialize(util.global)))
		GlobalSymbol.buildCache(reloaded)
		t.assert.equal(
			SymbolUtil.viewFromContext(reloaded.global.tag!['test'], uri)?.desc,
			'internal',
		)
		GlobalSymbol.clear(reloaded, { uri })
		t.assert.equal(reloaded.global.tag!['test'], undefined)
	})
})

describe('file symbol access checks', () => {
	it('does not scan usages of a visible symbol with many command definitions', t => {
		const util = new SymbolUtil({})
		const symbol = add(util, 'public', Scope.Global)
		let reads = 0
		symbol.facets!.global!.definition = Array.from({ length: 10000 }, () => ({
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
		const util = new SymbolUtil({})
		const symbol = add(util, 'private', Scope.Private)
		const isotope = symbol.facets!.isotopes![0]!
		isotope.definition = [{ uri, fromFile: true }]
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(symbol, uri), false)
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(symbol, outside), true)
		isotope.definition = [{ uri }]
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(symbol, outside), false)
		t.assert.equal(SymbolUtil.hasNoAccessToFileSymbol(undefined, outside), false)
	})
})
