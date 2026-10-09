import {
	ConfigService,
	FileNode,
	Logger,
	Project,
	SymbolUtil,
	VanillaConfig,
} from '@spyglassmc/core'
import { getNodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import { memfs } from 'memfs'
import type fsp from 'node:fs/promises'
import { it } from 'node:test'
import { TypeDefSymbolData } from '../lib/binder/index.js'
import { initialize } from '../lib/index.js'

it('loads unreferenced dependency dispatchers on first startup and after cache reload', async t => {
	const { fs } = memfs({
		'/root/spyglass.json': JSON.stringify({ env: { dependencies: ['file:///dependency/'] } }),
		'/dependency/player.mcdoc':
			'dispatch minecraft:entity[player] to struct { SelectedItem?: int }',
	}, '/')
	const logger = Logger.noop()
	for (let run = 0; run < 2; run++) {
		const project = new Project({
			cacheRoot: 'file:///cache/',
			projectRoots: ['file:///root/'],
			logger,
			externals: getNodeJsExternals({
				cacheRoot: 'file:///cache/',
				logger,
				nodeFsp: fs.promises as unknown as typeof fsp,
			}),
			defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
			initializers: [initialize],
		})
		try {
			await project.init()
			await project.ready()
			const player = project.symbolStorage.global['mcdoc/dispatcher']?.['minecraft:entity']
				?.members
				?.['player']
			const data = SymbolUtil.getCanonicalData(player)
			if (!TypeDefSymbolData.is(data) || data.typeDef.kind !== 'struct') {
				throw new Error('Missing player dispatcher type')
			}
			t.assert.equal(
				data.typeDef.fields.some(field =>
					field.kind === 'pair' && field.key === 'SelectedItem'
				),
				true,
			)
			t.assert.equal(player?.facets?.global?.definition?.length, 1)
		} finally {
			await project.close()
		}
	}
})

it('resolves public mcdoc types across separate dependency packages', async t => {
	const { fs } = memfs({
		'/root/spyglass.json': JSON.stringify({
			env: { dependencies: ['file:///first/', 'file:///second/'] },
		}),
		'/first/a.mcdoc': 'use ::b::Value\ntype Own = Value',
		'/second/b.mcdoc': 'type Value = int\ndispatch minecraft:item[example] to int',
	}, '/')
	const logger = Logger.noop()
	const project = new Project({
		cacheRoot: 'file:///cache/',
		projectRoots: ['file:///root/'],
		logger,
		externals: getNodeJsExternals({
			cacheRoot: 'file:///cache/',
			logger,
			nodeFsp: fs.promises as unknown as typeof fsp,
		}),
		defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
		initializers: [initialize],
	})
	const errors: string[] = []
	project.on(
		'documentUpdated',
		({ node }) => errors.push(...FileNode.getErrors(node).map(error => error.message)),
	)
	try {
		await project.init()
		await project.ready()
		await project.onDidOpen(
			'file:///root/main.mcdoc',
			'mcdoc',
			0,
			'use ::a::Own\ntype Result = Own',
		)
		t.assert.deepEqual(errors, [])
		t.assert.equal(
			project.symbolStorage.global.mcdoc!['::a::Own']?.facets?.global?.definition?.length,
			1,
		)
		t.assert.equal(
			project.symbolStorage.global.mcdoc!['::b::Value']?.facets?.global?.definition?.length,
			1,
		)
		t.assert.equal(
			project.symbolStorage.global.mcdoc!['::a::Own']
				?.facets?.global?.reference?.some(location =>
					location.uri === 'file:///root/main.mcdoc'
				),
			true,
		)
		const assertBaseSymbols = () => {
			for (const identifier of ['::a::Own', '::b::Value']) {
				const symbol = project.symbolStorage.global.mcdoc![identifier]
				t.assert.notEqual(symbol.data, undefined)
				t.assert.equal(symbol.facets?.isotopes, undefined)
			}
			const member =
				project.symbolStorage.global['mcdoc/dispatcher']!['minecraft:item'].members!['example']
			t.assert.notEqual(member.data, undefined)
			t.assert.equal(member.facets?.global?.definition?.length, 1)
			t.assert.equal(member.facets?.isotopes, undefined)
		}
		assertBaseSymbols()
		await project.onDidOpen(
			'file:///second/b.mcdoc',
			'mcdoc',
			0,
			'type Value = int\ndispatch minecraft:item[example] to int',
		)
		assertBaseSymbols()
	} finally {
		await project.close()
	}
})
