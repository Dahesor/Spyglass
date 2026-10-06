import * as core from '@spyglassmc/core'
import * as mcf from '@spyglassmc/mcfunction'
import * as nbt from '@spyglassmc/nbt'
import * as completer from '../completer/index.js'
import type { NbtPathNode } from '../node/index.js'
import * as parser from '../parser/index.js'
import type { NbtParserProperties } from '../tree/argument.js'

export type EmptyDocArgumentParser = (node: mcf.ArgumentTreeNode) => core.Parser

export interface DocArgumentsDefinition {
	readonly identifier: string
	readonly tree: mcf.RootTreeNode
	readonly argumentParser?: mcf.ArgumentParserGetter
	readonly mockNodes?: mcf.completer.MockNodesGetter
	readonly emptyArguments?: ReadonlyMap<string, EmptyDocArgumentParser>
}

const emptyNbtPath: EmptyDocArgumentParser = treeNode =>
	core.map(nbt.parser.path, path => ({
		type: 'mcfunction:nbt_path',
		range: path.range,
		children: [path],
		properties: treeNode.properties as NbtParserProperties | undefined,
	} satisfies NbtPathNode))

export function registerDocArguments(
	meta: core.MetaRegistry,
	definition: DocArgumentsDefinition,
): void {
	const { tree } = definition
	const id = `impdoc:${definition.identifier}_arguments`
	const parse = mcf.command(tree, definition.argumentParser ?? parser.argument)
	const complete = mcf.completer.entry(tree, definition.mockNodes ?? completer.getMockNodes)
	meta.registerParser(id, (src, ctx) => {
		const command = parse(src, ctx)
		// This tree describes directive arguments, so its first literal is not a command name.
		const first = command.children[0]?.children[0]
		if (mcf.LiteralCommandChildNode.is(first)) {
			const literal: mcf.LiteralCommandChildNode = {
				...first,
				options: { ...first.options, colorTokenType: 'literal' },
			}
			command.children[0].children[0] = literal
		}
		const last = command.children.at(-1)
		if (
			last?.type === 'mcfunction:command_child' && last.path.length
			&& src.cursor > last.range.end
		) {
			const parent = mcf.redirect(tree, last.path)
			const { treeNode, path } = mcf.resolveParentTreeNode(parent, tree, last.path)
			const next = Object.entries(treeNode?.children ?? {})
			if (next.length === 1 && next[0][1].type === 'argument') {
				const [name, argument] = next[0] as [string, mcf.ArgumentTreeNode]
				const emptyParser = definition.emptyArguments?.get(argument.parser)
					?? (argument.parser === 'minecraft:nbt_path' ? emptyNbtPath : undefined)
				const value = emptyParser?.(argument)(src, ctx)
				if (value && value !== core.Failure) {
					command.children.push({
						type: 'mcfunction:command_child',
						range: value.range,
						path: [...path, name],
						children: [value],
					})
				}
			}
		}
		return { type: id, range: command.range, children: [command] }
	})
	meta.registerCompleter(
		id,
		(node, ctx) =>
			complete(
				{ ...node, type: 'mcfunction:entry' } as core.DeepReadonly<mcf.McfunctionNode>,
				ctx,
			),
	)
}
