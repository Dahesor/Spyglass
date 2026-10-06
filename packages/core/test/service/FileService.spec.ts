import { memfs } from 'memfs'
import type fsp from 'node:fs/promises'
import { it, type TestContext } from 'node:test'
import { FileService, Logger, normalizeUri } from '../../lib/index.js'
import { getNodeJsExternals } from '../../lib/nodejs.js'

it('resolves mapped dependency views with VS Code Windows URI spelling', async (t: TestContext) => {
	const { fs } = memfs({}, '/')
	const externals = getNodeJsExternals({
		logger: Logger.noop(),
		nodeFsp: fs.promises as unknown as typeof fsp,
	})
	const writeFile = externals.fs.writeFile.bind(externals.fs)
	t.mock.method(
		externals.fs,
		'writeFile',
		(...[uri, data, options]: Parameters<typeof writeFile>) =>
			writeFile(uri, data, { ...options, mode: 0o666 }),
	)
	const service = FileService.create(externals, 'file:///C:/Users/example/cache/')
	const original = 'archive://dependency/data/demo/function/example.mcfunction'
	service.register('archive:', {
		hash: async () => 'hash',
		readFile: async () => new TextEncoder().encode('function demo:next'),
		listFiles: () => [original],
		listRoots: () => ['archive://dependency/'],
	})
	const mapped = await service.mapToDisk(original)
	t.assert.ok(mapped)
	for (const drive of ['c:', 'C:', 'c%3A', 'C%3A']) {
		const editorUri = mapped.replace(/\/[cC]:\//, `/${drive}/`)
		t.assert.equal(service.mapFromDisk(normalizeUri(editorUri)), original)
		t.assert.equal(service.mapFromDisk(editorUri), original)
	}
})
