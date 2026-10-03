import { SymbolTable, SymbolUtil } from '@spyglassmc/core'
import { describe, it } from 'node:test'

describe('symbol isotopes', () => {
	it('refreshes cached glob matching after replacement and in-place edits', t => {
		const base = symbol()
		base.isotopes = [base.isotopes![1]]
		const isotope = base.isotopes[0]
		t.assert.equal(SymbolUtil.selectIsotope(base, uri), isotope)
		isotope.visibleWithin = ['**/other/**']
		t.assert.equal(SymbolUtil.selectIsotope(base, uri), undefined)
		isotope.visibleWithin[0] = '**/demo/**'
		t.assert.equal(SymbolUtil.selectIsotope(base, uri), isotope)
		isotope.visibleWithin.push('**/other/**')
		t.assert.equal(SymbolUtil.selectIsotope(base, 'file:///other/test'), isotope)
		isotope.visibleWithin.length = 0
		t.assert.equal(SymbolUtil.selectIsotope(base, uri), undefined)
		isotope.visibleWithin.push('**/unmatched/**')
		t.assert.equal(SymbolUtil.selectIsotope(base, uri), undefined)
	})

	it('rejects clearing scope before changing metadata or adding a usage', t => {
		const base = symbol()
		const util = new SymbolUtil({ tag: { test: base } })
		let created = 0
		util.on('symbolLocationCreated', () => created++)
		t.assert.throws(() =>
			util.query(uri, 'tag', 'test').enterIsotope('isotope1', {
				data: { scope: undefined, desc: 'must not be written' },
				usage: { type: 'reference' },
			}), /scope cannot be undefined/)
		t.assert.equal(base.isotopes![1].scope, 0)
		t.assert.equal(base.isotopes![1].desc, 'first')
		t.assert.equal(base.isotopes![1].reference, undefined)
		t.assert.equal(created, 0)
		util.query(uri, 'tag', 'test').enterIsotope('isotope1', { data: { desc: 'updated' } })
		t.assert.equal(base.isotopes![1].scope, 0)
		t.assert.equal(base.isotopes![1].desc, 'updated')
		util.query(uri, 'tag', 'test').enterIsotope('isotope1', { data: { scope: 1 } })
		t.assert.equal(base.isotopes![1].scope, 1)
	})

	const uri = 'file:///pack/data/demo/function/test.mcfunction'
	const symbol = () =>
		SymbolTable.link({
			tag: {
				test: {
					visibility: 2,
					desc: 'base',
					declaration: [{ uri: 'file:///base' }],
					isotopes: [
						{
							identifier: 'isotope0',
							scope: 1,
							visibleWithin: ['**/demo/**'],
							desc: 'namespace',
						},
						{
							identifier: 'isotope1',
							scope: 0,
							visibleWithin: ['**/demo/**'],
							overrideLevel: 1,
							desc: 'first',
							definition: [{ uri: 'file:///first' }],
						},
						{
							identifier: 'isotope2',
							scope: 0,
							visibleWithin: ['**/demo/**'],
							overrideLevel: 1,
							desc: 'tie',
						},
					],
				},
			},
		}).tag!['test']

	it('selects scope before level, keeps the first tie, and replaces usages', t => {
		const base = symbol()
		const view = SymbolUtil.viewFromContext(base, uri)!
		t.assert.equal(view.desc, 'first')
		t.assert.equal(view.definition?.[0].uri, 'file:///first')
		t.assert.equal(view.declaration, undefined)
		t.assert.equal(base.desc, 'base')
		base.isotopes![2].overrideLevel = 2
		t.assert.equal(SymbolUtil.viewFromContext(view, uri)?.desc, 'tie')
	})

	it('falls back to public base but never to restricted base', t => {
		const base = symbol()
		t.assert.equal(SymbolUtil.viewFromContext(base, 'file:///other')?.desc, 'base')
		base.visibility = 3
		t.assert.equal(SymbolUtil.viewFromContext(base, 'file:///other'), undefined)
		t.assert.equal(SymbolUtil.viewFromContext(base, uri)?.desc, 'first')
		base.isotopes = undefined
		t.assert.equal(SymbolUtil.viewFromContext(base, uri), undefined)
	})

	it('returns original symbols from queries and visible collections', t => {
		const base = symbol()
		const util = new SymbolUtil({ tag: { test: base } })
		t.assert.equal(util.query(uri, 'tag', 'test').symbol, base)
		t.assert.equal(util.getVisibleSymbols('tag', uri)['test'], base)
		t.assert.equal(util.query(uri, 'tag').visibleMembers['test'], base)
		t.assert.equal(util.global.tag!['test'].desc, 'base')
	})
	it('checks namespace, ignores Local, and excludes nonmatching globs', t => {
		const base = symbol()
		base.isotopes = [
			{ identifier: 'isotope3', scope: -1, visibleWithin: ['**'], desc: 'local' },
			{ identifier: 'isotope4', scope: 0, visibleWithin: ['**/other/**'], desc: 'other' },
			{
				identifier: 'isotope5',
				scope: 1,
				namespace: ['other'],
				visibleWithin: ['**'],
				desc: 'wrong namespace',
			},
			{
				identifier: 'isotope6',
				scope: 1,
				namespace: ['demo'],
				visibleWithin: ['**'],
				desc: 'demo',
			},
		]
		t.assert.equal(SymbolUtil.viewFromContext(base, uri)?.desc, 'demo')
	})

	it('writes ordinary references to base even when an isotope matches', t => {
		const base = symbol()
		const util = new SymbolUtil({ tag: { test: base } })
		util.contributeAs('binder', () => {
			util.query(uri, 'tag', 'test').enter({ usage: { type: 'reference' } })
		})
		t.assert.equal(base.reference?.length, 1)
		t.assert.equal(base.isotopes![1].reference, undefined)
		util.clear({ uri, contributor: 'binder' })
		t.assert.equal(base.reference?.length, 0)
		t.assert.equal(base.isotopes![1].reference, undefined)
		t.assert.equal(base.isotopes![1].definition?.length, 1)
	})
	it('creates and updates an isotope by identifier with one location per write', t => {
		const util = new SymbolUtil({})
		const events: string[] = []
		util.on('symbolLocationCreated', event => events.push(event.type))
		util.contributeAs('binder', () => {
			util.query(uri, 'tag', 'new').enterIsotope('doc', {
				data: { scope: 0, visibleWithin: ['**/demo/**'], desc: 'first' },
				usage: { type: 'declaration' },
			})
			util.query(uri, 'tag', 'new').enterIsotope('doc', {
				data: { desc: 'updated' },
				usage: { type: 'definition' },
			})
		})
		const base = util.global.tag!['new']
		t.assert.equal(base.isotopes?.length, 1)
		t.assert.equal(base.desc, undefined)
		t.assert.equal(base.declaration, undefined)
		t.assert.equal(base.isotopes![0].declaration?.length, 1)
		t.assert.equal(util.query(uri, 'tag', 'new').symbol, base)
		t.assert.equal(SymbolUtil.viewFromContext(base, uri)?.desc, 'updated')
		t.assert.deepEqual(events, ['declaration', 'definition'])
	})
	it('changes visibility before metadata and clears only base locations', t => {
		const base = symbol()
		const util = new SymbolUtil({ tag: { test: base } })
		let removed = 0
		util.on('symbolLocationRemoved', () => removed++)
		util.query(uri, 'tag', 'test').enter({
			data: { visibility: 3, desc: 'must not become base', data: 'secret' },
		})
		t.assert.equal(base.desc, undefined)
		t.assert.equal(base.data, undefined)
		t.assert.equal(base.declaration, undefined)
		t.assert.equal(base.isotopes?.length, 3)
		t.assert.equal(removed, 1)
		util.query(uri, 'tag', 'test').enter({
			data: { visibility: 2, desc: 'new public', data: 'public' },
		})
		t.assert.equal(base.desc, 'new public')
		t.assert.equal(base.data, 'public')
		t.assert.equal(SymbolUtil.viewFromContext(base, 'file:///other')?.desc, 'new public')
	})

	it('never creates restricted base metadata or usages', t => {
		const util = new SymbolUtil({})
		util.query(uri, 'tag', 'restricted').enter({
			data: { visibility: 3, desc: 'secret', data: 'secret' },
			usage: { type: 'declaration' },
		})
		const base = util.global.tag!['restricted']
		t.assert.equal(base.desc, undefined)
		t.assert.equal(base.data, undefined)
		t.assert.equal(base.declaration, undefined)
		t.assert.equal(SymbolUtil.viewFromContext(base, uri), undefined)
	})
	it('defers isotope creation and applies a chained update in order', t => {
		const util = new SymbolUtil({})
		const delayed = util.clone()
		const events: string[] = []
		delayed.on('symbolLocationCreated', event => events.push(event.type))
		const query = delayed.query(uri, 'tag', 'delayed')
		t.assert.equal(
			query.enterIsotope('doc', {
				data: { scope: 0, visibleWithin: ['**'], desc: 'first' },
				usage: { type: 'declaration' },
			}).enterIsotope('doc', {
				data: { desc: 'updated' },
				usage: { type: 'reference' },
			}),
			query,
		)
		t.assert.equal(util.global.tag, undefined)
		t.assert.deepEqual(events, [])
		delayed.applyDelayedEdits()
		const isotope = util.global.tag!['delayed'].isotopes![0]
		t.assert.equal(isotope.desc, 'updated')
		t.assert.equal(isotope.declaration?.length, 1)
		t.assert.equal(isotope.reference?.length, 1)
		t.assert.deepEqual(events, ['declaration', 'reference'])
		delayed.applyDelayedEdits()
		t.assert.deepEqual(events, ['declaration', 'reference'])
	})

	it('does not leak an abandoned isotope update into the shared table', t => {
		const base = symbol()
		const util = new SymbolUtil({ tag: { test: base } })
		const abandoned = util.clone()
		abandoned.query(uri, 'tag', 'test').enterIsotope('isotope1', {
			data: { desc: 'abandoned' },
			usage: { type: 'reference' },
		})
		t.assert.equal(base.isotopes![1].desc, 'first')
		t.assert.equal(base.isotopes![1].reference, undefined)
		const accepted = util.clone()
		accepted.query(uri, 'tag', 'test').enterIsotope('isotope1', {
			data: { desc: 'accepted' },
			usage: { type: 'reference' },
		})
		t.assert.equal(base.isotopes![1].desc, 'first')
		accepted.applyDelayedEdits()
		t.assert.equal(base.isotopes![1].desc, 'accepted')
		t.assert.equal(base.isotopes![1].reference?.length, 1)
	})
	it('migrates covered base locations, respecting isotope priority and preserving provenance', t => {
		const util = new SymbolUtil({})
		const outside = 'file:///pack/data/other/function/test.mcfunction'
		const narrower = 'file:///pack/data/demo/function/narrow.mcfunction'
		util.contributeAs('binder', () => {
			for (const source of [uri, outside, narrower]) {
				util.query(source, 'tag', 'migration').enter({ usage: { type: 'reference' } })
				util.query(source, 'tag', 'migration').enter({ usage: { type: 'definition' } })
			}
		})
		const base = util.global.tag!['migration']
		const reference = base.reference![0]
		const definition = base.definition![0]
		const query = util.query(uri, 'tag', 'migration')
		query.enterIsotope('wide', { data: { scope: 1, visibleWithin: ['**/demo/**'] } })
		query.enterIsotope('narrow', { data: { scope: 0, visibleWithin: ['**/narrow.mcfunction'] } })
		query.migrateDefinitions('wide').migrateDefinitions('wide')
		const wide = base.isotopes![0]
		t.assert.deepEqual(wide.reference, [reference])
		t.assert.deepEqual(wide.implementation, [definition])
		t.assert.equal(wide.implementation![0], definition)
		t.assert.equal(wide.definition, undefined)
		t.assert.deepEqual(base.reference?.map(location => location.uri), [outside, narrower])
		t.assert.deepEqual(base.definition?.map(location => location.uri), [outside, narrower])
		util.clear({ uri, contributor: 'binder' })
		t.assert.equal(base.isotopes?.some(isotope => isotope.identifier === 'wide'), false)
		t.assert.equal(base.reference?.length, 2)
	})

	it('defers migration until the preceding isotope creation has committed', t => {
		const util = new SymbolUtil({})
		util.query(uri, 'tag', 'migration').enter({ usage: { type: 'definition' } })
		const base = util.global.tag!['migration']
		const delayed = util.clone()
		const events: string[] = []
		delayed.on('symbolLocationCreated', event => events.push(event.type))
		delayed.query(uri, 'tag', 'migration').enterIsotope('doc', {
			data: { scope: 0, visibleWithin: ['**/demo/**'] },
		}).migrateDefinitions('doc')
		t.assert.equal(base.definition?.length, 1)
		t.assert.equal(base.isotopes, undefined)
		t.assert.deepEqual(events, [])
		delayed.applyDelayedEdits()
		t.assert.equal(base.definition?.length, 0)
		t.assert.equal(base.isotopes![0].implementation?.length, 1)
		t.assert.deepEqual(events, ['implementation'])
	})
	it('writes public metadata and every usage type to base rather than the matching isotope', t => {
		const base = symbol()
		base.visibility = 3
		delete base.desc
		delete base.declaration
		const util = new SymbolUtil({ tag: { test: base } })
		for (
			const type of [
				'definition',
				'declaration',
				'implementation',
				'reference',
				'typeDefinition',
			] as const
		) {
			util.query(uri, 'tag', 'test').enter({
				data: { visibility: 2, desc: 'public', data: 'base data' },
				usage: { type },
			})
			t.assert.equal(base[type]?.length, 1)
		}
		t.assert.equal(base.desc, 'public')
		t.assert.equal(base.data, 'base data')
		t.assert.equal(base.isotopes![1].desc, 'first')
		t.assert.equal(base.isotopes![1].definition?.[0].uri, 'file:///first')
		t.assert.equal(base.isotopes![1].definition?.length, 1)
		t.assert.equal(base.isotopes![1].reference, undefined)
		t.assert.equal(
			SymbolUtil.isDeclared(util.query('file:///outside', 'tag', 'test').symbol),
			true,
		)
	})
	it('preserves identity and base data in getters and query callbacks', t => {
		const base = symbol()
		base.data = 'base data'
		base.isotopes![1].data = 'isotope data'
		const util = new SymbolUtil({ tag: { test: base } })
		const query = util.query(uri, 'tag', 'test')
		t.assert.equal(query.symbol, query.symbol)
		t.assert.equal(
			query.getData((value): value is string => typeof value === 'string'),
			'base data',
		)
		query.if(value => {
			t.assert.equal(value, base)
			return true
		}, value => {
			t.assert.equal(value, base)
			value!.desc = 'changed'
		})
		t.assert.equal(util.global.tag!['test'].desc, 'changed')
		query.ifDeclared(value => t.assert.equal(value, base))
		util.query(uri, 'tag', 'test').else(value => t.assert.equal(value, base))
		t.assert.equal(SymbolUtil.viewFromContext(query.symbol, uri)?.desc, 'first')
	})

	it('filters inaccessible symbols but returns raw restricted symbols when visible', t => {
		const base = symbol()
		base.visibility = 3
		const util = new SymbolUtil({ tag: { test: base } })
		t.assert.equal(util.query(uri, 'tag', 'test').symbol, base)
		t.assert.equal(util.getVisibleSymbols('tag', uri)['test'], base)
		t.assert.equal(util.query('file:///outside', 'tag', 'test').symbol, undefined)
		t.assert.deepEqual(util.getVisibleSymbols('tag', 'file:///outside'), {})
	})
})
