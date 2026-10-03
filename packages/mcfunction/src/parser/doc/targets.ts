import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { DocNode } from '../../node/index.js'
import { declareDocSymbol, DefaultDocTarget, registerDocTarget } from '../doc.js'

export function registerDocTargets(meta: core.MetaRegistry): void {
	registerDocTarget(meta, new FunctionDocTarget())
	registerDocTarget(meta, new SymbolDocTarget('tag', 'tag'))
	registerDocTarget(meta, new SymbolDocTarget('objective', 'objective'))
	registerDocTarget(meta, new SymbolDocTarget('team', 'team'))
	registerDocTarget(meta, new SymbolDocTarget('score', 'score_holder', false))
}

class SymbolDocTarget extends DefaultDocTarget {
	constructor(
		public override readonly identifier: string,
		private readonly category: string,
		private readonly unquotable = true,
	) {
		super()
	}

	override binder(node: DocNode, ctx: core.BinderContext): void {
		const tag = node.fields[0]
		if (!core.SymbolNode.is(tag) || tag.options.category !== this.category) {
			return
		}
		declareDocSymbol(node, tag, this.category, tag.value, ctx)
	}

	override completer(
		node: core.DeepReadonly<DocNode>,
		ctx: core.CompleterContext,
	): core.CompletionItem[] {
		const field = node.fields[0]
		if (field?.type !== 'symbol') {
			return []
		}
		const tag = field as core.DeepReadonly<core.SymbolNode>
		if (tag.options.category !== this.category) {
			return []
		}
		if (ctx.offset <= tag.range.end) {
			const completionNode = ctx.offset < tag.range.start
				? core.SymbolNode.mock(ctx.offset, { category: this.category })
				: tag
			return core.completer.symbol(
				{ ...completionNode, parent: tag.parent as core.AstNode },
				ctx,
			)
		}
		if (!tag.value) {
			return core.completer.symbol(
				{
					...core.SymbolNode.mock(ctx.offset, { category: this.category }),
					parent: tag.parent as core.AstNode,
				},
				ctx,
			)
		}
		return []
	}

	override parser(src: core.Source, ctx: core.ParserContext, node: DocNode): boolean {
		const tag = core.stopBefore(
			core.symbol({ category: this.category, usageType: 'declaration' }),
			core.Whitespaces,
		)(src, ctx)
		node.fields.push(tag)
		node.children.push(tag)
		if (!tag.value) {
			ctx.err.report(localize('expected', this.identifier), tag)
			return false
		}
		if (this.unquotable && !core.BrigadierUnquotablePattern.test(tag.value)) {
			ctx.err.report(localize('parser.string.illegal-brigadier', localeQuote(tag.value)), tag)
			return false
		}
		return true
	}
}

export class TagDocTarget extends SymbolDocTarget {
	constructor() {
		super('tag', 'tag')
	}
}

export class ObjectiveDocTarget extends SymbolDocTarget {
	constructor() {
		super('objective', 'objective')
	}
}

export class ScoreDocTarget extends SymbolDocTarget {
	constructor() {
		super('score', 'score_holder', false)
	}
}

class FunctionDocTarget extends DefaultDocTarget {
	override readonly identifier = 'function'

	override parser(src: core.Source, ctx: core.ParserContext, node: DocNode): boolean {
		const errors = ctx.err.errors.length
		const field = core.stopBefore(
			core.resourceLocation({ category: 'function', usageType: 'declaration' }),
			core.Whitespaces,
		)(src, ctx)
		node.fields.push(field)
		node.children.push(field)
		return ctx.err.errors.length === errors
	}

	override binder(node: DocNode, ctx: core.BinderContext): void {
		const field = node.fields[0]
		if (!core.ResourceLocationNode.is(field)) {
			return
		}
		if (node.isFunctionHeader) {
			const currentFunction = Object.values(ctx.symbols.global.function ?? {}).find(symbol => {
				let found = false
				core.SymbolUtil.forEachLocationOfSymbol(symbol, ({ type, location }) => {
					if (
						(type === 'definition' || type === 'implementation')
						&& location.uri === ctx.doc.uri
					) {
						found = true
					}
				})
				return found
			})
			const identifier = core.ResourceLocationNode.toString(field, 'full')
			if (!currentFunction || currentFunction.identifier !== identifier) {
				ctx.err.report(
					localize(
						'expected',
						currentFunction?.identifier ?? 'THIS',
					),
					field,
				)
				return
			}
			if (node.access?.visibility === core.SymbolVisibility.File) {
				ctx.symbols.clear({
					uri: ctx.doc.uri,
					contributor: 'uri_binder',
					predicate: event =>
						event.symbol.category === 'function' && event.symbol.identifier === identifier,
				})
				ctx.meta.getCustom<Map<string, string>>('impdoc:private_function')!.get('uris')!.set(
					ctx.doc.uri,
					identifier,
				)
				const query = ctx.symbols.query({ doc: ctx.doc, node: field }, 'function', identifier)
				query.enter({
					data: { visibility: core.SymbolVisibility.File },
					usage: { type: 'implementation', range: core.Range.create(0) },
				})
				declareDocSymbol(node, field, 'function', identifier, ctx)
				field.symbol = query.symbol
				return
			}
			// Preserve file identity as an implementation under a matching doc declaration.
			for (const location of currentFunction.definition ?? []) {
				if (location.uri === ctx.doc.uri) {
					location.originalUsageType = 'definition'
				}
			}
			declareDocSymbol(node, field, 'function', identifier, ctx)
			return
		}
		declareDocSymbol(
			node,
			field,
			'function',
			core.ResourceLocationNode.toString(field, 'full'),
			ctx,
		)
	}

	override completer(
		node: core.DeepReadonly<DocNode>,
		ctx: core.CompleterContext,
	): core.CompletionItem[] {
		const field = node.fields[0]
		if (field?.type !== 'resource_location') {
			return []
		}
		const resource = field as core.DeepReadonly<core.ResourceLocationNode>
		if (ctx.offset <= resource.range.end || !resource.path) {
			return core.completer.resourceLocation(
				ctx.offset < resource.range.start || ctx.offset > resource.range.end
					? {
						...core.ResourceLocationNode.mock(ctx.offset, { category: 'function' }),
						parent: resource.parent as core.AstNode,
					}
					: resource,
				ctx,
			)
		}
		return []
	}
}
