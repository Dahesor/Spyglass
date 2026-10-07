import type * as core from '@spyglassmc/core'

/** Access policy resolved by a doc directive before the target is bound. */
export type DocAccess =
	& {
		overrideLevel?: number
	}
	& (
		| {
			visibility:
				| typeof core.SymbolIsotopeScope.Local
				| typeof core.SymbolIsotopeScope.Project
				| typeof core.SymbolIsotopeScope.Global
		}
		| {
			visibility:
				| typeof core.SymbolIsotopeScope.Private
				| typeof core.SymbolIsotopeScope.Protected
			visibleWithin: core.IsotopeVisibility[]
		}
	)

export interface DocNode extends core.AstNode {
	type: 'mcfunction:doc'
	children: core.AstNode[]
	fields: core.AstNode[]
	docDirectives: DocDirectiveNode[]
	directive: core.LiteralNode
	commentDescription?: string
	description?: string
	isFunctionHeader?: boolean
	isImplicitFunction?: boolean
	valid: boolean
	access?: DocAccess
}

export interface DocDirectiveNode extends core.AstNode {
	type: 'mcfunction:doc_directive'
	identifier: string
	children: core.AstNode[]
	identifierRange: core.Range
	arguments: string[]
	argumentNode?: core.AstNode
	inputComment?: string
	/** References to the nested directives in children */
	docDirectives: DocDirectiveNode[]
	argumentSuggestions?: { range: core.Range; identifiers: string[] }[]
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
