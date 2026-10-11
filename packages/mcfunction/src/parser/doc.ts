import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { DocAccess, DocDirectiveNode, DocNode } from '../node/index.js'

export type DocDirectiveOverride = ReadonlyMap<
	string,
	Partial<
		Pick<
			DocDirective,
			'modifyAccess' | 'handleDirective' | 'parseArguments' | 'includeInSuggestion' | 'completer'
		>
	>
>
/**
 * The return type of a documentation directive handler.
 */
export type DocDirectiveReturn = {
	/** The documentation produced. Joined with `\n` */
	desc?: string[]
	/** Additional data produced by the directive handler. */
	data?: Record<string, unknown>
	/** Mark the documented symbol as deprecated. False or absence does not undo another handler's mark. */
	mark_deprecated?: boolean
}

export interface DocCommentInput {
	readonly text: string
	readonly indent: number
	/** The complete comment line, including # and indentation. */
	readonly range: core.Range
	readonly textRange: core.Range
}

export interface DocDirectiveParserContext {
	readonly caller?: core.DeepReadonly<DocDirectiveNode>
	readonly indent: number
	/** Inspect a more deeply indented ordinary comment without consuming it. */
	peekComment(): DocCommentInput | undefined
	/** Read and consume a more deeply indented ordinary comment if accepted. */
	readComment(accepts?: (comment: DocCommentInput) => boolean): DocCommentInput | undefined
	/** Read another directive as the input */
	readDirective(accepts: (identifier: string) => boolean): DocDirectiveNode | undefined
}

export interface DocDirectiveSuggestCtx {
	readonly node: core.DeepReadonly<DocNode>
	readonly occurrence?: core.DeepReadonly<DocDirectiveNode>
	readonly possibleCallers: readonly core.DeepReadonly<DocDirectiveNode>[]
}

export interface DocDirectiveHandlerContext {
	readonly caller?: core.DeepReadonly<DocDirectiveNode>
	handleDirective(child: core.DeepReadonly<DocDirectiveNode>): DocDirectiveReturn | undefined
}

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
	completer?(
		directive: core.DeepReadonly<DocDirectiveNode>,
		ctx: core.CompleterContext,
	): core.CompletionItem[]
	parseArguments?(
		src: core.Source,
		directive: DocDirectiveNode,
		ctx: core.ParserContext,
		input: DocDirectiveParserContext,
	): void
	modifyAccess(
		directive: core.DeepReadonly<DocDirectiveNode>,
		node: DocNode,
		ctx: core.BinderContext,
	): DocAccess | undefined
	handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		node: DocNode,
		ctx: core.BinderContext,
		input: DocDirectiveHandlerContext,
	): DocDirectiveReturn
	/** Whether this directive should be included in suggestion lists
	 * Note that this does not affect the actual parsing or handling of the directive.
	 */
	includeInSuggestion(ctx: core.CompleterContext, input: DocDirectiveSuggestCtx): boolean
}

export class DefaultDocTarget implements DocTargets {
	readonly identifier: string = ''
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
	readonly identifier: string = ''
	readonly isCommon: boolean = true
	readonly allowDuplicates: boolean = false
	readonly isAccessModifier: boolean = false
	readonly hasMandatoryArgument: boolean = false
	get description(): string[] | undefined {
		return ['mcfunction.doc.directive.desc.' + this.identifier]
	}
	parseArguments(
		src: core.Source,
		directive: DocDirectiveNode,
		_ctx: core.ParserContext,
		_input: DocDirectiveParserContext,
	): void {
		while (src.skipSpace().canReadInLine()) {
			directive.arguments.push(src.readUntil(...core.Whitespaces))
		}
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
		_input: DocDirectiveHandlerContext,
	): DocDirectiveReturn {
		return {}
	}
	includeInSuggestion(_ctx: core.CompleterContext, input: DocDirectiveSuggestCtx): boolean {
		return input.possibleCallers.length === 0
	}
	completer(
		directive: core.DeepReadonly<DocDirectiveNode>,
		ctx: core.CompleterContext,
	): core.CompletionItem[] {
		const argument = directive.argumentNode
		return argument && core.Range.contains(argument.range, ctx.offset, true)
			? core.completer.dispatch(argument, ctx)
			: []
	}
}

export function registerDocTarget(meta: core.MetaRegistry, target: DocTargets): void {
	if (target.identifier === '') {
		throw new Error('Doc target must have a non-empty identifier')
	}
	meta.registerCustom<DocTargets>('impdoc:target', target.identifier, target)
}

export function registerDocDirective(meta: core.MetaRegistry, directive: DocDirective): void {
	if (directive.identifier === '') {
		throw new Error('Doc directive must have a non-empty identifier')
	}
	meta.registerCustom<DocDirective>('impdoc:directive', directive.identifier, directive)
}

/** Writes a symbol declaration for a doc block */
export function declareDocSymbol(
	node: DocNode,
	field: core.AstNode,
	category: string,
	identifier: string,
	ctx: core.BinderContext,
): core.SymbolHandle {
	const usage: core.SymbolAdditionUsage = {
		type: 'declaration',
		node: field,
		fromDocDeclaration: true,
	}
	const access = node.access
	const local = access?.visibility === core.SymbolIsotopeScope.Local
	const handle = local
		? core.LocalSymbol.queryInsideScope(
			ctx.symbols,
			{ doc: ctx.doc, node: field },
			core.LocalSymbolVisibility.File,
			category,
			identifier,
		)
		: ctx.symbols.query({ doc: ctx.doc, node: field }, category, identifier)
	if (local) {
		return handle.enter({
			data: { desc: node.description ?? '', deprecated: node.deprecated },
			usage,
		})
	}
	return handle.enterIsotope(`doc:${ctx.doc.uri}:${node.range.start}`, {
		data: {
			scope: access?.visibility ?? core.SymbolIsotopeScope.Global,
			...(
				access?.visibility === core.SymbolIsotopeScope.Private
					|| access?.visibility === core.SymbolIsotopeScope.Protected
					? { visibleWithin: access.visibleWithin }
					: {}
			),
			source: core.SymbolIsotopeProvider.DocBlock,
			...(
				access?.overrideLevel !== undefined ? { overrideLevel: access.overrideLevel } : {}
			),
			origin: { uri: ctx.doc.uri, contributor: 'binder' },
			desc: node.description ?? '',
			deprecated: node.deprecated,
		},
		usage,
	})
}

export const doc: core.InfallibleParser<DocNode> = (src, ctx) => {
	const start = src.cursor
	src.skip(2).skipSpace()
	const inlineDirectives: DocDirectiveNode[] = []
	while (src.tryPeek('@')) {
		inlineDirectives.push(parseDirective(src, true, ctx))
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
		children: [...inlineDirectives, directive],
		fields: [],
		docDirectives: inlineDirectives,
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
	for (const occurrence of inlineDirectives) {
		occurrence.valid = validateDirective(occurrence, docTarget, ctx)
		ans.valid = ans.valid && occurrence.valid
	}

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
			const indent = src.cursor - contentStart
			const occurrence = parseDirective(src, false, ctx, undefined, indent, docTarget)
			occurrence.range.start = commentStart
			occurrence.valid = validateDirective(occurrence, docTarget, ctx)
			ans.valid = ans.valid && occurrence.valid
			ans.docDirectives.push(occurrence)
			ans.children.push(occurrence)
			continue
		}
		src.cursor = contentStart
		const comment = src.readLine()
		docBlockLines.push(comment)
		const commentNode: core.CommentNode = {
			type: 'comment',
			prefix: '#',
			comment,
			range: core.Range.create(commentStart, src),
		}
		ans.children.push(commentNode)
	}
	ans.description = docBlockLines.length ? docBlockLines.join('\n') : undefined
	ans.commentDescription = ans.description
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
	node.deprecated = undefined
	const accessModifierSeen = new Set<string>()
	for (const occurrence of node.docDirectives) {
		const docDirective = getDocDirective(ctx.meta, docTarget, occurrence.identifier)
		if (
			!occurrence.valid || !docDirective
			|| (!docDirective.allowDuplicates && accessModifierSeen.has(docDirective.identifier))
		) {
			continue
		}
		accessModifierSeen.add(docDirective.identifier)
		if (docDirective.isAccessModifier) {
			const access = docDirective.modifyAccess(occurrence, node, ctx)
			if (access) {
				node.access = access
			}
		}
	}
	for (const occurrence of node.docDirectives) {
		core.binder.fallbackSync(occurrence, ctx)
	}
	const seenDirectives = new Set<string>()
	const descriptions: string[] = []
	for (const occurrence of node.docDirectives) {
		if (occurrence.valid) {
			const result = handleDocDirective(occurrence, docTarget, node, ctx, seenDirectives)
			if (result?.desc?.length) {
				descriptions.push(result.desc.join('\n'))
			}
		}
	}
	node.description = [node.commentDescription, ...descriptions].filter(value =>
		value !== undefined && value !== ''
	)
		.join('\n\n') || undefined
	docTarget.binder(node, ctx)
})

export function getCurrentFunctionIdentifier(ctx: core.ProcessorContext): string | undefined {
	const privateIdentifier = ctx.meta.getCustom<Map<string, string>>('impdoc:private_function')
		?.get('uris')?.get(ctx.doc.uri)
	if (privateIdentifier) {
		return privateIdentifier
	}
	for (const symbol of ctx.symbols.getSymbolsInFile(ctx.doc.uri)) {
		if (symbol.category !== 'function') {
			continue
		}
		for (const owner of core.SymbolUtil.allUsageContainers(symbol)) {
			const isCurrentFile = (location: core.SymbolLocation) =>
				location.uri === ctx.doc.uri
				&& (location.fromFile || location.contributor === 'uri_binder')
			if (owner.definition?.some(isCurrentFile) || owner.implementation?.some(isCurrentFile)) {
				return symbol.identifier
			}
		}
	}
	const match = /\/data\/([^/]+)\/functions?\/(.+)\.mcfunction$/.exec(ctx.doc.uri)
	return match ? `${decodeURIComponent(match[1])}:${decodeURIComponent(match[2])}` : undefined
}

export function getDirectiveDescription(directive: DocDirective): string | undefined {
	return directive.description?.length
		? directive.description.map(key => localize(key)).join('  \n')
		: undefined
}

export function getDocDirective(
	meta: core.MetaRegistry,
	target: DocTargets | undefined,
	identifier: string,
): DocDirective | undefined {
	const directive = meta.getCustom<DocDirective>('impdoc:directive')?.get(identifier)
	if (!directive) {
		return undefined
	}
	const overrides = target?.directiveOverrides?.get(identifier)
	const parseArguments = overrides?.parseArguments ?? directive.parseArguments
	return {
		identifier: directive.identifier,
		isCommon: directive.isCommon,
		isAccessModifier: directive.isAccessModifier,
		hasMandatoryArgument: directive.hasMandatoryArgument,
		allowDuplicates: directive.allowDuplicates,
		description: directive.description ?? undefined,
		parseArguments: parseArguments?.bind(directive),
		completer:
			(overrides?.completer ?? directive.completer ?? DefaultDocDirective.prototype.completer)
				.bind(directive),
		includeInSuggestion: (completionCtx, input) =>
			(overrides?.includeInSuggestion ?? directive.includeInSuggestion).call(
				directive,
				completionCtx,
				input,
			),
		modifyAccess: (occurrence, node, ctx) =>
			overrides?.modifyAccess
				? overrides.modifyAccess(occurrence, node, ctx)
				: directive.modifyAccess(occurrence, node, ctx),
		handleDirective: (occurrence, node, ctx, input) =>
			overrides?.handleDirective
				? overrides.handleDirective(occurrence, node, ctx, input)
				: directive.handleDirective(occurrence, node, ctx, input),
	}
}

function handleDocDirective(
	occurrence: core.DeepReadonly<DocDirectiveNode>,
	target: DocTargets,
	node: DocNode,
	ctx: core.BinderContext,
	seenDirectives: Set<string>,
	caller?: core.DeepReadonly<DocDirectiveNode>,
): DocDirectiveReturn | undefined {
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
	if (
		!caller && !directive.isCommon && !target.acceptedDirectives.includes(directive.identifier)
	) {
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
	if (!directive.allowDuplicates && seenDirectives.has(identifier)) {
		ctx.err.report(
			localize('mcfunction.doc.directive.diagnostic.duplicate', localeQuote(identifier)),
			occurrence.identifierRange,
			core.ErrorSeverity.Warning,
		)
		return undefined
	}
	seenDirectives.add(identifier)
	const seenChildren = new Set<string>()
	const children = new Set(occurrence.docDirectives)
	const handled = new Set<core.DeepReadonly<DocDirectiveNode>>()
	const result = directive.handleDirective(occurrence, node, ctx, {
		caller,
		handleDirective: child => {
			if (!children.has(child) || !child.valid || handled.has(child)) {
				return undefined
			}
			handled.add(child)
			return handleDocDirective(child, target, node, ctx, seenChildren, occurrence)
		},
	})
	if (result.mark_deprecated) {
		node.deprecated = true
	}
	return result
}

function peekIndentedDocLine(src: core.Source, indent: number) {
	const next = src.clone().nextLine().skipSpace()
	if (!next.trySkip('#') || next.tryPeek('>')) {
		return undefined
	}
	const commentStart = next.cursor - 1
	const contentStart = next.cursor
	next.skipSpace()
	const childIndent = next.cursor - contentStart
	return childIndent > indent ? { next, commentStart, childIndent } : undefined
}

function peekCommentInput(src: core.Source, indent: number): DocCommentInput | undefined {
	const line = peekIndentedDocLine(src, indent)
	if (!line || line.next.tryPeek('@')) {
		return undefined
	}
	const textStart = line.next.cursor
	const text = line.next.readLine()
	return {
		text,
		indent: line.childIndent,
		range: core.Range.create(line.commentStart, line.next),
		textRange: core.Range.create(textStart, line.next),
	}
}

function parseDirective(
	src: core.Source,
	isInline: boolean,
	ctx: core.ParserContext,
	caller?: DocDirectiveNode,
	indent = 0,
	target?: DocTargets,
): DocDirectiveNode {
	const cursorStart = src.cursor
	// skip initial '@'
	src.skip()
	const identifier = src.readUntil(...core.Whitespaces)
	const identifierRange = core.Range.create(cursorStart, src)
	const node: DocDirectiveNode = {
		type: 'mcfunction:doc_directive',
		range: core.Range.create(cursorStart, src),
		identifier,
		identifierRange,
		arguments: [],
		children: [],
		docDirectives: [],
		isInline,
		valid: false,
	}
	if (!isInline) {
		const directive = getDocDirective(ctx.meta, target, identifier)
		const input: DocDirectiveParserContext = {
			caller,
			indent,
			peekComment: () => peekCommentInput(src, indent),
			readComment: accepts => {
				const comment = peekCommentInput(src, indent)
				if (!comment || (accepts && !accepts(comment))) {
					return undefined
				}
				src.cursor = comment.range.end
				node.children.push(
					{
						type: 'comment',
						prefix: '#',
						comment: comment.text,
						range: comment.range,
					} as core.CommentNode,
				)
				return comment
			},
			readDirective: accepts => {
				const line = peekIndentedDocLine(src, indent)
				if (!line) {
					return undefined
				}
				const { next, commentStart, childIndent } = line
				const suggestionStart = next.cursor
				if (!next.tryPeek('@')) {
					return undefined
				}
				const identifiers = [
					...(ctx.meta.getCustom<DocDirective>('impdoc:directive')?.keys() ?? []),
				]
					.filter(accepts)
				const suggestionEnd = next.clone().readLine().length + suggestionStart
				node.argumentSuggestions ??= []
				node.argumentSuggestions.push({
					range: core.Range.create(suggestionStart, suggestionEnd),
					identifiers,
				})
				if (!next.trySkip('@')) {
					return undefined
				}
				const childIdentifier = next.readUntil(...core.Whitespaces)
				if (!accepts(childIdentifier)) {
					return undefined
				}
				src.cursor = suggestionStart
				const child = parseDirective(src, false, ctx, node, childIndent, target)
				child.range.start = commentStart
				child.valid = validateDirective(child, undefined, ctx)
				node.children.push(child)
				node.docDirectives.push(child)
				return child
			},
		}
		if (directive?.parseArguments) {
			directive.parseArguments(src, node, ctx, input)
		} else {
			while (src.skipSpace().canReadInLine()) {
				node.arguments.push(src.readUntil(...core.Whitespaces))
			}
		}
		src.readLine()
	}
	node.range.end = src.cursor
	return node
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
	if (node.isInline && docDirective.hasMandatoryArgument) {
		ctx.err.report(localize('mcfunction.doc.directive.diagnostic.inline'), node)
		return false
	}
	if (!node.isInline && docDirective.hasMandatoryArgument && !node.arguments.length) {
		ctx.err.report(
			localize('mcfunction.doc.directive.diagnostic.argument', localeQuote(node.identifier)),
			node.identifierRange,
		)
		return false
	}
	return true
}
