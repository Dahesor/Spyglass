import * as core from '@spyglassmc/core'
import * as colorizer from './colorizer/index.js'
import type { DocNode, LiteralCommandChildNode } from './node/index.js'
import { bindDoc, completeDoc } from './parser/doc.js'
import { registerDocTargets } from './parser/doc/targets.js'

export * as colorizer from './colorizer/index.js'
export * as completer from './completer/index.js'
export * from './node/index.js'
export * from './parser/index.js'
export * from './tree/index.js'

/* istanbul ignore next */
export const initialize: core.SyncProjectInitializer = ({ meta }) => {
	registerDocTargets(meta)
	colorizer.register(meta)
	meta.registerBinder<DocNode>('mcfunction:doc', bindDoc)
	meta.registerCompleter<DocNode>('mcfunction:doc', completeDoc)
	meta.registerCompleter<LiteralCommandChildNode>(
		'mcfunction:command_child/literal',
		core.completer.literal,
	)
}
