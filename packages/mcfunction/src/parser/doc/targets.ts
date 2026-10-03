import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { DocNode } from '../../node/index.js'
import { DefaultDocTarget, registerDocTarget } from '../doc.js'

export function registerDocTargets(meta: core.MetaRegistry): void {
	registerDocTarget(meta, new TagDocTarget())
	registerDocTarget(meta, new FunctionDocTarget())
	registerDocTarget(meta, new ObjectiveDocTarget())
	registerDocTarget(meta, new ScoreDocTarget())
}

class SymbolDocTarget extends DefaultDocTarget {
	constructor(
		public override identifier: string,
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
		ctx.symbols.query({ doc: ctx.doc, node: tag }, this.category, tag.value).enter({
			data: { visibility: node.visibility ?? core.SymbolVisibility.Public },
			usage: { type: 'declaration', node: tag },
		})
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

export class FunctionDocTarget extends DefaultDocTarget {
	override identifier = 'function'

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
			const currentFunction = Object.values(
				ctx.symbols.getVisibleSymbols('function', ctx.doc.uri),
			)
				.find(symbol => symbol.definition?.some(location => location.uri === ctx.doc.uri))
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
			if (node.visibility === core.SymbolVisibility.File) {
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
					usage: { type: 'definition', range: core.Range.create(0) },
				})
				field.symbol = query.symbol
				return
			}
			field.symbol = currentFunction
			return
		}
		ctx.symbols.query(
			{ doc: ctx.doc, node: field },
			'function',
			core.ResourceLocationNode.toString(field, 'full'),
		)
			.enter({
				data: { visibility: node.visibility ?? core.SymbolVisibility.Public },
				usage: { type: 'declaration', node: field },
			})
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
