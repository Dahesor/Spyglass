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
				argument: { type: 'minecraft:score_holder', usageType: 'reference' },
			}],
			['objective', { type: 'argument', argument: { type: 'minecraft:objective' } }],
		]),
	},
}
const storage_target: NodeComponent = {
	storage: {
		type: 'literal',
		children: expandSequence([
			['storage', {
				type: 'argument',
				argument: {
					type: 'minecraft:resource_location',
					options: { category: 'storage', accessType: 'read' },
				},
			}],
			['path', {
				type: 'argument',
				argument: {
					type: 'minecraft:nbt_path',
					options: {
						dispatcher: 'minecraft:storage',
						dispatchedBy: 'storage',
						accessType: 'read',
					},
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
				argument: { type: 'minecraft:block_pos' },
			}],
			['path', {
				type: 'argument',
				executable: true,
				argument: {
					type: 'minecraft:nbt_path',
					options: {
						dispatcher: 'minecraft:block',
						dispatchedBy: 'target',
						accessType: 'read',
					},
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
				argument: { type: 'minecraft:entity' },
			}],
			['path', {
				type: 'argument',
				executable: true,
				argument: {
					type: 'minecraft:nbt_path',
					options: {
						dispatcher: 'minecraft:entity',
						dispatchedBy: 'target',
						accessType: 'read',
					},
				},
			}],
		]),
	},
}
const message_target: NodeComponent = {
	message: {
		type: 'argument',
		argument: { type: 'minecraft:message' },
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

const callbyArgTree: mcf.RootTreeNode = {
	type: 'root',
	children: {
		'function': {
			type: 'literal',
			children: {
				name: {
					type: 'argument',
					executable: true,
					argument: { type: 'minecraft:function' },
				},
			},
		},
		'enchantment': {
			type: 'literal',
			children: {
				name: {
					type: 'argument',
					executable: true,
					argument: { type: 'minecraft:resource', registry: 'minecraft:enchantment' },
				},
			},
		},
		'advancement': {
			type: 'literal',
			children: {
				name: {
					type: 'argument',
					executable: true,
					argument: { type: 'minecraft:resource', registry: 'minecraft:advancement' },
				},
			},
		},
		'user': {
			type: 'literal',
			executable: true,
		},
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
	registerDocArguments(meta, { identifier: 'callby', tree: callbyArgTree })
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
