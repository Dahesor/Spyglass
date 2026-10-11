import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { DocAccess, DocDirectiveNode, DocNode } from '../../node/index.js'
import {
	DefaultDocDirective,
	type DocDirectiveHandlerContext,
	type DocDirectiveParserContext,
	type DocDirectiveReturn,
	type DocDirectiveSuggestCtx,
	registerDocDirective,
} from '../doc.js'

export function registerDocDirectives(meta: core.MetaRegistry): void {
	registerDocDirective(meta, new PublicDocDirective())
	registerDocDirective(meta, new InternalDocDirective())
	registerDocDirective(meta, new ProtectedDocDirective())
	registerDocDirective(meta, new PrivateDocDirective())
	registerDocDirective(meta, new LocalDocDirective())
	registerDocDirective(meta, new UserDocDirective())
	registerDocDirective(meta, new ChatOnlyDocDirective())
	registerDocDirective(meta, new DeprecatedDocDirective())
	registerDocDirective(meta, new OverrideDocDirective())
	registerDocDirective(meta, new ReturnsDocDirective())
	registerDocDirective(meta, new ContextDocDirective())
	registerDocDirective(meta, new ReadsDocDirective())
	registerDocDirective(meta, new WritesDocDirective())
	registerDocDirective(meta, new InputDocDirective())
	registerDocDirective(meta, new ResultDocDirective())
	registerDocDirective(meta, new SuccessDocDirective())
	registerDocDirective(meta, new VoidDocDirective())
	registerDocDirective(meta, new TypeDocDirective())
	registerDocDirective(meta, new AuthorDocDirective())
	registerDocDirective(meta, new FunctionPredicateDocDirective())
}

// #region Abstract Directives
/** Reads a greedy string as argument */
class GreedyStringDirective extends DefaultDocDirective {
	override parseArguments(src: core.Source, directive: DocDirectiveNode): void {
		src.skipSpace()
		if (src.canReadInLine()) {
			directive.arguments.push(src.readLine())
		} else {
			directive.arguments.push('')
		}
	}
}

class CommandTreeDocDirective extends DefaultDocDirective {
	readonly parser_id: string = 'impdoc:read_write_arguments'
	override readonly hasMandatoryArgument: boolean = true
	override parseArguments(
		src: core.Source,
		directive: DocDirectiveNode,
		ctx: core.ParserContext,
		input: DocDirectiveParserContext,
	): void {
		src.skipSpace()
		const start = src.innerCursor
		const parser = ctx.meta.hasParser(this.parser_id)
			? ctx.meta.getParser(this.parser_id)
			: undefined
		if (parser) {
			const result = parser(src, ctx)
			if (result !== core.Failure) {
				directive.argumentNode = result
				directive.children.push(result)
			}
		} else {
			src.readLine()
		}
		directive.arguments.push(...(src.string.slice(start, src.innerCursor).match(/\S+/g) ?? []))
		directive.inputComment = input.readComment()?.text
	}
}

/** Access modifier directive */
class AccessModifierDirective extends DefaultDocDirective {
	override readonly isCommon: boolean = true
	override readonly isAccessModifier = true
}

class ScopedAccessModifierDirective extends AccessModifierDirective {
	override parseArguments(
		src: core.Source,
		directive: DocDirectiveNode,
		ctx: core.ParserContext,
	): void {
		src.skipSpace()
		if (!src.canReadInLine()) {
			return
		}
		const start = src.cursor
		const keyword = core.LiteralNode.mock(start, { pool: ['within'] })
		keyword.value = src.readUntil(...core.Whitespaces)
		keyword.range.end = src.cursor
		directive.children.push(keyword)
		src.skipSpace()
		const argument = core.string({
			quotes: ['"'],
			unquotable: { allowEmpty: true, blockList: new Set(core.Whitespaces) },
			escapable: false,
			colorTokenType: 'resourceLocation',
		})(src, ctx)
		if (argument.quote) {
			argument.options.colorTokenType = 'string'
		} else {
			argument.children = [...argument.value.matchAll(/%parent|[a-z0-9_.-]+|[:/]/g)].map(
				match => {
					const child = core.LiteralNode.mock(
						core.Range.create(
							argument.range.start + match.index,
							argument.range.start + match.index + match[0].length,
						),
						{
							pool: [match[0]],
							colorTokenType: match[0] === '%parent'
								? 'literal'
								: /[:/]/.test(match[0])
								? 'operator'
								: 'resourceLocation',
						},
					)
					child.value = match[0]
					return child
				},
			)
		}
		directive.argumentNode = argument
		directive.children.push(argument)
		directive.arguments.push(keyword.value, argument.value)
		src.readLine()
		if (!this.isValidWithin(directive, ctx.doc.getText(), src.cursor)) {
			ctx.err.report(
				localize('expected', 'within "glob" | namespace[:path] | %parent[/path]'),
				core.Range.create(start, src),
			)
		}
	}
	private isValidWithin(
		directive: core.DeepReadonly<DocDirectiveNode>,
		text: string,
		end = directive.range.end,
	): boolean {
		const argument = directive.argumentNode
		if (!core.StringNode.is(argument) || directive.arguments[0] !== 'within') {
			return false
		}
		if (text.slice(argument.range.end, end).trim()) {
			return false
		}
		return argument.quote
			? argument.quote === '"'
				&& text.slice(argument.range.start, argument.range.end).endsWith('"')
				&& argument.range.end > argument.range.start + 1
			// a bit unclear, FIX sometime later
			: /^(?:[a-z0-9_.-]+(?::[a-z0-9_./-]*)?|%parent(?:\/%parent)*(?:\/[a-z0-9_.-]+)*\/?)$/.test(
				argument.value,
			)
	}
	private escapeGlob(value: string): string {
		return value.replace(/[\\*?\[\]{}()!+@]/g, '\\// #endregion')
	}
	protected withinRules(
		directive: core.DeepReadonly<DocDirectiveNode>,
		ctx: core.BinderContext,
	): core.IsotopeVisibility[] | undefined {
		const within = directive.argumentNode
		if (!core.StringNode.is(within)) {
			return undefined
		}
		const rules: core.IsotopeVisibility[] = []
		if (this.isValidWithin(directive, ctx.doc.getText())) {
			if (within.quote) {
				rules.push({ glob: within.value })
			} else if (within.value.startsWith('%parent')) {
				let uri = ctx.doc.uri
				const parts = within.value.split('/')
				while (parts[0] === '%parent') {
					const parentEnd = uri.replace(/\/$/, '').lastIndexOf('/') + 1
					if (parentEnd > uri.indexOf('://') + 3) {
						uri = uri.slice(0, parentEnd)
					}
					parts.shift()
				}
				const path = this.escapeGlob(uri + parts.join('/'))
				rules.push({ glob: path.endsWith('/') ? path + '**' : path + '{,/**,.*}' })
			} else {
				const [namespace, path] = within.value.split(':')
				rules.push({ namespace, ...(path ? { path } : {}) })
			}
		}
		rules.push({ glob: this.escapeGlob(ctx.doc.uri) })
		return rules
	}
	override completer(
		node: core.DeepReadonly<DocDirectiveNode>,
		ctx: core.CompleterContext,
	): core.CompletionItem[] {
		const keyword = node.children[0]
		const argument = node.argumentNode
		const within = core.StringNode.is(argument) ? argument : undefined
		if (!within || ctx.offset <= keyword.range.end) {
			return [
				core.CompletionItem.create('within', keyword?.range ?? ctx.offset, {
					kind: core.CompletionKind.Keyword,
				}),
			]
		}
		if (within.quote || ctx.offset < within.range.start || ctx.offset > within.range.end) {
			return []
		}
		const range = within.range
		const namespace = ctx.meta.resolveResourceLocation?.(ctx.doc.uri, ctx)?.namespace
			?? 'minecraft'
		const items = [
			core.CompletionItem.create('""', range, {
				insertText: '"${1}"',
				kind: core.CompletionKind.Snippet,
			}),
		]
		const parts = within.value.split('/')
		const last = parts.pop()!
		const special_key = '%parent'
		if (parts.every(part => part === special_key) && special_key.includes(last)) {
			const prefix = parts.length ? parts.join('/') + '/' : ''
			const value = prefix
				+ (last === special_key ? `${special_key}/${special_key}` : special_key)
			items.push(core.CompletionItem.create(value, range, { kind: core.CompletionKind.Keyword }))
		}
		if (!within.value) {
			items.push(core.CompletionItem.create('THIS NAMESPACE', range, {
				insertText: namespace + ':',
				filterText: within.value + 'THIS NAMESPACE',
				detail: namespace + ':',
				kind: core.CompletionKind.Snippet,
			}))
		}
		return items
	}
}

// #endregion

export class PublicDocDirective extends AccessModifierDirective {
	override readonly identifier = 'public'
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
	): DocAccess {
		return { visibility: core.SymbolIsotopeScope.Global }
	}
}

export class PrivateDocDirective extends ScopedAccessModifierDirective {
	override readonly identifier = 'private'
	override modifyAccess(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		ctx: core.BinderContext,
	): DocAccess {
		const folder = ctx.doc.uri.slice(0, ctx.doc.uri.lastIndexOf('/') + 1)
		const escapedFolder = folder.replace(/[\\*?\[\]{}()!+@]/g, '\\$&')
		return {
			visibility: core.SymbolIsotopeScope.Private,
			visibleWithin: this.withinRules(directive, ctx) ?? [{ glob: `${escapedFolder}**` }],
		}
	}
}

export class LocalDocDirective extends AccessModifierDirective {
	override readonly identifier = 'local'
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
	): DocAccess {
		return { visibility: core.SymbolIsotopeScope.Local }
	}
}

export class UserDocDirective extends DefaultDocDirective {
	override readonly identifier = 'user'
	// TODO
}

export class ChatOnlyDocDirective extends DefaultDocDirective {
	override readonly identifier = 'chatonly'
	override readonly isCommon: boolean = false
	// TODO
}

export class ProtectedDocDirective extends ScopedAccessModifierDirective {
	override readonly identifier = 'protected'
	override modifyAccess(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		ctx: core.BinderContext,
	): DocAccess {
		const namespace = ctx.meta.resolveResourceLocation?.(ctx.doc.uri, ctx)?.namespace
		return {
			visibility: core.SymbolIsotopeScope.Protected,
			visibleWithin: this.withinRules(directive, ctx)
				?? (namespace === undefined ? [] : [{ namespace }]),
		}
	}
}

export class InternalDocDirective extends AccessModifierDirective {
	override readonly identifier = 'internal'
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
	): DocAccess {
		return { visibility: core.SymbolIsotopeScope.Project }
	}
}

export class AuthorDocDirective extends GreedyStringDirective {
	override readonly identifier = 'author'
	// Not including author as part of the description, so do nothing here
}

export class DeprecatedDocDirective extends GreedyStringDirective {
	override readonly identifier = 'deprecated'
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
		_input: DocDirectiveHandlerContext,
	): DocDirectiveReturn {
		const desc: string = bold('@' + italic(this.identifier))
			+ dashIfExists(directive.arguments[0])
		return {
			mark_deprecated: true,
			desc: [desc],
		}
	}
}

export class OverrideDocDirective extends AccessModifierDirective {
	override readonly identifier = 'override'
	// TODO
}

export class ContextDocDirective extends CommandTreeDocDirective {
	override readonly identifier = 'context'
	override readonly isCommon: boolean = false
	override readonly parser_id: string = 'impdoc:context_arguments'
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
	): DocDirectiveReturn {
		let wellKnownContext: string = ''
		let context_description: string = directive.arguments.slice(1).join(' ')
		if (directive.arguments[0] === '@root') {
			wellKnownContext = space(bold('Server'))
		} else if (directive.arguments[0] === '@any') {
			wellKnownContext = space(bold(localize('mcfunction.context.any')))
		} else if (directive.arguments[0] === '@player') {
			wellKnownContext = space(bold(localize('mcfunction.context.player')))
		} else {
			context_description = directive.arguments.join(' ')
		}
		let desc: string = italic('@' + this.identifier) + ' '
			+ wellKnownContext
			+ dashIfExists(context_description)
		desc += directive.inputComment ? Dash + directive.inputComment : ''
		return {
			desc: [desc],
		}
	}
}

export class ReadsDocDirective extends CommandTreeDocDirective {
	override readonly identifier = 'reads'
	override readonly isCommon: boolean = false
	override readonly allowDuplicates: boolean = true
	override readonly parser_id: string = 'impdoc:read_write_arguments'
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
	): DocDirectiveReturn {
		let desc: string = italic('@' + this.identifier) + ' '
			+ bold(directive.arguments[0])
			+ ' '
			+ code(directive.arguments.slice(1).join(' '))
		desc += Dash + (directive.inputComment ?? '')
		return {
			desc: [desc],
		}
	}
}

export class WritesDocDirective extends CommandTreeDocDirective {
	override readonly identifier = 'writes'
	override readonly isCommon: boolean = false
	override readonly allowDuplicates: boolean = true
	override readonly parser_id: string = 'impdoc:read_write_arguments'
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
	): DocDirectiveReturn {
		let desc: string = italic('@' + this.identifier) + ' '
			+ italic(directive.arguments[0])
			+ ' '
			+ code(directive.arguments.slice(1).join(' '))
		desc += dashIfExists(directive.inputComment)
		return {
			desc: [desc],
		}
	}
}

export class InputDocDirective extends CommandTreeDocDirective {
	override readonly identifier = 'input'
	override readonly isCommon: boolean = false
	override readonly allowDuplicates: boolean = true
	override readonly parser_id: string = 'impdoc:input_arguments'
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
	): DocDirectiveReturn {
		let desc: string = italic('@' + this.identifier) + ' '
			+ italic(directive.arguments[0])
			+ ' '
			+ code(directive.arguments.slice(1).join(' '))
		desc += dashIfExists(directive.inputComment)
		return {
			desc: [desc],
		}
	}
}

export class ReturnsDocDirective extends DefaultDocDirective {
	override readonly identifier = 'returns'
	override readonly isCommon: boolean = false
	override parseArguments(
		src: core.Source,
		directive: DocDirectiveNode,
		_ctx: core.ParserContext,
		input: DocDirectiveParserContext,
	): void {
		src.skipSpace()
		if (src.canReadInLine()) {
			directive.arguments.push(src.readLine())
		} else {
			directive.arguments.push('')
		}
		while (
			input.readDirective(identifier =>
				identifier === 'result' || identifier === 'success' || identifier === 'void'
			)
		) {
		}
	}
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
		input: DocDirectiveHandlerContext,
	): DocDirectiveReturn {
		const values = new Map<string, string>()
		for (const child of directive.docDirectives) {
			const result = input.handleDirective(child)
			if (result) {
				values.set(child.identifier, result.desc?.join('\n') ?? '')
			}
		}
		// If void is the only provided information
		if (
			!directive.arguments[0]
			&& !values.has('result') && !values.has('success') && values.has('void')
		) {
			return {
				desc: [italic('@returns') + ' ' + bold('void') + (values.get('void') ?? '')],
				data: Object.fromEntries(values),
			}
		}
		const lines: string[] = [
			directive.arguments[0]
				? italic('@returns') + `${Dash}${directive.arguments[0]}`
				: italic('@returns'),
		]
		lines.push(
			...['result', 'success'].filter(key => values.has(key))
				.map(key => Indent + bold(key) + Dash + values.get(key)),
		)
		lines.push(
			...['void'].filter(key => values.has(key))
				.map(key => Indent + bold(key) + values.get(key)),
		)
		return {
			desc: [lines.join(NewLine)],
			data: Object.fromEntries(values),
		}
	}
}

export class ResultDocDirective extends GreedyStringDirective {
	override includeInSuggestion(
		_ctx: core.CompleterContext,
		input: DocDirectiveSuggestCtx,
	): boolean {
		return input.possibleCallers.some(caller => caller.identifier === 'returns')
	}
	override readonly identifier = 'result'
	override readonly hasMandatoryArgument: boolean = true
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		ctx: core.BinderContext,
		input: DocDirectiveHandlerContext,
	): DocDirectiveReturn {
		if (input.caller?.identifier !== 'returns') {
			ctx.err.report(
				localize(
					'mcfunction.doc.directive.diagnostic.wrong_context.reason',
					localeQuote(this.identifier),
					localeQuote('@returns'),
				),
				directive.identifierRange,
			)
			return {}
		}
		return { desc: [directive.arguments[0] ?? ''] }
	}
}

export class SuccessDocDirective extends GreedyStringDirective {
	override includeInSuggestion(
		_ctx: core.CompleterContext,
		input: DocDirectiveSuggestCtx,
	): boolean {
		return input.possibleCallers.some(caller => caller.identifier === 'returns')
	}
	override readonly identifier = 'success'
	override readonly hasMandatoryArgument: boolean = true
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		ctx: core.BinderContext,
		input: DocDirectiveHandlerContext,
	): DocDirectiveReturn {
		if (input.caller?.identifier !== 'returns') {
			ctx.err.report(
				localize(
					'mcfunction.doc.directive.diagnostic.wrong_context.reason',
					localeQuote(this.identifier),
					localeQuote('@returns'),
				),
				directive.identifierRange,
			)
			return {}
		}
		return { desc: [directive.arguments[0] ?? ''] }
	}
}

export class VoidDocDirective extends GreedyStringDirective {
	override includeInSuggestion(
		_ctx: core.CompleterContext,
		input: DocDirectiveSuggestCtx,
	): boolean {
		return input.possibleCallers.some(caller => caller.identifier === 'returns')
	}
	override readonly identifier = 'void'
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		ctx: core.BinderContext,
		input: DocDirectiveHandlerContext,
	): DocDirectiveReturn {
		if (input.caller?.identifier !== 'returns') {
			ctx.err.report(
				localize(
					'mcfunction.doc.directive.diagnostic.wrong_context.reason',
					localeQuote(this.identifier),
					localeQuote('@returns'),
				),
				directive.identifierRange,
			)
			return {}
		}
		const desc: string = directive.arguments[0] ?? ''
		return (desc === '') ? { desc: [''] } : { desc: [Dash + desc] }
	}
}

export class FunctionPredicateDocDirective extends GreedyStringDirective {
	override readonly identifier = 'predicate'
	override readonly isCommon: boolean = false
	override handleDirective(
		directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		_ctx: core.BinderContext,
		_input: DocDirectiveHandlerContext,
	): DocDirectiveReturn {
		const desc: string = '@' + italic(this.identifier) + dashIfExists(directive.arguments[0])
		return { desc: [desc] }
	}
}

export class TypeDocDirective extends DefaultDocDirective {
	override readonly identifier = 'type'
	override readonly isCommon: boolean = true
	override readonly hasMandatoryArgument: boolean = true
	override readonly allowDuplicates: boolean = true
	override parseArguments(
		src: core.Source,
		directive: DocDirectiveNode,
		ctx: core.ParserContext,
	): void {
		src.skipSpace()
		if (!ctx.meta.hasParser('mcdoc:type')) {
			directive.arguments.push(src.readLine())
			return
		}
		const start = src.innerCursor
		const lookahead = src.clone()
		lookahead.readLine()
		const ends = [lookahead.innerCursor]
		let text = src.string.slice(0, lookahead.innerCursor)
		while (lookahead.canRead()) {
			const newlineStart = lookahead.innerCursor
			lookahead.nextLine().skipSpace()
			if (!lookahead.trySkip('#') || lookahead.tryPeek('>')) {
				break
			}
			const contentStart = lookahead.innerCursor
			if (/^@(?:[a-zA-Z_]|$)/.test(lookahead.clone().skipSpace().peekLine())) {
				break
			}
			lookahead.readLine()
			text += src.string.slice(newlineStart, contentStart - 1) + ' '
				+ src.string.slice(contentStart, lookahead.innerCursor)
			ends.push(lookahead.innerCursor)
		}
		const parser = ctx.meta.getParser('mcdoc:type')
		const parse = (end: number) => {
			const input = new core.Source(text.slice(0, end), src.indexMap)
			input.innerCursor = start
			const err = new core.ErrorReporter(ctx.err.source)
			const node = parser(input, { ...ctx, err })
			return { input, err, node, end }
		}
		let result = parse(ends.at(-1)!)
		if (result.err.errors.length) {
			for (let i = ends.length - 2; i >= 0; i--) {
				const candidate = parse(ends[i])
				if (candidate.node !== core.Failure && !candidate.err.errors.length) {
					result = candidate
					break
				}
			}
		}
		const consumed = text.slice(start, result.input.innerCursor).trimEnd()
		const end = Math.max(ends[0], start + consumed.length)
		src.innerCursor = ends.find(lineEnd => lineEnd >= end) ?? end
		if (result.end !== src.innerCursor) {
			result = parse(src.innerCursor)
		}
		if (result.input.skipSpace().canReadInLine()) {
			const trailing = core.Range.create(result.input.cursor, src)
			result.err.report(
				localize('mcfunction.parser.trailing', localeQuote(result.input.readLine())),
				trailing,
			)
		}
		if (typeof result.node !== 'symbol') {
			result.node.range = core.Range.create(
				core.IndexMap.toOuterOffset(src.indexMap, start),
				src,
			)
			directive.argumentNode = result.node
			directive.children.push(result.node)
		}
		directive.arguments.push(text.slice(start, src.innerCursor).trimEnd())
		ctx.err.absorb(result.err)
	}
}

const Indent: string = '\u00A0\u00A0\u00A0\u00A0'
const NewLine: string = '\\\n'
const Dash: string = ' — '

function code(str: string | undefined): string {
	return str ? '`' + str + '`' : ''
}

function space(str: string | undefined): string {
	return str ? ' ' + str + ' ' : ''
}

function dashIfExists(str: string | undefined): string {
	if (!str || str === '') {
		return ''
	}
	return Dash + str
}

function bold(str: string | undefined): string {
	if (!str) {
		return ''
	}
	return `**${str}**`
}

function italic(str: string | undefined): string {
	if (!str) {
		return ''
	}
	return `*${str}*`
}
