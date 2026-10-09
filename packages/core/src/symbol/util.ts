import type { TextDocument } from 'vscode-languageserver-textdocument'
import { bigintJsonNumberReplacer, type DeepReadonly } from '../common/index.js'
import { LocalSymbol } from './local.js'
import { SymbolPath, SymbolUsageTypes } from './Symbol.js'
import type {
	AllCategory,
	Symbol,
	SymbolLocation,
	SymbolMap,
	SymbolTable,
	SymbolUsageType,
	SymbolView,
} from './Symbol.ts'
import { Isotope } from './util/isotope.js'
import type { ResourceLocationResolver } from './util/visibility.ts'

export interface LookupResult {
	/**
	 * The {@link SymbolMap} that contains the symbol. If `symbol` is `undefined`, this property will be the map that could
	 * potentially store the symbol if it's ever created. `undefined` if no such map exists.
	 */
	parentMap:
		| SymbolMap
		| undefined
	/**
	 * The {@link Symbol} of which `symbol` is a member. If `symbol` is `undefined`, this property will be the symbol that could
	 * potentially store the symbol as a member if it's ever created. `undefined` if no such symbol exists.
	 */
	parentSymbol:
		| Symbol
		| undefined
	/**
	 * The {@link Symbol} corresponding to the `path`. `undefined` if no such symbol exists.
	 */
	symbol: Symbol | undefined
}

/** Stateless operations on symbol data. */
export namespace SymbolUtil {
	export function toUri(uri: TextDocument | string): string {
		if (typeof uri === 'string') {
			return uri
		}
		return uri.uri
	}

	/**
	 * @returns A {@link LookupResult}
	 */
	export function lookupInTable(
		table: SymbolTable,
		category: AllCategory,
		path: readonly string[],
	): LookupResult
	export function lookupInTable(
		table: SymbolTable,
		category: string,
		path: readonly string[],
	): LookupResult
	export function lookupInTable(
		table: SymbolTable,
		category: string,
		path: readonly string[],
	): LookupResult {
		let parentMap: SymbolMap | undefined = table[category]
		let parentSymbol: Symbol | undefined
		let symbol: Symbol | undefined
		for (let i = 0; i < path.length; i++) {
			symbol = parentMap?.[path[i]]
			if (!symbol) {
				if (i !== path.length - 1) {
					parentSymbol = undefined
					parentMap = undefined
				}
				break
			}
			if (i === path.length - 1) {
				break
			}
			parentSymbol = symbol
			parentMap = symbol.members
		}
		return { parentSymbol, parentMap, symbol }
	}

	/** @returns `true` if the symbol can be safely removed */
	export function isTrimmable(symbol: Symbol): boolean {
		if (LocalSymbol.is(symbol)) {
			return LocalSymbol.isTrimmable(symbol)
		}
		return !Object.keys(symbol.members ?? {}).length && !Isotope.allIsotopesOf(symbol).length
			&& !Isotope.allUsageContainers(symbol).some(owner =>
				SymbolUsageTypes.some(type => owner[type]?.length)
			)
	}

	/** @returns all usage containers of the given symbol. */
	export function allUsageContainers(
		symbol: Symbol,
	): Partial<Record<SymbolUsageType, SymbolLocation[]>>[] {
		return LocalSymbol.is(symbol) ? [symbol] : Isotope.allUsageContainers(symbol)
	}

	/** @returns a view of the symbol from the context of the given URI. */
	export function viewFromContext(
		symbol: Symbol | undefined,
		uri: string | undefined,
		resolve?: ResourceLocationResolver,
	): SymbolView | undefined {
		if (LocalSymbol.is(symbol)) {
			return symbol
		}
		if (!symbol) {
			return undefined
		}
		return Isotope.resolveFromContext(symbol, uri, resolve)
	}

	/** @returns `true` if the symbol is visible from the context of the given URI. */
	export function isVisible(
		symbol: Symbol,
		uri: string | undefined,
		resolve?: ResourceLocationResolver,
	): boolean {
		return LocalSymbol.is(symbol) || Isotope.isVisible(symbol, uri, resolve)
	}

	/** @returns `true` if the symbol is defined somewhere by the existence of a file. */
	export function isFromFile(symbol: Symbol | undefined): boolean {
		return !!symbol
			&& SymbolUtil.allUsageContainers(symbol).some(owner =>
				owner.definition?.some(location => location.fromFile)
				|| owner.implementation?.some(location => location.fromFile)
			)
	}

	/**
	 * @param symbol The symbol to check access for.
	 * @param uri The URI of the file from which access is being checked.
	 * @returns `true` if a file symbol is defined but cannot be accessed here
	 */
	export function hasNoAccessToFileSymbol(
		symbol: Symbol | undefined,
		uri: string,
		resolve?: ResourceLocationResolver,
	): boolean {
		return !!symbol && !LocalSymbol.is(symbol)
			&& !Isotope.isVisible(symbol, uri, resolve) && isFromFile(symbol)
	}

	function locationsFor(
		symbol: DeepReadonly<Symbol> | undefined,
	): DeepReadonly<Partial<Record<SymbolUsageType, SymbolLocation[]>>> {
		if (!symbol) {
			return {}
		}
		if (LocalSymbol.is(symbol as Symbol)) {
			return symbol as SymbolView
		}
		if (Isotope.isContextualView(symbol as Symbol)) {
			return symbol as SymbolView
		}
		const raw = symbol as Symbol
		const isotope = Isotope.selectIsotope(raw, undefined)
		return isotope ? Isotope.ownerOf(raw, isotope) : {}
	}

	/**
	 * @returns If the symbol has declarations or definitions.
	 */
	export function isDeclared(symbol: DeepReadonly<Symbol> | undefined): boolean {
		const view = locationsFor(symbol)
		return !!(view.declaration?.length || view.definition?.length)
	}

	/**
	 * @returns If the symbol has definitions, or declarations and implementations.
	 */
	export function isDefined(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		const view = locationsFor(symbol)
		return !!(view.definition?.length
			|| (view.declaration?.length && view.implementation?.length))
	}

	/**
	 * @returns If the symbol has implementations or definitions.
	 */
	export function isImplemented(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		const view = locationsFor(symbol)
		return !!(view.implementation?.length || view.definition?.length)
	}

	/**
	 * @returns If the symbol has references.
	 */
	export function isReferenced(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		return !!locationsFor(symbol).reference?.length
	}

	/**
	 * @returns If the symbol has type definitions.
	 */
	export function isTypeDefined(symbol: DeepReadonly<Symbol> | undefined): symbol is Symbol {
		return !!locationsFor(symbol).typeDefinition?.length
	}

	/**
	 * @throws If the symbol does not have any declarations or definitions.
	 */
	export function getDeclaredLocation(symbol: DeepReadonly<Symbol>): SymbolLocation {
		const view = locationsFor(symbol)
		return (view.declaration?.[0] ?? view.definition?.[0] ?? (() => {
			throw new Error(
				`Cannot get declared location of ${JSON.stringify(SymbolPath.fromSymbol(symbol))}`,
			)
		})())
	}

	/** Do something for each symbol in the given map. */
	export function forEachSymbolInMap(map: SymbolMap, fn: (symbol: Symbol) => unknown): void {
		for (const symbol of Object.values(map!)) {
			fn(symbol)
			if (symbol.members) {
				SymbolUtil.forEachSymbolInMap(symbol.members, fn)
			}
		}
	}

	/** Do something for each symbol in the given table. */
	export function forEachSymbol(table: SymbolTable, fn: (symbol: Symbol) => unknown): void {
		for (const map of Object.values(table)) {
			SymbolUtil.forEachSymbolInMap(map!, fn)
		}
	}

	/** Do something for each usage location of the given symbol. */
	export function forEachLocationOfSymbol(
		symbol: Symbol,
		fn: (data: { type: SymbolUsageType; location: SymbolLocation }) => unknown,
	): void {
		for (const container of SymbolUtil.allUsageContainers(symbol)) {
			for (const type of SymbolUsageTypes) {
				container[type]?.forEach((location) => fn({ type, location }))
			}
		}
	}

	/**
	 * @returns the canonical data of a global symbol, which is stored in its first global isotope.
	 */
	export function getCanonicalData(symbol: Pick<Symbol, 'facets'> | undefined): unknown {
		return symbol?.facets?.global?.isotopes[0]?.data
	}
}

/* istanbul ignore next */
/**
 * A series of methods for converting symbol structures to human-readable outputs. Mostly for debug purposes.
 */
export namespace SymbolFormatter {
	const IndentChar = '+ '

	function assertEqual<T>(a: T, b: T): void {
		if (a !== b) {
			throw new Error(`Assertion error: ${a} !== ${b}`)
		}
	}

	export function stringifySymbolTable(table: SymbolTable, indent = ''): string {
		const ans: [string, string][] = []
		for (const category of Object.keys(table)) {
			const map = table[category]!
			ans.push([category, stringifySymbolMap(map, `${indent}${IndentChar}`)])
		}
		return (ans.map((v) => `CATEGORY ${v[0]}\n${v[1]}`).join(`\n${indent}------------\n`)
			|| 'EMPTY TABLE')
	}

	export function stringifySymbolMap(map: SymbolMap | undefined, indent = ''): string {
		if (!map) {
			return 'undefined'
		}
		const ans: string[] = []
		for (const identifier of Object.keys(map)) {
			const symbol: Symbol = map[identifier]!
			assertEqual(identifier, symbol.identifier)
			ans.push(stringifySymbol(symbol, indent))
		}
		return ans.join(`\n${indent}------------\n`)
	}

	export function stringifySymbol(symbol: Symbol | undefined, indent = ''): string {
		if (!symbol) {
			return 'undefined'
		}
		const ans: string[] = []
		assertEqual(symbol.path[symbol.path.length - 1], symbol.identifier)
		ans.push(
			`SYMBOL ${symbol.path.join('.')}`
				+ ` {${symbol.category}${symbol.subcategory ? ` (${symbol.subcategory})` : ''}}`,
		)
		if (symbol.data) {
			ans.push(`${IndentChar}data: ${JSON.stringify(symbol.data, bigintJsonNumberReplacer)}`)
		}
		if (symbol.facets) {
			ans.push(`${IndentChar}facets: ${JSON.stringify(symbol.facets, bigintJsonNumberReplacer)}`)
		}
		if (LocalSymbol.is(symbol)) {
			if (symbol.desc !== undefined) {
				ans.push(`${IndentChar}desc: ${JSON.stringify(symbol.desc)}`)
			}
			for (const type of SymbolUsageTypes) {
				if (symbol[type]?.length) {
					ans.push(
						`${IndentChar}${type}: ${JSON.stringify(symbol[type], bigintJsonNumberReplacer)}`,
					)
				}
			}
		}
		if (symbol.relations) {
			ans.push(`${IndentChar}relations: ${JSON.stringify(symbol.relations)}`)
		}
		if (symbol.members) {
			ans.push(
				`${IndentChar}members:\n${
					stringifySymbolMap(symbol.members, `${indent}${IndentChar.repeat(2)}`)
				}`,
			)
		}
		return ans.map((v) => `${indent}${v}`).join('\n')
	}

	export function stringifyLookupResult(result: LookupResult): string {
		return `parentSymbol:
${stringifySymbol(result.parentSymbol, IndentChar)}
parentMap:
${stringifySymbolMap(result.parentMap, IndentChar)}
symbol:
${stringifySymbol(result.symbol, IndentChar)}`
	}
}
