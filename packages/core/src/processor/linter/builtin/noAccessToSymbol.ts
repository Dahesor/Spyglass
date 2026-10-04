import { localeQuote, localize } from '@spyglassmc/locales'
import type { AstNode } from '../../../node/index.js'
import { SymbolUtil } from '../../../symbol/index.js'
import type { Linter } from '../Linter.js'

export const noAccessToSymbol: Linter<AstNode> = (node, ctx) => {
	const symbol = ctx.symbols.resolveAlias(node.symbol)
	if (!symbol || !SymbolUtil.hasNoAccessToFileSymbol(symbol, ctx.doc.uri)) {
		return
	}
	ctx.err.lint(
		localize('linter.no-access-to-symbol.message', symbol.category, localeQuote(symbol.identifier)),
		node,
	)
}
