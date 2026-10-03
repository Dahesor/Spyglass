import type * as core from '@spyglassmc/core'

export interface DocNode extends core.AstNode {
	type: 'mcfunction:doc'
	children: core.AstNode[]
	fields: core.AstNode[]
	docDirectives: DocDirectiveNode[]
	directive: core.LiteralNode
	description?: string
	isFunctionHeader?: boolean
	isImplicitFunction?: boolean
	valid: boolean
}

export interface DocDirectiveNode extends core.AstNode {
	type: 'mcfunction:doc_directive'
	identifier: string
	identifierRange: core.Range
	arguments: string[]
	isInline: boolean
	valid: boolean
}

export namespace DocNode {
	export function is(
		node: core.DeepReadonly<core.AstNode> | undefined,
	): node is core.DeepReadonly<DocNode> {
		return node?.type === 'mcfunction:doc'
	}
}
