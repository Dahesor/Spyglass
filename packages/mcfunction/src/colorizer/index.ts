import * as core from '@spyglassmc/core'
import type {
	DocDirectiveNode,
	DocNode,
	LiteralCommandChildNode,
	MacroNode,
	TrailingCommandChildNode,
} from '../node/index.js'
import { doc, docDirective } from './doc.js'
import { macro } from './macro.js'

export function register(meta: core.MetaRegistry) {
	meta.registerColorizer<DocDirectiveNode>('mcfunction:doc_directive', docDirective)
	meta.registerColorizer<DocNode>('mcfunction:doc', doc)
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
