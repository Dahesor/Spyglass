import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { DocAccess, DocDirectiveNode, DocNode } from '../node/index.js'

export type DocDirectiveOverride = ReadonlyMap<
	string,
	Partial<Pick<DocDirective, 'modifyAccess' | 'handleDirective'>>
>

/*
	Represents a documentation target.
*/
export interface DocTargets {
	/** Its identifier, for example, `tag` */
	readonly identifier: string
	/**
	 * Its own parser for fields.
	 * @returns Whether the fields are valid.
	 */
	parser(src: core.Source, ctx: core.ParserContext, node: DocNode): boolean

	binder(node: DocNode, ctx: core.BinderContext): void
	completer(node: core.DeepReadonly<DocNode>, ctx: core.CompleterContext): core.CompletionItem[]
	acceptedDirectives: string[]
	/** Override individual handlers of registered directives */
	directiveOverrides?: DocDirectiveOverride
}

/*
	Represents a documentation directive.
*/
export interface DocDirective {
	/** Its identifier, for example, `public` */
	readonly identifier: string
	/** If this directive can be used for any doc target. */
	readonly isCommon: boolean
	/** If this directive is an access modifier */
	readonly isAccessModifier: boolean
	/** If it requires one or more arguments */
	readonly hasMandatoryArgument: boolean
	/** If it may appear multiple times */
	readonly allowDuplicates: boolean
	/** Its description. Should be a list of localize key */
	readonly description?: string[]
	modifyAccess(
		directive: core.DeepReadonly<DocDirectiveNode>,
		node: DocNode,
		ctx: core.BinderContext,
	): DocAccess | undefined
	handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		node: DocNode,
		ctx: core.BinderContext,
	): string
}

export class DefaultDocTarget implements DocTargets {
	readonly identifier: string = 'default'
	readonly acceptedDirectives: string[] = []
	readonly directiveOverrides: DocDirectiveOverride = new Map()
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

export class DefaultDocDirective implements DocDirective {
	readonly identifier: string = 'null'
	readonly isCommon: boolean = true
	readonly allowDuplicates: boolean = false
	readonly isAccessModifier: boolean = false
	readonly hasMandatoryArgument: boolean = false
	get description(): string[] | undefined {
		return ['mcfunction.doc.directive.desc.' + this.identifier]
	}
	modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
	): DocAccess | undefined {
		return undefined
	}
	handleDirective(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
	): string {
		return ''
	}
}

/** Writes a symbol declaration for a doc block */
export function declareDocSymbol(
	node: DocNode,
	field: core.AstNode,
	category: string,
	identifier: string,
	ctx: core.BinderContext,
): void {
	const query = ctx.symbols.query({ doc: ctx.doc, node: field }, category, identifier)
	const usage = { type: 'declaration' as const, node: field, fromDocDeclaration: true }
	if (node.access?.visibility === core.SymbolVisibility.Restricted) {
		query.enterIsotope(`doc:${ctx.doc.uri}:${node.range.start}`, {
			data: {
				...node.access.isotope,
				docDeclaration: true,
				desc: node.description ?? '',
			},
			usage,
		})
	} else {
		query.enter({
			data: {
				visibility: node.access?.visibility ?? core.SymbolVisibility.Public,
				desc: node.description ?? '',
			},
			usage,
		})
	}
}

export function registerDocTarget(meta: core.MetaRegistry, target: DocTargets): void {
	meta.registerCustom<DocTargets>('impdoc:target', target.identifier, target)
}

export function registerDocDirective(meta: core.MetaRegistry, directive: DocDirective): void {
	meta.registerCustom<DocDirective>('impdoc:directive', directive.identifier, directive)
}

export const doc: core.InfallibleParser<DocNode> = (src, ctx) => {
	const start = src.cursor
	src.skip(2).skipSpace()
	const inlineAccessModifier = src.tryPeek('@') ? parseDirective(src, true) : undefined
	if (inlineAccessModifier) {
		src.skipSpace()
	}
	const directiveStart = src.cursor
	const docTargets = ctx.meta.getCustom<DocTargets>('impdoc:target')
	const isFunctionHeader = ctx.doc.positionAt(start).line === 0
	const names = isFunctionHeader ? ['function'] : [...(docTargets?.keys() ?? [])]
	const directive: core.LiteralNode = {
		type: 'literal',
		range: core.Range.create(directiveStart),
		value: src.readUntil(...core.Whitespaces),
		options: { pool: names, colorTokenType: 'type' },
	}
	directive.range.end = src.cursor
	const isImplicitFunction = isFunctionHeader
		&& !directive.value.startsWith('@')
		&& directive.value !== 'function'
		&& !docTargets?.has(directive.value)
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
	const docTarget = isFunctionHeader && directive.value !== 'function'
		? undefined
		: docTargets?.get(directive.value)
	const docBlockLines: string[] = []
	if (docTarget) {
		src.skipSpace()
		ans.valid = docTarget.parser(src, ctx, ans)
		const descriptionStart = src.cursor
		src.skipSpace()
		if (src.canReadInLine()) {
			src.cursor = descriptionStart
			const comment = src.readLine()
			docBlockLines.push(comment)
			const commentNode: core.CommentNode = {
				type: 'comment',
				prefix: '',
				comment,
				range: core.Range.create(descriptionStart, src),
			}
			ans.children.push(commentNode)
		}
	} else {
		ctx.err.report(localize('expected', names), directive)
		src.readLine()
	}
	if (inlineAccessModifier) {
		inlineAccessModifier.valid = validateDirective(inlineAccessModifier, docTarget, ctx)
		ans.valid = ans.valid && inlineAccessModifier.valid
	}

	// Look ahead for block doc and directives
	let wasDirectiveLine = false
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
			occurrence.valid = validateDirective(occurrence, docTarget, ctx)
			ans.valid = ans.valid && occurrence.valid
			ans.docDirectives.push(occurrence)
			ans.children.push(occurrence)
			if (!wasDirectiveLine) {
				docBlockLines.push('')
			}
			wasDirectiveLine = true
			continue
		}
		src.cursor = contentStart
		const comment = src.readLine()
		docBlockLines.push(comment)
		wasDirectiveLine = false
		const commentNode: core.CommentNode = {
			type: 'comment',
			prefix: '#',
			comment,
			range: core.Range.create(commentStart, src),
		}
		ans.children.push(commentNode)
	}
	ans.description = docBlockLines.length ? docBlockLines.join('\n') : undefined
	ans.range.end = src.cursor
	return ans
}

export const bindDoc = core.SyncBinder.create<DocNode>((node, ctx) => {
	if (!node.valid) {
		return
	}
	const docTarget = ctx.meta.getCustom<DocTargets>('impdoc:target')?.get(node.directive.value)
	if (!docTarget) {
		return
	}
	// Resolve the access policy before binding the target.
	node.access = undefined
	const accessModifierSeen: string[] = []
	for (const occurrence of node.docDirectives) {
		const docDirective = getDocDirective(ctx.meta, docTarget, occurrence.identifier)
		if (
			!occurrence.valid || !docDirective
			|| (!docDirective.allowDuplicates && accessModifierSeen.includes(docDirective.identifier))
		) {
			continue
		}
		accessModifierSeen.push(docDirective.identifier)
		if (docDirective.isAccessModifier) {
			const access = docDirective.modifyAccess(occurrence, node, ctx)
			if (access) {
				node.access = access
			}
		}
	}
	const errors = ctx.err.errors.length
	docTarget.binder(node, ctx)
	if (ctx.err.errors.length !== errors) {
		return
	}
	const seenDirectives: string[] = []
	for (const docDirective of node.docDirectives) {
		if (docDirective.valid) {
			handleDocDirective(docDirective, docTarget, node, ctx, seenDirectives)
		}
	}
	core.traversePreOrder(node, () => true, child => !!child.symbol, child => {
		const symbol = child.symbol!
		if (node.access?.visibility === core.SymbolVisibility.Restricted) {
			return
		}
		ctx.symbols.query({ doc: ctx.doc, node: child }, symbol.category, ...symbol.path).amend({
			data: {
				desc: node.description ?? '',
				visibility: symbol.visibility ?? core.SymbolVisibility.Public,
			},
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
				documentation: getDirectiveDescription(docDirective),
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

function getDirectiveDescription(directive: DocDirective): string | undefined {
	return directive.description?.length
		? directive.description.map(key => localize(key)).join('  \n')
		: undefined
}

function getDocDirective(
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
		allowDuplicates: directive.allowDuplicates,
		description: directive.description ?? undefined,
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

function handleDocDirective(
	occurrence: core.DeepReadonly<DocDirectiveNode>,
	target: DocTargets,
	node: DocNode,
	ctx: core.BinderContext,
	seenDirectives: string[],
): string | undefined {
	const identifier = occurrence.identifier
	const range = occurrence.range
	const directive = getDocDirective(ctx.meta, target, identifier)
	if (!directive) {
		ctx.err.report(
			localize('mcfunction.doc.directive.diagnostic.unknown', localeQuote(identifier)),
			range,
		)
		return undefined
	}
	if (!directive.isCommon && !target.acceptedDirectives.includes(directive.identifier)) {
		ctx.err.report(
			localize(
				'mcfunction.doc.directive.diagnostic.disallowed',
				localeQuote(identifier),
				localeQuote(target.identifier),
			),
			range,
		)
		return undefined
	}
	if (!directive.allowDuplicates && seenDirectives.includes(identifier)) {
		ctx.err.report(
			localize('mcfunction.doc.directive.diagnostic.duplicate', localeQuote(identifier)),
			occurrence.identifierRange,
			core.ErrorSeverity.Warning,
		)
		return undefined
	}
	seenDirectives.push(identifier)
	return directive.handleDirective(occurrence, node, ctx)
}

function parseDirective(src: core.Source, isInline: boolean): DocDirectiveNode {
	const cursorStart = src.cursor
	// skip initial '@'
	src.skip()
	const identifier = src.readUntil(...core.Whitespaces)
	const identifierRange = core.Range.create(cursorStart, src)
	const args: string[] = []
	if (!isInline) {
		while (src.skipSpace().canReadInLine()) {
			args.push(src.readUntil(...core.Whitespaces))
		}
	}
	return {
		type: 'mcfunction:doc_directive',
		range: core.Range.create(cursorStart, src),
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
			localize('mcfunction.doc.directive.diagnostic.unknown', localeQuote(node.identifier)),
			node,
		)
		return false
	}
	node.hover = getDirectiveDescription(docDirective)
	if (target && !docDirective.isCommon && !target.acceptedDirectives.includes(node.identifier)) {
		ctx.err.report(
			localize(
				'mcfunction.doc.directive.diagnostic.disallowed',
				localeQuote(node.identifier),
				localeQuote(target.identifier),
			),
			node,
		)
		return false
	}
	if (node.isInline && (!docDirective.isAccessModifier || docDirective.hasMandatoryArgument)) {
		ctx.err.report(localize('mcfunction.doc.directive.diagnostic.inline'), node)
		return false
	}
	if (!node.isInline && docDirective.hasMandatoryArgument && !node.arguments.length) {
		ctx.err.report(
			localize('mcfunction.doc.directive.diagnostic.argument', localeQuote(node.identifier)),
			node,
		)
		return false
	}
	return true
}
