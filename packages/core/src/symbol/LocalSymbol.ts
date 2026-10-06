import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { AstNode } from '../node/index.js'
import type { Symbol, SymbolMap, SymbolTable, SymbolView } from './Symbol.js'
import { SymbolUsageTypes } from './Symbol.js'
import type { LookupResult, SymbolAddition, SymbolClearOptions, SymbolQuery } from './SymbolUtil.js'
import { SymbolFormatter, SymbolUtil } from './SymbolUtil.js'

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

/** File and block symbol tables, and their lookup order relative to global symbols. */
export namespace LocalSymbol {
	export function is(symbol: Symbol | undefined): symbol is LocalSymbol {
		return symbol?.isLocal === true
	}
	export function isTable(table: SymbolTable): boolean {
		return localTables.has(table)
	}
	export function registerTable(table: SymbolTable): void {
		localTables.add(table)
		for (const map of Object.values(table)) {
			if (map) { localMaps.add(map) }
		}
	}
	export function registerMap(map: SymbolMap): SymbolMap {
		localMaps.add(map)
		return map
	}
	export function isMap(map: SymbolMap | undefined): boolean {
		return !!map && localMaps.has(map)
	}
	export function amendSymbol(
		util: SymbolUtil,
		symbol: LocalSymbol,
		addition: SymbolAddition,
		doc: TextDocument,
		contributor: string | undefined,
	): void {
		if (addition.data && 'desc' in addition.data) { symbol.desc = addition.data.desc }
		const usage = addition.usage && { ...addition.usage }
		if (usage) { delete usage.isotopeIdentifier }
		util.amendSymbolUsage(symbol, usage, doc, contributor, symbol)
	}
	export function isTrimmable(symbol: LocalSymbol): boolean {
		return !Object.keys(symbol.members ?? {}).length && !SymbolUsageTypes.some(type => symbol[type]?.length)
	}
	/** Create a new local symbol table. */
	export function createTable(): SymbolTable {
		const table: SymbolTable = Object.create(null)
		registerTable(table)
		return table
	}

	export function stringifySymbolStack(stack: SymbolStack): string {
		return stack.map(table => SymbolFormatter.stringifySymbolTable(table)).join(
			'\n------------\n',
		)
	}

	/** Initialize the local symbol table for a given AST node.
	 * @param node The AST node to initialize
	 */
	export function initialize(node: AstNode): SymbolTable {
		return node.locals = createTable()
	}

	/** Clear local contributions from the local symbol table of a given AST node. */
	export function clear(
		util: SymbolUtil,
		node: AstNode,
		options: SymbolClearOptions,
	): void {
		util.runOrDefer(() => clearImmediately(util, node, options))
	}

	function clearImmediately(
		util: SymbolUtil,
		node: AstNode,
		{ uri, contributor, predicate = () => true }: SymbolClearOptions,
	): void {
		for (const table of getLocalsToLeaves(node)) {
			SymbolUtil.forEachSymbol(
				table,
				symbol =>
					util.removeLocationsFromSymbol(
						symbol,
						(event) =>
							(!uri || event.location.uri === uri)
							&& (!contributor || event.location.contributor === contributor)
							&& predicate(event),
					),
			)
			trim(util, table)
		}
	}

	/** Remove trimmable symbols from the given local symbol table. */
	export function trim(util: SymbolUtil, table: SymbolTable): void {
		const trimMap = (map: SymbolMap) => {
			for (const symbol of Object.values(map)) {
				if (symbol.members) {
					trimMap(symbol.members)
				}
				if (SymbolUtil.isTrimmable(symbol)) {
					delete map[symbol.identifier]
					util.emit('symbolRemoved', { symbol })
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
	 * Find the symbol table accroding to the node and visibility
	 * @throws Error if no suitable symbol table is found.
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

	/**
	 * Look up a symbol starting from the given node and traversing up.
	 * @param node The AST node to start the lookup from.
	 * @param category The category of the symbol.
	 * @param path
	 * @returns The lookup result if found; undefined otherwise.
	 */
	export function lookup(
		node: AstNode,
		category: string,
		path: readonly string[],
	): LookupResult | undefined {
		for (const table of getLocalsToRoot(node)) {
			const result = SymbolUtil.lookupTable(table, category, path)
			if (result.symbol) {
				return result
			}
		}
		return undefined
	}

	/** Return a query for the symbol. Does not fall back to the global table. */
	export function queryForScope(
		util: SymbolUtil,
		doc: LocalSymbolContext,
		visibility: LocalSymbolVisibility,
		category: string,
		...path: string[]
	): SymbolQuery {
		const table = findTable(doc.node, visibility)
		registerTable(table)
		return util.queryInTable(table, doc.doc, category, ...path)
	}
}

export type SymbolStack = [SymbolTable, ...SymbolTable[]]
