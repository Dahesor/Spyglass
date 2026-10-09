import * as core from '@spyglassmc/core'
import { DocNode, type McfunctionNode } from '../node/index.js'
import { bindDoc } from '../parser/doc.js'

export const entry = core.AsyncBinder.create<McfunctionNode>(async (node, ctx) => {
	const privateFunctions = ctx.meta.getCustom<Map<string, string>>(
		'impdoc:private_function',
	)!.get('uris')!
	const identifier = privateFunctions.get(ctx.doc.uri)
	if (identifier) {
		const symbol = ctx.symbols.lookup('function', [identifier]).symbol
		const restored = symbol && core.SymbolUtil.allUsageContainers(symbol).some(owner => {
			const isFileDefinition = (location: core.SymbolLocation) =>
				location.uri === ctx.doc.uri && location.contributor === 'uri_binder'
				&& location.fromFile
			return owner.definition?.some(isFileDefinition)
				|| owner.implementation?.some(isFileDefinition)
		})
		if (!restored) {
			ctx.symbols.contributeAs('uri_binder', () => {
				ctx.symbols.query(ctx.doc.uri, 'function', identifier).enter({
					usage: { type: 'definition' },
				}, core.SymbolEnterType.File)
			})
		}
		privateFunctions.delete(ctx.doc.uri)
	}
	if (node.parent?.type === 'file') {
		node.parent.locals = core.LocalSymbol.createTable()
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
