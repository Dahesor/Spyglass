import * as core from '@spyglassmc/core'
import type { DocDirectiveNode, DocNode } from '../node/index.js'

export const docDirective: core.Colorizer<DocDirectiveNode> = (node, ctx) => [
	core.ColorToken.create(node.identifierRange, 'literal'),
	...(node.children ?? []).flatMap(child => core.colorizer.fallback(child, ctx)),
]

export const doc: core.Colorizer<DocNode> = (node, ctx) => {
	const tokens = core.ColorToken.fillGap(
		node.children.flatMap(child => core.colorizer.fallback(child, ctx)),
		node.range,
		'comment',
	)
	const headings = new Map([
		...(!node.isImplicitFunction ? [node.directive.range] : []),
		...node.docDirectives.filter(directive => directive.isInline)
			.map(directive => directive.identifierRange),
	].map(range => [range.start, range.end]))
	return tokens.map(token => ({
		...token,
		modifiers: [
			...(token.modifiers ?? []),
			'documentation',
			...(headings.get(token.range.start) === token.range.end
				? ['declaration' as const]
				: []),
		],
	}))
}
