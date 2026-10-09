import * as core from '@spyglassmc/core'
import { mockProjectData, mockResourceLocation } from '@spyglassmc/core/test/utils.ts'
import { localeQuote, localize } from '@spyglassmc/locales'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { completeDoc } from '../lib/completer/doc.js'
import { entry, initialize } from '../lib/index.js'
import type { DocDirectiveNode, DocNode } from '../lib/node/doc.js'
import type {
	DocDirectiveHandlerContext,
	DocDirectiveParserContext,
	DocDirectiveSuggestCtx,
} from '../lib/parser/doc.js'
import {
	bindDoc,
	DefaultDocDirective,
	doc as parseDoc,
	registerDocDirective,
} from '../lib/parser/doc.js'
import { ReturnsDocDirective } from '../lib/parser/doc/directives.js'

const root = 'file:///pack/data/demo/function/'

describe('function header completion', () => {
	function complete(
		marked: string,
		project = mockProjectData(),
		uri = root + 'folder/self.mcfunction',
		symbols = new core.SymbolService(project.symbolStorage),
	) {
		initialize(project)
		class RequiredDirective extends DefaultDocDirective {
			override readonly identifier = 'required'
			override readonly hasMandatoryArgument = true
		}
		registerDocDirective(project.meta, new RequiredDirective())
		const offset = marked.indexOf('|')
		const text = marked.replace('|', '')
		const doc = TextDocument.create(uri, 'mcfunction', 0, text)
		const node = parseDoc(new core.Source(text), core.ParserContext.create(project, { doc }))
		return completeDoc(node, core.CompleterContext.create(project, { doc, offset, symbols }))
	}
	for (const marked of ['#>|', '#>   |', '#>@private |', '#>@private @chatonly |']) {
		it('puts THIS and function before usable inline directives: ' + marked, t => {
			const items = complete(marked)
			t.assert.deepEqual(items.slice(0, 2).map(item => item.label), ['THIS', 'function'])
			t.assert.equal(items[0].insertText, 'demo:folder/self')
			t.assert.equal(items[0].sortText! < items[1].sortText!, true)
			t.assert.equal(items.some(item => item.label === '@override'), true)
			t.assert.equal(items.some(item => item.label === '@private'), !marked.includes('@private'))
			t.assert.equal(
				items.some(item => item.label === '@chatonly'),
				!marked.includes('@chatonly'),
			)
			t.assert.equal(items.some(item => item.label === '@required'), false)
			t.assert.equal(items.some(item => item.label === '@result'), false)
			t.assert.equal(
				items.filter(item => item.label.startsWith('@')).every(item =>
					item.sortText! > items[1].sortText!
				),
				true,
			)
		})
	}
	for (
		const marked of ['#>function |', '#>function demo:|', '#>demo:|', '#>@private function |']
	) {
		it('only suggests the current function in header arguments: ' + marked, t => {
			const items = complete(marked)
			t.assert.deepEqual(items.map(item => item.label), ['THIS'])
			t.assert.equal(items[0].insertText, 'demo:folder/self')
		})
	}
	for (const marked of ['#>@|', '#>@p|', '#>@private @|']) {
		it('offers directives immediately after @: ' + marked, t => {
			const labels = complete(marked).map(item => item.label)
			t.assert.equal(labels.includes('@protected'), true)
			t.assert.equal(labels.includes('@chatonly'), true)
			t.assert.equal(labels.includes('@private'), !marked.includes('@private'))
		})
	}
	it('does not visit unrelated functions in a large symbol table', t => {
		const project = mockProjectData()
		for (let i = 0; i < 2000; i++) {
			new core.SymbolService(project.symbolStorage).query(
				root + `other${i}.mcfunction`,
				'function',
				`demo:other${i}`,
			).enter({
				usage: { type: 'definition', fromFile: true },
			})
		}
		const currentUri = root + 'folder/self.mcfunction'
		new core.SymbolService(project.symbolStorage).query(
			currentUri,
			'function',
			'demo:custom/self',
		).enter({
			usage: { type: 'definition', fromFile: true },
		})
		for (const symbol of Object.values(project.symbolStorage.global.function!)) {
			if (symbol.identifier !== 'demo:custom/self') {
				Object.defineProperty(symbol, 'facets', {
					get() {
						throw new Error('Unrelated function visited')
					},
				})
			}
		}
		const symbols = new core.SymbolService(project.symbolStorage)
		symbols.getScopedSymbols = () => {
			throw new Error('Global completion pool requested')
		}
		const items = complete('#>function |', project, currentUri, symbols)
		t.assert.deepEqual(items.map(item => item.label), ['THIS'])
		t.assert.equal(items[0].insertText, 'demo:custom/self')
	})
	it('does not inspect unrelated directive subtrees when completing header arguments', t => {
		const project = mockProjectData()
		initialize(project)
		const text = '#>function \n' + '# @chatonly\n'.repeat(2048)
		const doc = TextDocument.create(root + 'self.mcfunction', 'mcfunction', 0, text)
		const node = parseDoc(new core.Source(text), core.ParserContext.create(project, { doc }))
		let rangesRead = 0
		for (const directive of node.docDirectives) {
			const range = directive.range
			Object.defineProperty(directive, 'range', {
				get() {
					rangesRead++
					return range
				},
			})
			for (const key of ['docDirectives', 'argumentSuggestions']) {
				Object.defineProperty(directive, key, {
					get() {
						throw new Error('Unrelated directive inspected')
					},
				})
			}
		}
		const items = completeDoc(node, core.CompleterContext.create(project, { doc, offset: 11 }))
		t.assert.deepEqual(items.map(item => item.label), ['THIS'])
		t.assert.equal(rangesRead < 50, true)
	})
})
function setup() {
	const project = mockProjectData()
	project.meta.resolveResourceLocation = mockResourceLocation
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
		ctx.symbols.contributeAs('binder', () => bindDoc(node, ctx))
		return { node, errors: [...parserCtx.err.errors, ...ctx.err.errors] }
	}
	function command(uri: string, type: 'definition' | 'reference' = 'definition') {
		const doc = TextDocument.create(uri, 'mcfunction', 0, 'coins')
		const node = core.SymbolNode.mock(0, { category: 'objective', usageType: type })
		node.value = 'coins'
		const ctx = core.BinderContext.create(project, { doc })
		ctx.symbols.contributeAs('binder', () => core.binder.symbol(node, ctx))
		return node
	}
	const raw = () => project.symbolStorage.global.objective!['coins']
	const view = (uri: string) =>
		core.SymbolUtil.viewFromContext(raw(), uri, project.symbolStorage.resolveResourceLocation)
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
		new core.SymbolService(env.project.symbolStorage).clear({
			uri: second,
			contributor: 'binder',
		})
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
			const raw = env.project.symbolStorage.global.function!['demo:value']
			t.assert.equal(core.SymbolUtil.viewFromContext(raw, doc.uri)?.reference?.length, 1)
			t.assert.equal(core.SymbolUtil.viewFromContext(raw, root + 'outside.json'), undefined)
		})
	}
	it('uses directive-provided visibility alternatives instead of deriving a folder in the target', t => {
		const env = setup()
		class CustomPrivate extends DefaultDocDirective {
			override readonly identifier = 'private'
			override readonly isAccessModifier = true
			override modifyAccess() {
				return {
					visibility: core.SymbolIsotopeScope.Private,
					overrideLevel: 7,
					visibleWithin: [{ glob: '**/allowed/**' }, { glob: '**/second/**' }],
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
				return {
					visibility: core.SymbolIsotopeScope.Protected,
					visibleWithin: [{ namespace: 'demo' }],
				}
			}
		}
		registerDocDirective(env.project.meta, new NamespaceAccess())
		t.assert.deepEqual(env.declaration(root + 'doc.mcfunction').errors, [])
		t.assert.deepEqual(env.raw().facets?.isotopes![0].visibleWithin, [{ namespace: 'demo' }])
		t.assert.equal(env.raw().facets?.isotopes![0].scope, core.SymbolIsotopeScope.Protected)
		t.assert.notEqual(env.view(root + 'use.mcfunction'), undefined)
		t.assert.equal(env.view('file:///pack/data/other/function/use.mcfunction'), undefined)
	})
	it('exports protected declarations while restricting consumers to the declaring namespace', t => {
		const env = setup()
		t.assert.deepEqual(env.declaration(root + 'doc.mcfunction', '@protected').errors, [])
		t.assert.deepEqual(env.raw().facets?.isotopes?.[0].visibleWithin, [{ namespace: 'demo' }])
		const exported = core.SymbolTable.getDependencyExports(
			env.project.symbolStorage.global,
			'dependency',
		)
		const symbol = exported.objective!['coins']
		t.assert.notEqual(
			core.Isotope.selectIsotope(
				symbol,
				'file:///consumer/data/demo/function/use.mcfunction',
				mockResourceLocation,
			),
			undefined,
		)
		t.assert.equal(
			core.Isotope.selectIsotope(
				symbol,
				'file:///consumer/data/other/function/use.mcfunction',
				mockResourceLocation,
			),
			undefined,
		)
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
			new core.SymbolService(env.project.symbolStorage).getVisibleSymbols(
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
		new core.SymbolService(env.project.symbolStorage).clear({
			uri: source,
			contributor: 'binder',
		})
		t.assert.equal(env.raw().facets?.isotopes?.length ?? 0, 0)
		t.assert.equal(env.view(root)?.definition?.length, 1)
		t.assert.equal(env.view(root)?.reference?.length, 1)
		t.assert.equal(env.view(root)?.implementation?.length ?? 0, 0)
	})
	it('private function headers declare the name and hide the file definition outside', t => {
		const env = setup()
		const uri = root + 'private/doc.mcfunction'
		const symbols = new core.SymbolService(env.project.symbolStorage)
		symbols.contributeAs('uri_binder', () => {
			symbols.query(uri, 'function', 'demo:private/doc').enter({
				usage: { type: 'definition' },
			}, core.SymbolEnterType.File)
		})
		t.assert.deepEqual(
			env.declaration(uri, '@private', '#> @private function demo:private/doc description')
				.errors,
			[],
		)
		const symbol = env.project.symbolStorage.global.function!['demo:private/doc']
		t.assert.equal(core.SymbolUtil.viewFromContext(symbol, uri)?.declaration?.length, 1)
		t.assert.equal(core.SymbolUtil.viewFromContext(symbol, uri)?.implementation?.length, 1)
		t.assert.equal(
			core.SymbolUtil.viewFromContext(symbol, root + 'outside.mcfunction'),
			undefined,
		)
		new core.SymbolService(env.project.symbolStorage).clear({
			uri,
			contributor: 'binder',
		})
		t.assert.equal(symbol.facets?.global?.definition?.length, 1)
		t.assert.equal(symbol.facets?.isotopes?.length ?? 0, 0)
	})

	it('removing internal documentation restores public command definitions', t => {
		const env = setup()
		const uri = root + 'doc.mcfunction'
		env.declaration(uri, '@internal')
		env.command(root + 'command.mcfunction')
		new core.SymbolService(env.project.symbolStorage).clear({
			uri,
			contributor: 'binder',
		})
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
		await ctx.symbols.contributeAsAsync(
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
		const env = setupDescriptions(t, '\n#> @')
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
			t.assert.equal(
				item.documentation?.includes('mcfunction.doc.directive.desc.'),
				false,
				item.label,
			)
		}
	})
})

describe('multiple inline doc directives', () => {
	for (const prefix of ['', '\n']) {
		it(`parses multiple inline directives (prefix: ${JSON.stringify(prefix)})`, t => {
			const env = setup()
			const text = prefix + '#> @private @chatonly @override function demo:test Description'
			const doc = TextDocument.create(root + 'doc.mcfunction', 'mcfunction', 0, text)
			const ctx = core.ParserContext.create(env.project, { doc })
			const node = parseDoc(new core.Source(text).skip(prefix.length), ctx)
			const errors = ctx.err.errors
			t.assert.deepEqual(errors, [])
			t.assert.equal(node.valid, true)
			t.assert.equal(node.directive.value, 'function')
			t.assert.deepEqual(node.docDirectives.map(d => [d.identifier, d.arguments, d.valid]), [
				['private', [], true],
				['chatonly', [], true],
				['override', [], true],
			])
		})
	}
	it('rejects inline directives requiring arguments', t => {
		const env = setup()
		class Required extends DefaultDocDirective {
			override readonly identifier = 'required'
			override readonly hasMandatoryArgument = true
		}
		registerDocDirective(env.project.meta, new Required())
		const { node, errors } = env.declaration(
			root + 'doc.mcfunction',
			'',
			'\n#> @private @required function demo:test',
		)
		t.assert.equal(node.valid, false)
		t.assert.equal(errors.length, 1)
		t.assert.equal(errors[0]?.message, localize('mcfunction.doc.directive.diagnostic.inline'))
	})
	for (const text of ['\n#> ', '\n#> @private ', '\n#> @private @ch function demo:test']) {
		it('completes targets and non-access directives after earlier directives: ' + text, t => {
			const env = setup()
			const doc = TextDocument.create(root + 'doc.mcfunction', 'mcfunction', 0, text)
			const node = parseDoc(
				new core.Source(text).skip(),
				core.ParserContext.create(env.project, { doc }),
			)
			const offset = text.includes('@ch') ? text.indexOf('@ch') + 3 : text.length
			const items = completeDoc(node, core.CompleterContext.create(env.project, { doc, offset }))
			t.assert.equal(items.some(item => item.label === '@chatonly'), true)
			t.assert.equal(items.some(item => item.label === '@override'), true)
			if (!text.includes('@ch')) {
				t.assert.equal(items.some(item => item.label === 'function'), true)
			}
		})
	}
})

describe('doc directive completion duplicates', () => {
	const cases: [string, string, boolean][] = [
		['new inline directive', '\n#> @private @|', false],
		['partial inline directive', '\n#> @private @pr| function demo:test', false],
		['inline to block', '\n#> @private function demo:test\n# @|', false],
		['block to inline', '\n#> @| function demo:test\n# @private', false],
		['block to block', '\n#> function demo:test\n# @private\n# @|', false],
		['editing inline occurrence', '\n#> @pr|ivate function demo:test', true],
		['editing block occurrence', '\n#> function demo:test\n# @pr|ivate', true],
		['editing duplicate occurrence', '\n#> @private @pr|ivate function demo:test', false],
	]
	for (const [name, markedText, expected] of cases) {
		it(name, t => {
			const env = setup()
			class Repeatable extends DefaultDocDirective {
				override readonly identifier = 'repeatable'
				override readonly allowDuplicates = true
			}
			registerDocDirective(env.project.meta, new Repeatable())
			const offset = markedText.indexOf('|')
			const text = markedText.replace('|', '') + '\n# @repeatable'
			const doc = TextDocument.create(root + 'doc.mcfunction', 'mcfunction', 0, text)
			const node = parseDoc(
				new core.Source(text).skip(),
				core.ParserContext.create(env.project, { doc }),
			)
			const items = completeDoc(node, core.CompleterContext.create(env.project, { doc, offset }))
			t.assert.equal(items.some(item => item.label === '@private'), expected)
			t.assert.equal(items.some(item => item.label === '@repeatable'), true)
			t.assert.equal(items.some(item => item.label === '@public'), true)
		})
	}
})

describe('directive controlled input', () => {
	function parseAndBind(
		text: string,
		configure?: (project: ReturnType<typeof mockProjectData>) => void,
	) {
		const project = mockProjectData()
		initialize(project)
		configure?.(project)
		const doc = TextDocument.create(root + 'doc.mcfunction', 'mcfunction', 0, text)
		const parserCtx = core.ParserContext.create(project, { doc })
		const node = parseDoc(new core.Source(text).skip(text.startsWith('\r\n') ? 2 : 1), parserCtx)
		const ctx = core.BinderContext.create(project, { doc })
		const bind = () => ctx.symbols.contributeAs('binder', () => bindDoc(node, ctx))
		bind()
		return { project, node, ctx, bind, errors: [...parserCtx.err.errors, ...ctx.err.errors] }
	}
	for (const newline of ['\n', '\r\n']) {
		for (const indentation of ['  ', '\t\t']) {
			it(
				'consumes an indented comment and then a directive: '
					+ JSON.stringify([newline, indentation]),
				t => {
					let read = 0
					const text = [
						'',
						'#> function demo:test',
						'# @reads score @s foo.bar',
						`#${indentation}How many bar to do`,
						`#${indentation}@type int @ 0..10`,
					].join(newline)
					const env = parseAndBind(text, project => {
						class Reads extends DefaultDocDirective {
							override readonly identifier = 'reads'
							override parseArguments(
								src: core.Source,
								directive: DocDirectiveNode,
								ctx: core.ParserContext,
								input: DocDirectiveParserContext,
							) {
								super.parseArguments(src, directive, ctx, input)
								const cursor = src.cursor
								const peeked = input.peekComment()
								const again = input.peekComment()
								t.assert.deepEqual(again, peeked)
								t.assert.equal(src.cursor, cursor)
								t.assert.equal(input.indent, 1)
								t.assert.equal(peeked?.indent, 2)
								const comment = input.readComment(value => value.indent > input.indent)
								t.assert.deepEqual(comment, peeked)
								t.assert.equal(
									text.slice(comment!.textRange.start, comment!.textRange.end),
									'How many bar to do',
								)
								t.assert.equal(
									text.slice(comment!.range.start, comment!.range.end),
									`#${indentation}How many bar to do`,
								)
								directive.arguments.push(comment!.text)
								read++
								const beforeChild = src.cursor
								t.assert.equal(input.readComment(), undefined)
								t.assert.equal(src.cursor, beforeChild)
								input.readDirective(identifier => identifier === 'type')
							}
							override handleDirective(directive: core.DeepReadonly<DocDirectiveNode>) {
								return { desc: ['reads: ' + directive.arguments[3]] }
							}
						}
						class Type extends DefaultDocDirective {
							override readonly identifier = 'type'
						}
						registerDocDirective(project.meta, new Reads())
						registerDocDirective(project.meta, new Type())
					})
					t.assert.deepEqual(env.errors, [])
					t.assert.equal(read, 1)
					t.assert.deepEqual(env.node.docDirectives.map(d => d.identifier), ['reads'])
					t.assert.deepEqual(env.node.docDirectives[0].docDirectives[0].arguments, [
						'int',
						'@',
						'0..10',
					])
					t.assert.equal(
						env.node.commentDescription?.includes('How many bar to do') ?? false,
						false,
					)
					t.assert.equal(env.node.description, 'reads: How many bar to do')
				},
			)
		}
	}
	for (
		const suffix of [
			'# How many bar to do',
			'#How many bar to do',
			'#> function demo:other',
			'say hello',
		]
	) {
		it('leaves same-level comments, declarations and commands unconsumed: ' + suffix, t => {
			const env = parseAndBind(
				'\n#> function demo:test\n# @reads score @s foo.bar\n' + suffix,
				project => {
					class Reads extends DefaultDocDirective {
						override readonly identifier = 'reads'
						override parseArguments(
							src: core.Source,
							directive: DocDirectiveNode,
							ctx: core.ParserContext,
							input: DocDirectiveParserContext,
						) {
							super.parseArguments(src, directive, ctx, input)
							const cursor = src.cursor
							t.assert.equal(input.peekComment(), undefined)
							t.assert.equal(input.readComment(), undefined)
							t.assert.equal(src.cursor, cursor)
						}
					}
					registerDocDirective(project.meta, new Reads())
				},
			)
			t.assert.deepEqual(env.errors, [])
			if (suffix.includes('How many')) {
				t.assert.equal(env.node.commentDescription?.includes('How many bar to do'), true)
			}
		})
	}
	it('allows a directive to reject an indented comment without consuming it', t => {
		const env = parseAndBind(
			'\n#> function demo:test\n# @reads score @s foo.bar\n#  Keep outside',
			project => {
				class Reads extends DefaultDocDirective {
					override readonly identifier = 'reads'
					override parseArguments(
						src: core.Source,
						directive: DocDirectiveNode,
						ctx: core.ParserContext,
						input: DocDirectiveParserContext,
					) {
						super.parseArguments(src, directive, ctx, input)
						const cursor = src.cursor
						t.assert.equal(
							input.readComment(comment => comment.text.startsWith('Accept')),
							undefined,
						)
						t.assert.equal(src.cursor, cursor)
						t.assert.equal(input.peekComment()?.text, 'Keep outside')
					}
				}
				registerDocDirective(project.meta, new Reads())
			},
		)
		t.assert.equal(env.node.commentDescription?.includes('Keep outside'), true)
	})
	for (const newline of ['\n', '\r\n']) {
		it(
			'reads greedy strings once and appends only the parent result ' + JSON.stringify(newline),
			t => {
				const env = parseAndBind([
					'',
					'#> function demo:test Intro',
					'# Continued',
					'# @returns score sometparam',
					'#    @success some   param',
					'#    @result other param',
				].join(newline))
				t.assert.deepEqual(env.errors, [])
				t.assert.deepEqual(env.node.docDirectives.map(d => d.identifier), ['returns'])
				const parent = env.node.docDirectives[0]!
				t.assert.deepEqual(parent.arguments, ['score sometparam'])
				t.assert.deepEqual(parent.docDirectives.map(d => d.arguments), [['some   param'], [
					'other param',
				]])
				const expected =
					' Intro\n Continued\n\nreturns: score sometparam\n\n- result: other param\n- success: some   param'
				t.assert.equal(env.node.description, expected)
				const raw = env.project.symbolStorage.global.function!['demo:test']
				t.assert.equal(core.SymbolUtil.viewFromContext(raw, root)?.desc, expected)
				env.bind()
				t.assert.equal(env.node.description, expected)
			},
		)
	}
	it('separates documentation blocks while preserving lines within each block', t => {
		const env = parseAndBind(
			'\n#> function demo:test Intro\n# Continued\n# @first\n# @second',
			project => {
				class First extends DefaultDocDirective {
					override readonly identifier = 'first'
					override handleDirective() {
						return { desc: ['First line', 'Second line'] }
					}
				}
				class Second extends DefaultDocDirective {
					override readonly identifier = 'second'
					override handleDirective() {
						return { desc: ['Last block'] }
					}
				}
				registerDocDirective(project.meta, new First())
				registerDocDirective(project.meta, new Second())
			},
		)
		t.assert.equal(
			env.node.description,
			' Intro\n Continued\n\nFirst line\nSecond line\n\nLast block',
		)
		env.bind()
		t.assert.equal(
			env.node.description,
			' Intro\n Continued\n\nFirst line\nSecond line\n\nLast block',
		)
	})
	it('preserves actual trailing comment blank lines before directive documentation', t => {
		const env = parseAndBind('\n#> function demo:test Intro\n#\n# @returns\n#  @result value')
		t.assert.equal(env.node.commentDescription, ' Intro\n')
		t.assert.equal(env.node.description, ' Intro\n\n\nreturns:\n\n- result: value')
	})
	it('leaves a rejected indented directive for the outer parser', t => {
		let calls = 0
		const env = parseAndBind(
			'\n#> function demo:test\n# @returns\n#    @result hello\n#    @returnsdoesnottakeme',
			project => {
				class Rejected extends DefaultDocDirective {
					override readonly identifier = 'returnsdoesnottakeme'
					override handleDirective() {
						calls++
						return { desc: ['Separate docs'] }
					}
				}
				registerDocDirective(project.meta, new Rejected())
			},
		)
		t.assert.deepEqual(env.errors, [])
		t.assert.deepEqual(env.node.docDirectives.map(d => d.identifier), [
			'returns',
			'returnsdoesnottakeme',
		])
		t.assert.equal(calls, 1)
		t.assert.equal(env.node.description, 'returns:\n\n- result: hello\n\nSeparate docs')
	})
	it('warns and skips duplicate child execution', t => {
		const env = parseAndBind(
			'\n#> function demo:test\n# @returns\n#    @result first\n#    @result second\n#    @success yes',
		)
		t.assert.equal(env.errors.length, 1)
		t.assert.equal(env.errors[0]?.severity, core.ErrorSeverity.Warning)
		t.assert.equal(env.node.description?.includes('- result: first'), true)
		t.assert.equal(env.node.description?.includes('second'), false)
	})
	for (const identifier of ['result', 'success']) {
		it('reports a missing returns caller for ' + identifier, t => {
			const env = parseAndBind('\n#> function demo:test\n# @' + identifier + ' some param')
			t.assert.equal(env.errors.length, 1)
			t.assert.equal(
				env.errors[0]?.message,
				localize(
					'mcfunction.doc.directive.diagnostic.wrong_context.reason',
					localeQuote(identifier),
					localeQuote('@returns'),
				),
			)
		})
	}
	it('lets each directive choose consumption and invoke nested handlers recursively', t => {
		const calls: string[] = []
		const env = parseAndBind(
			'\n#> function demo:test\n# @returns score sometparam\n#    @success some param\n#       @more some param\n#    @result result text',
			project => {
				class RecursiveSuccess extends DefaultDocDirective {
					override readonly identifier = 'success'
					override parseArguments(
						src: core.Source,
						directive: DocDirectiveNode,
						_ctx: core.ParserContext,
						input: DocDirectiveParserContext,
					) {
						t.assert.equal(input.caller?.identifier, 'returns')
						directive.arguments.push(src.skipSpace().readLine())
						input.readDirective(identifier => identifier === 'more')
					}
					override handleDirective(
						directive: core.DeepReadonly<DocDirectiveNode>,
						_node: DocNode,
						_ctx: core.BinderContext,
						input: DocDirectiveHandlerContext,
					) {
						t.assert.equal(input.caller?.identifier, 'returns')
						const child = input.handleDirective(directive.docDirectives[0]!)
						t.assert.deepEqual(child?.data, { value: 'some param' })
						calls.push('success')
						return { desc: [directive.arguments[0]! + ' / ' + child?.desc?.join('')] }
					}
				}
				class More extends DefaultDocDirective {
					override readonly identifier = 'more'
					override parseArguments(src: core.Source, directive: DocDirectiveNode) {
						directive.arguments.push(src.skipSpace().readLine())
					}
					override handleDirective(
						directive: core.DeepReadonly<DocDirectiveNode>,
						_node: DocNode,
						_ctx: core.BinderContext,
						input: DocDirectiveHandlerContext,
					) {
						t.assert.equal(input.caller?.identifier, 'success')
						calls.push('more')
						return {
							desc: [directive.arguments[0]!],
							data: { value: directive.arguments[0] },
						}
					}
				}
				registerDocDirective(project.meta, new RecursiveSuccess())
				registerDocDirective(project.meta, new More())
			},
		)
		t.assert.deepEqual(env.errors, [])
		t.assert.deepEqual(calls, ['more', 'success'])
		t.assert.equal(env.node.description?.includes('- success: some param / some param'), true)
	})
	it('does not execute parsed children automatically', t => {
		let childCalls = 0
		class NoChildExecution extends ReturnsDocDirective {
			override handleDirective() {
				return { desc: ['Parent only'] }
			}
		}
		class Child extends DefaultDocDirective {
			override readonly identifier = 'result'
			override handleDirective() {
				childCalls++
				return { desc: ['Child'] }
			}
		}
		const env = parseAndBind(
			'\n#> function demo:test\n# @returns\n#    @result hello',
			project => {
				registerDocDirective(project.meta, new NoChildExecution())
				registerDocDirective(project.meta, new Child())
			},
		)
		t.assert.deepEqual(env.errors, [])
		t.assert.equal(env.node.docDirectives[0]?.children?.length, 1)
		t.assert.equal(childCalls, 0)
		t.assert.equal(env.node.description, 'Parent only')
	})
	it('does not look ahead or execute children unless the directive asks', t => {
		class NoLookahead extends ReturnsDocDirective {
			override parseArguments(
				src: core.Source,
				directive: DocDirectiveNode,
				ctx: core.ParserContext,
				input: DocDirectiveParserContext,
			) {
				DefaultDocDirective.prototype.parseArguments.call(this, src, directive, ctx, input)
			}
		}
		const env = parseAndBind(
			'\n#> function demo:test\n# @returns\n#    @result hello',
			project => {
				registerDocDirective(project.meta, new NoLookahead())
			},
		)
		t.assert.deepEqual(env.node.docDirectives.map(d => d.identifier), ['returns', 'result'])
		t.assert.equal(
			env.errors[0]?.message,
			localize(
				'mcfunction.doc.directive.diagnostic.wrong_context.reason',
				localeQuote('result'),
				localeQuote('@returns'),
			),
		)
	})
})

describe('directive suggestion policy', () => {
	function complete(
		marked: string,
		configure?: (project: ReturnType<typeof mockProjectData>) => void,
	) {
		const project = mockProjectData()
		initialize(project)
		configure?.(project)
		const offset = marked.indexOf('|')
		const text = marked.replace('|', '')
		const doc = TextDocument.create(root + 'doc.mcfunction', 'mcfunction', 0, text)
		const node = parseDoc(
			new core.Source(text).skip(),
			core.ParserContext.create(project, { doc }),
		)
		return {
			node,
			labels: completeDoc(node, core.CompleterContext.create(project, { doc, offset })).map(
				item => item.label,
			),
		}
	}
	for (const newline of ['\n', '\r\n']) {
		for (const suffix of ['#  @|', '#  @v|']) {
			it(
				'only suggests void inside returns after result and success: '
					+ JSON.stringify([newline, suffix]),
				t => {
					const { labels } = complete(
						[
							'',
							'#> @private function demo:test',
							'#@returns',
							'#  @result 123231dddsa',
							'#  @success true',
							suffix,
						].join(newline),
					)
					t.assert.deepEqual(labels, ['@void'])
				},
			)
		}
	}
	for (const suffix of ['#@|']) {
		it('hides returns arguments at top level: ' + suffix, t => {
			const { labels } = complete(
				'\n#> @private function demo:test\n#@returns\n#  @result 123231dddsa\n#  @success true\n'
					+ suffix,
			)
			t.assert.equal(labels.includes('@void'), false)
			t.assert.equal(labels.includes('@result'), false)
			t.assert.equal(labels.includes('@success'), false)
			t.assert.equal(labels.includes('@chatonly'), true)
		})
	}
	for (const suffix of ['#|', '#  |']) {
		it('provides no directive completion without @: ' + suffix, t => {
			t.assert.deepEqual(
				complete('\n#> function demo:test\n#@returns\n#  @result value\n' + suffix).labels,
				[],
			)
		})
	}
	it('retains the child being edited and filters its used siblings', t => {
		const { labels } = complete(
			'\n#> function demo:test\n# @returns\n#  @res|ult hello\n#  @success yes',
		)
		t.assert.deepEqual(labels, ['@result', '@void'])
	})
	it('suggests all returns argument directives in an empty parameter position', t => {
		t.assert.deepEqual(complete('\n#> function demo:test\n#@returns\n#  @|').labels, [
			'@result',
			'@success',
			'@void',
		])
	})
	it('does not infer parameter ownership from indentation alone', t => {
		const { labels } = complete('\n#> function demo:test\n#@chatonly\n#  @|')
		t.assert.equal(labels.includes('@void'), false)
		t.assert.equal(labels.includes('@public'), true)
	})
	it('does not alter validity for a directive hidden from suggestions', t => {
		let checks = 0
		const { node, labels } = complete('\n#> @hidden function demo:test\n#@|', project => {
			class Hidden extends DefaultDocDirective {
				override readonly identifier = 'hidden'
				override includeInSuggestion(
					ctx: core.CompleterContext,
					input: DocDirectiveSuggestCtx,
				) {
					checks++
					t.assert.equal(input.node.directive.value, 'function')
					t.assert.equal(ctx.offset > 0, true)
					return false
				}
			}
			registerDocDirective(project.meta, new Hidden())
		})
		t.assert.equal(node.docDirectives[0]?.valid, true)
		t.assert.equal(labels.includes('@hidden'), false)
		t.assert.equal(checks > 0, true)
	})
})
