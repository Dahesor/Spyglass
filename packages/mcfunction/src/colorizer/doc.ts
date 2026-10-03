import * as core from '@spyglassmc/core'
import type { DocDirectiveNode, DocNode } from '../node/index.js'

export const docDirective: core.Colorizer<DocDirectiveNode> =
	node => [core.ColorToken.create(node.identifierRange, 'literal')]

export const doc: core.Colorizer<DocNode> = (node, ctx) => {
	const tokens = core.ColorToken.fillGap(
		node.children.flatMap(child => core.colorizer.fallback(child, ctx)),
		node.range,
		'comment',
	)
	const headings = [
		...(!node.isImplicitFunction ? [node.directive.range] : []),
		...node.docDirectives.filter(directive => directive.isInline)
			.map(directive => directive.identifierRange),
	]
	return tokens.map(token => ({
		...token,
		modifiers: [
			...(token.modifiers ?? []),
			'documentation',
			...(headings.some(range =>
					range.start === token.range.start && range.end === token.range.end
				)
				? ['declaration' as const]
				: []),
		],
	}))
}
