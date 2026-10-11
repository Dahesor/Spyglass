import type * as core from '@spyglassmc/core'
import type * as mcf from '@spyglassmc/mcfunction'
import { registerDocArguments } from './arguments.js'

type NodeComponent = { [name: string]: mcf.TreeNode }
const score_target: NodeComponent = {
	score: {
		type: 'literal',
		children: expandSequence([
			['score', {
				type: 'argument',
				parser: 'minecraft:score_holder',
				properties: { amount: 'single', usageType: 'reference' },
			}],
			['objective', { type: 'argument', parser: 'minecraft:objective' }],
		]),
	},
}
const storage_target: NodeComponent = {
	storage: {
		type: 'literal',
		children: expandSequence([
			['storage', {
				type: 'argument',
				parser: 'minecraft:resource_location',
				properties: { category: 'storage', accessType: 'read' },
			}],
			['path', {
				type: 'argument',
				parser: 'minecraft:nbt_path',
				properties: {
					dispatcher: 'minecraft:storage',
					dispatchedBy: 'storage',
					accessType: 'read',
				},
			}],
		]),
	},
}
const block_target: NodeComponent = {
	block: {
		type: 'literal',
		children: expandSequence([
			['target', {
				type: 'argument',
				executable: true,
				parser: 'minecraft:block_pos',
			}],
			['path', {
				type: 'argument',
				executable: true,
				parser: 'minecraft:nbt_path',
				properties: {
					dispatcher: 'minecraft:block',
					dispatchedBy: 'target',
					accessType: 'read',
				},
			}],
		]),
	},
}
const entity_target: NodeComponent = {
	entity: {
		type: 'literal',
		children: expandSequence([
			['target', {
				type: 'argument',
				executable: true,
				parser: 'minecraft:entity',
				properties: { amount: 'multiple', type: 'entities' },
			}],
			['path', {
				type: 'argument',
				executable: true,
				parser: 'minecraft:nbt_path',
				properties: {
					dispatcher: 'minecraft:entity',
					dispatchedBy: 'target',
					accessType: 'read',
				},
			}],
		]),
	},
}

const message_target: NodeComponent = {
	message: {
		type: 'argument',
		parser: 'minecraft:message',
		executable: true,
	},
}

const contextArgTree: mcf.RootTreeNode = {
	type: 'root',
	children: {
		'@player': {
			type: 'literal',
			executable: true,
			children: {
				...message_target,
			},
		},
		'@any': {
			type: 'literal',
			executable: true,
			children: {
				...message_target,
			},
		},
		'@root': {
			type: 'literal',
			executable: true,
			children: {
				...message_target,
			},
		},
		...message_target,
	},
}

const inputArgTree: mcf.RootTreeNode = {
	type: 'root',
	children: {
		...score_target,
		...storage_target,
	},
}

const readwriteArgTree: mcf.RootTreeNode = {
	type: 'root',
	children: {
		...score_target,
		...storage_target,
		...block_target,
		...entity_target,
	},
}

export function registerDocInput(meta: core.MetaRegistry): void {
	registerDocArguments(meta, { identifier: 'input', tree: inputArgTree })
	registerDocArguments(meta, { identifier: 'read_write', tree: readwriteArgTree })
	registerDocArguments(meta, { identifier: 'context', tree: contextArgTree })
}

type DocArgumentStep = readonly [
	name: string,
	node: mcf.LiteralTreeNode | mcf.ArgumentTreeNode,
]

/** Expand a sequence of args into nested structure */
export function expandSequence(
	steps: readonly DocArgumentStep[],
): NonNullable<mcf.TreeNode['children']> {
	let children: NonNullable<mcf.TreeNode['children']> = {}
	for (let i = steps.length - 1; i >= 0; i--) {
		const [name, node] = steps[i]
		children = {
			[name]: { ...node, ...(i === steps.length - 1 ? { executable: true } : { children }) },
		}
	}
	return children
}
