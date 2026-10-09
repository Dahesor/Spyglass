import * as core from '@spyglassmc/core'
import { mockProjectData, SimpleProject } from '@spyglassmc/core/test/utils.ts'
import * as je from '@spyglassmc/java-edition'
import * as mcdoc from '@spyglassmc/mcdoc'
import * as mcf from '@spyglassmc/mcfunction'
import { completeDoc } from '@spyglassmc/mcfunction/lib/completer/doc.js'
import * as nbt from '@spyglassmc/nbt'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'

function parse(marked: string, project = mockProjectData()) {
	nbt.initialize(project)
	je.mcf.initialize(project, { type: 'root', children: {} }, '1.21.5')
	const offset = marked.indexOf('|')
	const text = marked.replace('|', '')
	const doc = TextDocument.create(
		'file:///pack/data/demo/function/self.mcfunction',
		'mcfunction',
		0,
		text,
	)
	const ctx = core.ParserContext.create(project, { doc })
	const node = mcf.doc(new core.Source(text), ctx)
	core.AstNode.setParents(node)
	return { project, doc, ctx, node, offset }
}

describe('@input', () => {
	for (
		const args of [
			'score @s counter',
			'storage demo:ram foo',
			'block ~ ~ ~ foo',
			'entity @s foo',
			'entity @e[limit=1] foo',
		]
	) {
		it('parses @writes without exceptions and produces documentation: ' + args, t => {
			const { node, ctx, project, doc } = parse(
				'#>function demo:self\n# @writes ' + args + '\n#  Explanation',
			)
			t.assert.equal(ctx.err.errors.length, 0)
			const binder = core.BinderContext.create(project, { doc })
			binder.symbols.contributeAs('binder', () => mcf.bindDoc(node, binder))
			t.assert.equal(node.description, 'writes: ' + args + '\nExplanation')
			const command = node.docDirectives[0].argumentNode!.children![0] as mcf.CommandNode
			const value = command.children.at(-1)!.children[0] as core.AstNode & {
				properties?: Record<string, unknown>
			}
			if (!args.startsWith('score')) {
				t.assert.equal(value.properties?.['accessType'], 'read')
				t.assert.equal(
					value.properties?.['dispatchedBy'],
					args.startsWith('storage') ? 'storage' : 'target',
				)
			}
		})
	}
	it('keeps selector parameters out of directive declaration highlighting', t => {
		const { node, project, doc } = parse('#>@public demo:self\n# @input score @s counter')
		const tokens = core.colorizer.fallback(
			node,
			core.ColorizerContext.create(project, { doc, range: node.range }),
		)
		const start = doc.getText().indexOf('@s ')
		const selector = tokens.find(token => token.range.start === start)
		t.assert.equal(selector?.range.end, start + 2)
		t.assert.equal(selector?.type, 'literal')
		t.assert.equal(selector?.modifiers?.includes('declaration'), false)
	})
	for (const args of ['score #2 asnbt.dnt', 'storage demo:ram foo']) {
		it('colors the first argument as a command parameter: ' + args, t => {
			const { node, project, doc } = parse('#>function demo:self\n#@input ' + args)
			const ctx = core.ColorizerContext.create(project, { doc, range: node.range })
			const tokens = core.colorizer.fallback(node, ctx)
			const start = doc.getText().indexOf(args)
			const token = tokens.find(token => token.range.start === start)
			t.assert.equal(token?.type, 'literal')
			t.assert.equal(token?.range.end, start + args.indexOf(' '))
			const command = mcf.command({
				type: 'root',
				children: { example: { type: 'literal', executable: true } },
			}, je.mcf.parser.argument)(
				new core.Source('example'),
				core.ParserContext.create(project, { doc }),
			)
			t.assert.equal(core.colorizer.fallback(command, ctx)[0].type, 'keyword')
		})
	}
	it('owns arguments, comments and nested directives in AST tree', t => {
		const { node } = parse(
			'#>function demo:self\n#@input score @s counter\n#  Description\n#@returns\n#  @result value',
		)
		const input = node.docDirectives[0]
		t.assert.deepEqual(input.children.map(child => child.type), [
			'impdoc:input_arguments',
			'comment',
		])
		t.assert.equal(input.children[0], input.argumentNode)
		t.assert.equal(input.argumentNode?.parent, input)
		t.assert.equal(input.argumentNode?.children?.[0].parent, input.argumentNode)
		const returns = node.docDirectives[1]
		t.assert.equal(returns.children[0], returns.docDirectives[0])
		t.assert.equal(returns.docDirectives[0].parent, returns)
		t.assert.deepEqual(input.docDirectives, [])
	})
	for (const args of ['score @s counter', 'storage demo:ram foo.bar[0]']) {
		it('documents arguments and one indented comment: ' + args, t => {
			const { project, doc, node, ctx } = parse(
				'#>function demo:self\n#@input ' + args + '\n#  Description\n# Other',
			)
			const binder = core.BinderContext.create(project, { doc })
			binder.symbols.contributeAs('binder', () => mcf.bindDoc(node, binder))
			t.assert.equal(ctx.err.errors.length, 0)
			t.assert.equal(node.description, ' Other\n\ninput: ' + args + '\nDescription')
			t.assert.equal(node.docDirectives[0].inputComment, 'Description')
		})
	}
	it('leaves an equally indented comment outside the input', t => {
		const { node } = parse('#>function demo:self\n#@input score @s counter\n#Description')
		t.assert.equal(node.docDirectives[0].inputComment, undefined)
		t.assert.equal(node.commentDescription, 'Description')
	})
	for (const suffix of ['', 's']) {
		it('completes the argument kinds: ' + suffix, t => {
			const { node, project, doc, offset } = parse(
				'#>function demo:self\n#@input ' + suffix + '|',
			)
			const items = completeDoc(node, core.CompleterContext.create(project, { doc, offset }))
			t.assert.deepEqual(items.map(item => item.label), ['score', 'storage'])
		})
	}
	for (
		const [args, category, identifier] of [
			['score @s ', 'objective', 'counter'],
			['storage ', 'storage', 'demo:ram'],
		]
	) {
		it('reuses symbol completion for ' + category, t => {
			const { node, project, doc, offset } = parse('#>function demo:self\n#@input ' + args + '|')
			new core.SymbolService(project.symbolStorage).query(doc.uri, category, identifier)
				.enter({
					usage: { type: 'definition' },
				})
			const items = completeDoc(node, core.CompleterContext.create(project, { doc, offset }))
			t.assert.deepEqual(
				items.map(item => item.label),
				category === 'storage' ? [identifier, 'THIS'] : [identifier],
			)
		})
	}
	for (
		const [directive, prefix] of [['input', ''], ['input', 'f'], ['writes', ''], ['writes', 'f']]
	) {
		it(
			'checks and completes storage paths using the existing mcdoc schema: ' + directive
				+ prefix,
			async t => {
				const meta = new core.MetaRegistry()
				mcdoc.initialize({ meta })
				nbt.initialize(mockProjectData({ meta }))
				const schema = new SimpleProject(meta, [{
					uri: 'file:///schema.mcdoc',
					content: 'dispatch minecraft:storage[demo:ram] to struct { foo: int, bar: string }',
				}])
				schema.parse()
				await schema.bind()
				const { project, doc, offset } = parse(
					'#>function demo:self\n#@' + directive + ' storage demo:ram ' + prefix + '|',
					schema.projectData,
				)
				const ctx = core.CheckerContext.create(project, { doc })
				// Use the production file/entry checker path rather than checking the directive directly.
				const file = core.file(project.meta.getParserForLanguageId('mcfunction')!)(
					new core.Source(doc.getText()),
					core.ParserContext.create(project, { doc }),
				)
				await project.meta.getChecker(file.type)(file, ctx)
				const docNode = file.children[0].children![0] as mcf.DocNode
				const items = completeDoc(
					docNode,
					core.CompleterContext.create(project, { doc, offset }),
				)
				t.assert.deepEqual(items.map(item => item.label), ['foo', 'bar'])
			},
		)
	}
	for (const args of ['score @s', 'storage demo:ram', 'other foo bar', 'score @s counter extra']) {
		it('uses command argument diagnostics: ' + args, t => {
			const { ctx } = parse('#>function demo:self\n#@input ' + args)
			t.assert.equal(ctx.err.errors.length > 0, true)
		})
	}
})
