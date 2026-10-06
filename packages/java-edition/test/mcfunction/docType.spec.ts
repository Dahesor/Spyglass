import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import * as je from '@spyglassmc/java-edition'
import * as mcdoc from '@spyglassmc/mcdoc'
import * as mcf from '@spyglassmc/mcfunction'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'

function parse(text: string) {
	const project = mockProjectData()
	mcdoc.initialize(project)
	je.mcf.initialize(project, { type: 'root', children: {} }, '1.21.5')
	// Type interpretation by individual documentation targets is separate from type syntax.
	project.meta.getCustom<mcf.DocTargets>('impdoc:target')!.get('function')!.acceptedDirectives
		.push('type')
	const doc = TextDocument.create(
		'file:///pack/data/demo/function/self.mcfunction',
		'mcfunction',
		0,
		text,
	)
	const ctx = core.ParserContext.create(project, { doc })
	const node = mcf.doc(new core.Source(text), ctx)
	core.AstNode.setParents(node)
	return { project, doc, ctx, node }
}

describe('@type', () => {
	for (const newline of ['\n', '\r\n']) {
		for (
			const value of [
				'int',
				'int @ 19..',
				'struct {\n     number: int\n  }',
				'struct {\nnumber: int\n}',
				'int\n @ 19..',
			]
		) {
			it(
				'parses the longest type and leaves prose outside: ' + JSON.stringify([newline, value]),
				t => {
					const text = [
						'#>function demo:self',
						...('@type ' + value).split('\n').map(line => '# ' + line),
						'# This is not part of the mcdoc',
						'# @returns',
					].join(newline)
					const { node, ctx, doc } = parse(text)
					t.assert.deepEqual(ctx.err.errors, [])
					t.assert.deepEqual(node.docDirectives.map(d => d.identifier), ['type', 'returns'])
					const directive = node.docDirectives[0]
					t.assert.equal(directive.argumentNode?.type, 'mcdoc:type')
					t.assert.equal(directive.argumentNode?.children?.[0].parent, directive.argumentNode)
					t.assert.equal(directive.arguments[0].includes('This is not part'), false)
					t.assert.equal(
						node.commentDescription?.includes('This is not part of the mcdoc'),
						true,
					)
					t.assert.equal(
						doc.getText().slice(directive.range.end).startsWith(newline + '# This is not'),
						true,
					)
				},
			)
		}
	}
	it('reports malformed mcdoc at original comment positions', t => {
		const { node, ctx, doc } = parse('#>function demo:self\n# @type struct {\n# number int\n# }')
		t.assert.equal(ctx.err.errors.length > 0, true)
		t.assert.equal(
			ctx.err.errors.some(error => error.range.start === doc.getText().indexOf('int')),
			true,
		)
		t.assert.equal(node.docDirectives[0].argumentNode?.children?.[0].type, 'mcdoc:struct')
	})
	it('falls back to a complete type before an invalid continuation', t => {
		const { node, ctx } = parse('#>function demo:self\n# @type int\n# <\n# Explanation')
		t.assert.deepEqual(ctx.err.errors, [])
		t.assert.equal(node.docDirectives[0].arguments[0], 'int')
		t.assert.equal(node.commentDescription, ' <\n Explanation')
	})
	it('diagnoses trailing input on the directive line', t => {
		const { ctx, doc } = parse('#>function demo:self\n# @type int invalid')
		t.assert.equal(ctx.err.errors.length, 1)
		t.assert.equal(ctx.err.errors[0].range.start, doc.getText().indexOf('invalid'))
	})
	it('colors nested types at original comment positions', t => {
		const { node, project, doc } = parse(
			'#>function demo:self\n# @type struct {\n# number: int\n# }',
		)
		const tokens = core.colorizer.fallback(
			node,
			core.ColorizerContext.create(project, { doc, range: node.range }),
		)
		const start = doc.getText().indexOf('int')
		t.assert.equal(
			tokens.some(token =>
				token.range.start === start && token.range.end === start + 3 && token.type === 'type'
			),
			true,
		)
	})
})
