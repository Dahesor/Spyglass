import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { entry, initialize } from '../lib/index.js'
import { bindDoc, DefaultDocDirective, doc as parseDoc, registerDocDirective } from '../lib/parser/doc.js'

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
	it('uses directive-provided glob lists instead of deriving a folder in the target', t => {
		const env = setup()
		class CustomPrivate extends DefaultDocDirective {
			override readonly identifier = 'private'
			override readonly isAccessModifier = true
			override modifyAccess() {
				return {
					visibility: 3 as const,
					isotope: {
						scope: 1 as const,
						overrideLevel: 7,
						visibleWithin: ['**/allowed/**', '**/second/**'],
					},
				}
			}
		}
		registerDocDirective(env.project.meta, new CustomPrivate())
		t.assert.deepEqual(env.declaration(root + 'source/doc.mcfunction').errors, [])
		t.assert.equal(env.raw().isotopes![0].scope, 1)
		t.assert.equal(env.raw().isotopes![0].overrideLevel, 7)
		t.assert.notEqual(env.view(root + 'allowed/use.mcfunction'), undefined)
		t.assert.notEqual(env.view(root + 'second/use.mcfunction'), undefined)
		t.assert.equal(env.view(root + 'source/use.mcfunction'), undefined)
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
		for (const modifier of ['@public', '']) {
			it(`public doc makes every command an implementation (${modifier}, commands first: ${commandsFirst})`, t => {
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
				t.assert.equal(env.raw().declaration?.length, 1)
				t.assert.equal(env.raw().implementation?.length, 2)
				t.assert.equal(env.raw().definition?.length ?? 0, 0)
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
			env.project.symbols.getVisibleSymbols('objective', root + 'outside.mcfunction')['coins'],
			undefined,
		)
	})
	it('restores definitions after deleting the doc source even when references remain', t => {
		const env = setup()
		const source = root + 'private/doc.mcfunction'
		env.declaration(source)
		env.command(root + 'private/command.mcfunction')
		env.command(root + 'private/ref.mcfunction', 'reference')
		env.project.symbols.clear({ uri: source, contributor: 'binder' })
		t.assert.equal(env.raw().isotopes?.length ?? 0, 0)
		t.assert.equal(env.raw().definition?.length, 1)
		t.assert.equal(env.raw().reference?.length, 1)
		t.assert.equal(env.raw().implementation?.length ?? 0, 0)
	})
	it('private function headers declare the name and hide the file definition outside', t => {
		const env = setup()
		const uri = root + 'private/doc.mcfunction'
		env.project.symbols.contributeAs('uri_binder', () => {
			env.project.symbols.query(uri, 'function', 'demo:private/doc').enter({
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
		env.project.symbols.clear({ uri, contributor: 'binder' })
		t.assert.equal(symbol.definition?.length, 1)
		t.assert.equal(symbol.isotopes?.length ?? 0, 0)
	})

	it('removing public documentation restores command definitions', t => {
		const env = setup()
		const uri = root + 'doc.mcfunction'
		env.declaration(uri, '@public')
		env.command(root + 'command.mcfunction')
		env.project.symbols.clear({ uri, contributor: 'binder' })
		t.assert.equal(env.raw().definition?.length, 1)
		t.assert.equal(env.raw().implementation?.length ?? 0, 0)
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
