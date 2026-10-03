import * as core from '@spyglassmc/core'
import type {
	DocNode,
	LiteralCommandChildNode,
	MacroNode,
	TrailingCommandChildNode,
} from '../node/index.js'
import { macro } from './macro.js'

export function register(meta: core.MetaRegistry) {
	meta.registerColorizer<DocNode>('mcfunction:doc', (node, ctx) =>
		core.ColorToken.fillGap(
			node.children.flatMap(child => core.colorizer.fallback(child, ctx)),
			node.range,
			'comment',
		))
	meta.registerColorizer<LiteralCommandChildNode>(
		'mcfunction:command_child/literal',
		core.colorizer.literal,
	)
	meta.registerColorizer<TrailingCommandChildNode>(
		'mcfunction:command_child/trailing',
		core.colorizer.error,
	)
	meta.registerColorizer<MacroNode>('mcfunction:macro', macro)
}
