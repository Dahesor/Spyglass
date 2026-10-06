import { GlobalSymbol } from '@spyglassmc/core'
import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import { localize } from '@spyglassmc/locales'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { entry, initialize } from '../lib/index.js'
import {
	bindDoc,
	DefaultDocDirective,
	doc as parseDoc,
	registerDocDirective,
} from '../lib/parser/doc.js'

const root = 'file:///pack/data/demo/function/'
function setup() {
	const project = mockProjectData()
	initialize(project)
	function declaration(uri: string, modifier = '@private', sourceText?: string) {
		const text = sourceText ?? `\n#> ${modifier} objective coins 金币`
		const doc = TextDocument.create(uri, 'mcfunction', 0, text)
		const src = new core.Source(text)
		if (text.startsWith('\n')) {
			src.skip()
		}
		const parserCtx = core.ParserContext.create(project, { doc })
		const node = parseDoc(src, parserCtx)
		const ctx = core.BinderContext.create(project, { doc })
		project.symbols.contributeAs('binder', () => bindDoc(node, ctx))
		return { node, errors: [...parserCtx.err.errors, ...ctx.err.errors] }
	}
	function command(uri: string, type: 'definition' | 'reference' = 'definition') {
		const doc = TextDocument.create(uri, 'mcfunction', 0, 'coins')
		const node = core.SymbolNode.mock(0, { category: 'objective', usageType: type })
		node.value = 'coins'
		const ctx = core.BinderContext.create(project, { doc })
		project.symbols.contributeAs('binder', () => core.binder.symbol(node, ctx))
		return node
	}
	const raw = () => project.symbols.global.objective!['coins']
	const view = (uri: string) => core.SymbolUtil.viewFromContext(raw(), uri)
	return { project, declaration, command, raw, view }
}

describe('doc access and command usages', () => {
	it('shares usages between public doc overrides and restores metadata after deleting the winning doc', t => {
		const env = setup()
		class PublicOverride extends DefaultDocDirective {
			override readonly identifier = 'public'
			override readonly isAccessModifier = true
			override modifyAccess() {
				return { visibility: core.SymbolIsotopeScope.Global, overrideLevel: 7 }
			}
		}
		env.declaration(root + 'first.mcfunction', '')
		registerDocDirective(env.project.meta, new PublicOverride())
		const second = root + 'second.mcfunction'
		env.declaration(second, '@public', '\n#> @public objective coins Override documentation')
		env.command(root + 'command.mcfunction')
		t.assert.equal(env.raw().facets?.global?.isotopes.length, 2)
		t.assert.equal(env.view(root)?.desc, ' Override documentation')
		t.assert.equal(env.view(root)?.declaration?.length, 2)
		t.assert.equal(env.view(root)?.implementation?.length, 1)
		GlobalSymbol.clear(env.project.symbols, { uri: second, contributor: 'binder' })
		t.assert.equal(env.view(root)?.desc, ' 金币')
		t.assert.equal(env.view(root)?.declaration?.length, 1)
		t.assert.equal(env.view(root)?.implementation?.length, 1)
	})
	it('keeps multiple Internal declarations in one shared facet ahead of Public', t => {
		const env = setup()
		env.declaration(root + 'public.mcfunction', '@public')
		env.declaration(root + 'internal1.mcfunction', '@internal')
		env.declaration(root + 'internal2.mcfunction', '@internal')
		env.command(root + 'command.mcfunction')
		t.assert.equal(env.raw().facets?.internal?.isotopes.length, 2)
		t.assert.equal(env.raw().facets?.global?.isotopes.length, 1)
		t.assert.equal(env.view(root)?.declaration?.length, 2)
		t.assert.equal(env.view(root)?.implementation?.length, 1)
	})
	for (const docFirst of [false, true]) {
		it(`routes JSON references to their doc facet independent of binding order (doc first: ${docFirst})`, t => {
			const env = setup()
			const doc = TextDocument.create(root + 'private/use.json', 'json', 0, 'demo:value')
			const reference = () => {
				const node = core.ResourceLocationNode.mock(core.Range.create(0, 10), {
					category: 'function',
					usageType: 'reference',
				})
				node.namespace = 'demo'
				node.path = ['value']
				core.binder.resourceLocation(node, core.BinderContext.create(env.project, { doc }))
			}
			const declaration = () =>
				env.declaration(
					root + 'private/doc.mcfunction',
					'@private',
					'\n#> @private function demo:value Documentation',
				)
			if (docFirst) {
				declaration()
				reference()
			} else {
				reference()
				declaration()
			}
			const raw = env.project.symbols.global.function!['demo:value']
			t.assert.equal(core.SymbolUtil.viewFromContext(raw, doc.uri)?.reference?.length, 1)
			t.assert.equal(core.SymbolUtil.viewFromContext(raw, root + 'outside.json'), undefined)
		})
	}
	it('uses directive-provided glob lists instead of deriving a folder in the target', t => {
		const env = setup()
		class CustomPrivate extends DefaultDocDirective {
			override readonly identifier = 'private'
			override readonly isAccessModifier = true
			override modifyAccess() {
				return {
					visibility: core.SymbolIsotopeScope.Private,
					overrideLevel: 7,
					visibleWithin: ['**/allowed/**', '**/second/**'],
				}
			}
		}
		registerDocDirective(env.project.meta, new CustomPrivate())
		t.assert.deepEqual(env.declaration(root + 'source/doc.mcfunction').errors, [])
		t.assert.equal(env.raw().facets?.isotopes![0].scope, core.SymbolIsotopeScope.Private)
		t.assert.equal(env.raw().facets?.isotopes![0].overrideLevel, 7)
		t.assert.notEqual(env.view(root + 'allowed/use.mcfunction'), undefined)
		t.assert.notEqual(env.view(root + 'second/use.mcfunction'), undefined)
		t.assert.equal(env.view(root + 'source/use.mcfunction'), undefined)
	})
	it('uses directive-provided namespace access', t => {
		const env = setup()
		class NamespaceAccess extends DefaultDocDirective {
			override readonly identifier = 'private'
			override readonly isAccessModifier = true
			override modifyAccess() {
				return { visibility: core.SymbolIsotopeScope.Namespace, namespace: 'demo' }
			}
		}
		registerDocDirective(env.project.meta, new NamespaceAccess())
		t.assert.deepEqual(env.declaration(root + 'doc.mcfunction').errors, [])
		t.assert.deepEqual(env.raw().facets?.isotopes![0].namespace, ['demo'])
		t.assert.equal(env.raw().facets?.isotopes![0].scope, core.SymbolIsotopeScope.Namespace)
		t.assert.notEqual(env.view(root + 'use.mcfunction'), undefined)
		t.assert.equal(env.view('file:///pack/data/other/function/use.mcfunction'), undefined)
	})
	for (const commandsFirst of [false, true]) {
		it(`private declaration scopes commands to its folder (commands first: ${commandsFirst})`, t => {
			const env = setup()
			const inside = root + 'private/one.mcfunction'
			const child = root + 'private/sub/two.mcfunction'
			const outside = root + 'private_other/three.mcfunction'
			const commands = () => {
				env.command(inside)
				env.command(child)
				env.command(outside)
			}
			if (commandsFirst) {
				commands()
			}
			t.assert.deepEqual(env.declaration(root + 'private/doc.mcfunction').errors, [])
			if (!commandsFirst) {
				commands()
			}
			t.assert.equal(env.view(inside)?.declaration?.length, 1)
			t.assert.equal(env.view(inside)?.implementation?.length, 2)
			t.assert.equal(env.view(inside)?.definition, undefined)
			t.assert.equal(env.view(outside)?.definition?.length, 1)
			t.assert.equal(env.view(outside)?.declaration?.length ?? 0, 0)
		})
		for (const modifier of ['@public', '@internal', '']) {
			it(`project-wide doc makes every command an implementation (${modifier}, commands first: ${commandsFirst})`, t => {
				const env = setup()
				const commands = () => {
					env.command(root + 'a.mcfunction')
					env.command(root + 'other/b.mcfunction')
				}
				if (commandsFirst) {
					commands()
				}
				t.assert.deepEqual(env.declaration(root + 'doc.mcfunction', modifier).errors, [])
				if (!commandsFirst) {
					commands()
				}
				t.assert.equal(env.view(root)?.declaration?.length, 1)
				t.assert.equal(env.view(root)?.implementation?.length, 2)
				t.assert.equal(env.view(root)?.definition?.length ?? 0, 0)
				t.assert.equal(
					core.Isotope.scopeOf(env.raw(), core.Isotope.selectIsotope(env.raw(), root)!),
					modifier === '@internal'
						? core.SymbolIsotopeScope.Project
						: core.SymbolIsotopeScope.Global,
				)
			})
		}
	}
	it('hides a private-only declaration outside its folder and binds references inside', t => {
		const env = setup()
		env.declaration(root + 'private/doc.mcfunction')
		env.command(root + 'private/ref.mcfunction', 'reference')
		t.assert.equal(env.view(root + 'private/sub/file.mcfunction')?.reference?.length, 1)
		t.assert.equal(env.view(root + 'outside.mcfunction'), undefined)
		t.assert.equal(
			GlobalSymbol.getVisibleSymbols(
				env.project.symbols,
				'objective',
				root + 'outside.mcfunction',
			)['coins'],
			undefined,
		)
	})
	it('restores definitions after deleting the doc source even when references remain', t => {
		const env = setup()
		const source = root + 'private/doc.mcfunction'
		env.declaration(source)
		env.command(root + 'private/command.mcfunction')
		env.command(root + 'private/ref.mcfunction', 'reference')
		GlobalSymbol.clear(env.project.symbols, { uri: source, contributor: 'binder' })
		t.assert.equal(env.raw().facets?.isotopes?.length ?? 0, 0)
		t.assert.equal(env.view(root)?.definition?.length, 1)
		t.assert.equal(env.view(root)?.reference?.length, 1)
		t.assert.equal(env.view(root)?.implementation?.length ?? 0, 0)
	})
	it('private function headers declare the name and hide the file definition outside', t => {
		const env = setup()
		const uri = root + 'private/doc.mcfunction'
		env.project.symbols.contributeAs('uri_binder', () => {
			env.project.symbols.query(uri, 'function', 'demo:private/doc').enterFileDefinition({
				usage: { type: 'definition' },
			})
		})
		t.assert.deepEqual(
			env.declaration(uri, '@private', '#> @private function demo:private/doc description')
				.errors,
			[],
		)
		const symbol = env.project.symbols.global.function!['demo:private/doc']
		t.assert.equal(core.SymbolUtil.viewFromContext(symbol, uri)?.declaration?.length, 1)
		t.assert.equal(core.SymbolUtil.viewFromContext(symbol, uri)?.implementation?.length, 1)
		t.assert.equal(
			core.SymbolUtil.viewFromContext(symbol, root + 'outside.mcfunction'),
			undefined,
		)
		GlobalSymbol.clear(env.project.symbols, { uri, contributor: 'binder' })
		t.assert.equal(symbol.facets?.global?.definition?.length, 1)
		t.assert.equal(symbol.facets?.isotopes?.length ?? 0, 0)
	})

	it('removing internal documentation restores public command definitions', t => {
		const env = setup()
		const uri = root + 'doc.mcfunction'
		env.declaration(uri, '@internal')
		env.command(root + 'command.mcfunction')
		GlobalSymbol.clear(env.project.symbols, { uri, contributor: 'binder' })
		t.assert.equal(env.view(root)?.definition?.length, 1)
		t.assert.equal(env.view(root)?.implementation?.length ?? 0, 0)
		t.assert.equal(env.raw().facets?.internal?.isotopes.length, 0)
		t.assert.equal(env.raw().facets?.global?.isotopes.length, 1)
	})

	it('private folder matching treats glob punctuation literally', t => {
		const env = setup()
		env.declaration(root + 'part[1]/doc.mcfunction')
		t.assert.notEqual(env.view(root + 'part[1]/sub/command.mcfunction'), undefined)
		t.assert.equal(env.view(root + 'part1/command.mcfunction'), undefined)
	})
	it('parses and binds commands with a following private block directive', async t => {
		const env = setup()
		core.binder.registerBinders(env.project.meta)
		const text = 'scoreboard objectives add coins\n#> objective coins 文档\n# @private'
		const doc = TextDocument.create(root + 'private/main.mcfunction', 'mcfunction', 0, text)
		const parser = entry(
			{
				type: 'root',
				children: {
					scoreboard: {
						type: 'literal',
						children: {
							objectives: {
								type: 'literal',
								children: {
									add: {
										type: 'literal',
										children: {
											name: {
												type: 'argument',
												parser: 'test:objective',
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
			() =>
				core.stopBefore(
					core.symbol({ category: 'objective', usageType: 'definition' }),
					core.Whitespaces,
				),
		)
		const parserCtx = core.ParserContext.create(env.project, { doc })
		const node = parser(new core.Source(text), parserCtx)
		if (!node || node === core.Failure) {
			throw new Error('Expected parsed mcfunction')
		}
		const ctx = core.BinderContext.create(env.project, { doc })
		await env.project.symbols.contributeAsAsync(
			'binder',
			async () => env.project.meta.getBinder(node.type)(node, ctx),
		)
		t.assert.deepEqual([...parserCtx.err.errors, ...ctx.err.errors], [])
		t.assert.equal(env.view(doc.uri)?.declaration?.length, 1)
		t.assert.equal(env.view(doc.uri)?.implementation?.length, 1)
		t.assert.equal(env.view(root + 'outside.mcfunction'), undefined)
	})
	it('completes the private declaration and its documentation only inside the folder', t => {
		const env = setup()
		env.declaration(root + 'private/doc.mcfunction')
		const complete = (uri: string) => {
			const doc = TextDocument.create(uri, 'mcfunction', 0, '')
			return core.completer.symbol(
				core.SymbolNode.mock(0, { category: 'objective' }),
				core.CompleterContext.create(env.project, { doc, offset: 0 }),
			)
		}
		t.assert.equal(
			complete(root + 'private/sub/use.mcfunction').some(item => item.label === 'coins'),
			true,
		)
		t.assert.equal(
			complete(root + 'outside.mcfunction').some(item => item.label === 'coins'),
			false,
		)
	})
})

describe('doc directive descriptions', () => {
	function setupDescriptions(t: { after: (fn: () => Promise<unknown>) => void }, text: string) {
		const project = mockProjectData({ logger: core.Logger.noop() })
		const service = new core.Service({
			logger: project.logger,
			project: { cacheRoot: project.cacheRoot, externals: project.externals, projectRoots: [] },
		})
		t.after(() => service.project.close())
		initialize(service.project)
		const doc = TextDocument.create(root + 'doc.mcfunction', 'mcfunction', 0, text)
		const parse = () => {
			const ctx = core.ParserContext.create(service.project, { doc })
			const node = parseDoc(new core.Source(text).skip(), ctx)
			const file: core.FileNode<core.AstNode> = {
				type: 'file',
				range: core.Range.create(0, text.length),
				children: [node],
				locals: {},
				parserErrors: ctx.err.errors,
			}
			core.AstNode.setParents(file)
			return { node, file }
		}
		const complete = (node: core.DeepReadonly<core.AstNode>, offset: number) =>
			service.project.meta.getCompleter('mcfunction:doc')(
				node,
				core.CompleterContext.create(service.project, { doc, offset }),
			)
		return { service, doc, parse, complete }
	}

	for (const inline of [true, false]) {
		const text = inline ? '\n#> @private objective coins' : '\n#> objective coins\n# @private'
		it(`shows the actual built-in directive description in completion and hover (inline: ${inline})`, t => {
			const env = setupDescriptions(t, text)
			const { node, file } = env.parse()
			t.assert.deepEqual(file.parserErrors, [])
			const offset = text.indexOf('@private') + 2
			const expected = localize('mcfunction.doc.directive.desc.private')
			t.assert.notEqual(expected, 'mcfunction.doc.directive.desc.private')
			t.assert.equal(
				env.complete(node, offset).find(item => item.label === '@private')?.documentation,
				expected,
			)
			t.assert.equal(env.service.getHover(file, env.doc, offset)?.markdown, expected)
		})
		it(`joins localized descriptions with rendered line breaks (inline: ${inline})`, t => {
			const env = setupDescriptions(t, text)
			class DescribedPrivate extends DefaultDocDirective {
				override readonly identifier = 'private'
				override readonly isAccessModifier = true
				override get description() {
					return [
						'mcfunction.doc.directive.desc.private',
						'mcfunction.doc.directive.desc.local',
					]
				}
			}
			registerDocDirective(env.service.project.meta, new DescribedPrivate())
			const { node, file } = env.parse()
			const offset = text.indexOf('@private') + 2
			const first = localize('mcfunction.doc.directive.desc.private')
			const second = localize('mcfunction.doc.directive.desc.local')
			const expected = `${first}  \n${second}`
			t.assert.equal(
				env.complete(node, offset).find(item => item.label === '@private')?.documentation,
				expected,
			)
			t.assert.equal(env.service.getHover(file, env.doc, offset)?.markdown, expected)
		})
	}
	for (const keys of [undefined, []]) {
		it(`omits completion documentation and hover when the description is absent or empty (${keys})`, t => {
			const text = '\n#> @private objective coins'
			const env = setupDescriptions(t, text)
			class UndescribedPrivate extends DefaultDocDirective {
				override readonly identifier = 'private'
				override readonly isAccessModifier = true
				override get description() {
					return keys
				}
			}
			registerDocDirective(env.service.project.meta, new UndescribedPrivate())
			const { node, file } = env.parse()
			const offset = text.indexOf('@private') + 2
			t.assert.equal(
				env.complete(node, offset).find(item => item.label === '@private')?.documentation,
				undefined,
			)
			t.assert.equal(env.service.getHover(file, env.doc, offset), undefined)
		})
	}
	it('documents directives suggested after the doc marker', t => {
		const env = setupDescriptions(t, '\n#> ')
		const { node } = env.parse()
		t.assert.equal(
			env.complete(node, env.doc.getText().length).find(item => item.label === '@public')
				?.documentation,
			localize('mcfunction.doc.directive.desc.public'),
		)
	})
	it('provides localized descriptions for all built-in block directives', t => {
		const text = '\n#> function demo:test\n# @'
		const env = setupDescriptions(t, text)
		const { node } = env.parse()
		const completions = env.complete(node, text.length)
		t.assert.equal(completions.some(item => item.label === '@input'), true)
		for (const item of completions) {
			t.assert.equal(typeof item.documentation, 'string')
			t.assert.equal(item.documentation?.includes('mcfunction.doc.directive.desc.'), false)
		}
	})
})
