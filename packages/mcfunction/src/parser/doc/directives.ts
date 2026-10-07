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
}

// #region Abstract Directives (not exported)
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
		directive.arguments.push(src.string.slice(start, src.innerCursor))
		directive.inputComment = input.readComment()?.text
	}
}

/** Access modifier directive */
class AccessModifierDirective extends DefaultDocDirective {
	override readonly isCommon: boolean = true
	override readonly isAccessModifier = true
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

export class PrivateDocDirective extends AccessModifierDirective {
	override readonly identifier = 'private'
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		ctx: core.BinderContext,
	): DocAccess {
		const folder = ctx.doc.uri.slice(0, ctx.doc.uri.lastIndexOf('/') + 1)
		const escapedFolder = folder.replace(/[\\*?\[\]{}()!+@]/g, '\\$&')
		return {
			visibility: core.SymbolIsotopeScope.Private,
			visibleWithin: [{ glob: `${escapedFolder}**` }],
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

export class ProtectedDocDirective extends AccessModifierDirective {
	override readonly identifier = 'protected'
	override modifyAccess(
		_directive: core.DeepReadonly<DocDirectiveNode>,
		_node: DocNode,
		ctx: core.BinderContext,
	): DocAccess {
		const namespace = ctx.meta.resolveResourceLocation?.(ctx.doc.uri, ctx)?.namespace
		return {
			visibility: core.SymbolIsotopeScope.Protected,
			visibleWithin: namespace === undefined ? [] : [{ namespace }],
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

export class DeprecatedDocDirective extends DefaultDocDirective {
	override readonly identifier = 'deprecated'
	// TODO
}

export class OverrideDocDirective extends AccessModifierDirective {
	override readonly identifier = 'override'
	// TODO
}

export class ContextDocDirective extends DefaultDocDirective {
	override readonly identifier = 'context'
	override readonly isCommon: boolean = false
	// TODO
}

export class ReadsDocDirective extends DefaultDocDirective {
	override readonly identifier = 'reads'
	override readonly isCommon: boolean = false
	// TODO
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
		return {
			desc: [
				'writes: ' + directive.arguments.join(' '),
				...(directive.inputComment === undefined ? [] : [directive.inputComment]),
			],
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
		return {
			desc: [
				'input: ' + directive.arguments.join(' '),
				...(directive.inputComment === undefined ? [] : [directive.inputComment]),
			],
		}
	}
}

export class ReturnsDocDirective extends DefaultDocDirective {
	override readonly identifier = 'returns'
	override readonly isCommon: boolean = false
	override parseArguments(
		src: core.Source,
		directive: DocDirectiveNode,
		ctx: core.ParserContext,
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
		return {
			desc: [
				directive.arguments[0] ? `returns: ${directive.arguments[0]}` : 'returns:',
				'',
				...['result', 'success'].filter(key => values.has(key))
					.map(key => '- ' + key + ': ' + values.get(key)),
				...['void'].filter(key => values.has(key))
					.map(key => '- ' + key + values.get(key)),
			],
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
		return (desc === '') ? { desc: [''] } : { desc: [': ' + desc] }
	}
}

export class TypeDocDirective extends DefaultDocDirective {
	override readonly identifier = 'type'
	override readonly isCommon: boolean = true
	override readonly hasMandatoryArgument: boolean = true
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
