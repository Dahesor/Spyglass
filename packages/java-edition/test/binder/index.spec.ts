import { UriBinderContext, VanillaConfig } from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	dissectUri,
	registerCustomResources,
	registerResourceLocationResolver,
} from '../../lib/binder/index.js'

describe('dissectUri()', () => {
	const suites: { uri: string; version?: `1.${number}` }[] = [
		{ uri: 'file:///data/minecraft/loot_tables/foo.json' },
		{ uri: 'file:///data/minecraft/loot_table/foo.json', version: '1.21' },
		{ uri: 'file:///data/minecraft/tags/blocks/bar.json' },
		{ uri: 'file:///data/minecraft/tags/blocks/bar.json', version: '1.21' },
		{ uri: 'file:///data/minecraft/tags/block/bar.json' },
		{ uri: 'file:///data/minecraft/tags/block/bar.json', version: '1.21' },
		{ uri: 'file:///data/qux/dimension/foo/baz.json', version: '1.16' },
		{ uri: 'file:///data/minecraft/advancements/data/foo/predicates/bar.json' },
		{ uri: 'file:///pack.mcmeta' },
		{ uri: 'file:///data/loot_tables/foo.json' },
		{ uri: 'file:///data/minecraft/entities/foo.json' },
	]
	for (const { uri, version } of suites) {
		it(`Dissect Uri '${uri}'${version ? ' in ' + version : ''}`, (t) => {
			const ctx = UriBinderContext.create(
				mockProjectData({ roots: ['file:///'], ctx: { loadedVersion: version ?? '1.15' } }),
			)
			t.assert.snapshot(dissectUri(uri, ctx) ?? 'undefined')
		})
	}

	it('Should decode percent-encoding', () => {
		// Even though special characters are illegal in resource locations, we should not show them
		// as percent-encodings when the user uses them.
		const ctx = UriBinderContext.create(
			mockProjectData({ roots: ['file:///'], ctx: { loadedVersion: '1.21' } }),
		)
		const result = dissectUri('file:///data/%23foo/function/%23bar.mcfunction', ctx)
		assert.equal(result?.namespace, '#foo')
		assert.equal(result?.identifier, '#bar')
	})
})

describe('dissectUri() with customResources', () => {
	const suites: { uri: string; version?: `1.${number}` }[] = [
		{ uri: 'file:///data/minecraft/loot_tables/foo.json' },
		{ uri: 'file:///data/minecraft/advancement/foo.json', version: '1.21' },
		{ uri: 'file:///data/qux/biome_modifiers/snowy.json' },
		{ uri: 'file:///data/qux/tags/custom_registry/nested/bar.json' },
	]
	for (const { uri, version } of suites) {
		it(`Dissect Uri '${uri}'${version ? ' in ' + version : ''}`, (t) => {
			const ctx = UriBinderContext.create(
				mockProjectData({
					config: {
						...VanillaConfig,
						env: {
							...VanillaConfig.env,
							customResources: {
								'biome_modifiers': { category: 'fabric:biome_modifier' },
								'tags/custom_registry': { category: 'tag/custom_registry' },
							},
						},
					},
					roots: ['file:///'],
					ctx: { loadedVersion: version ?? '1.15' },
				}),
			)
			registerCustomResources(ctx.config)
			t.assert.snapshot(dissectUri(uri, ctx) ?? 'undefined')
		})
	}
})

describe('resource visibility resolver', () => {
	it('uses canonical resource parsing, including nested types, escapes and custom directories', t => {
		const project = mockProjectData({ ctx: { loadedVersion: '1.21' }, roots: ['file:///'] })
		registerResourceLocationResolver(project.meta)
		const ctx = UriBinderContext.create(project)
		for (
			const path of [
				'function/folder/a.mcfunction',
				'functions/folder/a.mcfunction',
				'tags/function/folder/a.json',
				'worldgen/biome/folder/a.json',
				'tags/worldgen/biome/folder/a.json',
				'function/fold%65r/a.mcfunction',
			]
		) {
			t.assert.deepEqual(
				project.meta.resolveResourceLocation!('file:///pack/data/demo/' + path, ctx),
				{ namespace: 'demo', isTag: path.startsWith('tags/'), path: ['folder', 'a'] },
			)
		}
		t.assert.deepEqual(
			project.meta.resolveResourceLocation!('file:///pack/assets/demo/sounds.json', ctx),
			{ namespace: 'demo', isTag: false, path: ['sounds'] },
		)
		const uri = 'file:///pack/data/demo/visibility_test/nested/folder/a.json'
		t.assert.equal(project.meta.resolveResourceLocation!(uri, ctx), undefined)
		registerCustomResources({
			...VanillaConfig,
			env: {
				...VanillaConfig.env,
				customResources: { 'visibility_test/nested': { category: 'test:visibility' } },
			},
		})
		t.assert.deepEqual(project.meta.resolveResourceLocation!(uri, ctx), {
			namespace: 'demo',
			isTag: false,
			path: ['folder', 'a'],
		})
		t.assert.equal(
			project.meta.resolveResourceLocation!('file:///data/%oops/function/a.mcfunction', ctx),
			undefined,
		)
	})
	it('invalidates a cached result when the project version changes and isolates projects', t => {
		const first = mockProjectData({ ctx: {}, roots: ['file:///'] })
		const second = mockProjectData({ ctx: {}, roots: ['file:///'] })
		registerResourceLocationResolver(first.meta)
		registerResourceLocationResolver(second.meta)
		const uri = 'file:///data/demo/function/folder/a.mcfunction'
		const ctx = UriBinderContext.create(first)
		t.assert.equal(first.meta.resolveResourceLocation!(uri, ctx), undefined)
		first.ctx['loadedVersion'] = '1.21'
		const resolved = first.meta.resolveResourceLocation!(uri, ctx)
		t.assert.deepEqual(resolved, { namespace: 'demo', isTag: false, path: ['folder', 'a'] })
		t.assert.equal(first.meta.resolveResourceLocation!(uri, ctx), resolved)
		t.assert.equal(
			second.meta.resolveResourceLocation!(uri, UriBinderContext.create(second)),
			undefined,
		)
		const clone = first.symbols.clone()
		t.assert.deepEqual(clone.resolveResourceLocation!(uri), resolved)
	})
})
