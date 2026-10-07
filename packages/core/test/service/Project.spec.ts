import { memfs } from 'memfs'
import assert from 'node:assert/strict'
import type fsp from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
	ConfigService,
	EventDispatcher,
	fileUtil,
	GlobalSymbol,
	literal,
	Logger,
	Project,
	resourceLocation,
	Service,
	SymbolTable,
	SymbolUtil,
	UriStore,
	VanillaConfig,
} from '../../lib/index.js'
import type {
	Externals,
	FileWatcher,
	FileWatcherEventMap,
	LiteralNode,
	PosRangeLanguageError,
	ProjectInitializer,
	RootUriString,
} from '../../lib/index.js'
import { getNodeJsExternals } from '../../lib/nodejs.js'
import { mockResourceLocation } from '../utils.ts'

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
	it('keeps archive dependencies separate and publishes once per binding phase', async t => {
		const exports = t.mock.method(SymbolTable, 'getDependencyExports')
		const bound: string[] = []
		const { project } = await setup({
			'/root/spyglass.json': JSON.stringify({ env: { dependencies: ['@first', '@second'] } }),
			'/root/local.spyglasstest': 'foo',
		}, [({ meta, externals }) => {
			externals.archive.decompressBall = async bytes => [{
				path: 'value.spyglasstest',
				type: 'file',
				mode: 0o644,
				mtime: '',
				data: new TextEncoder().encode(bytes[0] === 1 ? 'foo' : 'bar'),
			}]
			for (const [name, id] of [['first', 1], ['second', 2]] as const) {
				meta.registerDependencyProvider(
					`@${name}`,
					() => ({ type: 'tarball-ram', name, data: new Uint8Array([id]) }),
				)
			}
			meta.registerLanguage('spyglasstest', {
				extensions: ['.spyglasstest'],
				parser: literal('foo', 'bar'),
			})
			meta.registerBinder<LiteralNode>('literal', (node, ctx) => {
				bound.push(ctx.doc.uri)
				ctx.symbols.query(ctx.doc, 'function', ctx.doc.uri).enter({
					usage: { type: 'definition' },
				})
				node.symbol = ctx.symbols.global.function![ctx.doc.uri]
			})
		}])
		try {
			assert.deepEqual(bound, [
				'archive://first/value.spyglasstest',
				'archive://second/value.spyglasstest',
				`${ProjectRoot}local.spyglasstest`,
			])
			assert.equal(exports.mock.callCount(), 4)
			for (const { uri, checksum } of project.cacheService.imports) {
				const symbol = project.symbols.global.function![`${uri}value.spyglasstest`]
				assert.equal(symbol.facets?.global?.isotopes?.length, 1)
				assert.equal(symbol.facets?.global?.isotopes?.[0].providerName, checksum)
			}
			const originalUri = 'archive://first/value.spyglasstest'
			// memfs refuses creation with a read-only mode before writing the data.
			const writeFile = project.externals.fs.writeFile.bind(project.externals.fs)
			t.mock.method(
				project.externals.fs,
				'writeFile',
				(...[uri, data, options]: Parameters<typeof writeFile>) =>
					writeFile(uri, data, { ...options, mode: 0o666 }),
			)
			const mappedUri = (await project.fs.mapToDisk(originalUri))!
			assert.ok(mappedUri.includes('/virtual-uris/'))
			const symbolsBefore = SymbolTable.serialize(project.symbols.global)
			const importsBefore = JSON.stringify(project.cacheService.imports)
			const service = Object.assign(Object.create(Service.prototype) as Service, {
				project,
				logger: Logger.noop(),
				isDebugging: false,
			})
			await project.onDidOpen(originalUri, 'spyglasstest', 0, 'bar')
			assert.equal(project.getClientManaged(originalUri), undefined)
			const hashes = t.mock.method(project.fs, 'hash')
			for (let i = 0; i < 2; i++) {
				const boundBefore = bound.length
				await project.onDidOpen(mappedUri, 'plaintext', i, 'bar')
				const opened = await project.ensureClientManagedChecked(mappedUri)
				assert.equal(opened?.doc.uri, originalUri)
				assert.equal(opened?.doc.getText(), 'foo')
				assert.equal(opened?.node.children[0]?.type, 'literal')
				assert.deepEqual(bound.slice(boundBefore), [originalUri])
				assert.equal(hashes.mock.callCount(), 0)
				assert.equal(
					(await service.getDefinitionLocations(opened!.node, opened!.doc, 1))
						?.locations?.[0]?.uri,
					mappedUri,
				)
				await project.onDidChange(mappedUri, [{ text: 'bar' }], i + 1)
				assert.equal(project.getClientManaged(mappedUri)?.doc.getText(), 'foo')
				assert.equal(SymbolTable.serialize(project.symbols.global), symbolsBefore)
				assert.equal(JSON.stringify(project.cacheService.imports), importsBefore)
				project.onDidClose(mappedUri)
				assert.equal(await project.ensureClientManagedChecked(mappedUri), undefined)
			}
			assert.equal(
				project.symbols.global.function![`${ProjectRoot}local.spyglasstest`].facets?.global
					?.isotopes[0].source,
				3,
			)
		} finally {
			await project.close()
		}
	})
	for (const drive of ['C:', 'C%3A']) {
		it(`filters dependency declarations with a noncanonical Windows drive ${drive}`, async () => {
			const { fs } = memfs({
				'/dependency/public.spyglasstest': 'public',
				'/dependency/internal.spyglasstest': 'internal',
				'/dependency/private.spyglasstest': 'private',
			}, '/')
			const originalExternals = getNodeJsExternals({
				cacheRoot: CacheRoot,
				logger: Logger.noop(),
				nodeFsp: fs.promises as unknown as typeof fsp,
			})
			// Model Windows drive aliases while keeping the fixture portable.
			const originalFs = originalExternals.fs
			const path = (uri: { toString(): string }) =>
				uri.toString().replace(/^file:\/\/\/[cC](?::|%3[aA])\//, 'file:///')
			const externals: Externals = {
				...originalExternals,
				fs: {
					...originalFs,
					stat: uri => originalFs.stat(path(uri)),
					readdir: uri => originalFs.readdir(path(uri)),
					readFile: uri => originalFs.readFile(path(uri)),
				},
			}
			const initializer: ProjectInitializer = ({ meta }) => {
				meta.registerLanguage('spyglasstest', {
					extensions: ['.spyglasstest'],
					parser: literal('public', 'internal', 'private'),
				})
				meta.registerUriBinder((uris, ctx) => {
					for (const uri of uris) {
						ctx.symbols.query(uri, 'function', fileUtil.basename(uri)!).enterFileDefinition({
							usage: {},
						})
					}
				})
				meta.registerBinder<LiteralNode>('literal', (node, ctx) => {
					const query = ctx.symbols.query(ctx.doc, 'function', `${node.value}.spyglasstest`)
					const usage = { type: 'declaration' as const, fromDocDeclaration: true }
					if (node.value === 'private') {
						query.enterIsotope('private', {
							data: { source: 0, scope: 0, visibleWithin: [{ glob: '**/dependency/**' }] },
							usage,
						})
					} else {
						query.enter({ data: { scope: node.value === 'public' ? 3 : 2 }, usage })
					}
				})
			}
			const project = new Project({
				cacheRoot: CacheRoot,
				externals,
				logger: Logger.noop(),
				initializers: [initializer],
				projectRoots: [ProjectRoot],
				defaultConfig: ConfigService.merge(VanillaConfig, {
					env: { dependencies: [`file:///${drive}/dependency/`] },
				}),
			})
			try {
				await project.init()
				await project.ready()
				const symbols = project.symbols.global.function!
				assert.equal(symbols['internal.spyglasstest'], undefined)
				assert.equal(symbols['private.spyglasstest'], undefined)
				assert.equal(symbols['public.spyglasstest'].facets?.global?.isotopes[0].source, 1)
				assert.equal(symbols['public.spyglasstest'].facets?.global?.declaration?.length, 1)
				assert.equal(symbols['public.spyglasstest'].facets?.global?.implementation?.length, 1)
				assert.equal(project.cacheService.imports[0].uri, 'file:///c:/dependency/')
			} finally {
				await project.close()
			}
		})
	}
	it('ignores duplicate checksums, prefers cached packages, and adopts a remaining copy', async () => {
		const bound: string[] = []
		const initializer: ProjectInitializer = ({ meta }) => {
			meta.registerLanguage('spyglasstest', {
				extensions: ['.spyglasstest'],
				parser: literal('foo', 'bar'),
			})
			meta.registerBinder<LiteralNode>('literal', (node, ctx) => {
				bound.push(ctx.doc.uri)
				ctx.symbols.query(ctx.doc, 'function', 'demo:duplicate').enter({
					data: { desc: node.value },
					usage: { type: 'definition' },
				})
			})
		}
		const first = 'file:///first/'
		const copy = 'file:///copy/'
		const other = 'file:///other/'
		const { project } = await setup({
			'/root/spyglass.json': JSON.stringify({ env: { dependencies: [first, copy] } }),
			'/first/value.spyglasstest': 'foo',
			'/copy/value.spyglasstest': 'foo',
			'/other/value.spyglasstest': 'bar',
		}, [initializer])
		let reloaded: Project | undefined
		try {
			assert.deepEqual(bound, [`${first}value.spyglasstest`])
			assert.deepEqual(project.cacheService.imports.map(value => value.uri), [first])
			assert.equal(project.getTrackedFiles().includes(`${copy}value.spyglasstest`), false)
			assert.equal(project.roots.includes(copy), false)
			await project.onDidOpen(`${copy}value.spyglasstest`, 'spyglasstest', 0, 'foo')
			assert.deepEqual(bound, [`${first}value.spyglasstest`])
			await project.close()
			await fileUtil.writeFile(
				project.externals,
				`${ProjectRoot}spyglass.json`,
				JSON.stringify({ env: { dependencies: [copy, first] } }),
			)
			reloaded = new Project({
				cacheRoot: CacheRoot,
				externals: project.externals,
				projectRoots: [ProjectRoot],
				logger: Logger.noop(),
				initializers: [initializer],
				defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
			})
			await reloaded.init()
			await reloaded.ready()
			assert.deepEqual(reloaded.cacheService.imports.map(value => value.uri), [first])
			assert.deepEqual(bound, [`${first}value.spyglasstest`])
			reloaded.config = ConfigService.merge(reloaded.config, { env: { dependencies: [first] } })
			await reloaded.restart()
			assert.deepEqual(bound, [`${first}value.spyglasstest`])
			reloaded.config = ConfigService.merge(reloaded.config, {
				env: { dependencies: [copy, other] },
			})
			await reloaded.restart()
			assert.deepEqual(reloaded.cacheService.imports.map(value => value.uri), [copy, other])
			assert.deepEqual(bound, [
				`${first}value.spyglasstest`,
				`${copy}value.spyglasstest`,
				`${other}value.spyglasstest`,
			])
			await reloaded.onDidOpen(`${other}value.spyglasstest`, 'spyglasstest', 0, 'foo')
			assert.deepEqual(reloaded.cacheService.imports.map(value => value.uri), [copy])
			assert.equal(reloaded.shouldExclude(`${other}value.spyglasstest`), true)
			const symbol = reloaded.symbols.global.function!['demo:duplicate']
			assert.equal(symbol.facets?.global?.isotopes?.length, 1)
			assert.equal(
				SymbolUtil.viewFromContext(symbol, ProjectRoot)?.definition?.[0].uri,
				`${copy}value.spyglasstest`,
			)
		} finally {
			await project.close()
			await reloaded?.close()
		}
	})
	it('replaces a cached import when the package at the same URI changes', async () => {
		const initializer: ProjectInitializer = ({ meta }) => {
			meta.registerLanguage('spyglasstest', {
				extensions: ['.spyglasstest'],
				parser: literal('foo', 'bar'),
			})
			meta.registerBinder<LiteralNode>('literal', (node, ctx) => {
				ctx.symbols.query(ctx.doc, 'function', 'demo:cached').enter({
					data: { desc: node.value },
					usage: { type: 'definition' },
				})
			})
		}
		const { project } = await setup({
			'/root/spyglass.json': JSON.stringify({ env: { dependencies: ['file:///dependency/'] } }),
			'/dependency/value.spyglasstest': 'foo',
		}, [initializer])
		let reloaded: Project | undefined
		try {
			await project.close()
			const previous = project.cacheService.imports[0]
			await fileUtil.writeFile(project.externals, 'file:///dependency/value.spyglasstest', 'bar')
			reloaded = new Project({
				cacheRoot: CacheRoot,
				externals: project.externals,
				projectRoots: [ProjectRoot],
				logger: Logger.noop(),
				initializers: [initializer],
				defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
			})
			await reloaded.init()
			await reloaded.ready()
			const current = reloaded.cacheService.imports[0]
			assert.equal(current.uri, previous.uri)
			assert.notEqual(current.checksum, previous.checksum)
			const symbol = reloaded.symbols.global.function!['demo:cached']
			assert.equal(SymbolUtil.viewFromContext(symbol, ProjectRoot)?.desc, 'bar')
			assert.deepEqual(symbol.facets?.global?.isotopes?.map(isotope => isotope.providerName), [
				current.checksum,
			])
		} finally {
			await project.close()
			await reloaded?.close()
		}
	})
	it('imports only dependency exports through spyglass.json and preserves them after cache reload', async () => {
		const names = [
			'public',
			'internal',
			'private',
			'namespace_internal',
			'namespace_restricted',
			'own_internal',
			'shared',
			'internal_shadow',
			'use_dependency',
			'external',
		]
		const bindCount = new Map<string, number>()
		const dependencyReads: boolean[] = []
		const initializer: ProjectInitializer = ({ meta }) => {
			meta.resolveResourceLocation = mockResourceLocation
			meta.registerLanguage('spyglasstest', {
				extensions: ['.spyglasstest'],
				parser: literal(...names),
			})
			meta.registerUriBinder((uris, ctx) => {
				for (const uri of uris.filter(uri => uri.endsWith('.spyglasstest'))) {
					const name = fileUtil.basename(uri).replace('.spyglasstest', '')
					ctx.symbols.query(uri, 'function', `demo:${name}`).enterFileDefinition({ usage: {} })
				}
			})
			meta.registerBinder<LiteralNode>('literal', async (node, ctx) => {
				bindCount.set(ctx.doc.uri, (bindCount.get(ctx.doc.uri) ?? 0) + 1)
				const name = node.value
				const identifier = name === 'internal_shadow' ? 'public' : name
				const query = ctx.symbols.query(
					ctx.doc,
					'function',
					`demo:${identifier}`,
				)
				if (name === 'use_dependency') {
					await ctx.ensureBindingStarted(
						'file:///second_dependency/data/demo/function/external.spyglasstest',
					)
					dependencyReads.push(
						SymbolUtil.isDeclared(
							SymbolUtil.viewFromContext(
								ctx.symbols.query(ctx.doc, 'function', 'demo:external').symbol,
								ctx.doc.uri,
							),
						),
					)
				}
				if (
					name.includes('internal')
					|| (name === 'shared' && ctx.doc.uri.startsWith(ProjectRoot))
				) {
					query.enter({
						data: { scope: 2, desc: 'internal base', data: 'internal data' },
						usage: { type: 'declaration', node, fromDocDeclaration: true },
					})
				} else if (name === 'public' || name === 'shared') {
					query.enter({
						data: { scope: 3, desc: 'public base' },
						usage: { type: 'declaration', node, fromDocDeclaration: true },
					})
				}
				if (name.startsWith('namespace_') || name === 'private') {
					query.enterIsotope(`private:${ctx.doc.uri}`, {
						data: {
							scope: 0,
							visibleWithin: [{ glob: 'file:///dependency/**' }],
							source: 0,
						},
						usage: { type: 'declaration', node, fromDocDeclaration: true },
					})
				}
				if (name.startsWith('namespace_')) {
					query.enterIsotope(`namespace:${ctx.doc.uri}`, {
						data: {
							scope: 1,
							visibleWithin: [{ namespace: 'demo', glob: '**/data/demo/**' }],
							desc: 'namespace documentation',
							source: 0,
						},
						usage: { type: 'declaration', node, fromDocDeclaration: true },
					})
				}
			})
		}
		const files: Record<string, string> = {
			'/root/spyglass.json': JSON.stringify({
				env: {
					dependencies: [
						'file:///dependency/',
						'file:///second_dependency/',
						'file:///hidden_dependency/',
					],
				},
			}),
			'/hidden_dependency/data/demo/function/internal.spyglasstest': 'internal',
			'/root/data/demo/function/own_internal.spyglasstest': 'own_internal',
			'/root/data/demo/function/shared.spyglasstest': 'shared',
			'/second_dependency/data/demo/function/public.spyglasstest': 'internal_shadow',
			'/second_dependency/data/demo/function/external.spyglasstest': 'external',
		}
		for (
			const name of names.filter(name =>
				!['own_internal', 'internal_shadow', 'external'].includes(name)
			)
		) {
			files[`/dependency/data/demo/function/${name}.spyglasstest`] = name
		}
		const { project } = await setup(files, [initializer])
		const assertExports = (project: Project) => {
			const symbols = project.symbols.global.function!
			assert.equal(
				SymbolUtil.viewFromContext(symbols['demo:public'], ProjectRoot)?.desc,
				'public base',
			)
			assert.equal(
				SymbolUtil.viewFromContext(symbols['demo:public'], ProjectRoot)?.implementation?.length,
				1,
			)
			assert.equal(symbols['demo:internal'], undefined)
			assert.equal(symbols['demo:private'], undefined)
			assert.equal(symbols['demo:own_internal'].facets?.internal?.isotopes.length, 1)
			assert.equal(symbols['demo:shared'].facets?.internal?.isotopes.length, 1)
			assert.equal(
				SymbolUtil.viewFromContext(symbols['demo:shared'], ProjectRoot)?.desc,
				'internal base',
			)
			for (const name of ['namespace_internal', 'namespace_restricted']) {
				const symbol = symbols[`demo:${name}`]
				assert.equal(symbol.facets?.global?.isotopes.length ?? 0, 0)
				assert.equal(symbol.data, undefined)
				assert.equal(symbol.facets?.global?.isotopes[0]?.desc, undefined)
				assert.equal(symbol.facets?.global?.implementation?.length ?? 0, 0)
				assert.equal(symbol.facets?.isotopes?.length, 1)
				const view = SymbolUtil.viewFromContext(
					symbol,
					`${ProjectRoot}data/demo/function/use.spyglasstest`,
					project.symbols.resolveResourceLocation,
				)
				assert.equal(view?.desc, 'namespace documentation')
				assert.equal(view?.implementation?.length, 1)
				assert.equal(
					SymbolUtil.viewFromContext(
						symbol,
						`${ProjectRoot}data/other/function/use.spyglasstest`,
						project.symbols.resolveResourceLocation,
					),
					undefined,
				)
			}
		}
		try {
			assertExports(project)
			assert.deepEqual(dependencyReads, [false])
			assert.equal(
				SymbolUtil.isDeclared(SymbolUtil.viewFromContext(
					project.symbols.global.function!['demo:external'],
					ProjectRoot,
				)),
				true,
			)
			await project.close()
			assert.deepEqual(project.cacheService.imports.map(value => value.uri).sort(), [
				'file:///dependency/',
				'file:///hidden_dependency/',
				'file:///second_dependency/',
			])
			const reloaded = new Project({
				cacheRoot: CacheRoot,
				externals: project.externals,
				projectRoots: [ProjectRoot],
				logger: Logger.noop(),
				initializers: [initializer],
				defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
			})
			try {
				await reloaded.init()
				assert.deepEqual(reloaded.cacheService.imports, project.cacheService.imports)
				await reloaded.ready({
					projectRootsWatcher: new TestFileWatcher(project.externals, [ProjectRoot]),
				})
				assertExports(reloaded)
				assert.equal(
					bindCount.get('file:///dependency/data/demo/function/internal.spyglasstest'),
					1,
				)
				assert.equal(
					bindCount.get('file:///hidden_dependency/data/demo/function/internal.spyglasstest'),
					1,
				)
				await reloaded.onDidOpen(
					'file:///dependency/data/demo/function/internal.spyglasstest',
					'spyglasstest',
					0,
					'internal',
				)
				assertExports(reloaded)
				assert.deepEqual(dependencyReads, [false, false])
				reloaded.symbols.query(
					`${ProjectRoot}private/doc.mcfunction`,
					'function',
					'demo:public',
				)
					.enterIsotope('local-doc', {
						data: {
							source: 0,
							scope: 0,
							visibleWithin: [{ glob: `${ProjectRoot}private/**` }],
							desc: 'local private',
						},
						usage: { type: 'declaration', fromDocDeclaration: true },
					})
				const raw = reloaded.symbols.global.function!['demo:public']
				assert.equal(
					SymbolUtil.viewFromContext(raw, `${ProjectRoot}outside.mcfunction`)?.desc,
					'public base',
				)
				reloaded.config = ConfigService.merge(reloaded.config, {
					env: { dependencies: ['file:///second_dependency/'] },
				})
				await reloaded.restart()
				assert.deepEqual(reloaded.cacheService.imports.map(value => value.uri), [
					'file:///second_dependency/',
				])
				assert.equal(reloaded.symbols.global.function!['demo:public'], raw)
				assert.equal(
					SymbolUtil.viewFromContext(raw, `${ProjectRoot}outside.mcfunction`),
					undefined,
				)
				assert.equal(
					SymbolUtil.viewFromContext(raw, `${ProjectRoot}private/use.mcfunction`)?.desc,
					'local private',
				)
			} finally {
				await reloaded.close()
			}
		} finally {
			await project.close()
		}
	})
	it('reports access errors through the project lint pipeline and keeps missing names undeclared', async () => {
		const source = `${ProjectRoot}source.spyglasstest`
		const outside = `${ProjectRoot}outside.spyglasstest`
		const { project, errors } = await setup({ '/root/source.spyglasstest': 'demo:example' }, [
			({ meta }) => {
				meta.registerLanguage('spyglasstest', {
					extensions: ['.spyglasstest'],
					parser: resourceLocation({ category: 'function', usageType: 'reference' }),
				})
				meta.registerUriBinder((uris, ctx) => {
					if (uris.includes(source)) {
						ctx.symbols.query(source, 'function', 'demo:example').enterFileDefinition({
							usage: {},
						})
					}
				})
			},
		])
		try {
			project.config = ConfigService.merge(project.config, { lint: { noAccessToSymbol: false } })
			project.symbols.contributeAs('binder', () => {
				project.symbols.query(
					`${ProjectRoot}private/doc.spyglasstest`,
					'function',
					'demo:example',
				)
					.enterIsotope('private', {
						data: { scope: 0, visibleWithin: [{ glob: '**/private/**' }], source: 0 },
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
			GlobalSymbol.clear(project.symbols, { uri, contributor: 'uri_binder' })
			project.symbols.contributeAs('binder', () => {
				project.symbols.query(
					`${ProjectRoot}other.spyglasstest`,
					'function',
					'test:folder/inner',
				)
					.enterCommand({ usage: { type: 'reference' } })
			})
			await project.onDidOpen(uri, 'spyglasstest', 0, 'foo')
			await project.ensureClientManagedChecked(uri)
			const symbol = project.symbols.global.function!['test:folder/inner']
			assert.equal(symbol.facets?.global?.definition?.length, 1)
			assert.equal(symbol.facets?.global?.definition?.[0].uri, uri)
			assert.equal(symbol.facets?.global?.definition?.[0].fromFile, true)
			assert.equal(symbol.facets?.global?.reference?.length, 1)
			await project.onDidChange(uri, [{ text: 'foo' }], 1)
			assert.equal(symbol.facets?.global?.definition?.length, 1)
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
