import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { DocDirectiveNode, DocNode } from '../node/index.js'

export type DocDirectiveOverride = ReadonlyMap<
	string,
	Partial<Pick<DocDirective, 'modifyAccess' | 'handleDirective'>>
>

/*
	Represents a documentation target.
*/
export interface DocTargets {
	// Its identifier, for example, 'tag'
	identifier: string
	// Its own parser for fields. Returns whether the fields form a valid declaration.
	parser(src: core.Source, ctx: core.ParserContext, node: DocNode): boolean

	binder(node: DocNode, ctx: core.BinderContext): void
	completer(node: core.DeepReadonly<DocNode>, ctx: core.CompleterContext): core.CompletionItem[]
	acceptedDirectives: string[]
	// Override individual handlers of registered directives
	directiveOverrides?: DocDirectiveOverride
}

export class DefaultDocTarget implements DocTargets {
	identifier: string = 'default'
	acceptedDirectives: string[] = []
	directiveOverrides: DocDirectiveOverride = new Map()
	parser(_src: core.Source, _ctx: core.ParserContext, _node: DocNode): boolean {
		return true
	}
	binder(_node: DocNode, _ctx: core.BinderContext): void {}
	completer(
		_node: core.DeepReadonly<DocNode>,
		_ctx: core.CompleterContext,
	): core.CompletionItem[] {
		return []
	}
}

/*
	Represents a documentation directive.
*/
export interface DocDirective {
	// Its identifier, for example, 'public'
	identifier: string
	// If this directive can be used for any doc target.
	isCommon: boolean
	// If this directive is an access modifier
	isAccessModifier: boolean
	// If it requires one or more arguments
	hasMandatoryArgument: boolean
	modifyAccess(
		directive: core.DeepReadonly<DocDirectiveNode>,
		node: DocNode,
		ctx: core.BinderContext,
	): void
	handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		node: DocNode,
		ctx: core.BinderContext,
	): string
}

export class DefaultDocDirective implements DocDirective {
	identifier: string = 'null'
	isCommon: boolean = true
	isAccessModifier: boolean = false
	allowUsage: boolean = true
	hasMandatoryArgument: boolean = false
	modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
	): void {
	}
	handleDirective(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
	): string {
		return ''
	}
}

export function registerDocTarget(meta: core.MetaRegistry, target: DocTargets): void {
	meta.registerCustom<DocTargets>('impdoc:target', target.identifier, target)
}

export function registerDocDirective(meta: core.MetaRegistry, directive: DocDirective): void {
	meta.registerCustom<DocDirective>('impdoc:directive', directive.identifier, directive)
}

export function getDocDirective(
	meta: core.MetaRegistry,
	target: DocTargets,
	identifier: string,
): DocDirective | undefined {
	const directive = meta.getCustom<DocDirective>('impdoc:directive')?.get(identifier)
	if (!directive) {
		return undefined
	}
	const overrides = target.directiveOverrides?.get(identifier)
	return {
		identifier: directive.identifier,
		isCommon: directive.isCommon,
		isAccessModifier: directive.isAccessModifier,
		hasMandatoryArgument: directive.hasMandatoryArgument,
		modifyAccess: (occurrence, node, ctx) =>
			overrides?.modifyAccess
				? overrides.modifyAccess(occurrence, node, ctx)
				: directive.modifyAccess(occurrence, node, ctx),
		handleDirective: (occurrence, node, ctx) =>
			overrides?.handleDirective
				? overrides.handleDirective(occurrence, node, ctx)
				: directive.handleDirective(occurrence, node, ctx),
	}
}

export function getAcceptedDocDirectives(
	meta: core.MetaRegistry,
	target: DocTargets,
): DocDirective[] {
	return [...(meta.getCustom<DocDirective>('impdoc:directive')?.values() ?? [])]
		.filter(directive =>
			directive.isCommon || target.acceptedDirectives.includes(directive.identifier)
		)
		.map(directive => getDocDirective(meta, target, directive.identifier)!)
}

export function handleDocDirective(
	occurrence: core.DeepReadonly<DocDirectiveNode>,
	target: DocTargets,
	node: DocNode,
	ctx: core.BinderContext,
): string | undefined {
	const identifier = occurrence.identifier
	const range = occurrence.range
	const directive = getDocDirective(ctx.meta, target, identifier)
	if (!directive) {
		ctx.err.report(localize('mcfunction.doc.directive.unknown', localeQuote(identifier)), range)
		return undefined
	}
	if (!directive.isCommon && !target.acceptedDirectives.includes(directive.identifier)) {
		ctx.err.report(
			localize(
				'mcfunction.doc.directive.disallowed',
				localeQuote(identifier),
				localeQuote(target.identifier),
			),
			range,
		)
		return undefined
	}
	if (directive.isAccessModifier) {
		directive.modifyAccess(occurrence, node, ctx)
	}
	return directive.handleDirective(occurrence, node, ctx)
}

function parseDirective(src: core.Source, isInline: boolean): DocDirectiveNode {
	const start = src.cursor
	src.skip()
	const identifier = src.readUntil(...core.Whitespaces)
	const identifierRange = core.Range.create(start, src)
	const args: string[] = []
	if (!isInline) {
		while (src.skipSpace().canReadInLine()) {
			args.push(src.readUntil(...core.Whitespaces))
		}
	}
	return {
		type: 'mcfunction:doc_directive',
		range: core.Range.create(start, src),
		identifier,
		identifierRange,
		arguments: args,
		isInline,
		valid: false,
	}
}

function validateDirective(
	node: DocDirectiveNode,
	target: DocTargets | undefined,
	ctx: core.ParserContext,
): boolean {
	const docDirective = ctx.meta.getCustom<DocDirective>('impdoc:directive')?.get(node.identifier)
	if (!docDirective) {
		ctx.err.report(
			localize('mcfunction.doc.directive.unknown', localeQuote(node.identifier)),
			node,
		)
		return false
	}
	if (target && !docDirective.isCommon && !target.acceptedDirectives.includes(node.identifier)) {
		ctx.err.report(
			localize(
				'mcfunction.doc.directive.disallowed',
				localeQuote(node.identifier),
				localeQuote(target.identifier),
			),
			node,
		)
		return false
	}
	if (node.isInline && (!docDirective.isAccessModifier || docDirective.hasMandatoryArgument)) {
		ctx.err.report(localize('mcfunction.doc.directive.inline'), node)
		return false
	}
	if (!node.isInline && docDirective.hasMandatoryArgument && !node.arguments.length) {
		ctx.err.report(
			localize('mcfunction.doc.directive.argument', localeQuote(node.identifier)),
			node,
		)
		return false
	}
	return true
}

export const doc: core.InfallibleParser<DocNode> = (src, ctx) => {
	const start = src.cursor
	src.skip(2).skipSpace()
	const inlineAccessModifier = src.tryPeek('@') ? parseDirective(src, true) : undefined
	if (inlineAccessModifier) {
		src.skipSpace()
	}
	const directiveStart = src.cursor
	const targets = ctx.meta.getCustom<DocTargets>('impdoc:target')
	const isFunctionHeader = ctx.doc.positionAt(start).line === 0
	const names = isFunctionHeader ? ['function'] : [...(targets?.keys() ?? [])]
	const directive: core.LiteralNode = {
		type: 'literal',
		range: core.Range.create(directiveStart),
		value: src.readUntil(...core.Whitespaces),
		options: { pool: names, colorTokenType: 'keyword' },
	}
	directive.range.end = src.cursor
	const isImplicitFunction = isFunctionHeader && !directive.value.startsWith('@')
		&& directive.value !== 'function'
		&& !targets?.has(directive.value)
	if (isImplicitFunction) {
		src.cursor = directiveStart
		directive.value = 'function'
		directive.range.end = directiveStart
	}
	const ans: DocNode = {
		type: 'mcfunction:doc',
		range: core.Range.create(start),
		children: inlineAccessModifier ? [inlineAccessModifier, directive] : [directive],
		fields: [],
		docDirectives: inlineAccessModifier ? [inlineAccessModifier] : [],
		directive,
		valid: false,
		isFunctionHeader,
		isImplicitFunction,
	}
	const target = isFunctionHeader && directive.value !== 'function'
		? undefined
		: targets?.get(directive.value)
	if (target) {
		src.skipSpace()
		ans.valid = target.parser(src, ctx, ans)
		src.skipSpace()
		if (src.canReadInLine()) {
			const trailingStart = src.cursor
			const trailing = src.readLine()
			ctx.err.report(
				localize('mcfunction.parser.trailing', localeQuote(trailing)),
				core.Range.create(trailingStart, src),
			)
			ans.valid = false
		}
	} else {
		ctx.err.report(localize('expected', names), directive)
		src.readLine()
	}
	if (inlineAccessModifier) {
		inlineAccessModifier.valid = validateDirective(inlineAccessModifier, target, ctx)
		ans.valid = ans.valid && inlineAccessModifier.valid
	}
	const lines: string[] = []
	let previousWasDirective = false

	// Look ahead for block doc and directives
	while (true) {
		const next = src.clone().nextLine().skipSpace()
		if (!next.tryPeek('#') || next.tryPeek('#>')) {
			break
		}
		src.cursor = next.cursor
		const commentStart = src.cursor
		src.skip()
		const contentStart = src.cursor
		src.skipSpace()
		if (src.tryPeek('@')) {
			const occurrence = parseDirective(src, false)
			occurrence.range.start = commentStart
			occurrence.valid = validateDirective(occurrence, target, ctx)
			ans.valid = ans.valid && occurrence.valid
			ans.docDirectives.push(occurrence)
			ans.children.push(occurrence)
			if (!previousWasDirective) {
				lines.push('')
			}
			previousWasDirective = true
			continue
		}
		src.cursor = contentStart
		const comment = src.readLine()
		lines.push(comment)
		previousWasDirective = false
		const commentNode: core.CommentNode = {
			type: 'comment',
			prefix: '#',
			comment,
			range: core.Range.create(commentStart, src),
		}
		ans.children.push(commentNode)
	}
	ans.description = lines.length ? lines.join('\n') : undefined
	ans.range.end = src.cursor
	return ans
}

export const bindDoc = core.SyncBinder.create<DocNode>((node, ctx) => {
	if (!node.valid) {
		return
	}
	const target = ctx.meta.getCustom<DocTargets>('impdoc:target')?.get(node.directive.value)
	if (!target) {
		return
	}
	const errors = ctx.err.errors.length
	target.binder(node, ctx)
	if (ctx.err.errors.length !== errors) {
		return
	}
	for (const directive of node.docDirectives) {
		if (directive.valid) {
			handleDocDirective(directive, target, node, ctx)
		}
	}
	core.traversePreOrder(node, () => true, child => !!child.symbol, child => {
		const symbol = child.symbol!
		ctx.symbols.query({ doc: ctx.doc, node: child }, symbol.category, ...symbol.path).amend({
			data: { desc: node.description ?? '' },
		})
	})
})

export const completeDoc: core.Completer<DocNode> = (node, ctx) => {
	const docTargets = ctx.meta.getCustom<DocTargets>('impdoc:target')
	const docTarget = docTargets?.get(node.directive.value)
	const docDirectives = [...(ctx.meta.getCustom<DocDirective>('impdoc:directive')?.values() ?? [])]
	const accepts = (docDirective: DocDirective, candidate: DocTargets) =>
		docDirective.isCommon || candidate.acceptedDirectives.includes(docDirective.identifier)
	const inlineDocDirectives = docDirectives.filter(docDirective =>
		docDirective.isAccessModifier && !docDirective.hasMandatoryArgument
	)
	const completeDirectives = (pool: DocDirective[], range: core.RangeLike) =>
		pool.map(docDirective =>
			core.CompletionItem.create(`@${docDirective.identifier}`, range, {
				kind: core.CompletionKind.Property,
			})
		)
	const occurrence = node.docDirectives.find(docDirective =>
		core.Range.contains(docDirective.range, ctx.offset, true)
	)
	if (occurrence) {
		if (ctx.offset > occurrence.identifierRange.end) {
			return []
		}
		return completeDirectives(
			occurrence.isInline
				? inlineDocDirectives
				: docDirectives.filter(directive => docTarget && accepts(directive, docTarget)),
			occurrence.identifierRange,
		)
	}
	if (
		node.children.some(child =>
			child.type === 'comment' && core.Range.contains(child.range, ctx.offset, true)
		)
	) {
		return []
	}
	if (ctx.offset < node.range.start + 2) {
		return []
	}
	const emptyImplicitFunction = node.isImplicitFunction && node.fields[0]?.range.start
			=== node.fields[0]?.range.end
	if (
		ctx.offset <= node.directive.range.end
		&& (!node.isImplicitFunction || emptyImplicitFunction)
	) {
		const range = ctx.offset < node.directive.range.start
			? core.Range.create(ctx.offset)
			: node.directive.range
		const items = core.completer.literal({ ...node.directive, range }, ctx)
		return node.docDirectives.some(directive => directive.isInline)
			? items
			: [...items, ...completeDirectives(inlineDocDirectives, range)]
	}
	return docTarget?.completer(node, ctx) ?? []
}
