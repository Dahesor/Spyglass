import * as core from '@spyglassmc/core'
import { getNodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import { mockProjectData, SimpleProject } from '@spyglassmc/core/test/utils.ts'
import * as je from '@spyglassmc/java-edition'
import type { McmetaCommands } from '@spyglassmc/java-edition/lib/dependency/index.js'
import * as mcdoc from '@spyglassmc/mcdoc'
import * as nbt from '@spyglassmc/nbt'
import { memfs } from 'memfs'
import type fsp from 'node:fs/promises'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'

const commands: McmetaCommands = {
	type: 'root',
	children: {
		data: {
			type: 'literal',
			children: {
				get: {
					type: 'literal',
					children: {
						entity: {
							type: 'literal',
							children: {
								target: {
									type: 'argument',
									parser: 'minecraft:entity',
									properties: { amount: 'single', type: 'entities' },
									children: {
										path: {
											type: 'argument',
											parser: 'minecraft:nbt_path',
											executable: true,
										},
									},
								},
							},
						},
					},
				},
				merge: {
					type: 'literal',
					children: {
						entity: {
							type: 'literal',
							children: {
								target: {
									type: 'argument',
									parser: 'minecraft:entity',
									properties: { amount: 'single', type: 'entities' },
									children: {
										nbt: {
											type: 'argument',
											parser: 'minecraft:nbt_compound_tag',
											executable: true,
										},
									},
								},
							},
						},
					},
				},
			},
		},
	},
}

describe('mcdoc command completion', () => {
	it('checks and completes SelectedItem from an unreferenced dependency module after startup and reload', async t => {
		const { fs } = memfs({
			'/root/spyglass.json': JSON.stringify({ env: { dependencies: ['file:///dependency/'] } }),
			'/dependency/player.mcdoc':
				'dispatch minecraft:entity[player] to struct { SelectedItem?: int }',
		}, '/')
		const logger = core.Logger.noop()
		for (let run = 0; run < 2; run++) {
			const service = new core.Service({
				logger,
				project: {
					cacheRoot: 'file:///cache/',
					projectRoots: ['file:///root/'],
					externals: getNodeJsExternals({
						cacheRoot: 'file:///cache/',
						logger,
						nodeFsp: fs.promises as unknown as typeof fsp,
					}),
					defaultConfig: core.ConfigService.merge(core.VanillaConfig, {
						env: { dependencies: [] },
					}),
					initializers: [mcdoc.initialize, ctx => {
						nbt.initialize(ctx)
						je.mcf.initialize(ctx, commands, '1.21.5')
						return { loadedVersion: '1.21.5' }
					}],
				},
			})
			try {
				await service.project.init()
				await service.project.ready()
				const uri = 'file:///root/data/test/function/home.mcfunction'
				const text = 'data get entity @s SelectedItem'
				await service.project.onDidOpen(uri, 'mcfunction', 0, text)
				const result = service.project.getClientManaged(uri)
				if (!result) {
					throw new Error('Missing command document')
				}
				t.assert.deepEqual(core.FileNode.getErrors(result.node), [])
				t.assert.equal(
					service.complete(result.node, result.doc, text.length).some(item =>
						item.label === 'SelectedItem'
					),
					true,
				)
			} finally {
				await service.project.close()
			}
		}
	})
	for (const enableMcdocCaching of [false, true]) {
		it(`completes entity NBT from Global isotope data after cache reload (type caching: ${enableMcdocCaching})`, async t => {
			const meta = new core.MetaRegistry()
			mcdoc.initialize({ meta })
			nbt.initialize(mockProjectData({ meta }))
			const schema = new SimpleProject(meta, [{
				uri: 'file:///entity.mcdoc',
				content:
					'struct Entity { Health?: float, CustomName?: string }\ndispatch minecraft:entity[pig] to Entity',
			}])
			schema.parse()
			await schema.bind()
			const project = {
				...schema.projectData,
				ctx: { loadedVersion: '1.21.5' },
				config: core.ConfigService.merge(core.VanillaConfig, { env: { enableMcdocCaching } }),
			}
			// No duplicate type data on the symbol base: Global is the authoritative storage.
			core.SymbolUtil.forEachSymbol(project.symbolStorage.global, symbol => {
				delete symbol.data
			})
			project.symbolStorage = new core.SymbolStorage(
				core.SymbolTable.deserialize(core.SymbolTable.serialize(project.symbolStorage.global)),
			)
			je.mcf.initialize(project, commands, '1.21.5')
			for (
				const text of ['data merge entity @s {}', 'data merge entity @e[type=pig,limit=1] {}']
			) {
				const doc = TextDocument.create(
					'file:///pack/data/test/function/main.mcfunction',
					'mcfunction',
					0,
					text,
				)
				const parserCtx = core.ParserContext.create(project, { doc })
				const node = core.file(meta.getParserForLanguageId('mcfunction')!)(
					new core.Source(text),
					parserCtx,
				)
				const checkerCtx = core.CheckerContext.create(project, { doc })
				await meta.getChecker(node.type)(core.StateProxy.create(node), checkerCtx)
				const completions = core.completer.file(
					node,
					core.CompleterContext.create(project, {
						doc,
						offset: text.indexOf('{}') + 1,
					}),
				)
				t.assert.deepEqual(parserCtx.err.dump(), [])
				t.assert.deepEqual(checkerCtx.err.dump(), [])
				t.assert.deepEqual(completions.map(item => item.label), ['Health', 'CustomName'])
			}
		})
	}
})
