import * as core from '@spyglassmc/core'
import type { DocDirectiveNode, DocNode } from '../node/index.js'
import type { DocDirective, DocDirectiveSuggestCtx, DocTargets } from '../parser/doc.js'
import {
	getCurrentFunctionIdentifier,
	getDirectiveDescription,
	getDocDirective,
} from '../parser/doc.js'

type DirectiveNode = core.DeepReadonly<DocDirectiveNode>
type DocumentationNode = core.DeepReadonly<DocNode>
interface DirectivePosition {
	occurrence: DirectiveNode
	parent?: DirectiveNode
}

/** Completer for DocNode */
export const completeDoc: core.Completer<DocNode> = (node, ctx) => {
	// before #>
	if (ctx.offset < node.range.start + 2) {
		return []
	}
	const position = findDirectivePosition(node.docDirectives, ctx.offset)
	if (position) {
		if (ctx.offset > position.occurrence.identifierRange.end) {
			return getDocDirective(ctx.meta, docTarget(node, ctx), position.occurrence.identifier)
				?.completer?.(position.occurrence, ctx) ?? []
		}
		return position.occurrence.isInline
			? completeInlineDocDirectives(
				node,
				ctx,
				position.occurrence.identifierRange,
				position.occurrence,
			)
			: completeBlockDocDirectives(node, ctx, position)
	}
	if (findNodeAtOffset(node.children, ctx.offset)?.type === 'comment') {
		return []
	}
	if (isDocTargetPosition(node, ctx.offset)) {
		const targets = node.isFunctionHeader
			? completeFunctionHeaderTarget(node, ctx)
			: completeDocTarget(node, ctx)
		return targets.concat(completeInlineDocDirectives(node, ctx, targetRange(node, ctx.offset)))
	}
	return node.isFunctionHeader && node.directive.value === 'function'
		? completeFunctionHeaderArguments(node, ctx)
		: completeDocTargetArguments(node, ctx)
}

function findNodeAtOffset<N extends core.DeepReadonly<core.AstNode>>(
	nodes: readonly N[],
	offset: number,
): N | undefined {
	let low = 0
	let high = nodes.length
	while (low < high) {
		const middle = (low + high) >>> 1
		if (nodes[middle].range.start <= offset) {
			low = middle + 1
		} else {
			high = middle
		}
	}
	const node = nodes[low - 1]
	return node && core.Range.contains(node.range, offset, true) ? node : undefined
}

function findDirectivePosition(
	directives: readonly DirectiveNode[],
	offset: number,
	parent?: DirectiveNode,
): DirectivePosition | undefined {
	const occurrence = findNodeAtOffset(directives, offset)
	if (!occurrence) {
		return undefined
	}
	return findDirectivePosition(occurrence.docDirectives, offset, occurrence)
		?? { occurrence, parent }
}

function isDocTargetPosition(node: DocumentationNode, offset: number): boolean {
	const field = node.fields[0]
	return offset <= node.directive.range.end
		&& (!node.isImplicitFunction || field?.range.start === field?.range.end)
}

function docTarget(node: DocumentationNode, ctx: core.CompleterContext): DocTargets | undefined {
	return ctx.meta.getCustom<DocTargets>('impdoc:target')?.get(node.directive.value)
}

function targetRange(node: DocumentationNode, offset: number): core.Range {
	return offset < node.directive.range.start ? core.Range.create(offset) : node.directive.range
}

function completeDocTarget(
	node: DocumentationNode,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	const range = targetRange(node, ctx.offset)
	const items = core.completer.literal({ ...node.directive, range }, ctx)
	for (const item of items) {
		item.sortText = '1'
	}
	return items
}

function completeDocTargetArguments(
	node: DocumentationNode,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	return docTarget(node, ctx)?.completer(node, ctx) ?? []
}

function completeThis(ctx: core.CompleterContext, range: core.RangeLike): core.CompletionItem {
	const identifier = getCurrentFunctionIdentifier(ctx)
	return core.CompletionItem.create('THIS', range, {
		kind: core.CompletionKind.Snippet,
		insertText: identifier ?? 'THIS',
		detail: identifier,
		filterText: ctx.src.slice(core.Range.get(range).start, ctx.offset) + 'THIS',
		sortText: '0',
	})
}

function completeFunctionHeaderTarget(
	node: DocumentationNode,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	return [completeThis(ctx, targetRange(node, ctx.offset)), ...completeDocTarget(node, ctx)]
}

function completeFunctionHeaderArguments(
	node: DocumentationNode,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	const field = node.fields[0]
	if (!field || (ctx.offset > field.range.end && 'path' in field && field.path)) {
		return []
	}
	const range = ctx.offset < field.range.start || ctx.offset > field.range.end
		? core.Range.create(ctx.offset)
		: field.range
	return [completeThis(ctx, range)]
}

function accepts(directive: DocDirective, target: DocTargets): boolean {
	return directive.isCommon || target.acceptedDirectives.includes(directive.identifier)
}

function completeInlineDocDirectives(
	node: DocumentationNode,
	ctx: core.CompleterContext,
	range: core.RangeLike,
	occurrence?: DirectiveNode,
): core.CompletionItem[] {
	const target = docTarget(node, ctx)
	const items = completeDirectives(
		ctx,
		target,
		range,
		{ node, occurrence, possibleCallers: [] },
		node.docDirectives,
		directive => directive.isCommon && !directive.hasMandatoryArgument,
		occurrence ? undefined : '2',
	)
	if (
		node.isFunctionHeader && node.isImplicitFunction
		&& node.fields[0]?.range.start === node.fields[0]?.range.end
		&& !node.docDirectives.some(directive =>
			directive.isInline && directive.identifierRange.start > ctx.offset
		)
	) {
		const identifier = getCurrentFunctionIdentifier(ctx)
		if (identifier) {
			for (const item of items) {
				item.insertText = core.CompletionItem.escape(`${item.label} ${identifier}`)
			}
		}
	}
	return items
}

interface DirectiveSlot {
	caller: DirectiveNode
	identifiers: readonly string[]
}

function collectArgumentSlots(
	directives: readonly DirectiveNode[],
	offset: number,
	slots: DirectiveSlot[],
): void {
	for (const caller of directives) {
		if (caller.range.start > offset) {
			break
		}
		for (const slot of caller.argumentSuggestions ?? []) {
			if (slot.identifiers.length && core.Range.contains(slot.range, offset, true)) {
				slots.push({ caller, identifiers: slot.identifiers })
			}
		}
		collectArgumentSlots(caller.docDirectives, offset, slots)
	}
}

function completeBlockDocDirectives(
	node: DocumentationNode,
	ctx: core.CompleterContext,
	position: DirectivePosition,
): core.CompletionItem[] {
	const { occurrence, parent } = position
	const target = docTarget(node, ctx)
	const slots: DirectiveSlot[] = []
	if (!parent) {
		collectArgumentSlots(node.docDirectives, ctx.offset, slots)
	}
	const possibleCallers = parent ? [parent] : slots.map(slot => slot.caller)
	const siblings = parent?.docDirectives ?? possibleCallers.at(-1)?.docDirectives
		?? node.docDirectives
	const acceptedArguments = new Set(slots.flatMap(slot => slot.identifiers))
	return completeDirectives(
		ctx,
		target,
		occurrence.identifierRange,
		{ node, occurrence, possibleCallers },
		siblings,
		directive =>
			possibleCallers.length > 0
				? !!parent || acceptedArguments.has(directive.identifier)
				: !!target && accepts(directive, target),
	)
}

function completeDirectives(
	ctx: core.CompleterContext,
	target: DocTargets | undefined,
	range: core.RangeLike,
	input: DocDirectiveSuggestCtx,
	siblings: readonly DirectiveNode[],
	eligible: (directive: DocDirective) => boolean,
	sortText?: string,
): core.CompletionItem[] {
	const used = new Set<string>()
	for (const sibling of siblings) {
		if (sibling !== input.occurrence) {
			used.add(sibling.identifier)
		}
	}
	const items: core.CompletionItem[] = []
	for (const directive of ctx.meta.getCustom<DocDirective>('impdoc:directive')?.values() ?? []) {
		if (!eligible(directive)) {
			continue
		}
		const include = target?.directiveOverrides?.get(directive.identifier)?.includeInSuggestion
			?? directive.includeInSuggestion
		if (
			!include.call(directive, ctx, input)
			|| (!directive.allowDuplicates && used.has(directive.identifier))
		) {
			continue
		}
		items.push(core.CompletionItem.create(`@${directive.identifier}`, range, {
			kind: core.CompletionKind.Property,
			documentation: getDirectiveDescription(directive),
			...(sortText === undefined ? {} : { sortText }),
		}))
	}
	return items
}
