import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import * as je from '@spyglassmc/java-edition'
import { registerDocArguments } from '@spyglassmc/java-edition/lib/mcfunction/doc/arguments.js'
import { expandSequence } from '@spyglassmc/java-edition/lib/mcfunction/doc/input.js'
import type { NbtPathNode } from '@spyglassmc/java-edition/lib/mcfunction/node/index.js'
import type * as mcf from '@spyglassmc/mcfunction'
import * as nbt from '@spyglassmc/nbt'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'

function setup(tree: mcf.RootTreeNode, text: string) {
	const project = mockProjectData()
	nbt.initialize(project)
	je.mcf.initialize(project, { type: 'root', children: {} }, '1.21.5')
	registerDocArguments(project.meta, { identifier: 'example', tree })
	const doc = TextDocument.create(
		'file:///pack/data/demo/function/self.mcfunction',
		'mcfunction',
		0,
		text,
	)
	const ctx = core.ParserContext.create(project, { doc })
	const node = project.meta.getParser('impdoc:example_arguments')(new core.Source(text), ctx)
	if (node === core.Failure) {
		throw new Error('Expected argument AST')
	}
	core.AstNode.setParents(node)
	return { project, doc, ctx, node }
}

describe('doc argument framework', () => {
	const tree: mcf.RootTreeNode = {
		type: 'root',
		children: expandSequence([
			['flag', { type: 'literal' }],
			['enabled', { type: 'argument', parser: 'brigadier:bool' }],
			['count', {
				type: 'argument',
				parser: 'brigadier:integer',
				properties: { min: 1, max: 5 },
			}],
		]),
	}
	it('parses another directive signature with standard argument validation', t => {
		const valid = setup(tree, 'flag true 3')
		t.assert.equal(valid.ctx.err.errors.length, 0)
		t.assert.equal(valid.node.type, 'impdoc:example_arguments')
		const invalid = setup(tree, 'flag true 9')
		t.assert.equal(invalid.ctx.err.errors.length > 0, true)
	})
	it('completes standard arguments without an input-specific completer', t => {
		const { project, doc, node } = setup(tree, 'flag ')
		const items = core.completer.dispatch(
			node,
			core.CompleterContext.create(project, { doc, offset: doc.getText().length }),
		)
		t.assert.deepEqual(items.map(item => item.label), ['false', 'true'])
	})
	it('materializes an empty NBT path from a different branch and parameter name', t => {
		const { node } = setup({
			type: 'root',
			children: expandSequence([
				['read', { type: 'literal' }],
				['source', {
					type: 'argument',
					parser: 'minecraft:resource_location',
					properties: { category: 'storage' },
				}],
				['value', {
					type: 'argument',
					parser: 'minecraft:nbt_path',
					properties: { dispatcher: 'minecraft:storage', dispatchedBy: 'source' },
				}],
			]),
		}, 'read demo:ram ')
		const command = node.children![0] as mcf.CommandNode
		const path = command.children.at(-1)!
		t.assert.deepEqual(path.path, ['read', 'source', 'value'])
		t.assert.equal(path.children[0].type, 'mcfunction:nbt_path')
		t.assert.deepEqual((path.children[0] as NbtPathNode).properties, {
			dispatcher: 'minecraft:storage',
			dispatchedBy: 'source',
		})
	})
})
