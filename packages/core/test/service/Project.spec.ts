import { memfs } from 'memfs'
import assert from 'node:assert/strict'
import type fsp from 'node:fs/promises'
import { describe, it } from 'node:test'
import type {
	Externals,
	FileWatcher,
	FileWatcherEventMap,
	LiteralNode,
	PosRangeLanguageError,
	ProjectInitializer,
	RootUriString,
} from '../../lib/index.js'
import {
	ConfigService,
	EventDispatcher,
	fileUtil,
	literal,
	Logger,
	Project,
	resourceLocation,
	UriStore,
	VanillaConfig,
} from '../../lib/index.js'
import { getNodeJsExternals } from '../../lib/nodejs.js'

const CacheRoot: RootUriString = 'file:///cache/'
const ProjectRoot: RootUriString = 'file:///root/'
const TestCheckerMessage = 'Test checker error'

/**
 * A {@link FileWatcher} that populates its file store with the files that exist under the watched
 * locations when {@link ready} is called, similarly to the initial scan of the language server's
 * `LspFileWatcher`, and never reports any changes.
 */
class TestFileWatcher extends EventDispatcher<FileWatcherEventMap> implements FileWatcher {
	readonly #externals: Externals
	readonly #locations: readonly RootUriString[]
	readonly #watchedFiles = new UriStore()

	constructor(externals: Externals, locations: readonly RootUriString[]) {
		super()
		this.#externals = externals
		this.#locations = locations
	}

	get watchedFiles(): UriStore {
		return this.#watchedFiles
	}

	async ready(): Promise<void> {
		for (const location of this.#locations) {
			for (const uri of await fileUtil.getAllFiles(this.#externals, location)) {
				this.#watchedFiles.add(uri)
			}
		}
		this.emit('ready', undefined)
	}

	async close(): Promise<void> {}
}

/**
 * Registers a language `spyglasstest` for `.spyglasstest` files, the content of which must be the
 * literal `foo`, along with a checker that always reports {@link TestCheckerMessage}.
 */
const testLanguageInitializer: ProjectInitializer = ({ meta }) => {
	meta.registerLanguage('spyglasstest', {
		extensions: ['.spyglasstest'],
		parser: literal('foo'),
	})
	meta.registerChecker<LiteralNode>('literal', (node, ctx) => {
		ctx.err.report(TestCheckerMessage, node)
	})
}

interface SetupResult {
	errors: Map<string, readonly PosRangeLanguageError[]>
	project: Project
}

async function setup(
	files: Record<string, string>,
	initializers: ProjectInitializer[] = [],
): Promise<SetupResult> {
	const { fs } = memfs(files, '/')
	const externals = getNodeJsExternals({
		cacheRoot: CacheRoot,
		logger: Logger.noop(),
		nodeFsp: fs.promises as unknown as typeof fsp,
	})

	const project = new Project({
		cacheRoot: CacheRoot,
		defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
		externals,
		initializers: [testLanguageInitializer, ...initializers],
		logger: Logger.noop(),
		projectRoots: [ProjectRoot],
	})
	const errors = new Map<string, readonly PosRangeLanguageError[]>()
	project.on('documentErrored', ({ uri, errors: documentErrors }) => {
		errors.set(uri, documentErrors)
	})

	await project.init()
	await project.ready({
		projectRootsWatcher: new TestFileWatcher(externals, [ProjectRoot]),
	})

	return { errors, project }
}

describe('Project', () => {
	it('reports access errors through the project lint pipeline and keeps missing names undeclared', async () => {
		const source = `${ProjectRoot}source.spyglasstest`
		const outside = `${ProjectRoot}outside.spyglasstest`
		const { project, errors } = await setup({ '/root/source.spyglasstest': 'demo:example' }, [({ meta }) => {
			meta.registerLanguage('spyglasstest', {
				extensions: ['.spyglasstest'],
				parser: resourceLocation({ category: 'function', usageType: 'reference' }),
			})
			meta.registerUriBinder((uris, ctx) => {
				if (uris.includes(source)) {
					ctx.symbols.query(source, 'function', 'demo:example').enterFileDefinition({ usage: {} })
				}
			})
		}])
		try {
			project.config = ConfigService.merge(project.config, { lint: { noAccessToSymbol: false } })
			project.symbols.contributeAs('binder', () => {
				project.symbols.query(`${ProjectRoot}private/doc.spyglasstest`, 'function', 'demo:example')
					.enterIsotope('private', {
						data: { scope: 0, visibleWithin: ['**/private/**'], docDeclaration: true },
						usage: { type: 'declaration', fromDocDeclaration: true },
					})
			})
			await project.onDidOpen(outside, 'spyglasstest', 0, 'demo:example')
			await project.ensureClientManagedChecked(outside)
			assert.equal(errors.get(outside)?.length, 1)
			assert.ok(errors.get(outside)?.[0].message.includes('noAccessToSymbol'))
			assert.equal(errors.get(outside)?.[0].info?.codeAction, undefined)
			const inside = `${ProjectRoot}private/use.spyglasstest`
			await project.onDidOpen(inside, 'spyglasstest', 0, 'demo:example')
			await project.ensureClientManagedChecked(inside)
			assert.deepEqual(errors.get(inside), [])
			await project.onDidChange(outside, [{ text: 'demo:missing' }], 1)
			await project.ensureClientManagedChecked(outside)
			assert.equal(errors.get(outside)?.length, 1)
			assert.ok(errors.get(outside)?.[0].message.includes('undeclaredSymbol'))
		} finally {
			await project.close()
		}
	})
	it('restores missing file definitions before rebinding an edited document', async () => {
		const uri = `${ProjectRoot}inner.spyglasstest`
		const { project } = await setup({ '/root/inner.spyglasstest': 'foo' }, [({ meta }) => {
			meta.registerUriBinder((uris, ctx) => {
				for (const fileUri of uris) {
					ctx.symbols.query(fileUri, 'function', 'test:folder/inner').enterFileDefinition({
						usage: { type: 'definition' },
					})
				}
			})
		}])
		try {
			project.symbols.clear({ uri, contributor: 'uri_binder' })
			project.symbols.contributeAs('binder', () => {
				project.symbols.query(`${ProjectRoot}other.spyglasstest`, 'function', 'test:folder/inner')
					.enterCommand({ usage: { type: 'reference' } })
			})
			await project.onDidOpen(uri, 'spyglasstest', 0, 'foo')
			await project.ensureClientManagedChecked(uri)
			const symbol = project.symbols.global.function!['test:folder/inner']
			assert.equal(symbol.definition?.length, 1)
			assert.equal(symbol.definition?.[0].uri, uri)
			assert.equal(symbol.definition?.[0].fromFile, true)
			assert.equal(symbol.reference?.length, 1)
			await project.onDidChange(uri, [{ text: 'foo' }], 1)
			assert.equal(symbol.definition?.length, 1)
		} finally {
			await project.close()
		}
	})
	describe('analyzeProject()', () => {
		it('Should check all files and emit their errors', async () => {
			const uriA = `${ProjectRoot}a.spyglasstest`
			const uriB = `${ProjectRoot}b.spyglasstest`
			const { errors, project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			})
			try {
				assert.deepEqual(errors.get(uriA), [])
				assert.deepEqual(errors.get(uriB), [])
				const result = await project.analyzeProject()

				assert.deepEqual(result, { analyzedFiles: 2, cancelled: false, totalFiles: 2 })
				for (const uri of [uriA, uriB]) {
					assert.deepEqual(
						errors.get(uri)?.map((e) => e.message),
						[TestCheckerMessage],
					)
				}
			} finally {
				await project.close()
			}
		})

		it('Should report progress and support cancellation', async () => {
			const { project } = await setup({
				'/root/a.spyglasstest': 'foo',
				'/root/b.spyglasstest': 'foo',
			})
			try {
				const controller = new AbortController()
				const progress: [number, number][] = []
				const result = await project.analyzeProject({
					onProgress: (done, total) => {
						progress.push([done, total])
						if (done === 1) {
							controller.abort()
						}
					},
					signal: controller.signal,
				})

				assert.deepEqual(result, { analyzedFiles: 1, cancelled: true, totalFiles: 2 })
				assert.deepEqual(progress, [[1, 2]])
			} finally {
				await project.close()
			}
		})
	})
})
