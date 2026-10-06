import * as core from '@spyglassmc/core'
import { DocNode, type McfunctionNode } from '../node/index.js'
import { bindDoc } from '../parser/doc.js'

export const entry = core.AsyncBinder.create<McfunctionNode>(async (node, ctx) => {
	const privateFunctions = ctx.meta.getCustom<Map<string, string>>(
		'impdoc:private_function',
	)!.get('uris')!
	const identifier = privateFunctions.get(ctx.doc.uri)
	if (identifier) {
		ctx.symbols.contributeAs('uri_binder', () => {
			ctx.symbols.query(ctx.doc.uri, 'function', identifier).enterFileDefinition({
				usage: { type: 'definition' },
			})
		})
		privateFunctions.delete(ctx.doc.uri)
	}
	if (node.parent?.type === 'file') {
		core.LocalSymbol.initialize(node.parent)
	}
	for (const child of node.children) {
		if (DocNode.is(child)) {
			bindDoc(child, ctx)
		}
	}
	for (const child of node.children) {
		if (!DocNode.is(child)) {
			await ctx.meta.getBinder(child.type)(child, ctx)
		}
	}
})
