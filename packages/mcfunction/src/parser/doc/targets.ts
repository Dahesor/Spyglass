import { GlobalSymbol } from '@spyglassmc/core'
import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { DocNode } from '../../node/index.js'
import {
	declareDocSymbol,
	DefaultDocTarget,
	getCurrentFunctionIdentifier,
	registerDocTarget,
} from '../doc.js'

export function registerDocTargets(meta: core.MetaRegistry): void {
	registerDocTarget(meta, new FunctionDocTarget())
	registerDocTarget(meta, new SymbolDocTarget('tag', 'tag'))
	registerDocTarget(meta, new SymbolDocTarget('objective', 'objective'))
	registerDocTarget(meta, new SymbolDocTarget('team', 'team'))
	registerDocTarget(meta, new SymbolDocTarget('score', 'score_holder', false))

	core.NormalFileCategories.forEach(registry => {
		if (registry === 'function') {
			return
		}
		registerDocTarget(meta, new RegistryDocTarget(registry, registry))
	})
	core.DataMiscCategories.forEach(registry => {
		registerDocTarget(meta, new RegistryDocTarget(registry, registry))
	})
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

class RegistryDocTarget extends DefaultDocTarget {
	constructor(
		public override readonly identifier: string,
		private readonly registry: core.ResourceLocationCategory,
	) {
		super()
	}

	override binder(node: DocNode, ctx: core.BinderContext): void {
		const field = node.fields[0]
		if (!core.ResourceLocationNode.is(field)) {
			return
		}
		declareDocSymbol(
			node,
			field,
			this.registry,
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
						...core.ResourceLocationNode.mock(ctx.offset, { category: this.registry }),
						parent: resource.parent as core.AstNode,
					}
					: resource,
				ctx,
			)
		}
		return []
	}

	override parser(src: core.Source, ctx: core.ParserContext, node: DocNode): boolean {
		const errors = ctx.err.errors.length
		const field = core.stopBefore(
			core.resourceLocation({ category: this.registry, usageType: 'declaration' }),
			core.Whitespaces,
		)(src, ctx)
		node.fields.push(field)
		node.children.push(field)
		return ctx.err.errors.length === errors
	}
}
class FunctionDocTarget extends RegistryDocTarget {
	constructor() {
		super('function', 'function')
	}
	override acceptedDirectives: string[] = [
		'chatonly',
		'reads',
		'writes',
		'input',
		'context',
		'returns',
	]
	override binder(node: DocNode, ctx: core.BinderContext): void {
		const field = node.fields[0]
		if (!core.ResourceLocationNode.is(field)) {
			return
		}
		if (node.isFunctionHeader) {
			const currentFunction = getCurrentFunctionIdentifier(ctx)
			const identifier = core.ResourceLocationNode.toString(field, 'full')
			if (!currentFunction || currentFunction !== identifier) {
				ctx.err.report(
					localize(
						'expected',
						currentFunction ?? 'THIS',
					),
					field,
				)
				return
			}
			if (node.access?.visibility === core.SymbolIsotopeScope.Local) {
				GlobalSymbol.clear(ctx.symbols, {
					uri: ctx.doc.uri,
					contributor: 'uri_binder',
					predicate: event =>
						event.symbol.category === 'function' && event.symbol.identifier === identifier,
				})
				ctx.meta.getCustom<Map<string, string>>('impdoc:private_function')!.get('uris')!.set(
					ctx.doc.uri,
					identifier,
				)
				const query = core.LocalSymbol.queryForScope(
					ctx.symbols,
					{ doc: ctx.doc, node: field },
					core.LocalSymbolVisibility.File,
					'function',
					identifier,
				)
				query.enter({
					usage: {
						type: 'implementation',
						range: core.Range.create(0),
						fromFile: true,
					},
				})
				declareDocSymbol(node, field, 'function', identifier, ctx)
				field.symbol = query.symbol
				return
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
}
