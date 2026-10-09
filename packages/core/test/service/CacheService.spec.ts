import { memfs } from 'memfs'
import assert from 'node:assert/strict'
import type fsp from 'node:fs/promises'
import { it } from 'node:test'
import {
	ConfigService,
	fileUtil,
	getSha1,
	Logger,
	Project,
	VanillaConfig,
} from '../../lib/index.js'
import { getNodeJsExternals } from '../../lib/nodejs.js'
import { LatestCacheVersion } from '../../lib/service/CacheService.js'

it('reuses hashes only within the supplied validation pass', async t => {
	const { fs } = memfs({ '/root/spyglass.json': '{}' }, '/')
	const logger = Logger.noop()
	const externals = getNodeJsExternals({
		cacheRoot: 'file:///cache/',
		logger,
		nodeFsp: fs.promises as unknown as typeof fsp,
	})
	const project = new Project({
		cacheRoot: 'file:///cache/',
		projectRoots: ['file:///root/'],
		externals,
		logger,
		defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
	})
	try {
		await project.init()
		await project.ready()
		const uri = 'file:///root/spyglass.json'
		project.cacheService.checksums.files = { [uri]: 'original' }
		const hash = t.mock.method(project.fs, 'hash', async () => 'edited')
		const cached = await project.cacheService.validate(new Map([[uri, 'original']]))
		t.assert.deepEqual(cached.unchangedFiles, [uri])
		t.assert.equal(hash.mock.callCount(), 0)
		const refreshed = await project.cacheService.validate()
		t.assert.deepEqual(refreshed.changedFiles, [uri])
		t.assert.equal(hash.mock.callCount(), 1)
	} finally {
		await project.close()
	}
})

for (
	const [name, version, imports] of [
		['legacy cache without imports', 8, undefined],
	] as const
) {
	it(`rebuilds ${name} without crashing or retaining stale symbols`, async () => {
		const { fs } = memfs({ '/root/spyglass.json': '{}' }, '/')
		const logger = Logger.noop()
		const externals = getNodeJsExternals({
			cacheRoot: 'file:///cache/',
			logger,
			nodeFsp: fs.promises as unknown as typeof fsp,
		})
		const uri = `file:///cache/symbols/${await getSha1('file:///root/')}.json.gz`
		await fileUtil.writeGzippedJson(externals, uri, {
			version,
			imports,
			projectRoots: ['file:///root/'],
			checksums: { files: {}, roots: {}, symbolRegistrars: { stale: 'old-checksum' } },
			symbols: { function: { stale: { definition: [{ uri: 'file:///old.mcfunction' }] } } },
			errors: {},
		})
		const project = new Project({
			cacheRoot: 'file:///cache/',
			projectRoots: ['file:///root/'],
			externals,
			logger,
			defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
		})
		try {
			await project.init()
			assert.deepEqual(project.cacheService.imports, [])
			assert.deepEqual(project.cacheService.checksums.symbolRegistrars, {})
			assert.equal(project.symbolStorage.global.function?.['stale'], undefined)
			await project.ready()
			assert.equal(await project.cacheService.save(), true)
			const saved = await fileUtil.readGzippedJson(externals, uri) as {
				version: number
				imports: unknown
			}
			assert.equal(saved.version, LatestCacheVersion)
			assert.deepEqual(saved.imports, [])
		} finally {
			await project.close()
		}
	})
}

it('round-trips imports and stores only nonempty error lists', async () => {
	const { fs } = memfs({ '/root/spyglass.json': '{}' }, '/')
	const logger = Logger.noop()
	const externals = getNodeJsExternals({
		cacheRoot: 'file:///cache/',
		logger,
		nodeFsp: fs.promises as unknown as typeof fsp,
	})
	const create = () =>
		new Project({
			cacheRoot: 'file:///cache/',
			projectRoots: ['file:///root/'],
			externals,
			logger,
			defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
		})
	const project = create()
	const reloaded = create()
	try {
		await project.init()
		const imports = [{ uri: 'file:///dependency/', checksum: 'package-checksum' }]
		project.cacheService.imports = imports
		const errors = [{
			message: 'test error',
			severity: 3,
			posRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		}]
		project.emit('documentErrored', { uri: 'file:///root/bad', errors })
		project.emit('documentErrored', { uri: 'file:///root/fixed', errors })
		project.emit('documentErrored', { uri: 'file:///root/fixed', errors: [] })
		project.emit('documentErrored', { uri: 'file:///root/clean', errors: [] })
		assert.deepEqual(project.cacheService.getErrors('file:///root/fixed'), [])
		assert.equal(Object.hasOwn(project.cacheService.errors, 'file:///root/clean'), false)
		assert.equal(await project.cacheService.save(), true)
		const uri = `file:///cache/symbols/${await getSha1('file:///root/')}.json.gz`
		const disk = await fileUtil.readGzippedJson(externals, uri) as {
			imports: typeof imports
			errors: Record<string, typeof errors>
		}
		assert.deepEqual(disk.imports, imports)
		assert.deepEqual(disk.errors, { 'file:///root/bad': errors })
		await reloaded.init()
		assert.deepEqual(reloaded.cacheService.imports, imports)
		assert.deepEqual(reloaded.cacheService.getErrors('file:///root/bad'), errors)
		assert.deepEqual(reloaded.cacheService.getErrors('file:///root/clean'), [])
		reloaded.cacheService.reset()
		assert.deepEqual(reloaded.cacheService.imports, [])
		assert.deepEqual(reloaded.cacheService.getErrors('file:///root/bad'), [])
	} finally {
		await project.close()
		await reloaded.close()
	}
})
