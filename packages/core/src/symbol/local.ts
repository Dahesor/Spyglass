import type { TextDocument } from 'vscode-languageserver-textdocument'
import { StateProxy } from '../common/StateProxy.js'
import type { AstNode } from '../node/index.js'
import type { SymbolAddition, SymbolHandle as SymbolHandle } from './Handle.js'
import type { SymbolClearOptions, SymbolService } from './Service.js'
import type { Symbol, SymbolMap, SymbolTable, SymbolView } from './Symbol.js'
import { SymbolUsageTypes } from './Symbol.js'
import { SymbolUtil } from './util.js'

export interface LocalSymbolContext {
	doc: TextDocument
	node: AstNode
}

export interface LocalSymbol extends SymbolView {
	isLocal: true
	facets?: never
}

const localTables = new WeakSet<SymbolTable>()
const localMaps = new WeakSet<SymbolMap>()

export const enum LocalSymbolVisibility {
	Block,
	File,
}

/** File and block symbol tables. */
export namespace LocalSymbol {
	export function is(symbol: Symbol | undefined): symbol is LocalSymbol {
		return symbol?.isLocal === true
	}
	export function isTable(table: SymbolTable): boolean {
		return localTables.has(StateProxy.dereference(table))
	}
	export function registerTable(table: SymbolTable): void {
		localTables.add(StateProxy.dereference(table))
		for (const map of Object.values(table)) {
			if (map) {
				registerMap(map)
			}
		}
	}
	export function registerMap(map: SymbolMap): SymbolMap {
		localMaps.add(StateProxy.dereference(map))
		return map
	}
	export function isMap(map: SymbolMap | undefined): boolean {
		return !!map && localMaps.has(StateProxy.dereference(map))
	}
	export function amendSymbol(
		service: SymbolService,
		symbol: LocalSymbol,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): void {
		if (addition.data && 'data' in addition.data) {
			symbol.data = addition.data.data
		}
		if (addition.data && 'desc' in addition.data) {
			symbol.desc = addition.data.desc
		}
		if (addition.data && 'deprecated' in addition.data) {
			symbol.deprecated = addition.data.deprecated
		}
		const usage = addition.usage && { ...addition.usage }
		if (usage) {
			delete usage.isotopeIdentifier
		}
		service.appendSymbolUsage(symbol, usage, doc, contributor, symbol)
	}
	export function isTrimmable(symbol: LocalSymbol): boolean {
		return !Object.keys(symbol.members ?? {}).length
			&& !SymbolUsageTypes.some(type => symbol[type]?.length)
	}

	/** Create a new local symbol table.
	 * @returns the table created.
	 */
	export function createTable(): SymbolTable {
		const table: SymbolTable = Object.create(null)
		registerTable(table)
		return table
	}

	/** Clear local contributions from the local symbol table of a given AST node. */
	export function clear(
		service: SymbolService,
		node: AstNode,
		options: SymbolClearOptions,
	): void {
		service.runOrDefer(() => clearImmediately(service, node, options))
	}

	function clearImmediately(
		service: SymbolService,
		node: AstNode,
		{ uri, contributor, predicate = () => true }: SymbolClearOptions,
	): void {
		for (const table of getLocalsToLeaves(node)) {
			SymbolUtil.forEachSymbol(
				table,
				symbol =>
					service.removeLocationsFromSymbol(
						symbol,
						(event) =>
							(!uri || event.location.uri === uri)
							&& (!contributor || event.location.contributor === contributor)
							&& predicate(event),
					),
			)
			trim(service, table)
		}
	}

	/** Remove trimmable symbols from the given local symbol table. */
	export function trim(service: SymbolService, table: SymbolTable): void {
		const trimMap = (map: SymbolMap) => {
			for (const symbol of Object.values(map)) {
				if (symbol.members) {
					trimMap(symbol.members)
				}
				if (SymbolUtil.isTrimmable(symbol)) {
					delete map[symbol.identifier]
					service.emitEvent('symbolRemoved', { symbol })
				}
			}
		}
		for (const map of Object.values(table)) {
			if (map) {
				trimMap(map)
			}
		}
	}

	/** Traverse the local symbol tables from the given AST node up to the root. */
	export function* getLocalsToRoot(node: AstNode): Generator<SymbolTable> {
		let current: AstNode | undefined = node
		while (current) {
			if (current.locals) {
				yield current.locals
			}
			current = current.parent
		}
	}

	/** Traverse the local symbol tables from the given AST node down to the leaves. */
	export function* getLocalsToLeaves(node: AstNode): Generator<SymbolTable> {
		if (node.locals) {
			yield node.locals
		}
		for (const child of node.children ?? []) {
			yield* getLocalsToLeaves(child)
		}
	}

	/**
	 * Find the symbol table to use accroding to the node and visibility
	 * @throws if no suitable symbol table is found.
	 * @param node The AST node
	 * @param visibility
	 * @returns The table that this node should writs to
	 */
	export function findTable(node: AstNode, visibility: LocalSymbolVisibility): SymbolTable {
		let current: AstNode | undefined = node
		while (
			current && (visibility === LocalSymbolVisibility.File
				? current.type !== 'file'
				: !current.locals)
		) {
			current = current.parent
		}
		if (!current?.locals) {
			throw new Error('Local symbol requires a node with locals.')
		}
		return current.locals
	}

	/** Return a {@link SymbolHandle} for the symbol.*/
	export function queryInsideScope(
		service: SymbolService,
		doc: LocalSymbolContext,
		scope: LocalSymbolVisibility,
		category: string,
		...path: string[]
	): SymbolHandle {
		const table = findTable(doc.node, scope)
		registerTable(table)
		return service.queryInTable(table, doc.doc, category, ...path)
	}
}
