import { describe, it } from 'node:test'
import type { IsotopeVisibility } from '../../lib/index.js'
import {
	Isotope,
	SymbolIsotopeProvider,
	SymbolIsotopeScope,
	SymbolTable,
	SymbolUtil,
} from '../../lib/index.js'
import { getVisibilityScope, matchesVisibility } from '../../lib/symbol/visibility.js'
import { mockResourceLocation } from '../utils.ts'

const uri = 'file:///pack/data/demo/function/path/subdir/test.mcfunction'

describe('isotope visibility rules', () => {
	it('keeps the direct structured fast path equivalent to the shared matcher', t => {
		for (
			const rule of [{}, { namespace: 'demo' }, { path: '' }, { path: 'path/subdir' }, {
				namespace: 'demo',
				path: 'path/subdir/',
			}]
		) {
			const rules: IsotopeVisibility[] = [rule]
			for (
				const candidate of [
					uri,
					uri.replace('/demo/', '/other/'),
					uri.replace('/subdir/', '/subdir_other/'),
					'file:///unknown',
					'file:///pack/assets/demo/sounds.json',
				]
			) {
				t.assert.equal(
					matchesVisibility(rules, candidate, mockResourceLocation(candidate)),
					getVisibilityScope(rules).matches(candidate, mockResourceLocation(candidate)),
				)
			}
			rules[0].path = 'outside/'
			t.assert.equal(matchesVisibility(rules, uri), false)
		}
	})
	it('combines fields with AND and alternative rules with OR', t => {
		const rules = [{ namespace: 'demo', path: 'path/subdir', glob: '**/test.mcfunction' }, {
			namespace: 'other',
			path: 'allowed/',
		}]
		const scope = getVisibilityScope(rules)
		t.assert.equal(scope.matches(uri, mockResourceLocation(uri)), true)
		t.assert.equal(scope.matches(uri.replace('test.mcfunction', 'another.mcfunction')), false)
		t.assert.equal(scope.matches(uri.replace('/demo/', '/other/')), false)
		t.assert.equal(
			scope.matches('archive://dependency/data/other/function/allowed/test.mcfunction', {
				namespace: 'other',
				path: ['allowed', 'test'],
			}),
			true,
		)
		t.assert.equal(scope.matches(uri, mockResourceLocation(uri)), true)
	})
	it('checks literal directory boundaries and resource contexts independently of URI', t => {
		const rules = [{ namespace: 'demo', path: 'part[1]' }]
		const scope = getVisibilityScope(rules)
		for (const identifier of ['part[1]/file', 'part[1]/child/file']) {
			t.assert.equal(
				scope.matches(uri, { namespace: 'demo', path: identifier.split('/') }),
				true,
			)
		}
		t.assert.equal(
			scope.matches(uri, { namespace: 'demo', path: ['part[1]_other', 'file'] }),
			false,
		)
		t.assert.equal(
			scope.matches(uri, { namespace: 'other', path: ['part[1]', 'file'] }),
			false,
		)
		t.assert.equal(scope.matches(uri), false)
		t.assert.equal(
			scope.matches(uri, { namespace: 'demo', path: ['part[1]', 'file'] }),
			true,
		)
	})
	it('distinguishes absent rules, empty globs and an unconstrained rule', t => {
		t.assert.equal(getVisibilityScope([]).matches(uri, mockResourceLocation(uri)), false)
		t.assert.equal(
			getVisibilityScope([{ glob: '' }]).matches(uri, mockResourceLocation(uri)),
			false,
		)
		t.assert.equal(getVisibilityScope([{}]).matches(uri, mockResourceLocation(uri)), true)
		t.assert.equal(
			getVisibilityScope([{ namespace: 'demo' }]).matches('file:///data/%oops/function/a'),
			false,
		)
	})
	it('shares compiled rules while detecting replacements and nested in-place edits', t => {
		const rules: IsotopeVisibility[] = [{ namespace: 'demo', path: 'path/', glob: '**' }]
		const independent = structuredClone(rules)
		const original = getVisibilityScope(rules)
		t.assert.equal(original, getVisibilityScope(independent))
		t.assert.equal(original.matches(uri, mockResourceLocation(uri)), true)
		rules[0].namespace = 'other'
		t.assert.equal(getVisibilityScope(rules).matches(uri, mockResourceLocation(uri)), false)
		t.assert.equal(getVisibilityScope(independent).matches(uri, mockResourceLocation(uri)), true)
		rules[0].namespace = 'demo'
		rules[0].path = 'outside/'
		t.assert.equal(getVisibilityScope(rules).matches(uri, mockResourceLocation(uri)), false)
		rules[0].path = 'path/'
		rules[0].glob = '**/other.mcfunction'
		t.assert.equal(getVisibilityScope(rules).matches(uri, mockResourceLocation(uri)), false)
		rules[0].glob = '**/test.mcfunction'
		t.assert.equal(getVisibilityScope(rules).matches(uri, mockResourceLocation(uri)), true)
		rules[0] = { namespace: 'other' }
		t.assert.equal(getVisibilityScope(rules).matches(uri, mockResourceLocation(uri)), false)
		rules.push({ namespace: 'demo' })
		t.assert.equal(getVisibilityScope(rules).matches(uri, mockResourceLocation(uri)), true)
		rules.length = 0
		t.assert.equal(getVisibilityScope(rules).matches(uri, mockResourceLocation(uri)), false)
	})
	for (const scope of [SymbolIsotopeScope.Private, SymbolIsotopeScope.Protected]) {
		it(`checks every rule field and survives serialization at scope ${scope}`, t => {
			const util = new SymbolUtil({})
			util.query(uri, 'function', 'demo:test').enterIsotope('doc', {
				data: {
					scope,
					source: SymbolIsotopeProvider.DocBlock,
					visibleWithin: [{
						namespace: 'demo',
						path: 'path/subdir/',
						glob: '**/test.mcfunction',
					}],
				},
				usage: { type: 'declaration' },
			})
			const table = SymbolTable.deserialize(SymbolTable.serialize(util.global))
			const symbol = table.function!['demo:test']
			t.assert.notEqual(Isotope.selectIsotope(symbol, uri, mockResourceLocation), undefined)
			t.assert.equal(
				Isotope.selectIsotope(
					symbol,
					uri.replace('/subdir/', '/subdir_other/'),
					mockResourceLocation,
				),
				undefined,
			)
			t.assert.equal(
				Isotope.selectIsotope(symbol, uri.replace('/demo/', '/other/'), mockResourceLocation),
				undefined,
			)
			t.assert.equal(
				Isotope.selectIsotope(
					symbol,
					uri.replace('/test.mcfunction', '/other.mcfunction'),
					mockResourceLocation,
				),
				undefined,
			)
			const exported = SymbolTable.getDependencyExports(table, 'dep').function?.['demo:test']
			t.assert.equal(!!exported, scope === SymbolIsotopeScope.Protected)
			if (exported) {
				t.assert.notEqual(Isotope.selectIsotope(exported, uri, mockResourceLocation), undefined)
				t.assert.equal(
					Isotope.selectIsotope(
						exported,
						uri.replace('/demo/', '/other/'),
						mockResourceLocation,
					),
					undefined,
				)
			}
		})
	}
})

it('uses ResourceLocation defaults and observes mutable path changes', t => {
	const path = ['private', 'file']
	const location = { namespace: undefined, path }
	const rules = [{ namespace: 'minecraft', path: 'private/' }]
	const scope = getVisibilityScope(rules)
	t.assert.equal(matchesVisibility(rules, uri, location), true)
	t.assert.equal(scope.matches(uri, location), true)
	path[0] = 'outside'
	t.assert.equal(matchesVisibility(rules, uri, location), false)
	t.assert.equal(scope.matches(uri, location), false)
	t.assert.equal(
		scope.matches(uri, { ...location, path: Object.freeze(['private', 'file']) }),
		true,
	)
})

it('ignores tag status in direct and cached visibility checks', t => {
	const location = { namespace: 'demo', path: Object.freeze(['private', 'file']), isTag: false }
	const rules = [{ namespace: 'demo', path: 'private/' }]
	const scope = getVisibilityScope(rules)
	for (const isTag of [false, true, false]) {
		location.isTag = isTag
		t.assert.equal(matchesVisibility(rules, uri, location), true)
		t.assert.equal(scope.matches(uri, location), true)
	}
})

it('supports static and instance visibility APIs with the querying instance resolver', t => {
	const allowed = () => ({ namespace: 'demo', path: ['private', 'file'], isTag: false })
	const denied = () => ({ namespace: 'other', path: ['private', 'file'], isTag: false })
	const first = new SymbolUtil({}, undefined, false, allowed)
	first.query(uri, 'function', 'demo:test').enterIsotope('doc', {
		data: {
			scope: SymbolIsotopeScope.Protected,
			source: SymbolIsotopeProvider.DocBlock,
			visibleWithin: [{ namespace: 'demo' }],
			desc: 'visible',
		},
		usage: { type: 'definition', fromFile: true },
	})
	const symbol = first.global.function!['demo:test']
	const second = new SymbolUtil(first.global, undefined, false, denied)
	for (const util of [first, second, first.clone()]) {
		const resolve = util.resolveResourceLocation!
		const visible = resolve === allowed
		t.assert.equal(util.isVisible(symbol, uri), visible)
		t.assert.equal(util.isVisible(symbol, uri), SymbolUtil.isVisible(symbol, uri, resolve))
		t.assert.deepEqual(
			util.viewFromContext(symbol, uri),
			SymbolUtil.viewFromContext(symbol, uri, resolve),
		)
		t.assert.equal(util.viewFromContext(symbol, uri)?.desc, visible ? 'visible' : undefined)
		t.assert.deepEqual(
			util.filterVisibleSymbols(uri, { test: symbol }),
			visible ? { test: symbol } : {},
		)
		t.assert.deepEqual(
			util.filterVisibleSymbols(uri, { test: symbol }),
			SymbolUtil.filterVisibleSymbols(uri, { test: symbol }, resolve),
		)
		t.assert.equal(util.hasNoAccessToFileSymbol(symbol, uri), !visible)
		t.assert.equal(
			util.hasNoAccessToFileSymbol(symbol, uri),
			SymbolUtil.hasNoAccessToFileSymbol(symbol, uri, resolve),
		)
	}
})
